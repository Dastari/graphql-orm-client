import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient, selectorOf, type GraphQLResponse } from "../src/client.js"
import { installFreshness } from "../src/freshness.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  input CursorInput { limit: Int after: String }
  type Query { Ticket(Id: ID!): Ticket, Person(Id: ID!): Person, Tickets(Page: CursorInput): TicketConnection! }
  type Mutation { RenameTicket(Id: ID!, Title: String!): Ticket }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  enum ChangeKind { DIRECT PROPAGATED }
  type TicketChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind, Ticket: Ticket }
  type PageInfo { HasNextPage: Boolean!, EndCursor: String }
  type TicketEdge { Node: Ticket!, Cursor: String! }
  type TicketConnection { Edges: [TicketEdge!]!, PageInfo: PageInfo! }
  type Ticket { Id: ID!, Title: String!, RecordVersion: Int!, Expires: Int }
  type Person { Id: ID!, Name: String! }
`)
const documents = [
  `fragment TicketTitle on Ticket @live { Title }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`,
  `query PersonPage($Id: ID!) { Person(Id: $Id) { Name } }`,
  `query TicketList($Page: CursorInput) { Tickets(Page: $Page) @connection(key: "tickets") { Edges { Node { ...TicketTitle } } } }`,
  `mutation Rename($Id: ID!, $Title: String!) { RenameTicket(Id: $Id, Title: $Title) { Id Title RecordVersion } }`,
]
const compiled = compile(schema, documents)
const ops = compiled.operations
const MINUTE = 60_000

const ticket = (Id: string, Title = Id, RecordVersion = 1) => ({ __typename: "Ticket", Id, Title, RecordVersion })

function setup(options: { freshness?: boolean; retainMs?: number } = {}) {
  const clock = createTestClock()
  const streams = createMockStreams()
  const rows = ["a", "b"]
  const versions = new Map<string, number>()
  const titles = new Map<string, string>()
  let mutation: () => Promise<GraphQLResponse> | GraphQLResponse = () => ({ data: { RenameTicket: ticket("a", "renamed", 2) } })
  const network = createMockNetwork({
    operations: {
      TicketPage: (variables) => {
        const id = variables.Id as string
        return { data: { Ticket: ticket(id, titles.get(id), versions.get(id) ?? 1) } }
      },
      PersonPage: (variables) => ({ data: { Person: { __typename: "Person", Id: variables.Id, Name: "someone" } } }),
      TicketList: (variables) => {
        const page = (variables.Page ?? {}) as { after?: string; limit?: number }
        const start = page.after ? rows.indexOf(page.after) + 1 : 0
        const shown = rows.slice(start, start + (page.limit ?? 2))
        return {
          data: {
            Tickets: {
              __typename: "TicketConnection",
              Edges: shown.map((id) => ({ __typename: "TicketEdge", Cursor: id, Node: ticket(id) })),
              PageInfo: { __typename: "PageInfo", HasNextPage: start + shown.length < rows.length, EndCursor: shown.at(-1) ?? null },
            },
          },
        }
      },
      Rename: () => mutation(),
    },
  })
  const client = createClient({
    network,
    store: { ...clock.store, retainMs: options.retainMs ?? 60 * MINUTE },
    polling: clock.polling,
    live: {
      ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, resyncJitterMs: 0, settleMs: false, onDiagnostic: null,
      connection: { state: () => "connected", subscribe: (listener) => streams.onReconnect(() => listener({ reconnected: true })) },
    },
  })
  if (options.freshness !== false) installFreshness(client, { staleMs: { Ticket: MINUTE } })
  const reads = (name: string) => network.calls(name).length
  return { client, clock, streams, network, rows, versions, titles, reads, setMutation: (next: typeof mutation) => void (mutation = next) }
}

/** Open a store-or-network watched query, let it settle, and close it again. */
async function visit(context: ReturnType<typeof setup>, name: string, variables: Record<string, unknown>) {
  const query = context.client.watchQuery(compiled.operations[name]!, variables, "store-or-network")
  query.open()
  await context.clock.tick()
  const state = query.getState()
  query.close()
  return state
}

describe("installFreshness", () => {
  it("answers a store-or-network read from the store within staleMs of the last write, and reads again after it", async () => {
    const context = setup()
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(1)

    await context.clock.tick(MINUTE - 1)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    await visit(context, "TicketPage", { Id: "a" })
    expect(context.reads("TicketPage")).toBe(1)

    await context.clock.tick(1)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(2)

    // That read restarted the age; a watched query that opens past it shows the stored data while it reads.
    await context.clock.tick(MINUTE)
    const query = context.client.watchQuery(ops.TicketPage!, { Id: "a" }, "store-or-network")
    expect(query.getState().status).toBe("ready")
    query.open()
    expect(query.getState().data).toBeTruthy()
    await context.clock.tick()
    expect(context.reads("TicketPage")).toBe(3)
    query.close()
    context.client.dispose()
  })

  it("leaves a type with no setting as it reads without freshness", async () => {
    for (const freshness of [true, false]) {
      const context = setup({ freshness })
      await context.client.query(ops.PersonPage!, { Id: "p" })
      await context.clock.tick(30 * MINUTE)
      await context.client.query(ops.PersonPage!, { Id: "p" })
      await visit(context, "PersonPage", { Id: "p" })
      expect(context.reads("PersonPage")).toBe(1)
      context.client.dispose()
    }
    // And without freshness installed, no type goes stale.
    const context = setup({ freshness: false })
    await context.client.query(ops.TicketPage!, { Id: "a" })
    await context.clock.tick(30 * MINUTE)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(1)
    context.client.dispose()
  })

  it("restarts a record's age when a live event writes it", async () => {
    const context = setup()
    const watched = context.client.watchQuery(ops.TicketPage!, { Id: "a" })
    watched.open()
    await context.clock.tick()
    expect(context.reads("TicketPage")).toBe(1)

    await context.clock.tick(50_000)
    context.streams.one("LiveTicket").emit(ticket("a", "from an event", 2))
    watched.close()
    expect(context.client.store.get(encodeNodeId("Ticket", ["a"]))?.fields.get("Title")).toBe("from an event")

    // Seventy seconds after the read, twenty after the event.
    await context.clock.tick(20_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(1)

    await context.clock.tick(40_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(2)
    context.client.dispose()
  })

  it("doesn't count a stream's coverage as freshness, and a child deletion makes a record stale", async () => {
    const context = setup()
    const watched = context.client.watchQuery(ops.TicketPage!, { Id: "a" })
    watched.open()
    await context.clock.tick()
    // Covered all along, with no event: past the setting, it is read again.
    await context.clock.tick(MINUTE)
    expect(context.streams.one("LiveTicket").closed).toBe(false)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(2)

    const fresh = () => context.client.store.freshness!.fresh(selectorOf(ops.TicketPage!, { Id: "a" }))
    expect(fresh()).toBe(true)
    // A child deleted under the record says it changed, and carries nothing: stale until the holders' read lands.
    context.streams.one("LiveTicket").emit(ticket("a"), { action: "DELETED", changeKind: "PROPAGATED" })
    expect(fresh()).toBe(false)
    await context.clock.tick(5000)
    expect(context.reads("TicketPage")).toBe(3)
    expect(fresh()).toBe(true)
    watched.close()
    context.client.dispose()
  })

  it("doesn't restart the age for an optimistic write, and does for the mutation's response", async () => {
    const context = setup()
    await context.client.query(ops.TicketPage!, { Id: "a" })
    await context.clock.tick(50_000)
    let respond!: (response: GraphQLResponse) => void
    context.setMutation(() => new Promise((resolve) => (respond = resolve)))
    const pending = context.client.mutate(ops.Rename!, { Id: "a", Title: "optimistic" }, { optimisticResponse: { RenameTicket: ticket("a", "optimistic", 2) } })
    await context.clock.tick(20_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(2)

    // That read carried an older version than the optimistic one, so the store kept the optimistic values and their age.
    await context.clock.tick(55_000)
    respond({ data: { RenameTicket: ticket("a", "renamed", 3) } })
    await pending
    // 150 s: eighty seconds after that read, twenty-five after the mutation's response.
    await context.clock.tick(25_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(2)
    context.client.dispose()
  })

  it("doesn't restart the age for a write the store refused as older", async () => {
    const context = setup()
    context.versions.set("a", 2)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    await context.clock.tick(50_000)
    context.versions.set("a", 1)
    context.titles.set("a", "older")
    await context.client.query(ops.TicketPage!, { Id: "a" }, { policy: "network-only" })
    expect(context.client.store.get(encodeNodeId("Ticket", ["a"]))?.fields.get("Title")).toBe("a")
    await context.clock.tick(20_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(3)

    // The same version is a confirmation, and restarts it.
    context.versions.set("a", 2)
    context.titles.delete("a")
    await context.clock.tick(50_000)
    await context.client.query(ops.TicketPage!, { Id: "a" }, { policy: "network-only" })
    await context.clock.tick(20_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(4)
    context.client.dispose()
  })

  it("ages a list by when it was read, not by its rows", async () => {
    const context = setup()
    await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(1)
    // Both rows written again 50 s later, by another read.
    await context.clock.tick(50_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    await context.client.query(ops.TicketPage!, { Id: "b" })
    await context.clock.tick(20_000)
    await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(2)
    await context.clock.tick(30_000)
    await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(2)
    context.client.dispose()
  })

  it("ages an empty list too", async () => {
    const context = setup()
    context.rows.length = 0
    await visit(context, "TicketList", {})
    await context.clock.tick(MINUTE - 1)
    await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(1)
    await context.clock.tick(1)
    await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(2)
    context.client.dispose()
  })

  it("doesn't let a next page restart the age of the pages before it", async () => {
    const context = setup()
    context.rows.push("c", "d")
    const query = context.client.watchQuery(ops.TicketList!, {}, "store-or-network")
    query.open()
    await context.clock.tick()
    await context.clock.tick(50_000)
    await query.loadMore()
    await context.client.query(ops.TicketPage!, { Id: "a" })
    await context.client.query(ops.TicketPage!, { Id: "b" })
    query.close()
    expect(context.reads("TicketList")).toBe(2)
    // Every row was written 20 s ago; the first page's place in the list, 70 s ago.
    await context.clock.tick(20_000)
    const state = await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(3)
    expect(context.network.calls("TicketList").at(-1)!.variables).toEqual({ Page: { limit: 4 } })
    expect(state.data).toBeTruthy()
    // That read replaced every loaded row, so the list is fresh again.
    await context.clock.tick(20_000)
    await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(3)
    context.client.dispose()
  })

  it("doesn't let a first page that kept the pages after it restart the list's age", async () => {
    const context = setup()
    context.rows.push("c", "d")
    const query = context.client.watchQuery(ops.TicketList!, {}, "store-or-network")
    query.open()
    await context.clock.tick()
    await query.loadMore()
    // A first page read alone, by another query with the same list, keeps the second page.
    await context.clock.tick(50_000)
    await context.client.query(ops.TicketList!, {}, { policy: "network-only" })
    expect(context.network.calls("TicketList").at(-1)!.variables).toEqual({})
    // Every row is fresh; only the list's second page is as old as it was.
    await context.client.query(ops.TicketPage!, { Id: "c" })
    await context.client.query(ops.TicketPage!, { Id: "d" })
    query.close()
    await context.clock.tick(20_000)
    await visit(context, "TicketList", {})
    expect(context.reads("TicketList")).toBe(4)
    context.client.dispose()
  })

  it("never makes a restored record fresh, however recently it was saved", async () => {
    const saving = setup()
    await saving.client.query(ops.TicketPage!, { Id: "a" })
    const saved = saving.client.store.persistenceSnapshot()!
    saving.client.dispose()

    const context = setup()
    context.client.store.restore(saved)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(1)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(1)
    context.client.dispose()
  })

  it("forgets the age of a collected record", async () => {
    const context = setup({ retainMs: 10 })
    const store = context.client.store
    await context.client.query(ops.TicketPage!, { Id: "a" })
    const saved = store.persistenceSnapshot()!
    await context.clock.tick(10)
    expect(store.get(encodeNodeId("Ticket", ["a"]))).toBeUndefined()
    // Written back by something that isn't a server response, within what was its age.
    for (const entry of saved) {
      const record = store.getOrCreate(entry.id, entry.typename)
      for (const [key, value] of entry.fields) store.setField(record, key, value)
    }
    store.publish()
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(2)
    context.client.dispose()
  })

  it("still expires a fresh record by its lifetime field", async () => {
    const withLifetime = compile(schema, documents, { lifetimes: { Ticket: { field: "Expires", format: "unix-seconds" } } })
    const clock = createTestClock()
    const network = createMockNetwork({ operations: { TicketPage: { data: { Ticket: { ...ticket("a"), Expires: 1_010 } } } } })
    const client = createClient({ network, store: clock.store })
    installFreshness(client, { staleMs: { Ticket: 60 * MINUTE } })
    await client.query(withLifetime.operations.TicketPage!, { Id: "a" })
    await clock.tick(5000)
    await client.query(withLifetime.operations.TicketPage!, { Id: "a" })
    expect(network.calls("TicketPage")).toHaveLength(1)
    // Past Expires (1,010 s on the store's clock, which starts at 1,000 s), well within staleMs.
    await clock.tick(10_000)
    await client.query(withLifetime.operations.TicketPage!, { Id: "a" })
    expect(network.calls("TicketPage")).toHaveLength(2)
    client.dispose()
  })

  it("restarts the age with a refetch and with the read a reconnect replays", async () => {
    const context = setup()
    const watched = context.client.watchQuery(ops.TicketPage!, { Id: "a" })
    watched.open()
    await context.clock.tick()
    await context.clock.tick(50_000)
    await watched.refetch()
    expect(context.reads("TicketPage")).toBe(2)
    await context.clock.tick(50_000)
    // Events in the gap are gone, so the holders read again.
    context.streams.reconnect()
    await context.clock.tick(5000)
    expect(context.reads("TicketPage")).toBe(3)
    watched.close()
    // 105 s after the refetch, 55 s after the reconnect.
    await context.clock.tick(50_000)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    expect(context.reads("TicketPage")).toBe(3)
    context.client.dispose()
  })

  it("is dropped with the client's identity, and installs once", async () => {
    const context = setup()
    expect(() => installFreshness(context.client, { staleMs: {} })).toThrow(/already installed/)
    await context.client.query(ops.TicketPage!, { Id: "a" })
    context.client.dispose()
    expect(context.client.store.freshness).toBeUndefined()
    const next = createClient({ network: context.network, store: context.clock.store })
    expect(() => installFreshness(next, { staleMs: { Ticket: -1 } })).toThrow(RangeError)
    expect(() => installFreshness(next, { staleMs: { Ticket: Number.NaN } })).toThrow(RangeError)
    next.dispose()
  })
})
