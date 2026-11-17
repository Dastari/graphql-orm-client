import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient, readFragment, type ClientOptions, type GraphQLErrorLike } from "../src/client.js"
import type { LiveDiagnostic } from "../src/health.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

// A query with two @connection lists, and keyset cursors the server can refuse.
const schema = buildSchema(`
  input CursorInput { limit: Int after: String }
  input PageInput { Limit: Int Offset: Int }
  input WidgetKeyInput { Id: ID! }
  type Widget { NodeId: ID! Id: ID! Name: String! RecordVersion: Int! }
  type PageInfo { TotalCount: Int! HasNextPage: Boolean! HasPreviousPage: Boolean! EndCursor: String }
  type Edge { Node: Widget! Cursor: String! }
  type Result { Edges: [Edge!]! PageInfo: PageInfo! }
  type Owner { Id: ID! Children(Page: CursorInput): Result! }
  type Query { Open(Page: CursorInput): Result! Closed(Page: CursorInput): Result! Recent(Page: PageInput): Result! Older(Page: PageInput): Result! Owner: Owner }
  type Subscription { WidgetChanged(Keys: [WidgetKeyInput!]): Event! }
  type Event { Action: String! Widget: Widget }
`)
const compiled = compile(schema, [
  `fragment Row on Widget @live { Name RecordVersion }`,
  `query Two($OpenPage: CursorInput, $ClosedPage: CursorInput) {
    Open(Page: $OpenPage) @connection(key: "open") { Edges { Node { ...Row } } }
    Closed(Page: $ClosedPage) @connection(key: "closed") { Edges { Node { ...Row } } }
  }`,
  `query Mixed($OpenPage: CursorInput, $RecentPage: PageInput) {
    Open(Page: $OpenPage) @connection(key: "open") { Edges { Node { ...Row } } }
    Recent(Page: $RecentPage) @connection(key: "recent") { Edges { Node { ...Row } } }
  }`,
  `query Shared($Page: CursorInput) {
    Open(Page: $Page) @connection(key: "open") { Edges { Node { ...Row } } }
    Closed(Page: $Page) @connection(key: "closed") { Edges { Node { ...Row } } }
  }`,
  `query One($Page: CursorInput) { Open(Page: $Page) @connection(key: "open") { Edges { Node { ...Row } } } }`,
  `query SharedOffset($Page: PageInput) {
    Recent(Page: $Page) @connection(key: "recent") { Edges { Node { ...Row } } }
    Older(Page: $Page) @connection(key: "older") { Edges { Node { ...Row } } }
  }`,
  `query Owned($Page: CursorInput, $ClosedPage: CursorInput) {
    Owner { Id Children(Page: $Page) @connection(key: "children") { Edges { Node { ...Row } } } }
    Closed(Page: $ClosedPage) @connection(key: "closed") { Edges { Node { ...Row } } }
  }`,
])
const row = (id: string, version = 1) => ({ __typename: "Widget", NodeId: encodeNodeId("Widget", [id]), Id: id, Name: id, RecordVersion: version })
const cursorInvalid = [{ message: "invalid cursor", path: ["Open"], extensions: { code: "CURSOR_INVALID" } }]

type Refusal = (root: string, page: Record<string, unknown>) => readonly GraphQLErrorLike[] | null

/** A server with `Open`, `Closed` and `Recent` lists, two rows a page unless asked otherwise. */
function setup(options: { live?: Partial<NonNullable<ClientOptions["live"]>>; connections?: ClientOptions["connections"] } = {}) {
  const clock = createTestClock(), streams = createMockStreams()
  const lists: Record<string, string[]> = { Open: ["a", "b", "c", "d", "e", "f"], Closed: ["p", "q", "r", "s", "t", "u"], Recent: ["x1", "x2", "x3", "x4", "x5"], Older: ["y1", "y2", "y3", "y4", "y5"], Owner: ["k1", "k2", "k3", "k4"] }
  let owner = true
  const versions = new Map<string, number>()
  let refuse: Refusal = () => null
  const variableOf: Record<string, Record<string, string>> = {
    Two: { Open: "OpenPage", Closed: "ClosedPage" },
    Mixed: { Open: "OpenPage", Recent: "RecentPage" },
    Shared: { Open: "Page", Closed: "Page" },
    One: { Open: "Page" },
    SharedOffset: { Recent: "Page", Older: "Page" },
    Owned: { Owner: "Page", Closed: "ClosedPage" },
  }
  const network = createMockNetwork({
    respond: (request) => {
      const data: Record<string, unknown> = {}
      const errors: GraphQLErrorLike[] = []
      for (const [root, variable] of Object.entries(variableOf[request.name]!)) {
        const page = (request.variables[variable] as Record<string, unknown> | undefined) ?? {}
        const refused = refuse(root, page)
        if (refused) {
          errors.push(...refused)
          // Owner is nullable: its error nulls it, and the rest of the response keeps its data.
          if (root === "Owner") data.Owner = null
          continue
        }
        if (root === "Owner" && !owner) {
          data.Owner = null
          continue
        }
        const ids = lists[root]!
        const after = page.after as string | undefined
        const offset = (page.Offset as number | undefined) ?? (after ? ids.indexOf(after) + 1 : 0)
        const limit = (page.Limit as number | undefined) ?? (page.limit as number | undefined) ?? 2
        const shown = ids.slice(offset, offset + limit)
        const connection = { __typename: "Result", Edges: shown.map((id) => ({ __typename: "Edge", Cursor: id, Node: row(id, versions.get(id) ?? 1) })), PageInfo: { __typename: "PageInfo", TotalCount: ids.length, HasNextPage: offset + shown.length < ids.length, HasPreviousPage: offset > 0, EndCursor: shown.at(-1) ?? null } }
        data[root] = root === "Owner" ? { __typename: "Owner", Id: "o", Children: connection } : connection
      }
      // A refused non-null root has no data in the whole response, as graphql-orm answers.
      if (errors.length && !("Owner" in data)) return { data: null, errors }
      return errors.length ? { data, errors } : { data }
    },
  })
  const diagnostics: LiveDiagnostic[] = []
  const client = createClient({
    network,
    store: { ...clock.store, retainMs: 10 },
    polling: clock.polling,
    ...(options.connections ? { connections: options.connections } : {}),
    live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, connection: { state: () => "connected", subscribe: (listener) => streams.onReconnect(() => listener({ reconnected: true })) }, debounceMs: 0, resyncJitterMs: 0, settleMs: false, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic), ...options.live },
  })
  const names = (data: any, root: string): string[] => data?.[root]?.Edges.map((edge: any) => readFragment<{ Name: string }>(compiled.fragments.Row!, edge.Node).Name)
  const pages = (name: string, variable: string) => network.requests.filter((request) => request.name === name).map((request) => request.variables[variable])
  return { client, clock, streams, network, lists, versions, diagnostics, names, pages, refuse: (next: Refusal) => { refuse = next }, owner: (value: boolean) => { owner = value } }
}

describe("several @connection lists in one query", () => {
  it("loads more of each by its key, and reports each one's state", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    expect(query.getState().connections).toEqual({
      open: { hasMore: true, loadingMore: false, listRefreshTruncated: false, restarts: 0 },
      closed: { hasMore: true, loadingMore: false, listRefreshTruncated: false, restarts: 0 },
    })
    const loading = query.loadMore({ connection: "closed" })
    expect(query.getState()).toMatchObject({ loadingMore: true, connections: { closed: { loadingMore: true }, open: { loadingMore: false } } })
    await loading
    expect(c.network.requests.at(-1)!.variables).toEqual({ OpenPage: { limit: 2 }, ClosedPage: { limit: 2, after: "q" } })
    expect(c.names(query.getState().data, "Closed")).toEqual(["p", "q", "r", "s"])
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b"])
    await query.loadMore({ connection: "closed" })
    expect(c.names(query.getState().data, "Closed")).toEqual(["p", "q", "r", "s", "t", "u"])
    expect(query.getState().connections!.closed!.hasMore).toBe(false)
    // The first list's flags stay at the top level, as for a query with one list.
    expect(query.getState().hasMore).toBe(true)
    await query.loadMore()
    expect(c.network.requests.at(-1)!.variables).toEqual({ OpenPage: { limit: 2, after: "b" }, ClosedPage: { limit: 2 } })
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d"])
    // Loading one list read the other's first page again; the rows it had loaded stay.
    expect(c.names(query.getState().data, "Closed")).toEqual(["p", "q", "r", "s", "t", "u"])
    c.client.dispose()
  })

  it("loads one list after another when both are asked for at once, and the same list once", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    const before = c.network.requests.length
    await Promise.all([query.loadMore({ connection: "open" }), query.loadMore({ connection: "open" }), query.loadMore({ connection: "closed" })])
    expect(c.network.requests.slice(before).map((request) => request.variables)).toEqual([
      { OpenPage: { limit: 2, after: "b" }, ClosedPage: { limit: 2 } },
      { OpenPage: { limit: 2 }, ClosedPage: { limit: 2, after: "q" } },
    ])
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d"])
    expect(c.names(query.getState().data, "Closed")).toEqual(["p", "q", "r", "s"])
    c.client.dispose()
  })

  it("rejects a key the query doesn't have, and keyset lists that share a paging variable", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    await expect(query.loadMore({ connection: "archived" })).rejects.toThrow(/no @connection with key "archived"/)
    await expect(query.restart({ connection: "archived" })).rejects.toThrow(/no @connection with key "archived"/)
    const shared = c.client.watchQuery<any>(compiled.operations.Shared!, { Page: { limit: 2 } })
    shared.open(); await c.clock.tick()
    const before = c.network.requests.length
    await expect(shared.loadMore()).rejects.toThrow(/shares its paging variable \$Page with "closed"/)
    await expect(shared.loadMore({ connection: "closed" })).rejects.toThrow(/shares its paging variable/)
    expect(c.network.requests.length).toBe(before)
    c.client.dispose()
  })

  it("offset lists sharing one paging variable load more together, as they always have", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.SharedOffset!, { Page: { Limit: 2 } })
    query.open(); await c.clock.tick()
    await query.loadMore()
    expect(c.network.requests.at(-1)!.variables).toEqual({ Page: { Limit: 2, Offset: 2 } })
    expect(c.names(query.getState().data, "Recent")).toEqual(["x1", "x2", "x3", "x4"])
    expect(c.names(query.getState().data, "Older")).toEqual(["y1", "y2", "y3", "y4"])
    expect(query.getState().error).toBeNull()
    c.client.dispose()
  })

  it("loadMore() and hasMore both mean the first stored list", async () => {
    const c = setup()
    c.owner(false)
    const query = c.client.watchQuery<any>(compiled.operations.Owned!, { Page: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    // The first declared list is under a null Owner; the first stored one is "closed".
    expect(query.getState().hasMore).toBe(true)
    await query.loadMore()
    expect(c.network.requests.at(-1)!.variables).toEqual({ Page: { limit: 2 }, ClosedPage: { limit: 2, after: "q" } })
    expect(c.names(query.getState().data, "Closed")).toEqual(["p", "q", "r", "s"])
    c.client.dispose()
  })

  it("a live refresh reads each loaded range again, in order, in one request", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    await query.loadMore({ connection: "closed" }); await query.loadMore({ connection: "closed" })
    await query.loadMore({ connection: "open" })
    // A row created at the head of the second list, and one moved within it.
    c.lists.Closed = ["n", "p", "r", "q", "s", "t", "u"]
    const before = c.network.requests.length
    c.streams.one("LiveWidget").emit(row("n"), { action: "CREATED" }); await c.clock.tick()
    expect(c.network.requests.slice(before).map((request) => request.variables)).toEqual([{ OpenPage: { limit: 4 }, ClosedPage: { limit: 6 } }])
    expect(c.names(query.getState().data, "Closed")).toEqual(["n", "p", "r", "q", "s", "t"])
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d"])
    expect(query.getState().connections!.closed!.hasMore).toBe(true)
    // Load more of the second list continues after its refreshed range.
    await query.loadMore({ connection: "closed" })
    expect(c.network.requests.at(-1)!.variables).toEqual({ OpenPage: { limit: 2 }, ClosedPage: { limit: 2, after: "t" } })
    c.client.dispose()
  })

  it("follows the second list's cursor alone past the bound, and flags only the list it couldn't finish", async () => {
    const c = setup({ live: { maxRereadRows: 2, maxRereadPages: 2 } })
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    await query.loadMore({ connection: "closed" }); await query.loadMore({ connection: "closed" })
    await query.loadMore({ connection: "open" })
    const before = c.network.requests.length
    c.streams.one("LiveWidget").emit(row("x"), { action: "CREATED" }); await c.clock.tick()
    expect(c.network.requests.slice(before).map((request) => request.variables)).toEqual([
      { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } },
      { OpenPage: { limit: 2, after: "b" }, ClosedPage: { limit: 2 } },
      { OpenPage: { limit: 2 }, ClosedPage: { limit: 2, after: "q" } },
    ])
    expect(query.getState().connections).toMatchObject({ open: { listRefreshTruncated: false }, closed: { listRefreshTruncated: true } })
    expect(query.getState().listRefreshTruncated).toBe(true)
    expect(c.names(query.getState().data, "Closed")).toEqual(["p", "q", "r", "s", "t", "u"])
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d"])
    c.client.dispose()
  })

  it("refreshes an offset list beside a keyset one", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Mixed!, { OpenPage: { limit: 2 }, RecentPage: { Limit: 2 } })
    query.open(); await c.clock.tick()
    await query.loadMore({ connection: "recent" })
    expect(c.network.requests.at(-1)!.variables).toEqual({ OpenPage: { limit: 2 }, RecentPage: { Limit: 2, Offset: 2 } })
    const before = c.network.requests.length
    c.streams.one("LiveWidget").emit(row("x"), { action: "CREATED" }); await c.clock.tick()
    expect(c.network.requests.slice(before).map((request) => request.variables)).toEqual([{ OpenPage: { limit: 2 }, RecentPage: { Limit: 4, Offset: 0 } }])
    expect(c.names(query.getState().data, "Recent")).toEqual(["x1", "x2", "x3", "x4"])
    c.client.dispose()
  })

  it("keeps a newer version of a second-list row against an older refresh, and reads both ranges once after a reconnect", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    await query.loadMore({ connection: "closed" })
    c.streams.one("LiveWidget").emit(row("r", 5), { action: "UPDATED" })
    expect(c.client.store.get(encodeNodeId("Widget", ["r"]))?.fields.get("RecordVersion")).toBe(5)
    const before = c.network.requests.length
    c.streams.reconnect(); await c.clock.tick(2000)
    expect(c.network.requests.slice(before).map((request) => request.variables)).toEqual([{ OpenPage: { limit: 2 }, ClosedPage: { limit: 4 } }])
    // The server's copy is version 1; the event's version 5 stays.
    expect(c.client.store.get(encodeNodeId("Widget", ["r"]))?.fields.get("RecordVersion")).toBe(5)
    expect(c.names(query.getState().data, "Closed")).toEqual(["p", "q", "r", "s"])
    c.client.dispose()
  })

  it("drops a second list's load in flight when the identity is disposed, and collects its rows on release", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    const loading = query.loadMore({ connection: "closed" })
    c.client.dispose(); await loading
    expect(c.client.store.get(encodeNodeId("Widget", ["r"]))).toBeUndefined()

    const d = setup()
    const other = d.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    other.open(); await d.clock.tick(); await other.loadMore({ connection: "closed" })
    expect(d.client.store.get(encodeNodeId("Widget", ["r"]))).toBeDefined()
    other.close(); await d.clock.tick(20)
    expect(d.client.store.get(encodeNodeId("Widget", ["r"]))).toBeUndefined()
    d.client.dispose()
  })
})

describe("a refused cursor", () => {
  const refuseAfter = (cursor: string, code = "CURSOR_INVALID", extra: readonly GraphQLErrorLike[] = []): Refusal => (root, page) =>
    root === "Open" && page.after === cursor ? [{ message: "refused", path: [root], extensions: { code } }, ...extra] : null

  it("starts the list again from its first page, keeping its records and reading the loaded rows and the next page", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.One!, { Page: { limit: 2 } })
    query.open(); await c.clock.tick(); await query.loadMore()
    const before = c.names(query.getState().data, "Open")
    const record = c.client.store.get(encodeNodeId("Widget", ["a"]))
    // A deploy moved the sort keys: the stored end cursor is refused once.
    let refused = 0
    c.refuse((root, page) => (page.after === "d" && refused++ === 0 ? cursorInvalid : null))
    const sent = c.network.requests.length
    await query.loadMore()
    expect(c.network.requests.slice(sent).map((request) => request.variables.Page)).toEqual([{ limit: 2, after: "d" }, { limit: 6 }])
    expect(before).toEqual(["a", "b", "c", "d"])
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d", "e", "f"])
    expect(query.getState()).toMatchObject({ status: "ready", error: null, loadingMore: false, hasMore: false, connections: { open: { restarts: 1 } } })
    expect(c.client.store.get(encodeNodeId("Widget", ["a"]))).toBe(record)
    expect(c.diagnostics.map((diagnostic) => [diagnostic.reason, diagnostic.fragment, diagnostic.typename, diagnostic.code])).toEqual([["cursor-restarted", "One", "Widget", "CURSOR_INVALID"]])
    c.client.dispose()
  })

  it("restarts at most once per cursor, and fails with the original error when the restart is refused too", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.One!, { Page: { limit: 2 } })
    query.open(); await c.clock.tick()
    // A server that refuses every cursor, and the first page too after the first refusal.
    let refusals = 0
    c.refuse((_root, page) => (page.after || refusals > 0 ? (refusals++, [{ message: refusals === 1 ? "first" : "again", path: ["Open"], extensions: { code: "CURSOR_INVALID" } }]) : null))
    const sent = c.network.requests.length
    await query.loadMore()
    expect(c.network.requests.length - sent).toBe(2)
    expect(query.getState().error?.message).toBe("first")
    expect(query.getState().connections!.open!.restarts).toBe(0)
    // The same stored cursor refused again fails at once: no second restart for it.
    const again = c.network.requests.length
    await query.loadMore()
    expect(c.network.requests.length - again).toBe(1)
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b"])
    expect(c.diagnostics).toEqual([])
    c.client.dispose()
  })

  it("is an error when the response also refuses access, or when restarts are turned off", async () => {
    for (const [label, extra, options] of [
      ["access", [{ message: "denied", extensions: { code: "FORBIDDEN" } }], {}],
      ["step-up", [{ message: "step up", extensions: { code: "STEP_UP_REQUIRED" } }], {}],
      ["off", [], { connections: { restartOn: [] } }],
    ] as const) {
      const c = setup(options)
      const query = c.client.watchQuery<any>(compiled.operations.One!, { Page: { limit: 2 } })
      query.open(); await c.clock.tick()
      c.refuse(refuseAfter("b", "CURSOR_INVALID", [...extra]))
      const sent = c.network.requests.length
      await query.loadMore()
      expect(c.network.requests.length - sent, label).toBe(1)
      expect(query.getState().error, label).not.toBeNull()
      c.client.dispose()
    }
  })

  it("restarts on INVALID_INPUT only when asked to", async () => {
    for (const restartOn of [undefined, ["CURSOR_INVALID", "INVALID_INPUT"] as const]) {
      const c = setup(restartOn ? { connections: { restartOn } } : {})
      const query = c.client.watchQuery<any>(compiled.operations.One!, { Page: { limit: 2 } })
      query.open(); await c.clock.tick()
      let refused = 0
      c.refuse((root, page) => (page.after === "b" && refused++ === 0 ? [{ message: "bad cursor", path: [root], extensions: { code: "INVALID_INPUT" } }] : null))
      await query.loadMore()
      expect(query.getState().error === null).toBe(restartOn !== undefined)
      expect(query.getState().connections!.open!.restarts).toBe(restartOn ? 1 : 0)
      c.client.dispose()
    }
  })

  it("in a refresh's later page reads the range again once, from the first page", async () => {
    const c = setup({ live: { maxRereadRows: 2 } })
    const query = c.client.watchQuery<any>(compiled.operations.One!, { Page: { limit: 2 } })
    query.open(); await c.clock.tick(); await query.loadMore()
    let refused = 0
    c.refuse((root, page) => (page.after === "b" && refused++ === 0 ? cursorInvalid : null))
    const sent = c.network.requests.length
    await query.refetch()
    expect(c.network.requests.slice(sent).map((request) => request.variables.Page)).toEqual([{ limit: 2 }, { limit: 2, after: "b" }, { limit: 2 }, { limit: 2, after: "b" }])
    expect(query.getState()).toMatchObject({ status: "ready", error: null, connections: { open: { restarts: 1 } } })
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d"])
    // Refused on the second try as well: the refresh fails with its error and keeps the rows.
    c.refuse(refuseAfter("b"))
    await query.refetch()
    expect(query.getState().status).toBe("error")
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d"])
    expect(c.diagnostics).toHaveLength(1)
    c.client.dispose()
  })

  it("restart() reads the loaded rows again and drops the rest and the stored cursor", async () => {
    const c = setup({ live: { maxRereadRows: 2, maxRereadPages: 1 } })
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    await query.loadMore({ connection: "closed" })
    c.lists.Closed = ["s", "p", "q", "r", "t", "u"]
    const sent = c.network.requests.length
    await query.restart({ connection: "closed" })
    // The bound allows two rows: the rest is dropped, not kept behind a cursor that may no longer hold.
    expect(c.network.requests.slice(sent).map((request) => request.variables)).toEqual([{ OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } }])
    expect(c.names(query.getState().data, "Closed")).toEqual(["s", "p"])
    expect(query.getState().connections!.closed).toEqual({ hasMore: true, loadingMore: false, listRefreshTruncated: false, restarts: 0 })
    // A later refresh reads the restarted list, not the range it had before.
    const refreshed = c.network.requests.length
    c.streams.one("LiveWidget").emit(row("x"), { action: "CREATED" }); await c.clock.tick()
    expect(c.network.requests.slice(refreshed).map((request) => request.variables)).toEqual([{ OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } }])
    expect(query.getState().connections!.closed!.listRefreshTruncated).toBe(false)
    await query.loadMore({ connection: "closed" })
    expect(c.network.requests.at(-1)!.variables).toEqual({ OpenPage: { limit: 2 }, ClosedPage: { limit: 2, after: "p" } })
    expect(c.names(query.getState().data, "Closed")).toEqual(["s", "p", "q", "r"])
    c.client.dispose()
  })

  it("restart() waits for every read in flight, and still restarts its list", async () => {
    const c = setup({ live: { maxRereadRows: 2, maxRereadPages: 1 } })
    const query = c.client.watchQuery<any>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    await query.loadMore({ connection: "open" }); await query.loadMore({ connection: "open" })
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b", "c", "d", "e", "f"])
    const sent = c.network.requests.length
    await Promise.all([query.loadMore({ connection: "closed" }), query.refetch(), query.restart({ connection: "open" })])
    expect(c.network.requests.slice(sent).map((request) => request.variables)).toEqual([
      { OpenPage: { limit: 2 }, ClosedPage: { limit: 2, after: "q" } },
      { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } },
      { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } },
    ])
    expect(c.names(query.getState().data, "Open")).toEqual(["a", "b"])
    expect(query.getState().connections!.open!.listRefreshTruncated).toBe(false)
    c.client.dispose()
  })

  it("under a nullable parent restarts the list instead of writing the parent's null", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.Owned!, { Page: { limit: 2 }, ClosedPage: { limit: 2 } })
    query.open(); await c.clock.tick()
    let refused = 0
    c.refuse((root, page) => (root === "Owner" && page.after === "k2" && refused++ === 0 ? [{ message: "invalid cursor", path: ["Owner", "Children"], extensions: { code: "CURSOR_INVALID" } }] : null))
    const sent = c.network.requests.length
    await query.loadMore({ connection: "children" })
    expect(c.network.requests.slice(sent).map((request) => request.variables.Page)).toEqual([{ limit: 2, after: "k2" }, { limit: 4 }])
    expect(query.getState()).toMatchObject({ error: null, connections: { children: { restarts: 1 } } })
    expect(c.names(query.getState().data.Owner, "Children")).toEqual(["k1", "k2", "k3", "k4"])
    c.client.dispose()

    // With restarts off, the response is written as before, and its errors are in the state.
    const d = setup({ connections: { restartOn: [] } })
    const off = d.client.watchQuery<any>(compiled.operations.Owned!, { Page: { limit: 2 }, ClosedPage: { limit: 2 } })
    off.open(); await d.clock.tick()
    d.refuse((root, page) => (root === "Owner" && page.after === "k2" ? [{ message: "invalid cursor", path: ["Owner", "Children"], extensions: { code: "CURSOR_INVALID" } }] : null))
    await off.loadMore({ connection: "children" })
    expect(off.getState().errors.map((error) => error.extensions?.code)).toEqual(["CURSOR_INVALID"])
    d.client.dispose()
  })

  it("reports the diagnostic once per list", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.One!, { Page: { limit: 2 } })
    query.open(); await c.clock.tick()
    const once = new Set<string>()
    c.refuse((root, page) => {
      const cursor = page.after as string | undefined
      if (!cursor || once.has(cursor)) return null
      once.add(cursor)
      return cursorInvalid
    })
    await query.loadMore(); await query.loadMore()
    expect(query.getState().connections!.open!.restarts).toBe(2)
    expect(c.diagnostics).toHaveLength(1)
    c.client.dispose()
  })

  it("a restart in flight when the identity is disposed writes nothing", async () => {
    const c = setup()
    const query = c.client.watchQuery<any>(compiled.operations.One!, { Page: { limit: 2 } })
    query.open(); await c.clock.tick()
    c.refuse(refuseAfter("b"))
    const loading = query.loadMore()
    await Promise.resolve()
    c.client.dispose(); await loading
    expect(c.client.store.get(encodeNodeId("Widget", ["a"]))).toBeUndefined()
  })
})
