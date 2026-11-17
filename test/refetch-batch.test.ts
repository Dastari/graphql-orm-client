import { buildSchema } from "graphql"
import { describe, expect, it, vi } from "vitest"
import { createClient, type ClientOptions, type GraphQLResponse, type OperationRequest } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork } from "../src/test/index.js"

// The router's lookup, as graphql-orm-router hosts it: `node(NodeId)` and `nodes(NodeIds)`.
const types = `
  interface Node { NodeId: ID! }
  type Widget implements Node { NodeId: ID! Id: String! Name: String! RecordVersion: Int! }
`
const schema = buildSchema(`
  type Query { node(NodeId: ID!): Node nodes(NodeIds: [ID!]!): [Node]! Widgets: [Widget!]! }
  ${types}
`)
const documents = [`fragment WidgetCard on Widget @refetchable { Name RecordVersion }`, `query WidgetList { Widgets { ...WidgetCard } }`]
const compiled = compile(schema, documents)
const WidgetCard = compiled.fragments.WidgetCard!
const WidgetList = compiled.operations.WidgetList!

const id = (key: string) => encodeNodeId("Widget", [key])
const widget = (key: string, overrides: Record<string, unknown> = {}) => ({ __typename: "Widget", NodeId: id(key), Id: key, Name: `widget-${key}`, RecordVersion: 1, ...overrides })

/** A client holding `count` widgets w0…wN, and a lookup the test can change. */
async function setup(count: number, options: Partial<ClientOptions> = {}) {
  let lookup = (request: OperationRequest): GraphQLResponse | Promise<GraphQLResponse> => {
    if (request.name === "WidgetCardRefetch") return { data: { node: widget(keyOf(request.variables.NodeId as string), { Name: "fresh" }) } }
    return { data: { nodes: (request.variables.NodeIds as string[]).map((nodeId) => widget(keyOf(nodeId), { Name: "fresh" })) } }
  }
  const keys = Array.from({ length: count }, (_, index) => `w${index}`)
  const keyOf = (nodeId: string) => keys.find((key) => id(key) === nodeId)!
  const network = createMockNetwork({ respond: (request) => (request.name === "WidgetList" ? { data: { Widgets: keys.map((key) => widget(key)) } } : lookup(request)) })
  const client = createClient({ network, ...options })
  const { snapshot } = await client.execute<{ Widgets: object[] }>(WidgetList, {})
  const refs = snapshot.data.Widgets
  const name = (key: string) => client.store.get(id(key))?.fields.get("Name")
  const lookups = () => network.requests.filter((request) => request.name !== "WidgetList")
  return { client, network, refs, keys, name, lookups, keyOf, answer: (next: typeof lookup) => { lookup = next } }
}

describe("batched refetchFragment", () => {
  it("compiles a nodes(NodeIds) query only where the schema has one", () => {
    expect(WidgetCard.refetchNodes?.name).toBe("WidgetCardRefetchNodes")
    expect(WidgetCard.refetchNodes?.text).toContain("query WidgetCardRefetchNodes($NodeIds: [ID!]!)")
    expect(WidgetCard.refetchNodes?.text).toContain("nodes(NodeIds: $NodeIds)")
    expect(Object.keys(compiled.operations)).toEqual(["WidgetList"])
    const nodeOnly = compile(buildSchema(`type Query { node(NodeId: ID!): Node Widgets: [Widget!]! } ${types}`), documents)
    expect(nodeOnly.fragments.WidgetCard!.refetch).toBeDefined()
    expect(nodeOnly.fragments.WidgetCard!.refetchNodes).toBeUndefined()
    expect(() => compile(schema, [...documents, `query WidgetCardRefetchNodes { Widgets { Id } }`])).toThrow(/WidgetCardRefetchNodes has the name of another operation/)
  })

  it("sends 100 calls made in one tick as one request, each caller getting its own result", async () => {
    const c = await setup(100)
    const results = await Promise.all(c.refs.map((ref) => c.client.refetchFragment(WidgetCard, ref)))
    expect(c.lookups()).toHaveLength(1)
    expect(c.lookups()[0]).toMatchObject({ name: "WidgetCardRefetchNodes", variables: { NodeIds: c.keys.map(id) } })
    expect(results.every((result) => result.found && result.errors.length === 0)).toBe(true)
    expect(c.keys.every((key) => c.name(key) === "fresh")).toBe(true)
  })

  it("chunks within the bound, asks for a record once, and sends a single call as node(NodeId)", async () => {
    const c = await setup(7, { refetchBatch: { maxNodes: 3 } })
    await Promise.all([...c.refs, c.refs[0]!].map((ref) => c.client.refetchFragment(WidgetCard, ref)))
    expect(c.lookups().map((request) => (request.variables.NodeIds as string[]).map(c.keyOf))).toEqual([["w0", "w1", "w2"], ["w3", "w4", "w5"], ["w6"]])
    await c.client.refetchFragment(WidgetCard, c.refs[1]!)
    expect(c.lookups().at(-1)).toMatchObject({ name: "WidgetCardRefetch", variables: { NodeId: id("w1") } })
    // A later tick is a new request.
    await c.client.refetchFragment(WidgetCard, c.refs[2]!)
    await c.client.refetchFragment(WidgetCard, c.refs[3]!)
    expect(c.lookups()).toHaveLength(6)
  })

  it("sends one node(NodeId) request per call with refetchBatch: false", async () => {
    const c = await setup(3, { refetchBatch: false })
    await Promise.all(c.refs.map((ref) => c.client.refetchFragment(WidgetCard, ref)))
    expect(c.lookups().map((request) => request.name)).toEqual(["WidgetCardRefetch", "WidgetCardRefetch", "WidgetCardRefetch"])
  })

  it("removes only a missing record, and keeps one whose entry has an error", async () => {
    const c = await setup(4)
    c.answer(() => ({
      data: { nodes: [widget("w0", { Name: "fresh" }), null, null, widget("w3", { Name: "fresh" })] },
      errors: [{ message: "unavailable", path: ["nodes", 2, "Name"], extensions: { code: "SERVICE_UNAVAILABLE" } }],
    }))
    const results = await Promise.all(c.refs.map((ref) => c.client.refetchFragment(WidgetCard, ref)))
    expect(results.map((result) => [result.found, result.errors.length])).toEqual([[true, 0], [false, 0], [false, 1], [true, 0]])
    expect(c.client.store.get(id("w1"))).toBeUndefined()
    expect(c.name("w2")).toBe("widget-w2")
    expect([c.name("w0"), c.name("w3")]).toEqual(["fresh", "fresh"])
  })

  it("gives an error with no entry to every caller and removes nothing", async () => {
    const c = await setup(2)
    c.answer(() => ({ data: { nodes: [null, null] }, errors: [{ message: "partial" }] }))
    const results = await Promise.all(c.refs.map((ref) => c.client.refetchFragment(WidgetCard, ref)))
    expect(results.map((result) => [result.found, result.errors.length])).toEqual([[false, 1], [false, 1]])
    expect(c.client.store.get(id("w0"))).toBeDefined()
    expect(c.client.store.get(id("w1"))).toBeDefined()
  })

  it("a failed request rejects every caller and leaves every record as it was", async () => {
    for (const failure of [{ data: null, errors: [{ message: "nodes accepts at most 100 NodeIds", extensions: { code: "INVALID_INPUT" } }] }, new Error("offline")]) {
      const c = await setup(3)
      c.answer(() => {
        if (failure instanceof Error) throw failure
        return failure as GraphQLResponse
      })
      const results = await Promise.allSettled(c.refs.map((ref) => c.client.refetchFragment(WidgetCard, ref)))
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
      expect(c.keys.map(c.name)).toEqual(["widget-w0", "widget-w1", "widget-w2"])
    }
  })

  it("keeps a newer stored version against an older entry", async () => {
    const c = await setup(2)
    c.client.store.setField(c.client.store.get(id("w0"))!, "RecordVersion", 5)
    c.answer(() => ({ data: { nodes: [widget("w0", { Name: "older", RecordVersion: 3 }), widget("w1", { Name: "newer", RecordVersion: 2 })] } }))
    await Promise.all(c.refs.map((ref) => c.client.refetchFragment(WidgetCard, ref)))
    expect([c.name("w0"), c.client.store.get(id("w0"))?.fields.get("RecordVersion")]).toEqual(["widget-w0", 5])
    expect([c.name("w1"), c.client.store.get(id("w1"))?.fields.get("RecordVersion")]).toEqual(["newer", 2])
  })

  it("writes nothing when the identity is disposed during the request, or before it is sent", async () => {
    const c = await setup(3)
    let answer!: (response: GraphQLResponse) => void
    c.answer(() => new Promise((resolve) => { answer = resolve }))
    const pending = Promise.allSettled(c.refs.map((ref) => c.client.refetchFragment(WidgetCard, ref)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(c.lookups()).toHaveLength(1)
    c.client.dispose()
    answer({ data: { nodes: [null, null, widget("w2", { Name: "fresh" })] } })
    expect((await pending).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
    expect(c.client.store.get(id("w2"))).toBeUndefined()

    const d = await setup(2)
    const queued = Promise.allSettled(d.refs.map((ref) => d.client.refetchFragment(WidgetCard, ref)))
    d.client.dispose()
    expect((await queued).map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(d.lookups()).toHaveLength(0)
  })

  it("stops listening to the callers' signals once the request settles", async () => {
    const c = await setup(2)
    const controllers = [new AbortController(), new AbortController()]
    const spies = controllers.map((controller) => [vi.spyOn(controller.signal, "addEventListener"), vi.spyOn(controller.signal, "removeEventListener")] as const)
    await Promise.all(c.refs.map((ref, index) => c.client.refetchFragment(WidgetCard, ref, { signal: controllers[index]!.signal })))
    for (const [add, remove] of spies) {
      expect(add.mock.calls.length).toBeGreaterThan(0)
      expect(remove.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining(add.mock.calls.map((call) => call[1])))
    }
  })

  it("rejects a call whose signal aborts, and cancels the request when every call has", async () => {
    const c = await setup(3)
    let signal: AbortSignal | undefined
    let answer!: (response: GraphQLResponse) => void
    c.answer(() => new Promise((resolve) => { answer = resolve }))
    const network = c.network.execute.bind(c.network)
    c.network.execute = (request, options) => { signal = options.signal; return network(request, options) }
    const one = new AbortController(), two = new AbortController()
    const calls = [c.client.refetchFragment(WidgetCard, c.refs[0]!, { signal: one.signal }), c.client.refetchFragment(WidgetCard, c.refs[1]!, { signal: two.signal }), c.client.refetchFragment(WidgetCard, c.refs[2]!)]
    await new Promise((resolve) => setTimeout(resolve, 0))
    one.abort()
    await expect(calls[0]).rejects.toThrow(/cancelled/)
    answer({ data: { nodes: [widget("w0", { Name: "fresh" }), widget("w1", { Name: "fresh" }), widget("w2", { Name: "fresh" })] } })
    expect(await calls[1]).toEqual({ found: true, errors: [] })
    expect(await calls[2]).toEqual({ found: true, errors: [] })
    expect(signal?.aborted).toBe(false)

    const both = [new AbortController(), new AbortController()]
    c.answer(() => new Promise(() => {}))
    const aborted = c.refs.slice(0, 2).map((ref, index) => c.client.refetchFragment(WidgetCard, ref, { signal: both[index]!.signal }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    both.forEach((controller) => controller.abort())
    expect((await Promise.allSettled(aborted)).map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(signal?.aborted).toBe(true)
  })
})
