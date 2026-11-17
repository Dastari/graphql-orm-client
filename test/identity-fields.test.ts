import { buildSchema } from "graphql"
import { describe, expect, it, vi } from "vitest"
import { createClient, fragmentSelector, readFragment } from "../src/client.js"
import { CompileError, compile, generate, type CompileOptions } from "../src/compiler/index.js"
import type { Selection } from "../src/artifact.js"
import { encodeNodeId } from "../src/node-id.js"
import { readAll } from "../src/read-all.js"
import { contextOf, identify, normalize } from "../src/store/normalize.js"
import { ROOT_ID, Store } from "../src/store/store.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"

// A versioned type with a server NodeId, the shape graphql-orm generates.
const schema = buildSchema(`
  type Query { Tickets(Page: PageInput): TicketConnection!, Ticket(Id: ID!): Ticket, Notes: [Note!]! }
  type Mutation { CloseTicket(Id: ID!): Ticket }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  type TicketChangedEvent { Action: String!, Ticket: Ticket }
  input PageInput { Limit: Int, Offset: Int }
  type TicketConnection { Edges: [TicketEdge!]!, PageInfo: PageInfo! }
  type TicketEdge { Node: Ticket! }
  type PageInfo { HasNextPage: Boolean!, TotalCount: Int! }
  type Ticket { NodeId: ID!, Id: ID!, Title: String!, State: String!, RecordVersion: Int! }
  type Note { Id: ID!, Body: String!, Revision: String!, Stamp: Float!, Flag: Boolean! }
`)

const documents = [
  `fragment TicketRow on Ticket @live { Title State }`,
  `query TicketsPage { Tickets(Page: { Limit: 50 }) { Edges { Node { ...TicketRow } } } }`,
  `query TicketsWithIds { Tickets(Page: { Limit: 50 }) { Edges { Node { Id RecordVersion ...TicketRow } } } }`,
  `query TicketTitles($Page: PageInput) { Tickets(Page: $Page) @connection(key: "titles") { Edges { Node { Title } } PageInfo { HasNextPage TotalCount } } }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketRow } }`,
  `query TicketWithVersion($Id: ID!) { Ticket(Id: $Id) { Id RecordVersion ...TicketRow } }`,
  `mutation Close($Id: ID!) { CloseTicket(Id: $Id) { State } }`,
]

type Row = Record<string, unknown>
type Data = { Tickets: { Edges: { Node: Row }[] }; Ticket: Row }

const ticket = (id: string, version: number, title = `ticket-${id}`): Row => ({
  __typename: "Ticket", NodeId: encodeNodeId("Ticket", [id]), Id: id, Title: title, State: "open", RecordVersion: version,
})
const page = (rows: Row[], more = false, total = rows.length) => ({
  Tickets: {
    __typename: "TicketConnection",
    Edges: rows.map((Node) => ({ __typename: "TicketEdge", Node })),
    PageInfo: { __typename: "PageInfo", HasNextPage: more, TotalCount: total },
  },
})

/** A client showing five rows, live through the generated Ticket stream. `rows` is what the server answers with. */
async function setup(options: CompileOptions = {}, operation = "TicketsPage") {
  const compiled = compile(schema, documents, options)
  const clock = createTestClock(), streams = createMockStreams()
  const rows: Row[] = Array.from({ length: 5 }, (_, i) => ticket(`t${i}`, 1))
  let reads = 0
  const client = createClient({
    network: {
      execute: async ({ name, variables }) => {
        reads++
        return { data: name.startsWith("Tickets") ? page(rows) : { Ticket: rows.find((row) => row.Id === variables.Id) } }
      },
    },
    store: clock.store,
    polling: { ...clock.polling, undeclared: "off" },
    live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, settleMs: false, debounceMs: 0, resyncJitterMs: 0, onDiagnostic: null },
  })
  const query = client.watchQuery<Data>(compiled.operations[operation]!, operation.startsWith("Tickets") ? {} : { Id: "t2" })
  query.open()
  await query.refetch()
  await clock.tick()
  const listener = vi.fn()
  query.subscribe(listener)
  /** The server changes row t2, and its stream says so. */
  const change = (version: number, title: string) => {
    rows[2] = ticket("t2", version, title)
    streams.one("LiveTicket").emit(rows[2])
  }
  return { client, compiled, clock, streams, query, listener, change, reads: () => reads }
}

const scalarNames = (selections: readonly Selection[]): string[] =>
  selections.flatMap((selection) => (selection.kind === "scalar" ? [selection.fieldName] : []))
const child = (selections: readonly Selection[], name: string): readonly Selection[] => {
  const found = selections.find((selection) => selection.kind === "link" && selection.fieldName === name)
  if (!found || found.kind !== "link") throw new Error(`no ${name}`)
  return found.selections
}
const nodeOf = (selections: readonly Selection[]) => child(child(child(selections, "Tickets"), "Edges"), "Node")

describe("compiler-added identity and version fields", () => {
  it("are sent and written, but not read into data unless the document selects them", () => {
    const { operations, fragments } = compile(schema, documents)
    const list = operations.TicketsPage!
    expect(list.text).toMatch(/Node \{\s*__typename\s+NodeId\s+Id\s+RecordVersion\s+\.\.\.TicketRow/)
    expect(scalarNames(nodeOf(list.normalization))).toEqual(expect.arrayContaining(["NodeId", "Id", "RecordVersion"]))
    expect(scalarNames(nodeOf(list.selections))).toEqual(["__typename"])
    expect(scalarNames(fragments.TicketRow!.selections)).toEqual(["__typename", "Title", "State"])
    // Selected by the document itself, they're read.
    expect(scalarNames(nodeOf(operations.TicketsWithIds!.selections))).toEqual(["__typename", "Id", "RecordVersion"])
    // `identityFields: "always"` reads them everywhere, as before, and sends the same text.
    const always = compile(schema, documents, { identityFields: "always" })
    expect(scalarNames(nodeOf(always.operations.TicketsPage!.selections))).toEqual(["__typename", "NodeId", "Id", "RecordVersion"])
    expect(scalarNames(always.fragments.TicketRow!.selections)).toEqual(["__typename", "NodeId", "Id", "RecordVersion", "Title", "State"])
    expect(always.operations.TicketsPage!.text).toBe(list.text)
    expect(always.operations.TicketsPage!.normalization).toEqual(list.normalization)
    expect(() => compile(schema, documents, { identityFields: "sometimes" as never })).toThrow(/identityFields/)
  })

  it("aren't in the generated types unless selected", () => {
    const module = generate(schema, documents, { onWarning: () => {} })
    expect(module).toContain(`readonly Node: { readonly __typename: "Ticket" } & FragmentRefs<"TicketRow">`)
    expect(module).toMatch(/export type TicketsWithIdsQuery = .*\{ readonly __typename: "Ticket"; readonly Id: string; readonly RecordVersion: number \}/)
    expect(module).toContain(`export type TicketRowFragment = { readonly __typename: "Ticket"; readonly Title: string; readonly State: string }`)
    const always = generate(schema, documents, { onWarning: () => {}, identityFields: "always" })
    expect(always).toMatch(/export type TicketsPageQuery = .*readonly NodeId: string; readonly Id: string; readonly RecordVersion: number/)
  })

  it("a newer version of a row shown only through fragments doesn't notify the list's subscription", () => {
    // 5 rows are read whole on each write; 100 go through the store's memo.
    for (const count of [5, 100]) {
      for (const [identityFields, expected] of [["selected", 0], ["always", 2]] as const) {
        const { operations, live } = compile(schema, documents, { identityFields })
        const list = operations.TicketsPage!
        const store = new Store()
        normalize(store, list.normalization, page(Array.from({ length: count }, (_, i) => ticket(`t${i}`, 1))), contextOf(list, {}))
        store.publish()
        const calls = vi.fn()
        store.subscribe(store.lookup({ id: ROOT_ID, selections: list.selections, variables: {}, fragments: list.fragments }), calls)
        const event = live.Ticket!.operation
        for (const version of [2, 3]) {
          normalize(store, event.normalization, { TicketChanged: { __typename: "TicketChangedEvent", Action: "UPDATED", Ticket: ticket("t2", version, `v${version}`) } }, contextOf(event, {}), "client:subscription:1", "Subscription")
          store.delete("client:subscription:1")
          store.publish()
        }
        expect(store.get(encodeNodeId("Ticket", ["t2"]))?.fields.get("RecordVersion")).toBe(3)
        expect({ count, identityFields, calls: calls.mock.calls.length }).toEqual({ count, identityFields, calls: expected })
        store.dispose()
      }
    }
  })

  it("an event for a record shown only through fragments notifies the fragment, not the query", async () => {
    const { client, compiled, query, listener, clock, change } = await setup({}, "TicketPage")
    const before = query.getState().data!
    expect(before.Ticket).not.toHaveProperty("Id")
    expect(before.Ticket).not.toHaveProperty("RecordVersion")
    const rowListener = vi.fn()
    const { store, selector } = fragmentSelector(compiled.fragments.TicketRow!, before.Ticket)
    store.subscribe(store.lookup(selector), rowListener)
    change(2, "renamed")
    await clock.tick()
    expect(client.store.get(encodeNodeId("Ticket", ["t2"]))?.fields.get("RecordVersion")).toBe(2)
    expect(rowListener).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
    expect(query.getState().data).toBe(before)
    expect(readFragment<{ Title: string }>(compiled.fragments.TicketRow!, before.Ticket).Title).toBe("renamed")
    client.dispose()
  })

  it(`with identityFields: "always", the same event notifies the query once`, async () => {
    const { client, query, listener, clock, change } = await setup({ identityFields: "always" }, "TicketPage")
    expect(query.getState().data!.Ticket.RecordVersion).toBe(1)
    change(2, "renamed")
    await clock.tick()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(query.getState().data!.Ticket.RecordVersion).toBe(2)
    client.dispose()
  })

  it("a document that selects the key and version reads them, and hears the version advance", async () => {
    const { client, query, listener, clock, change, streams } = await setup({}, "TicketWithVersion")
    expect(query.getState().data!.Ticket).toMatchObject({ Id: "t2", RecordVersion: 1 })
    expect(query.getState().data!.Ticket).not.toHaveProperty("NodeId")
    change(2, "renamed")
    await clock.tick()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(query.getState().data!.Ticket.RecordVersion).toBe(2)
    // An older event after a newer one changes nothing and notifies no one.
    streams.one("LiveTicket").emit(ticket("t2", 1, "older"))
    await clock.tick()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(client.store.get(encodeNodeId("Ticket", ["t2"]))?.fields.get("Title")).toBe("renamed")
    client.dispose()
  })

  it("a list's data stays the same object through an event for one of its rows", async () => {
    for (const [identityFields, changed] of [["selected", false], ["always", true]] as const) {
      const { client, query, clock, change, reads } = await setup({ identityFields })
      const before = query.getState().data!
      const shown: unknown[] = []
      query.subscribe(() => shown.push(query.getState().data))
      change(2, "renamed")
      // The event itself: only the store's write has happened, and the list's data changes only if it reads the version.
      expect(query.getState().data !== before).toBe(changed)
      expect(shown.some((data) => data !== before)).toBe(changed)
      // A list also reads again after an event for its type, to see whether its rows changed; that read is coalesced.
      await clock.tick(5000)
      expect(reads()).toBe(2)
      if (!changed) expect(query.getState().data).toEqual(before)
      client.dispose()
    }
  })

  it("keep ordering, reconnect replay, holdings, collection and identity disposal working without being read", async () => {
    const { client, streams, query, clock } = await setup()
    const id = encodeNodeId("Ticket", ["t1"])
    streams.one("LiveTicket").emit(ticket("t1", 3, "newest"))
    streams.one("LiveTicket").emit(ticket("t1", 2, "older"))
    await clock.tick()
    expect(client.store.get(id)?.fields.get("Title")).toBe("newest")
    // A reconnect reads the query again; its older row doesn't replace the newer one.
    const before = client.liveTypeHealth("Ticket")
    streams.reconnect()
    await clock.tick(5000)
    expect(client.store.get(id)?.fields.get("Title")).toBe("newest")
    // The live layer still holds every row by its NodeId.
    expect(before.held).toBe(5)
    expect(client.liveTypeHealth("Ticket").held).toBe(5)
    expect(client.liveTypeHealth("Ticket").state).toBe("live")
    query.close()
    await clock.tick(10 * 60_000)
    client.store.collect()
    expect(client.store.get(id)).toBeUndefined()
    const store = client.store
    client.dispose()
    expect(store.isDisposed).toBe(true)
    expect(store.size).toBe(0)
  })

  it("leave mutation results to what the mutation selects", async () => {
    const { operations } = compile(schema, documents)
    const client = createClient({ network: { execute: async () => ({ data: { CloseTicket: { ...ticket("t1", 4), State: "closed" } } }) } })
    const { snapshot } = await client.execute<{ CloseTicket: Row }>(operations.Close!, { Id: "t1" })
    expect(snapshot.data.CloseTicket).toEqual({ __typename: "Ticket", State: "closed" })
    expect(client.store.get(encodeNodeId("Ticket", ["t1"]))?.fields.get("RecordVersion")).toBe(4)
    client.dispose()
  })

  it("readAll still tells rows apart when the rows select no key", async () => {
    const { operations } = compile(schema, documents)
    const all = Array.from({ length: 5 }, (_, i) => ticket(`t${i}`, 1))
    const client = createClient({
      network: {
        execute: async ({ variables }) => {
          const { Limit, Offset } = (variables as { Page: { Limit: number; Offset: number } }).Page
          return { data: page(all.slice(Offset, Offset + Limit), Offset + Limit < all.length, all.length) }
        },
      },
    })
    const result = await readAll(client, operations.TicketTitles!, { Page: { Limit: 2, Offset: 0 } }, { limit: 5, pageSize: 2 })
    expect(result.rows.map((row) => (row as Row).Title)).toEqual(all.map((row) => row.Title))
    expect(result.rows[0]).not.toHaveProperty("Id")
    expect(result.total).toBe(5)
    client.dispose()
  })
})

describe("version fields that aren't numbers", () => {
  const notes = [`query NoteList { Notes { Body } }`]

  it("fail generation naming the type and field, unless a comparison is declared", () => {
    expect(() => compile(schema, notes, { versions: { Note: "Revision" } })).toThrow(CompileError)
    expect(() => compile(schema, notes, { versions: { Note: "Revision" } })).toThrow(/versions\.Note: Note\.Revision is String!, not Int or Float/)
    expect(() => compile(schema, notes, { versions: { Note: "Flag" } })).toThrow(/versions\.Note: Note\.Flag is Boolean!/)
    expect(() => compile(schema, notes, { versions: { Note: "Missing" } })).toThrow(/versions\.Note: Note\.Missing does not exist/)
    expect(() => compile(schema, notes, { versions: { Note: { field: "Flag", compare: "decimal" } } })).toThrow(/versions\.Note: Note\.Flag is Boolean!/)
    expect(() => compile(schema, notes, { versions: { Note: { field: "Revision", compare: "number" } } })).toThrow(/versions\.Note: Note\.Revision is String!/)
    expect(() => compile(schema, notes, { versions: { Note: { field: "Revision", compare: "text" as never } } })).toThrow(/versions\.Note: compare must be "number" or "decimal"/)
    // A number, a declared comparison and null all compile.
    expect(compile(schema, notes, { versions: { Note: "Stamp" } }).operations.NoteList!.versions).toEqual({ Note: "Stamp" })
    const decimal = compile(schema, notes, { versions: { Note: { field: "Revision", compare: "decimal" } } }).operations.NoteList!
    expect(decimal.versions).toEqual({ Note: "Revision" })
    expect(decimal.versionCompare).toEqual({ Note: "decimal" })
    expect(compile(schema, notes, { versions: { Note: null } }).operations.NoteList!.versions).toEqual({})
    expect(compile(schema, notes, { versions: { Note: "Stamp" } }).operations.NoteList!.versionCompare).toBeUndefined()
    // The generated module carries the comparison, and generation fails the same way.
    const options = { versions: { Note: { field: "Revision", compare: "decimal" } as const }, onWarning: () => {} }
    expect(generate(schema, notes, options)).toContain(`"versionCompare":{"Note":"decimal"}`)
    expect(() => generate(schema, notes, { versions: { Note: "Revision" }, onWarning: () => {} })).toThrow(/versions\.Note: Note\.Revision/)
  })

  it("a declared decimal comparison keeps a newer string-versioned record when an older one arrives after it", () => {
    const { operations } = compile(schema, [`query NoteList { Notes { Body Revision } }`], { versions: { Note: { field: "Revision", compare: "decimal" } } })
    const list = operations.NoteList!
    const store = new Store()
    const notified = vi.fn()
    const write = (revision: string, body: string) => {
      normalize(store, list.normalization, { Notes: [{ __typename: "Note", Id: "n1", Body: body, Revision: revision }] }, contextOf(list, {}))
      store.publish()
    }
    const id = encodeNodeId("Note", ["n1"])
    write("10", "ten")
    store.subscribe(store.lookup({ id: ROOT_ID, selections: list.selections, variables: {}, fragments: {} }), notified)
    // As text "9" sorts after "10"; as an integer it's older.
    write("9", "nine")
    expect(store.get(id)?.fields.get("Body")).toBe("ten")
    expect(notified).not.toHaveBeenCalled()
    // Past 2^53, where a JavaScript number can't tell them apart.
    write("9007199254740993", "newer")
    write("9007199254740992", "older")
    expect(store.get(id)?.fields.get("Body")).toBe("newer")
    expect(store.get(id)?.fields.get("Revision")).toBe("9007199254740993")
    expect(notified).toHaveBeenCalledTimes(1)
    // A value that isn't a decimal integer can't be ordered, so the last write wins.
    write("n/a", "unordered")
    expect(store.get(id)?.fields.get("Body")).toBe("unordered")
  })
})

describe("a server NodeId", () => {
  it("is used only when it names the object's own type", () => {
    const keys = { Ticket: ["Id"], Note: ["Id"] }
    const own = encodeNodeId("Ticket", ["t1"])
    expect(identify({ __typename: "Ticket", NodeId: own, Id: "t1" }, keys)).toBe(own)
    // A NodeId naming another type is ignored, and the object's own key fields identify it.
    expect(identify({ __typename: "Ticket", NodeId: encodeNodeId("Note", ["n1"]), Id: "t1" }, keys)).toBe(own)
    // Without key fields to fall back to, it has no identity of its own.
    expect(identify({ __typename: "Ticket", NodeId: encodeNodeId("Note", ["n1"]) }, keys)).toBeNull()
  })

  it("can't make a response object overwrite another type's record", () => {
    const { operations } = compile(schema, [`query NoteList { Notes { Body } }`, `query One($Id: ID!) { Ticket(Id: $Id) { Title } }`])
    const store = new Store()
    normalize(store, operations.NoteList!.normalization, { Notes: [{ __typename: "Note", Id: "n1", Body: "kept" }] }, contextOf(operations.NoteList!, {}))
    const noteId = encodeNodeId("Note", ["n1"])
    normalize(store, operations.One!.normalization, { Ticket: { __typename: "Ticket", NodeId: noteId, Id: "t1", Title: "other", RecordVersion: 1 } }, contextOf(operations.One!, { Id: "t1" }))
    expect(store.get(noteId)?.__typename).toBe("Note")
    expect(store.get(noteId)?.fields.get("Body")).toBe("kept")
    expect(store.get(noteId)?.fields.has("Title")).toBe(false)
    expect(store.get(encodeNodeId("Ticket", ["t1"]))?.fields.get("Title")).toBe("other")
  })
})
