import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  input WhereInput { Name: String }
  input WidgetKeyInput { Id: ID! }
  input PageInput { Limit: Int Offset: Int }
  input CursorInput { limit: Int after: String }
  type Widget { NodeId: ID! Id: ID! Name: String! RecordVersion: Int! Children: [Widget!]! }
  type PageInfo { TotalCount: Int! HasNextPage: Boolean! HasPreviousPage: Boolean! EndCursor: String }
  type Edge { Node: Widget! Cursor: String! }
  type Result { Edges: [Edge!]! PageInfo: PageInfo! }
  type Query { Widgets(Page: PageInput, Where: WhereInput): Result! Scroll(Page: CursorInput): Result! Rows: [Widget!]! Widget: Widget }
  type Subscription { WidgetChanged(Keys: [WidgetKeyInput!]): Event! }
  type Event { Action: String! Widget: Widget }
`)
const sources = [
  `fragment Row on Widget @live { Name RecordVersion }`,
  `query List($Page: PageInput, $Where: WhereInput) { Widgets(Page: $Page, Where: $Where) { Edges { Node { ...Row } } PageInfo { TotalCount } } }`,
  `query Count { Widgets { PageInfo { TotalCount } } }`,
  `query Paged($Page: PageInput) { Widgets(Page: $Page) @paged { Edges { Node { ...Row } } } }`,
  `query Offset($Page: PageInput) { Widgets(Page: $Page) @connection(key: "scroll") { Edges { Node { ...Row } } PageInfo { TotalCount } } }`,
  `query Keyset($Page: CursorInput) { Scroll(Page: $Page) @connection(key: "scroll") { Edges { Node { ...Row } } PageInfo { TotalCount } } }`,
  `query Nested { Widget { Children { ...Row } } }`,
  `query Single { Widget { ...Row } }`,
  `query Rows { Rows { ...Row } }`,
]
const compiled = compile(schema, sources)
const row = (id: string, version = 1) => ({ __typename: "Widget", NodeId: encodeNodeId("Widget", [id]), Id: id, Name: id, RecordVersion: version })
function setup(name = "List", options: { listStreams?: boolean; legacy?: boolean; required?: boolean; settleMs?: number | false; maxRereadPages?: number; maxRereadRows?: number } = {}) {
  const clock = createTestClock(), streams = createMockStreams()
  let rows = ["b", "d"], active = true
  const renamed = new Map<string, string>()
  let wait: Promise<void> | undefined
  const network = createMockNetwork({ operations: Object.fromEntries(Object.keys(compiled.operations).map(name => [name, async (_variables: any, request: any) => {
    await wait
    const matching = rows.filter(id => (renamed.get(id) ?? id) !== request.variables.Where?.Name).sort((a,b) => (renamed.get(a) ?? a).localeCompare(renamed.get(b) ?? b))
    const page = request.variables.Page ?? {}, offset = page.Offset ?? (page.after ? matching.indexOf(page.after) + 1 : 0), limit = page.Limit ?? page.limit ?? 2
    const shown = matching.slice(offset, offset + limit)
    const connection = { __typename: "Result", Edges: shown.map(id => ({ __typename: "Edge", Cursor: id, Node: { ...row(id), Name: renamed.get(id) ?? id } })), PageInfo: { __typename: "PageInfo", TotalCount: matching.length, HasNextPage: offset + shown.length < matching.length, HasPreviousPage: offset > 0, EndCursor: shown.at(-1) ?? null } }
    return { data: { Widgets: connection, Scroll: connection, Rows: rows.map(id => row(id)), Widget: row("single") } }
  }])) })
  const live = options.required ? { Widget: { ...compiled.live.Widget!, keyOptional: false } } : compiled.live
  const client = createClient({ network, store: { ...clock.store, retainMs: 10 }, polling: { ...clock.polling, isActive: () => active }, live: { ...clock.live, artifacts: live, subscribe: streams.subscribe, connection: { state: () => "connected", subscribe: (listener) => streams.onReconnect(() => listener({ reconnected: true })) }, debounceMs: 0, resyncJitterMs: 0, settleMs: false, ...options, onDiagnostic: null } })
  const artifact = options.legacy ? { ...compiled.operations[name]!, lists: undefined } : compiled.operations[name]!
  const query = client.watchQuery<any>(artifact, { Where: { Name: "outside" }, Page: name === "Keyset" ? { limit: 2 } : { Limit: 2, Offset: name === "Paged" ? 4 : 0 } })
  const open = async () => { query.open(); await clock.tick() }
  const emit = (id = "unheld", action: "UPDATED" | "CREATED" | "DELETED" = "UPDATED", version = 1) => streams.one("LiveWidget").emit(row(id, version), { action })
  return { client, clock, streams, network, query, open, emit, rename: (id: string, name: string) => renamed.set(id,name), rows: (value: string[]) => { rows = value }, active: (value: boolean) => { active = value }, wait: (value: typeof wait) => { wait = value }, ids: () => query.getState().data?.[name === "Keyset" ? "Scroll" : "Widgets"].Edges.map((e: any) => e.Node.__id ?? e.Node) }
}

describe("R3 list streams", () => {
  it("derives root, nested and count-only list types from the schema", () => {
    for (const name of ["List", "Count", "Nested", "Rows"]) expect(compiled.operations[name]!.lists).toEqual(["Widget"])
    expect(compiled.operations.Single!.lists).toEqual([])
    const countOnly = compile(schema, [sources[2]!])
    expect(countOnly.operations.Count!.lists).toEqual(["Widget"])
    expect(countOnly.live.Widget).toBeDefined()
  })
  it("opens before the read, sees the first row, filter entry/exit, sorting and totals without polling", async () => {
    const c = setup(); c.rows([]); c.query.open()
    expect(c.streams.one("LiveWidget").request.variables).toEqual({})
    await c.clock.tick(); expect(c.client.liveTypeHealth("Widget").state).toBe("unconfirmed")
    c.rows(["b", "a"]); c.emit("a"); await c.clock.tick()
    expect(c.query.getState().data.Widgets.Edges).toHaveLength(2)
    expect(c.query.getState().data.Widgets.PageInfo.TotalCount).toBe(2)
    expect(c.query.getState().data.Widgets.Edges.map((e: any) => readFragment<{ Name: string }>(compiled.fragments.Row!, e.Node).Name)).toEqual(["a", "b"])
    c.rename("a", "outside"); c.emit("a"); await c.clock.tick(2000)
    expect(c.query.getState().data.Widgets.Edges).toHaveLength(1)
    expect(c.query.getState().data.Widgets.PageInfo.TotalCount).toBe(1)
    c.rename("a", "a"); c.emit("a"); await c.clock.tick(2000)
    expect(c.query.getState().data.Widgets.PageInfo.TotalCount).toBe(2)
    expect(c.client.liveTypeHealth("Widget").pollMs).toBeNull()
    c.client.dispose()
  })
  it("100 unheld events cause exactly two reads, never store unheld rows, and skip unrelated queries", async () => {
    const c = setup(); await c.open()
    const single = c.client.watchQuery(compiled.operations.Single!, {}); single.open(); await c.clock.tick()
    const before = c.network.requests.length
    for (let i = 0; i < 100; i++) { c.emit(); await c.clock.tick(10) }
    await c.clock.tick(1000)
    expect(c.network.requests.length - before).toBe(2)
    expect(c.client.store.get(encodeNodeId("Widget", ["unheld"]))).toBeUndefined()
    c.client.dispose()
  })
  it("pauses reads while inactive, catches up once and refreshes after reconnect and continuity loss", async () => {
    const c = setup(); await c.open(); c.active(false); c.emit(); await c.clock.tick(3000)
    expect(c.network.requests).toHaveLength(1)
    c.active(true); await c.clock.tick(1000); expect(c.network.requests).toHaveLength(2)
    c.streams.one("LiveWidget").loseContinuity(); await c.clock.tick(2000)
    expect(c.network.requests).toHaveLength(3)
    c.streams.reconnect(); await c.clock.tick(2000); expect(c.network.requests).toHaveLength(4); c.client.dispose()
  })
  it.each(["Count", "Paged"])("refreshes %s and preserves the shown offset", async name => {
    const c = setup(name); c.rows(["a", "b", "c", "d", "e", "f"]); await c.open(); c.emit(); await c.clock.tick()
    expect(c.network.requests.at(-1)!.variables.Page).toMatchObject({ Offset: name === "Paged" ? 4 : 0 })
    expect(c.query.getState().data.Widgets.PageInfo.TotalCount).toBe(6); c.client.dispose()
  })
  it.each(["Offset", "Keyset"])("refreshes all three loaded %s pages and serializes load-more", async name => {
    const c = setup(name); c.rows(["a", "b", "c", "d", "e", "f", "g"]); await c.open(); await c.query.loadMore(); await c.query.loadMore()
    expect(c.query.getState().data[name === "Keyset" ? "Scroll" : "Widgets"].Edges).toHaveLength(6)
    c.rows(["0", "a", "b", "c", "d", "e", "f", "g"])
    let done!: () => void; c.wait(new Promise<void>(r => { done = r }))
    const more = c.query.loadMore(); c.emit(); c.wait(undefined); done(); await more; await c.clock.tick()
    const edges = c.query.getState().data[name === "Keyset" ? "Scroll" : "Widgets"].Edges
    expect(edges).toHaveLength(8); expect(new Set(edges.map((e: any) => JSON.stringify(e.Node))).size).toBe(8)
    c.client.dispose()
  })
  it("reports a bounded keyset refresh and preserves its loaded tail", async () => {
    const c = setup("Keyset", { maxRereadPages: 1 }); c.rows(["a", "b", "c", "d", "e", "f"]); await c.open(); await c.query.loadMore(); await c.query.loadMore()
    c.emit(); await c.clock.tick(); expect(c.query.getState().listRefreshTruncated).toBe(true)
    expect(c.client.liveTypeHealth("Widget").reason).toBe("list-refresh-truncated")
    expect(c.query.getState().data.Scroll.Edges).toHaveLength(6); c.client.dispose()
  })
  it.each(["list-streams-disabled", "list-key-required"])("polls and names the operation for %s", async reason => {
    const c = setup("Count", reason === "list-streams-disabled" ? { listStreams: false } : { required: true }); await c.open()
    expect(c.streams.open.size).toBe(0); const health = c.client.liveTypeHealth("Widget")
    expect(health.reason).toBe(reason); expect(health.state).toBe("polling"); expect(health.fragments).toContain("Count"); c.client.dispose()
  })
  it("keeps old artifacts narrowed and confirms only a newly established list stream", async () => {
    const old = setup("List", { legacy: true }); await old.open(); expect(old.streams.one("LiveWidget").request.variables).toHaveProperty("Keys"); old.client.dispose()
    const c = setup("List", { settleMs: 250 }); await c.open(); await c.clock.tick(250); expect(c.network.requests).toHaveLength(2)
    const other = c.client.watchQuery(compiled.operations.Count!, {}); other.open(); await c.clock.tick(500)
    expect(c.network.requests).toHaveLength(3); c.client.dispose()
  })
  it("overlaps narrowed and whole-type coverage in both directions", async () => {
    const c = setup("Single", { settleMs: 50 }); await c.open(); await c.clock.tick(100)
    expect(c.streams.one("LiveWidget").request.variables).toHaveProperty("Keys")
    const list = c.client.watchQuery(compiled.operations.List!, { Page: { Limit: 2 } })
    list.open(); expect(c.streams.open.size).toBe(2)
    await c.clock.tick(100); expect(c.streams.one("LiveWidget").request.variables).toEqual({})
    list.close(); expect(c.streams.open.size).toBe(2)
    await c.clock.tick(100); expect(c.streams.one("LiveWidget").request.variables).toHaveProperty("Keys")
    c.client.dispose()
  })
  it("replaces a loaded keyset range that starts after an explicit cursor", async () => {
    const c = setup("Count"); c.rows(["a", "b", "c", "d", "e", "f"])
    const query = c.client.watchQuery<any>(compiled.operations.Keyset!, { Page: { limit: 2, after: "b" } })
    query.open(); await c.clock.tick(); await query.loadMore(); c.emit(); await c.clock.tick()
    expect(query.getState().data.Scroll.Edges.map((edge: any) => readFragment<{ Name: string }>(compiled.fragments.Row!, edge.Node).Name)).toEqual(["c", "d", "e", "f"])
    c.client.dispose()
  })
  it("bounds offset refresh to one request and keeps a flagged tail", async () => {
    const c = setup("Offset", { maxRereadRows: 2 }); c.rows(["a", "b", "c", "d", "e", "f"])
    await c.open(); await c.query.loadMore(); await c.query.loadMore()
    const before = c.network.requests.length; c.emit(); await c.clock.tick()
    expect(c.network.requests.length - before).toBe(1)
    expect(c.query.getState().listRefreshTruncated).toBe(true)
    expect(c.query.getState().data.Widgets.Edges).toHaveLength(6); c.client.dispose()
  })
  it("drops an identity's in-flight list response and pending invalidations", async () => {
    const c = setup(); await c.open()
    let done!: () => void; c.wait(new Promise<void>(r => { done = r }))
    c.emit(); c.emit(); c.client.dispose(); c.wait(undefined); done(); await c.clock.tick(3000)
    expect(c.streams.open.size).toBe(0)
    expect(c.client.store.get(encodeNodeId("Widget", ["b"]))).toBeUndefined()
  })
  it("rejects old versions, deletes held rows, cancels identity work and garbage collects on release", async () => {
    const c = setup(); await c.open(); c.emit("b", "UPDATED", 3); c.emit("b", "UPDATED", 2)
    expect(c.client.store.get(encodeNodeId("Widget", ["b"]))?.fields.get("RecordVersion")).toBe(3)
    c.rows(["d"]); c.emit("b", "DELETED"); await c.clock.tick(2000)
    expect(c.client.store.get(encodeNodeId("Widget", ["b"]))).toBeUndefined()
    c.query.close(); await c.clock.tick(20); expect(c.streams.open.size).toBe(0)
    expect(c.client.store.get(encodeNodeId("Widget", ["d"]))).toBeUndefined()
    c.client.dispose(); expect(c.client.store.get(encodeNodeId("Widget", ["d"]))).toBeUndefined()
  })
})
