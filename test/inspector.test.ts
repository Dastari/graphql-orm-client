import { buildSchema } from "graphql"
import { inspect as show } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { inspect, type InspectorEvent } from "../src/inspector.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  type Query { Ticket(Id: ID!): Ticket, Tickets: [Ticket!]!, Secret(Id: ID!): Ticket }
  type Mutation { IssueToken(Id: ID!): Token! }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  enum ChangeKind { DIRECT PROPAGATED }
  type TicketChangedEvent { Action: ChangeAction!, ChangeKind: ChangeKind!, Ticket: Ticket }
  type Ticket { Id: ID!, Title: String!, RecordVersion: Int! }
  type Token { Secret: String!, Ticket: Ticket }
`)
const compiled = compile(schema, [
  `fragment TicketTitle on Ticket @live { Title }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`,
  `query TicketWatch($Id: ID!) @poll(reason: "Inspector poll test") { Ticket(Id: $Id) { ...TicketTitle } }`,
  `query TicketList { Tickets { ...TicketTitle } }`,
  `query SecretTicket($Id: ID!) @sensitive { Secret(Id: $Id) { Id Title RecordVersion } }`,
  `mutation SecretToken($Id: ID!) @sensitive { IssueToken(Id: $Id) { Secret Ticket { Id Title RecordVersion } } }`,
  `mutation Token($Id: ID!) { IssueToken(Id: $Id) { Secret Ticket { Id Title RecordVersion } } }`,
], { liveSelection: "as-written" })
const TicketPage = compiled.operations.TicketPage!
const TicketWatch = compiled.operations.TicketWatch!
const TicketList = compiled.operations.TicketList!
const SecretTicket = compiled.operations.SecretTicket!
const SecretToken = compiled.operations.SecretToken!
const Token = compiled.operations.Token!
const ticket = (Id: string, Title = `title-${Id}`, RecordVersion = 1) => ({ __typename: "Ticket", Id, Title, RecordVersion })
const SECRET = "sensitive-value-never-inspected"

function setup() {
  const clock = createTestClock()
  const streams = createMockStreams({ schema })
  let titles: Record<string, string> = {}
  const network = createMockNetwork({
    schema,
    operations: {
      TicketPage: (variables) => ({ data: { Ticket: ticket(String(variables.Id), titles[String(variables.Id)]) } }),
      TicketWatch: (variables) => ({ data: { Ticket: ticket(String(variables.Id), titles[String(variables.Id)]) } }),
      TicketList: () => ({ data: { Tickets: [ticket("t1", titles.t1), ticket("t2", titles.t2)] } }),
      SecretTicket: { data: { Secret: ticket("t1", SECRET, 99) } },
      SecretToken: { data: { IssueToken: { __typename: "Token", Secret: SECRET, Ticket: ticket("t1", SECRET, 99) } } },
      Token: { data: { IssueToken: { __typename: "Token", Secret: SECRET, Ticket: ticket("t1", SECRET, 99) } } },
    },
  })
  const client = createClient({
    network,
    store: { ...clock.store, retainMs: 1000 },
    polling: clock.polling,
    live: {
      ...clock.live,
      artifacts: compiled.live,
      subscribe: streams.subscribe,
      connection: { state: () => "connected", subscribe: (listener) => streams.onReconnect(() => listener({ reconnected: true })) },
      debounceMs: 0,
      settleMs: false,
      resyncJitterMs: 0,
      onDiagnostic: null,
    },
  })
  const inspector = inspect(client, { enabled: true })
  const events: InspectorEvent[] = []
  inspector.subscribe((event) => events.push(event))
  return { client, clock, streams, network, inspector, events, title: (id: string, value: string) => { titles = { ...titles, [id]: value } } }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("the store inspector", () => {
  it("lists a record with the queries holding it and the stream covering it", async () => {
    const { client, clock, inspector } = setup()
    const page = client.watchQuery(TicketPage, { Id: "t1" })
    page.open()
    await clock.tick(1)
    const id = encodeNodeId("Ticket", ["t1"])

    const [query] = inspector.queries()
    expect(query).toMatchObject({ operation: "TicketPage", variables: { Id: "t1" }, state: "open", status: "ready", pollMs: null })
    expect(query!.records).toContain(id)
    const [stream] = inspector.streams()
    expect(stream).toMatchObject({ typename: "Ticket", operation: "LiveTicket", scope: "keys", thin: false, records: [id] })
    const record = inspector.records().find((entry) => entry.id === id)
    expect(record).toMatchObject({ typename: "Ticket", fields: { Id: "t1", Title: "title-t1" }, heldBy: [query!.key], coveredBy: [stream!.id] })
    // A copy: changing it leaves the store as it was.
    ;(record!.fields as Record<string, unknown>).Title = "changed"
    expect(client.store.get(id)!.fields.get("Title")).toBe("title-t1")
    client.dispose()
  })

  it("records why each query was read: opening, a list event, a held record's event, a poll, a reconnect and a refetch", async () => {
    const { client, clock, streams, inspector, events } = setup()
    const list = client.watchQuery(TicketList, {})
    list.open()
    const page = client.watchQuery(TicketWatch, { Id: "t9" }, { pollMs: 60_000 })
    page.open()
    await clock.tick(1)
    expect(inspector.reads().map((read) => [read.operation, read.cause])).toEqual([["TicketList", "first"], ["TicketWatch", "first"]])

    // An event for a row the list doesn't show: the list is read again.
    // The list's stream carries every ticket, so it is the one stream, covering the page's record too.
    expect(inspector.streams()).toMatchObject([{ scope: "all", records: ["t1", "t2", "t9"].map((id) => encodeNodeId("Ticket", [id])) }])
    streams.one("LiveTicket").emit(ticket("t3"), { action: "CREATED" })
    await clock.tick(1)
    expect(inspector.reads().at(-1)).toMatchObject({ operation: "TicketList", cause: "list", typename: "Ticket", query: inspector.queries()[0]!.key })

    // A child deleted below a held record: the event carries nothing to write, so the query holding it reads again.
    streams.one("LiveTicket").emit(ticket("t9"), { action: "DELETED", changeKind: "PROPAGATED" })
    await clock.tick(1)
    expect(inspector.reads().filter((read) => read.operation === "TicketWatch").at(-1)).toMatchObject({ cause: "event", typename: "Ticket" })

    await clock.tick(60_000)
    expect(inspector.reads().at(-1)).toMatchObject({ operation: "TicketWatch", cause: "poll" })

    const before = inspector.reads().length
    streams.reconnect()
    await clock.tick(1)
    expect(inspector.reads().slice(before).map((read) => [read.operation, read.cause]).sort()).toEqual([["TicketList", "reconnect"], ["TicketWatch", "reconnect"]])

    await list.refetch()
    expect(inspector.reads().at(-1)).toMatchObject({ operation: "TicketList", cause: "manual" })
    // Listeners heard each read as it started, in order.
    expect(events.filter((event) => event.type === "read").map((event) => event.type === "read" && event.read)).toEqual(inspector.reads())
    client.dispose()
  })

  it("keeps a bounded list of reads", async () => {
    const { client, clock } = setup()
    const inspector = inspect(client)
    expect(inspector).toBe(inspect(client))
    inspector.dispose()
    const bounded = inspect(client, { enabled: true, maxReads: 2 })
    const page = client.watchQuery(TicketPage, { Id: "t1" })
    page.open()
    await clock.tick(1)
    for (let i = 0; i < 3; i++) await page.refetch()
    expect(bounded.reads().map((read) => read.cause)).toEqual(["manual", "manual"])
    client.dispose()
  })

  it("receives nothing from an @sensitive query, an @sensitive mutation or a no-store mutation", async () => {
    const { client, clock, inspector, events } = setup()
    const page = client.watchQuery(TicketPage, { Id: "t1" })
    page.open()
    await clock.tick(1)
    const seen = events.length
    const reads = inspector.reads().length

    const query = await client.query<any>(SecretTicket, { Id: "t1" })
    const sensitive = await client.mutate<any>(SecretToken, { Id: "t1" })
    const isolated = await client.mutate<any>(Token, { Id: "t1" }, { policy: "no-store" })
    // The values reached the caller, so there was something to leak.
    expect([query.data.Secret.Title, sensitive.data.IssueToken.Secret, isolated.data.IssueToken.Secret]).toEqual([SECRET, SECRET, SECRET])
    await clock.tick(1)

    expect(events.length).toBe(seen)
    expect(inspector.reads().length).toBe(reads)
    const given = [inspector.records(), inspector.queries(), inspector.streams(), inspector.reads(), events]
    expect(JSON.stringify(given)).not.toContain(SECRET)
    // Everything the inspector holds, including the client it reads from, its store and live layer.
    expect(show(inspector, { depth: null, showHidden: true })).not.toContain(SECRET)
    // The search does reach the store's values.
    expect(show(inspector, { depth: null, showHidden: true })).toContain("title-t1")
    client.dispose()
  })

  it("holds nothing after its client is disposed, and its listeners are removed", async () => {
    const { client, clock, inspector, events } = setup()
    const page = client.watchQuery(TicketPage, { Id: "t1" })
    page.open()
    await clock.tick(1)
    expect(inspector.records().length).toBeGreaterThan(0)
    const listener = vi.fn()
    inspector.subscribe(listener)
    const live = client.live as unknown as { onEvent: unknown }
    const tapped = live.onEvent
    expect(Object.prototype.hasOwnProperty.call(client, "executeResponse")).toBe(true)

    client.dispose()
    expect(inspector.active).toBe(false)
    expect(events.at(-1)).toEqual({ type: "dispose" })
    expect(listener).toHaveBeenLastCalledWith({ type: "dispose" })
    expect([inspector.records(), inspector.queries(), inspector.streams(), inspector.reads()]).toEqual([[], [], [], []])
    // Nothing of the identity remains in it: no client, no record, no read.
    const held = show(inspector, { depth: null, showHidden: true })
    expect(held).not.toContain("title-t1")
    expect(held).not.toContain(encodeNodeId("Ticket", ["t1"]))
    expect(held).not.toContain("TicketPage")
    expect(held).toMatch(/client: null/)
    expect(held).toMatch(/listeners: Set\(0\)/)
    // What it put on the client is gone.
    expect(Object.prototype.hasOwnProperty.call(client, "executeResponse")).toBe(false)
    expect(live.onEvent).not.toBe(tapped)
    listener.mockClear()
    expect(inspector.subscribe(listener)).toBeTypeOf("function")
    expect(listener).not.toHaveBeenCalled()
  })

  it("follows collection: a closed query is released, then its records and the query go", async () => {
    const { client, clock, inspector } = setup()
    const page = client.watchQuery(TicketPage, { Id: "t1" })
    page.open()
    await clock.tick(1)
    page.close()
    expect(inspector.queries()).toMatchObject([{ operation: "TicketPage", state: "released" }])
    await clock.tick(1000)
    expect(inspector.queries()).toEqual([])
    expect(inspector.records().map((record) => record.id)).toEqual(["client:root"])
    expect(inspector.streams()).toEqual([])
    client.dispose()
  })

  it("detaches on dispose() and leaves the client working", async () => {
    const { client, clock, inspector, network } = setup()
    inspector.dispose()
    expect(inspector.active).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(client, "executeResponse")).toBe(false)
    const page = client.watchQuery(TicketPage, { Id: "t1" })
    page.open()
    await clock.tick(1)
    expect(page.getState().status).toBe("ready")
    expect(network.calls("TicketPage")).toHaveLength(1)
    expect(inspector.reads()).toEqual([])
    const again = inspect(client, { enabled: true })
    expect(again).not.toBe(inspector)
    await page.refetch()
    expect(again.reads()).toMatchObject([{ operation: "TicketPage", cause: "manual" }])
    client.dispose()
  })

  it("never attaches in production, and attaches by default only where the bundle says development or tests", () => {
    const client = createClient({ network: createMockNetwork({ schema }) })
    vi.stubEnv("NODE_ENV", "production")
    for (const options of [{}, { enabled: true }]) {
      const inspector = inspect(client, options)
      expect(inspector.active).toBe(false)
      expect(inspector.records()).toEqual([])
      expect(Object.prototype.hasOwnProperty.call(client, "executeResponse")).toBe(false)
    }
    vi.stubEnv("NODE_ENV", undefined)
    expect(inspect(client).active).toBe(false)
    expect(inspect(client, { enabled: false }).active).toBe(false)
    const explicit = inspect(client, { enabled: true })
    expect(explicit.active).toBe(true)
    explicit.dispose()
    vi.stubEnv("NODE_ENV", "development")
    const development = inspect(client)
    expect(development.active).toBe(true)
    expect(inspect(client, { enabled: false })).toBe(development)
    client.dispose()
    expect(inspect(client, { enabled: true }).active).toBe(false)
  })
})
