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
const frags = compiled.fragments
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
    // A count selects no fragment, and stays current because the project made the type live.
    const countOnly = compile(schema, [sources[0]!, sources[2]!])
    expect(countOnly.operations.Count!.lists).toEqual(["Widget"])
    expect(countOnly.live.Widget).toBeDefined()
  })

  it("a list of a type the project hasn't made live opens no stream", () => {
    const result = compile(schema, [sources[2]!, `fragment Plain on Widget { Name }`, `query Plain { Rows { ...Plain } }`])
    expect(result.operations.Count!.lists).toEqual([])
    expect(result.operations.Plain!.lists).toEqual([])
    expect(result.live).toEqual({})
  })

  it("a list reopening in the same tick keeps its stream", async () => {
    const c = setup(); await c.open(); await c.clock.tick(250)
    const stream = c.streams.one("LiveWidget")
    c.query.close(); c.query.open(); await c.clock.tick(100)
    expect(stream.closed).toBe(false)
    expect(c.streams.find("LiveWidget")).toHaveLength(1)
    c.client.dispose()
  })

  it("a query closed while load-more is running doesn't read afterwards", async () => {
    const c = setup("Keyset"); c.rows(["a", "b", "c", "d"]); await c.open(); await c.clock.tick(250)
    const loading = c.query.loadMore()
    const reads = c.network.requests.length
    const refetch = c.query.refetch()
    c.query.close()
    await loading; await refetch; await c.clock.tick(100)
    expect(c.network.requests.length).toBe(reads)
    c.client.dispose()
  })

  it("a row seen twice while reading a loaded range is shown once", async () => {
    const page = (ids: string[], more: boolean) => ({ data: { Scroll: { __typename: "Result", Edges: ids.map((id) => ({ __typename: "Edge", Cursor: id, Node: row(id) })), PageInfo: { __typename: "PageInfo", TotalCount: 4, HasNextPage: more, HasPreviousPage: false, EndCursor: ids.at(-1) } } } })
    // Two pages load; then a row created at the head during the re-read pushes b onto the second page as well.
    const answers = [page(["a", "b"], true), page(["c", "d"], false), page(["a", "b"], true), page(["b", "c"], true), page(["d"], false)]
    const clock = createTestClock(), streams = createMockStreams()
    const network = createMockNetwork({ respond: () => answers.shift()! })
    const client = createClient({ network, store: clock.store, polling: clock.polling, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, onDiagnostic: null } })
    const query = client.watchQuery<any>(compiled.operations.Keyset!, { Page: { limit: 2 } })
    query.open()
    await clock.tick()
    await query.loadMore()
    await query.refetch()
    const names = query.getState().data.Scroll.Edges.map((edge: any) => readFragment<{ Name: string }>(frags.Row!, edge.Node).Name)
    expect(names).toEqual(["a", "b", "c", "d"])
    client.dispose()
  })
  it("a page with room keeps its rows when one is created above them", async () => {
    // The page asks for 50 and holds 2. A re-read must ask for the page, not only for what's loaded, or the new row pushes one out.
    let rows = ["b", "d"]
    const limits: unknown[] = []
    const clock = createTestClock(), streams = createMockStreams()
    const network = createMockNetwork({ respond: (request) => {
      const page = request.variables.Page as { Limit: number; Offset?: number }
      limits.push(page.Limit)
      const shown = rows.slice(page.Offset ?? 0, (page.Offset ?? 0) + page.Limit)
      return { data: { Widgets: { __typename: "Result", Edges: shown.map((id) => ({ __typename: "Edge", Cursor: id, Node: row(id) })), PageInfo: { __typename: "PageInfo", TotalCount: rows.length, HasNextPage: (page.Offset ?? 0) + page.Limit < rows.length, HasPreviousPage: false, EndCursor: shown.at(-1) ?? null } } } }
    } })
    const client = createClient({ network, store: clock.store, polling: clock.polling, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, onDiagnostic: null } })
    const query = client.watchQuery<any>(compiled.operations.Offset!, { Page: { Limit: 50, Offset: 0 } })
    query.open()
    await clock.tick()
    rows = ["a", "b", "d"]
    streams.one("LiveWidget").emit(row("a"), { action: "CREATED" })
    await clock.tick(2000)
    const names = query.getState().data.Widgets.Edges.map((edge: any) => readFragment<{ Name: string }>(frags.Row!, edge.Node).Name)
    expect(names).toEqual(["a", "b", "d"])
    expect(limits.every((limit) => limit === 50)).toBe(true)
    client.dispose()
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
  it("100 unheld events coalesce list repair and add one burst read for a record holder, without storing unheld rows", async () => {
    const c = setup(); await c.open()
    const single = c.client.watchQuery(compiled.operations.Single!, {}); single.open(); await c.clock.tick()
    const before = c.network.requests.length
    for (let i = 0; i < 100; i++) { c.emit(); await c.clock.tick(10) }
    await c.clock.tick(1000)
    const requests = c.network.requests.slice(before)
    expect(requests.filter(request => request.name === "List")).toHaveLength(2) // burst joins the pending R3 read
    expect(requests.filter(request => request.name === "Single")).toHaveLength(1) // a holder of the same type, repaired only by burst
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
    const c = setup("Keyset", { maxRereadPages: 1, maxRereadRows: 2 }); c.rows(["a", "b", "c", "d", "e", "f"]); await c.open(); await c.query.loadMore(); await c.query.loadMore()
    c.emit(); await c.clock.tick(); expect(c.query.getState().listRefreshTruncated).toBe(true)
    expect(c.client.liveTypeHealth("Widget").reason).toBe("list-refresh-truncated")
    expect(c.query.getState().data.Scroll.Edges).toHaveLength(6); c.client.dispose()
  })
  it("refreshes three loaded keyset pages in one request", async () => {
    const c = setup("Keyset"); c.rows(["a", "b", "c", "d", "e", "f", "g"]); await c.open(); await c.query.loadMore(); await c.query.loadMore()
    const before = c.network.requests.length; c.emit(); await c.clock.tick()
    expect(c.network.requests.slice(before).map(r => r.variables.Page)).toEqual([{ limit: 6 }])
    expect(c.query.getState().listRefreshTruncated).toBe(false)
    expect(c.ids()).toHaveLength(6); expect(c.query.getState().data.Scroll.Edges.map((e: any) => readFragment<{ Name: string }>(frags.Row!, e.Node).Name)).toEqual(["a", "b", "c", "d", "e", "f"])
    // Load more continues after the refreshed range with the query's own page size.
    await c.query.loadMore(); expect(c.network.requests.at(-1)!.variables.Page).toEqual({ limit: 2, after: "f" }); expect(c.ids()).toHaveLength(7)
    c.client.dispose()
  })
  it("a partly filled last keyset page costs one request, and a new row fills its room", async () => {
    const c = setup("Keyset"); c.rows(["a", "b", "c", "d", "e"]); await c.open(); await c.query.loadMore(); await c.query.loadMore()
    expect(c.query.getState().hasMore).toBe(false)
    c.rows(["a", "b", "c", "d", "e", "f"])
    for (let poll = 0; poll < 3; poll++) {
      const before = c.network.requests.length; c.emit(); await c.clock.tick(2000)
      expect(c.network.requests.length - before).toBe(1)
    }
    expect(c.ids()).toHaveLength(6); expect(c.query.getState().listRefreshTruncated).toBe(false); c.client.dispose()
  })
  it("reads the rest of a keyset range in requests of maxRereadRows, asking only for what's missing", async () => {
    const c = setup("Keyset", { maxRereadRows: 4 }); c.rows(["a", "b", "c", "d", "e", "f", "g"]); await c.open(); await c.query.loadMore(); await c.query.loadMore()
    const before = c.network.requests.length; c.emit(); await c.clock.tick()
    expect(c.network.requests.slice(before).map(r => r.variables.Page)).toEqual([{ limit: 4 }, { limit: 2, after: "d" }])
    expect(c.ids()).toHaveLength(6); expect(c.query.getState().listRefreshTruncated).toBe(false); c.client.dispose()
  })
  it("a keyset refresh after a reconnect reads the loaded range once, with newer versions kept", async () => {
    const c = setup("Keyset"); c.rows(["a", "b", "c", "d"]); await c.open(); await c.query.loadMore()
    c.emit("a", "UPDATED", 5)
    expect(c.client.store.get(encodeNodeId("Widget", ["a"]))?.fields.get("RecordVersion")).toBe(5)
    const before = c.network.requests.length; c.streams.reconnect(); await c.clock.tick(2000)
    expect(c.network.requests.slice(before).filter(r => r.name === "Keyset").map(r => r.variables.Page)).toEqual([{ limit: 4 }])
    // The server's copy is version 1; the event's version 5 stays.
    expect(c.client.store.get(encodeNodeId("Widget", ["a"]))?.fields.get("RecordVersion")).toBe(5)
    expect(c.ids()).toHaveLength(4); c.client.dispose()
  })
  it("drops a keyset continuation in flight when the identity is disposed, and collects its rows on release", async () => {
    const c = setup("Keyset", { maxRereadRows: 2 }); c.rows(["a", "b", "c", "d"]); await c.open(); await c.query.loadMore()
    let done!: () => void; c.wait(new Promise<void>(r => { done = r }))
    const before = c.network.requests.length; c.emit(); await c.clock.tick(0)
    expect(c.network.requests.slice(before).map(r => r.variables.Page)).toEqual([{ limit: 2 }])
    c.client.dispose(); c.wait(undefined); done(); await c.clock.tick(3000)
    // The first page's answer arrives after disposal: no continuation is sent and nothing is written.
    expect(c.network.requests.length - before).toBe(1)
    expect(c.client.store.get(encodeNodeId("Widget", ["a"]))).toBeUndefined()
    const d = setup("Keyset"); d.rows(["a", "b", "c", "d"]); await d.open(); await d.query.loadMore(); d.emit(); await d.clock.tick()
    d.query.close(); await d.clock.tick(20)
    expect(d.client.store.get(encodeNodeId("Widget", ["c"]))).toBeUndefined(); d.client.dispose()
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
    list.close(); c.client.live!.flush(); expect(c.streams.open.size).toBe(2)
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
