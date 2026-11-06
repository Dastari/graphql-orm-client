import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile, generate } from "../src/compiler/index.js"
import { createClient } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  type Query { Slots: [Slot!]! }
  input SlotKeyInput { Site: String! Name: String! }
  type Subscription { SlotChanged(Keys: [SlotKeyInput!]): SlotEvent! }
  type SlotEvent { Action: String! Slot: Slot }
  type Vendor { Id: ID! Name: String! }
  type Slot { NodeId: ID! Site: String! Name: String! State: String! RecordVersion: Int! Vendor: Vendor Score(scale: Int): Int Summary: String }
`)
const sources = [
  `fragment Row on Slot @live { State Vendor { Name } Score(scale: 2) Summary }`,
  `query Page { Slots { ...Row } }`,
]
const compiled = compile(schema, sources)
// Keep this suite focused on keyed record streams; R3 has regenerated-list tests.
for (const operation of Object.values(compiled.operations)) delete (operation as { lists?: readonly string[] }).lists

function setup(settleMs: number | false = false) {
  const clock = createTestClock()
  const streams = createMockStreams()
  let reads = 0, active = true, version = 1, vendor = "a"
  let answer: (() => Promise<any>) | undefined
  const row = () => ({ __typename: "Slot", Site: "north", Name: "a", NodeId: encodeNodeId("Slot", ["north", "a"]), State: "free", RecordVersion: version, Summary: `v${version}`, Score: version, Vendor: { __typename: "Vendor", Id: vendor, Name: vendor } })
  const client = createClient({ network: { execute: async () => { reads++; return answer ? answer() : { data: { Slots: [row()] } } } }, store: { ...clock.store, retainMs: 10 }, polling: { ...clock.polling, isActive: () => active }, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs, resyncJitterMs: 0, onDiagnostic: null } })
  const query = client.watchQuery(compiled.operations.Page!, {})
  const open = async () => { query.open(); await clock.tick() }
  return { client, query, streams, clock, row, open, reads: () => reads, update: () => { version++; vendor = "b" }, active: (value: boolean) => { active = value }, answer: (value: typeof answer) => { answer = value } }
}

describe("R2 projections and bounded holder re-reads", () => {
  it("flattens schema-derived composite keys and omits NodeId, relations and argument scalars", () => {
    const live = compiled.live.Slot!
    expect(live.keyFields).toEqual(["Site", "Name"])
    expect(live.operation.text).toContain("RecordVersion")
    for (const name of ["NodeId", "Vendor", "Score", "fragment", "...Row"]) expect(live.operation.text).not.toContain(name)
    expect(live.operation.text).toContain("Summary")
    expect(live.thinOperation!.text).not.toContain("RecordVersion")
    expect(live.thinOperation!.text).not.toContain("State")
    expect(live.rereadFragments).toEqual(["Row"])
  })

  it("warns with fragment and excluded field names during generation", () => {
    const warnings: string[] = []
    generate(schema, sources, { onWarning: (warning) => warnings.push(warning) })
    expect(warnings).toContain("Fragment Row: stream excludes Slot.Vendor")
    expect(warnings).toContain("Fragment Row: stream excludes Slot.Score")
  })

  it("falls back for the client lifetime, reads on thin, and treats thin refusal as real", async () => {
    const c = setup(); await c.open()
    c.streams.one("LiveSlot").refuse()
    await c.clock.tick()
    expect(c.streams.one("LiveSlot").request.text).toBe(compiled.live.Slot!.thinOperation!.text)
    expect(c.client.liveTypeHealth("Slot").reason).toBe("selection-refused")
    c.update(); c.streams.one("LiveSlot").emit({ __typename: "Slot", Site: "north", Name: "a" })
    await c.clock.tick()
    expect(c.reads()).toBe(2)
    expect(c.client.store.get(encodeNodeId("Slot", ["north", "a"]))?.fields.get("Summary")).toBe("v2")
    c.streams.one("LiveSlot").end(); await c.clock.tick()
    c.streams.one("LiveSlot").refuse()
    expect(c.client.live!.status().Slot!.backedOff).toBe(true)
    c.client.dispose()
  })

  it("re-reads a changed relation link and bounds 100 events in one second to two reads", async () => {
    const c = setup(); await c.open(); c.update()
    for (let i = 0; i < 100; i++) { c.streams.one("LiveSlot").emit(c.row()); await c.clock.tick(10) }
    expect(c.reads()).toBe(2) // initial plus leading
    await c.clock.tick(1000)
    expect(c.reads()).toBe(3) // one trailing
    const record = c.client.store.get(encodeNodeId("Slot", ["north", "a"]))!
    expect(record.fields.get("Vendor")).toEqual({ __ref: encodeNodeId("Vendor", ["b"]) })
    c.client.dispose()
  })

  it("pauses stale reads while inactive and catches up once on return", async () => {
    const c = setup(); await c.open(); c.active(false)
    for (let i = 0; i < 100; i++) c.streams.one("LiveSlot").emit(c.row())
    await c.clock.tick(3000); expect(c.reads()).toBe(1)
    c.active(true); await c.clock.tick(1000); expect(c.reads()).toBe(2)
    c.client.dispose()
  })

  it("follows a read in flight with one more and cancels pending work on disposal", async () => {
    const c = setup(); await c.open()
    let resolve!: (value: any) => void
    c.answer(() => new Promise((done) => { resolve = done }))
    const read = c.query.refetch(); c.streams.one("LiveSlot").emit(c.row())
    c.answer(undefined); resolve({ data: { Slots: [c.row()] } }); await read; await c.clock.tick()
    expect(c.reads()).toBe(3)
    c.streams.one("LiveSlot").emit(c.row()); c.client.dispose(); await c.clock.tick(3000)
    expect(c.reads()).toBe(3); expect(c.streams.open.size).toBe(0); expect(c.client.store.get(encodeNodeId("Slot", ["north", "a"])) ).toBeUndefined()
  })

  it("bounds R4 confirmation when every read adds a new record", async () => {
    const c = setup(250)
    let count = 0
    c.answer(async () => ({ data: { Slots: Array.from({ length: ++count }, (_, i) => ({ ...c.row(), Name: String(i), NodeId: encodeNodeId("Slot", ["north", String(i)]) })) } }))
    await c.open(); await c.clock.tick(10_000)
    expect(c.reads()).toBe(6) // initial, then 250, 2250, 4250, 6250, 8250
    expect(c.streams.open.size).toBeLessThanOrEqual(2)
    c.client.dispose()
  })

  it("orders versioned events, replays reconnect reads and collects released records", async () => {
    const c = setup(); await c.open(); c.update()
    c.streams.one("LiveSlot").emit(c.row()); await c.clock.tick()
    c.streams.one("LiveSlot").emit({ ...c.row(), RecordVersion: 0, State: "old" })
    const id = encodeNodeId("Slot", ["north", "a"])
    expect(c.client.store.get(id)?.fields.get("State")).toBe("free")
    c.streams.one("LiveSlot").loseContinuity(); await c.clock.tick(2000)
    expect(c.reads()).toBe(3)
    c.query.close(); await c.clock.tick(100); expect(c.client.store.get(id)).toBeUndefined()
    c.client.dispose()
  })
})

it("preserves legacy subscription text and runs artifacts without a thin projection", async () => {
  const legacy = compile(schema, [`fragment Row on Slot @live { State }`, `query Page { Slots { ...Row } }`], { liveSelection: "as-written" })
  expect(legacy.live.Slot!.operation.text).toBe(`subscription LiveSlot($Keys: [SlotKeyInput!]) {
  SlotChanged(Keys: $Keys) {
    __typename
    Action
    Slot {
      __typename
      NodeId
      Site
      Name
      RecordVersion
      ...Row
    }
  }
}

fragment Row on Slot {
  __typename
  NodeId
  Site
  Name
  RecordVersion
  State
}`)
  expect(legacy.live.Slot!.thinOperation).toBeUndefined()
  const clock = createTestClock(), streams = createMockStreams()
  const client = createClient({ network: { execute: async () => ({ data: { Slots: [{ __typename: "Slot", Site: "north", Name: "a", State: "free" }] } }) }, live: { ...clock.live, artifacts: legacy.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, onDiagnostic: null } })
  const query = client.watchQuery(legacy.operations.Page!, {}); query.open(); await clock.tick()
  streams.one("LiveSlot").refuse(); expect(client.live!.status().Slot!.backedOff).toBe(true)
  expect(streams.started).toHaveLength(1)
  client.dispose()
})

it.each(["key", "keys", "unkeyed"] as const)("keeps fallback coverage bounded through reconcile in %s mode", async (mode) => {
  const clock = createTestClock(), streams = createMockStreams()
  const s = buildSchema(`type Query { Widgets: [Widget!]! }
    type Widget { Id: ID! Name: String! }
    type Event { Action: String! Widget: Widget }
    type Subscription { WidgetChanged${mode === "key" ? "(Key: ID)" : mode === "keys" ? "(Keys: [ID!])" : ""}: Event! }`)
  const c = compile(s, [`fragment F on Widget @live { Name }`, `query Q { Widgets { ...F } }`])
  delete (c.operations.Q as { lists?: readonly string[] }).lists
  let rows = ["a"]
  const client = createClient({ network: { execute: async () => ({ data: { Widgets: rows.map(Id => ({ __typename: "Widget", Id, Name: Id })) } }) }, live: { ...clock.live, subscribe: streams.subscribe, artifacts: c.live, debounceMs: 0, settleMs: 50, onDiagnostic: null } })
  const query = client.watchQuery(c.operations.Q!, {}); query.open(); await clock.tick(50)
  streams.one("LiveWidget").refuse(); await clock.tick(100)
  expect(streams.one("LiveWidget").request.text).toBe(c.live.Widget!.thinOperation!.text)
  rows = ["a", "b"]; await query.refetch(); await clock.tick(100)
  expect(streams.open.size).toBe(mode === "key" ? 2 : 1)
  for (const stream of streams.open) expect(stream.request.text).toBe(c.live.Widget!.thinOperation!.text)
  rows = ["b"]; await query.refetch(); await clock.tick(100)
  expect(streams.open.size).toBe(1)
  query.close(); await clock.tick(100); expect(streams.open.size).toBe(0)
  client.dispose()
})

it("records omissions selected directly by a root as well as by fragments", () => {
  const c = compile(schema, [`fragment F on Slot @live { State }`, `query Q { Slots { ...F Vendor { Name } Score(scale: 3) } }`])
  expect(c.live.Slot!.rereadFragments).toEqual([])
  expect(c.operations.Q!.liveReread).toEqual(["Slot"])
})
