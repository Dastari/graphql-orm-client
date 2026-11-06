import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const schemaOf = (changeKind: string) => buildSchema(`
  type Query { Vendor(Id: String!): Vendor Vendors: [Vendor!]! }
  type Subscription { VendorChanged(Key: String): VendorEvent! }
  type VendorEvent { Action: String! ${changeKind} Vendor: Vendor }
  type Vendor { Id: String! Name: String! RecordVersion: Int! }
`)
const documents = [
  `fragment Row on Vendor @live { Name }`,
  `query One($Id: String!) { Vendor(Id: $Id) { ...Row } }`,
]
const served = compile(schemaOf("ChangeKind: String!"), documents)
const vendor = (name = "first") => ({ __typename: "Vendor", Id: "v1", Name: name, RecordVersion: 1 })
const id = encodeNodeId("Vendor", ["v1"])

function setup(compiled = served, minRereadMs?: number) {
  const clock = createTestClock()
  const streams = createMockStreams()
  let name = "first"
  const network = createMockNetwork({ respond: () => ({ data: { Vendor: vendor(name) } }) })
  const client = createClient({
    network,
    store: clock.store,
    polling: clock.polling,
    live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, onDiagnostic: null, ...(minRereadMs ? { minRereadMs } : {}) },
  })
  const query = client.watchQuery<{ Vendor: object | null }>(compiled.operations.One!, { Id: "v1" })
  const open = async () => {
    query.open()
    await clock.tick()
    return streams.one("LiveVendor")
  }
  const shown = () => {
    const data = query.getState().data?.Vendor
    return data ? readFragment<{ Name: string }>(compiled.fragments.Row!, data).Name : null
  }
  return { client, clock, network, query, open, shown, rename: (next: string) => { name = next } }
}

describe("a DELETED event's change kind", () => {
  it("selects the change kind in every generated stream, in the service's casing, where it's served", () => {
    for (const [field, compiled] of [
      ["ChangeKind", served],
      ["changeKind", compile(schemaOf("changeKind: String!"), documents)],
      ["ChangeKind", compile(schemaOf("ChangeKind: String!"), documents, { liveSelection: "as-written" })],
    ] as const) {
      const artifact = compiled.live.Vendor!
      expect(artifact.changeKindField).toBe(field)
      expect(artifact.operation.text).toContain(field)
      if (artifact.thinOperation) expect(artifact.thinOperation.text).toContain(field)
    }
    const without = compile(schemaOf(""), documents).live.Vendor!
    expect(without.changeKindField).toBeUndefined()
    expect(without.operation.text.toLowerCase()).not.toContain("changekind")
  })

  it("DELETED and PROPAGATED keeps the record and reads the query again", async () => {
    const c = setup()
    const stream = await c.open()
    expect(c.network.requests).toHaveLength(1)
    c.rename("after the child went")
    stream.emit(vendor(), { action: "DELETED", changeKind: "PROPAGATED" })
    expect(c.client.store.get(id)).toBeDefined()
    expect(c.shown()).toBe("first")
    await c.clock.tick()
    expect(c.network.requests).toHaveLength(2)
    expect(c.shown()).toBe("after the child went")
    c.client.dispose()
  })

  it("DELETED and DIRECT removes the record", async () => {
    const c = setup()
    const stream = await c.open()
    stream.emit(vendor(), { action: "DELETED", changeKind: "DIRECT" })
    expect(c.client.store.get(id)).toBeUndefined()
    c.client.dispose()
  })

  it("a service that doesn't serve the change kind keeps removing the record", async () => {
    const c = setup(compile(schemaOf(""), documents))
    const stream = await c.open()
    stream.emit(vendor(), { action: "DELETED" })
    expect(c.client.store.get(id)).toBeUndefined()
    c.client.dispose()
  })

  it("an artifact generated before this field keeps removing the record, whatever the event says", async () => {
    const { changeKindField: _dropped, ...earlier } = served.live.Vendor!
    const c = setup({ ...served, live: { Vendor: earlier } })
    const stream = await c.open()
    stream.emit(vendor(), { action: "DELETED", changeKind: "PROPAGATED" })
    expect(c.client.store.get(id)).toBeUndefined()
    c.client.dispose()
  })

  it("the rule holds for artifacts with no thin selection", async () => {
    const c = setup(compile(schemaOf("ChangeKind: String!"), documents, { liveSelection: "as-written" }))
    const stream = await c.open()
    stream.emit(vendor(), { action: "DELETED", changeKind: "PROPAGATED" })
    expect(c.client.store.get(id)).toBeDefined()
    await c.clock.tick()
    expect(c.network.requests).toHaveLength(2)
    c.client.dispose()
  })

  it("deleting 100 children in a burst coalesces to two reads", async () => {
    const c = setup()
    const stream = await c.open()
    for (let index = 0; index < 100; index++) stream.emit(vendor(), { action: "DELETED", changeKind: "PROPAGATED" })
    await c.clock.tick()
    expect(c.network.requests).toHaveLength(2) // the first read, then the start of the burst
    await c.clock.tick(2000)
    expect(c.network.requests).toHaveLength(3) // the end of the burst
    await c.clock.tick(10_000)
    expect(c.network.requests).toHaveLength(3)
    expect(c.client.store.get(id)).toBeDefined()
    c.client.dispose()
  })

  it("a propagated delete for a record nobody holds does nothing", async () => {
    const c = setup()
    const stream = await c.open()
    stream.emit({ ...vendor(), Id: "elsewhere" }, { action: "DELETED", changeKind: "PROPAGATED" })
    await c.clock.tick()
    expect(c.network.requests).toHaveLength(1)
    c.client.dispose()
  })

  it("a waiting refresh doesn't survive disposal", async () => {
    const c = setup()
    const stream = await c.open()
    stream.emit(vendor(), { action: "DELETED", changeKind: "PROPAGATED" })
    await c.clock.tick()
    stream.emit(vendor(), { action: "DELETED", changeKind: "PROPAGATED" })
    c.client.dispose()
    expect(c.clock.pending()).toHaveLength(0)
    const reads = c.network.requests.length
    await c.clock.tick(5000)
    expect(c.network.requests).toHaveLength(reads)
  })
})
