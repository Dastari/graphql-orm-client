import { buildSchema } from "graphql"
import { expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { classifyError, createClient, readFragment } from "../src/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

// A loaded list whose refresh fails keeps the rows it had and says why.
const schema = buildSchema(`
  input CursorInput { limit: Int after: String }
  input WidgetKeyInput { Id: ID! }
  type Widget { NodeId: ID! Id: ID! Name: String! RecordVersion: Int! }
  type PageInfo { HasNextPage: Boolean! EndCursor: String }
  type Edge { Node: Widget! Cursor: String! }
  type Result { Edges: [Edge!]! PageInfo: PageInfo! }
  type Holder { Id: ID! Scroll(Page: CursorInput): Result! }
  type Query { Scroll(Page: CursorInput): Result! Holder: Holder }
  type Subscription { WidgetChanged(Keys: [WidgetKeyInput!]): Event! }
  type Event { Action: String! Widget: Widget }
`)
const compiled = compile(schema, [
  `fragment Row on Widget @live { Name }`,
  `query Keyset($Page: CursorInput) { Scroll(Page: $Page) @connection(key: "s") { Edges { Node { ...Row } } } }`,
  `query Nested($Page: CursorInput) { Holder { Id Scroll(Page: $Page) @connection(key: "h") { Edges { Node { ...Row } } } } }`,
])
const row = (id: string, version = 1) => ({ __typename: "Widget", NodeId: encodeNodeId("Widget", [id]), Id: id, Name: id, RecordVersion: version })
const connection = (ids: string[], more: boolean) => ({ __typename: "Result", Edges: ids.map((id) => ({ __typename: "Edge", Cursor: id, Node: row(id) })), PageInfo: { __typename: "PageInfo", HasNextPage: more, EndCursor: ids.at(-1) } })
const page = (ids: string[], more: boolean) => ({ data: { Scroll: connection(ids, more) } })
const held = (ids: string[], more: boolean) => ({ data: { Holder: { __typename: "Holder", Id: "h", Scroll: connection(ids, more) } } })
const cursor = [{ message: "invalid cursor", path: ["Scroll"], extensions: { code: "CURSOR_INVALID" } }]

function setup(answers: unknown[], options: { name?: string; partialResults?: "preserve-errors" } = {}) {
  const clock = createTestClock(), streams = createMockStreams()
  const network = createMockNetwork({ respond: () => answers.shift() as never })
  const client = createClient({ network, store: { ...clock.store, retainMs: 10 }, polling: clock.polling, ...(options.partialResults ? { partialResults: options.partialResults } : {}), live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, onDiagnostic: null } })
  const query = client.watchQuery<any>(compiled.operations[options.name ?? "Keyset"]!, { Page: { limit: 2 } })
  const names = () => {
    const data = query.getState().data
    const list = options.name === "Nested" ? data?.Holder?.Scroll : data?.Scroll
    return list === null ? null : list?.Edges.map((edge: any) => readFragment<{ Name: string }>(compiled.fragments.Row!, edge.Node).Name)
  }
  return { client, clock, streams, network, query, names }
}

it.each([
  ["an error response with no data, as a 400 with GraphQL errors gives", { errors: cursor }],
  ["data: null with errors", { data: null, errors: cursor }],
])("a refetch failing with %s keeps every loaded row, with the error set", async (_label, failure) => {
  const c = setup([page(["a", "b"], true), page(["c", "d"], false), failure])
  c.query.open(); await c.clock.tick(); await c.query.loadMore()
  await c.query.refetch()
  const state = c.query.getState()
  expect(state.status).toBe("error")
  expect(classifyError(state.error)!.kind).toBe("cursor-invalid")
  expect(c.names()).toEqual(["a", "b", "c", "d"])
  c.client.dispose()
})

it("a failure on a later page of the re-read keeps the loaded rows and writes nothing", async () => {
  const c = setup([page(["a", "b"], true), page(["c", "d"], false), page(["a2", "b2"], true), { errors: cursor }])
  c.query.open(); await c.clock.tick(); await c.query.loadMore()
  await c.query.refetch()
  expect(c.query.getState().status).toBe("error")
  expect(c.names()).toEqual(["a", "b", "c", "d"])
  expect(c.network.requests.map((r) => r.variables.Page)).toEqual([{ limit: 2 }, { limit: 2, after: "b" }, { limit: 4 }, { limit: 2, after: "b2" }])
  c.client.dispose()
})

it("a live re-read that fails keeps the rows, and the next one recovers", async () => {
  const c = setup([page(["a", "b"], true), page(["c", "d"], false), { errors: cursor }, page(["a", "b", "c", "d"], false)])
  c.query.open(); await c.clock.tick(); await c.query.loadMore()
  c.streams.one("LiveWidget").emit(row("x"), { action: "CREATED" }); await c.clock.tick(10)
  expect(c.query.getState().status).toBe("error")
  expect(c.names()).toEqual(["a", "b", "c", "d"])
  c.streams.one("LiveWidget").emit(row("y"), { action: "CREATED" }); await c.clock.tick(3000)
  expect(c.query.getState()).toMatchObject({ status: "ready", error: null })
  expect(c.names()).toEqual(["a", "b", "c", "d"])
  c.client.dispose()
})

it("a list under a nullable field that comes back null with an error is cleared by default, and kept with preserve-errors", async () => {
  const nulled = { data: { Holder: null }, errors: [{ message: "unavailable", path: ["Holder"], extensions: { code: "SERVICE_UNAVAILABLE" } }] }
  const legacy = setup([held(["a", "b"], true), held(["c", "d"], false), nulled], { name: "Nested" })
  legacy.query.open(); await legacy.clock.tick(); await legacy.query.loadMore(); await legacy.query.refetch()
  expect(legacy.query.getState()).toMatchObject({ status: "ready", error: null })
  expect(classifyError(legacy.query.getState().errors)!.kind).toBe("unavailable")
  expect(legacy.query.getState().data.Holder).toBeNull()
  legacy.client.dispose()

  const kept = setup([held(["a", "b"], true), held(["c", "d"], false), nulled], { name: "Nested", partialResults: "preserve-errors" })
  kept.query.open(); await kept.clock.tick(); await kept.query.loadMore(); await kept.query.refetch()
  expect(kept.names()).toEqual(["a", "b", "c", "d"])
  expect(classifyError(kept.query.getState().errors)!.kind).toBe("unavailable")
  kept.client.dispose()
})

it("disposing the identity while a failing refresh is in flight shows nothing afterwards", async () => {
  let fail!: (value: unknown) => void
  const answers: unknown[] = [page(["a", "b"], false), new Promise((resolve) => { fail = resolve })]
  const c = setup(answers)
  c.query.open(); await c.clock.tick()
  const refetch = c.query.refetch()
  c.client.dispose()
  fail({ errors: cursor }); await refetch.catch(() => {})
  expect(c.client.store.isDisposed).toBe(true)
  expect(c.client.store.get(encodeNodeId("Widget", ["a"]))).toBeUndefined()
})
