// @vitest-environment jsdom
import { StrictMode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { buildSchema } from "graphql"
import { createClient } from "../src/client.js"
import { ClientProvider, useLoadedQuery } from "../src/react/index.js"
import { compile, generate } from "../src/compiler/index.js"
import { schema, ops, widget, catalog, mockNetwork } from "./fixtures.js"
import { createMockNetwork, createMockStreams } from "../src/test/index.js"

afterEach(() => { cleanup(); vi.useRealTimers() })
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve } }
function View({ loaded }: { loaded: ReturnType<ReturnType<typeof createClient>["loadQuery"]> }) {
  const state = useLoadedQuery(loaded)
  return <p>{state.status}</p>
}
it("starts before mount, shares one in-flight read across two StrictMode views, and closes", async () => {
  const pending = deferred(), streams = createMockStreams()
  const { network, requests } = mockNetwork(() => pending.promise)
  const client = createClient({ network, live: { artifacts: {}, subscribe: streams.subscribe } })
  const loaded = client.loadQuery(ops.CatalogPage, {})
  expect(requests).toHaveLength(1)
  const view = render(<StrictMode><ClientProvider client={client}><View loaded={loaded}/><View loaded={loaded}/></ClientProvider></StrictMode>)
  expect(requests).toHaveLength(1)
  await act(async () => { pending.resolve({ data: catalog([widget("w1")]) }); await loaded.ready })
  expect(screen.getAllByText("ready")).toHaveLength(2)
  view.unmount(); await act(async () => {})
  loaded.dispose()
  expect(() => loaded.mount()).toThrow(/disposed/)
  client.dispose()
})
it("two loaders share the same read and cached mount does not refetch", async () => {
  const { network, requests } = mockNetwork(() => ({ data: catalog([]) }))
  const client = createClient({ network })
  const a = client.loadQuery(ops.CatalogPage, {}), b = client.loadQuery(ops.CatalogPage, {})
  await a.ready; await b.ready
  a.dispose()
  const release = b.mount()
  expect(requests).toHaveLength(1)
  release(); await Promise.resolve(); client.dispose()
})
it("abort releases an abandoned read quietly and ignores a transport's late answer", async () => {
  const pending = deferred(), abort = new AbortController()
  const { network } = mockNetwork(() => pending.promise)
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}, { signal: abort.signal })
  abort.abort()
  await loaded.ready // cancellation settles even if a transport ignores abort
  pending.resolve({ data: catalog([widget("w1")]) }); await loaded.ready
  expect(loaded.getState().error).toBeNull()
  expect(client.store.get("WyJXaWRnZXQiLCJ3MSJd")).toBeUndefined()
  client.dispose()
})
it("times out an unused load and rejects sensitive reads", async () => {
  vi.useFakeTimers()
  const { network } = mockNetwork(() => ({ data: catalog([]) }))
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {}, { timeoutMs: 10 })
  await loaded.ready; await vi.advanceTimersByTimeAsync(10)
  expect(vi.getTimerCount()).toBe(0)
  expect(() => client.loadQuery({ ...ops.CatalogPage, sensitive: true }, {})).toThrow(/@sensitive.*client.query/)
  client.dispose()
})
it("identity disposal clears the loader timer and rejects a late write", async () => {
  const pending = deferred(), { network } = mockNetwork(() => pending.promise)
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {})
  client.dispose(); pending.resolve({ data: catalog([widget("w1")]) }); await loaded.ready
  expect(loaded.getState().error).toBeNull()
  expect(() => loaded.mount()).toThrow(/disposed/)
})
for (const directive of ["skip", "include"]) it(`rejects @${directive} on fields and live fragments at build`, () => {
  const sources = [`fragment Conditional on Widget @live { Name @${directive}(if: true) }`, `query Conditional { Widget(Id: "w1") { ...Conditional } }`]
  expect(() => compile(schema, sources)).toThrow(/conditional reads, generated optional types and live projections/)
  expect(() => generate(schema, sources)).toThrow(/unsupported/)
  expect(() => compile(schema, sources, { conditionalDirectives: "legacy" })).not.toThrow()
})
it("rejects fragment arguments clearly", () => {
  expect(() => compile(schema, [`fragment Args on Widget @argumentDefinitions(id: {type: "ID!"}) { Name }`])).toThrow(/fragment arguments are unsupported/)
})
it("opens a list stream before the read, preserves it through mount replay, and collects on release", async () => {
  vi.useFakeTimers()
  const { buildSchema } = await import("graphql")
  const { encodeNodeId } = await import("../src/node-id.js")
  const compiled = compile(buildSchema(`type Query { Rows: [Widget!]! } type Widget { Id: ID! Name: String! RecordVersion: Int! } type Event { Action: String! Widget: Widget } type Subscription { WidgetChanged: Event! }`), [`fragment Row on Widget @live { Name }`, `query Rows { Rows { ...Row } }`])
  const streams = createMockStreams(), order: string[] = []
  const id = encodeNodeId("Widget", ["w1"])
  let reads = 0, readName = "old", readVersion = 1
  const client = createClient({
    network: { execute: async () => { order.push("read"); reads++; return { data: { Rows: [{ __typename: "Widget", Id: "w1", Name: readName, RecordVersion: readVersion }] } } } },
    store: { retainMs: 10 },
    live: { artifacts: compiled.live, connection: { state: () => "connected", subscribe: listener => streams.onReconnect(() => listener({ reconnected: true })) }, subscribe: (r,s) => { order.push("stream"); return streams.subscribe(r,s) }, debounceMs: 0, settleMs: false, minRereadMs: 1, resyncJitterMs: 0, onDiagnostic: null },
  })
  const loaded = client.loadQuery(compiled.operations.Rows!, {})
  await loaded.ready
  expect(order.slice(0,2)).toEqual(["stream", "read"])
  const release = loaded.mount(); release(); const releaseAgain = loaded.mount(); await Promise.resolve()
  expect(order.filter(x => x === "stream")).toHaveLength(1)
  streams.one("LiveWidget").emit({ __typename: "Widget", Id: "w1", Name: "new", RecordVersion: 3 })
  expect(client.store.get(id)?.fields.get("Name")).toBe("new")
  await loaded.refetch() // older read cannot replace stream version
  expect(client.store.get(id)?.fields.get("Name")).toBe("new")
  const before = reads
  readName = "gap"; readVersion = 4
  streams.reconnect(); await vi.advanceTimersByTimeAsync(10)
  expect(reads).toBeGreaterThan(before)
  expect(client.store.get(id)?.fields.get("Name")).toBe("gap")
  releaseAgain(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(20)
  expect(client.store.get(id)).toBeUndefined()
  expect(streams.open.size).toBe(0)
  const abandoned = client.loadQuery(compiled.operations.Rows!, {}, { timeoutMs: 5 })
  await abandoned.ready
  expect(streams.open.size).toBe(1)
  await vi.advanceTimersByTimeAsync(20)
  expect(streams.open.size).toBe(0)
  expect(client.store.get(id)).toBeUndefined()
  client.dispose()
})
it("pins unsafe legacy conditional behaviour end to end for migration", async () => {
  const sources = [`fragment Conditional on Widget @live { Name @include(if: false) }`, `query Conditional { Widget(Id: "w1") { ...Conditional } }`]
  const compiled = compile(schema, sources, { conditionalDirectives: "legacy" })
  expect(compiled.operations.Conditional!.text).toContain("@include(if: false)")
  expect(compiled.live.Widget!.operation.text).not.toContain("@include")
  expect(compiled.live.Widget!.operation.text).toContain("Name")
  const types = generate(schema, sources, { conditionalDirectives: "legacy" })
  expect(types).toMatch(/readonly Name: string/)
  expect(types).not.toMatch(/Name\?:/)
  const { selectorOf } = await import("../src/client.js")
  const client = createClient({ network: { execute: async () => ({ data: { Widget: { __typename: "Widget", Id: "w1" } } }) } })
  await client.execute(compiled.operations.Conditional!, {})
  // The wire omission was legal, but the old read representation demands the missing field.
  expect(client.store.lookup({ ...selectorOf(compiled.operations.Conditional!, {}), selections: compiled.operations.Conditional!.normalization }).missing).toBe(true)
  client.dispose()
})
it("hydrates the idle server shell before showing a loader result without mismatch", async () => {
  const { hydrateRoot } = await import("react-dom/client")
  const { network } = mockNetwork(() => ({ data: catalog([]) }))
  const client = createClient({ network })
  const loaded = client.loadQuery(ops.CatalogPage, {})
  await loaded.ready
  const container = document.createElement("div")
  container.innerHTML = "<p>idle</p>"
  document.body.append(container)
  const errors: unknown[] = []
  let root!: ReturnType<typeof hydrateRoot>
  await act(async () => { root = hydrateRoot(container, <ClientProvider client={client}><View loaded={loaded}/></ClientProvider>, { onRecoverableError: e => errors.push(e) }) })
  expect(container.textContent).toBe("ready")
  expect(errors).toEqual([])
  await act(async () => root.unmount())
  container.remove(); client.dispose()
})

it("a load that expired, or whose last user unmounted, opens again when mounted, and a disposed one doesn't", async () => {
  const network = createMockNetwork({ respond: () => ({ data: { Widget: { __typename: "Widget", Id: "w1", Name: "first" } } }) })
  const schema = buildSchema(`type Query { Widget: Widget } type Widget { Id: ID! Name: String! }`)
  const { operations } = compile(schema, [`query One { Widget { Id Name } }`])
  const client = createClient({ network })
  const expired = client.loadQuery(operations.One!, {}, { timeoutMs: 1 })
  await expired.ready
  await new Promise((resolve) => setTimeout(resolve, 10))
  const unmount = expired.mount()
  expect(expired.getState().status).toBe("ready")
  unmount()
  await Promise.resolve()
  const again = expired.mount()
  expect(expired.getState().data).toBeDefined()
  again()
  expired.dispose()
  expect(() => expired.mount()).toThrow(/disposed/)
  client.dispose()
})
