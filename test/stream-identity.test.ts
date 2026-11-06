import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient } from "../src/client.js"
import type { LiveDiagnostic } from "../src/health.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  type Query { Slots: [Slot!]! Gauges: [Gauge!]! Apis: [Api!]! }
  input SlotKeyInput { Site: String! Name: String! }
  input ApiKeyInput { Label: String! Secret: String! }
  type Subscription {
    SlotChanged(Keys: [SlotKeyInput!]): SlotEvent!
    GaugeChanged(Key: String): GaugeEvent!
  }
  type SlotEvent { Action: String! Slot: Slot }
  type GaugeEvent { Action: String! Gauge: Gauge }
  type Slot { NodeId: ID! Site: String! Name: String! State: String! }
  type Gauge { Id: String! Reading: Int! Trend(Scale: Int): Int }
  type Api { Id: String! Label: String! }
`)
const compiled = compile(schema, [
  `fragment SlotRow on Slot @live { State }`,
  `fragment GaugeRow on Gauge @live { Reading Trend(Scale: 2) }`,
  `query SlotPage { Slots { ...SlotRow } }`,
  `query GaugePage { Gauges { ...GaugeRow } }`,
])

function setup(responses: { slots?: unknown[]; gauges?: unknown[] }) {
  const clock = createTestClock()
  const streams = createMockStreams()
  const diagnostics: LiveDiagnostic[] = []
  let reads = 0
  const client = createClient({
    network: { execute: async (request) => { reads++; return { data: request.name === "SlotPage" ? { Slots: responses.slots ?? [] } : { Gauges: responses.gauges ?? [] } } } },
    store: { ...clock.store },
    polling: { ...clock.polling, liveFallbackMs: 1000 },
    live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, resyncJitterMs: 0, onDiagnostic: (entry) => diagnostics.push(entry) },
  })
  return { client, clock, streams, diagnostics, reads: () => reads }
}

const gauge = (id: string, reading = 1) => ({ __typename: "Gauge", Id: id, Reading: reading, Trend: reading })
const slot = (site: string, name: string, nodeId = encodeNodeId("Slot", [site, name])) => ({ __typename: "Slot", NodeId: nodeId, Site: site, Name: name, State: "free" })

describe("stream arguments and identity come from what the store holds", () => {
  it("a held record that was deleted doesn't stop the live layer reconciling", async () => {
    const c = setup({ gauges: [gauge("a"), gauge("b")], slots: [slot("north", "a")] })
    const gauges = c.client.watchQuery(compiled.operations.GaugePage!, {})
    gauges.open()
    await c.clock.tick()
    const a = c.streams.find("LiveGauge").find((stream) => stream.request.variables.Key === "a")!
    a.emit({ __typename: "Gauge", Id: "a", Reading: 2 }, { action: "DELETED" })
    expect(c.client.store.get(encodeNodeId("Gauge", ["a"]))).toBeUndefined()
    // Another query changes what's held while the deleted record is still in the first one's holdings.
    const slots = c.client.watchQuery(compiled.operations.SlotPage!, {})
    expect(() => {
      slots.open()
      c.client.live!.flush()
    }).not.toThrow()
    await c.clock.tick()
    expect(c.streams.find("LiveSlot")).toHaveLength(1)
    c.client.dispose()
  })

  it("finds the key order from the server's NodeId, so an event reaches a composite record", async () => {
    // Introspection through the router lists the key fields in another order than the server encodes them.
    const server = encodeNodeId("Slot", ["a", "north"])
    const c = setup({ slots: [slot("north", "a", server)] })
    const slots = c.client.watchQuery(compiled.operations.SlotPage!, {})
    slots.open()
    await c.clock.tick()
    c.client.live!.flush()
    const stream = c.streams.one("LiveSlot")
    expect(stream.request.variables).toEqual({ Keys: [{ Site: "north", Name: "a" }] })
    stream.emit({ __typename: "Slot", Site: "north", Name: "a", State: "taken" })
    expect(c.client.store.get(server)?.fields.get("State")).toBe("taken")
    expect(c.client.store.get(encodeNodeId("Slot", ["north", "a"]))).toBeUndefined()
    expect(c.client.liveTypeHealth("Slot").reason).toBeNull()
    c.client.dispose()
  })

  it("a server NodeId no key order encodes to polls and says so, rather than dropping every event", async () => {
    const c = setup({ slots: [slot("north", "a", encodeNodeId("Slot", ["elsewhere"]))] })
    const slots = c.client.watchQuery(compiled.operations.SlotPage!, {})
    slots.open()
    await c.clock.tick()
    c.client.live!.flush()
    await c.clock.tick()
    expect(c.streams.find("LiveSlot")).toHaveLength(0)
    const health = c.client.liveTypeHealth("Slot")
    expect(health.state).toBe("polling")
    expect(health.reason).toBe("identity-mismatch")
    expect(health.pollMs).toBe(1000)
    expect(c.diagnostics.map((entry) => entry.reason)).toContain("identity-mismatch")
    const before = c.reads()
    await c.clock.tick(1000)
    expect(c.reads()).toBe(before + 1)
    c.client.dispose()
  })

  it("a matching server NodeId stays live", async () => {
    const c = setup({ slots: [slot("north", "a")] })
    const slots = c.client.watchQuery(compiled.operations.SlotPage!, {})
    slots.open()
    await c.clock.tick()
    c.client.live!.flush()
    expect(c.streams.find("LiveSlot")).toHaveLength(1)
    expect(c.client.liveTypeHealth("Slot").reason).toBeNull()
    c.client.dispose()
  })

  it("disposing the client cancels a waiting re-read", async () => {
    const c = setup({ gauges: [gauge("a")] })
    const gauges = c.client.watchQuery(compiled.operations.GaugePage!, {})
    gauges.open()
    await c.clock.tick()
    const stream = c.streams.one("LiveGauge")
    stream.emit(gauge("a", 2))
    await c.clock.tick()
    const reads = c.reads()
    stream.emit(gauge("a", 3))
    await c.clock.tick()
    expect(c.reads()).toBe(reads)
    expect(c.clock.pending().length).toBeGreaterThan(0)
    c.client.dispose()
    expect(c.clock.pending()).toHaveLength(0)
  })

  it("a <Type>KeyInput whose fields aren't on the type doesn't decide the key", () => {
    const result = compile(schema, [`query Apis { Apis { Label } }`])
    expect(result.operations.Apis!.keys.Api).toEqual(["Id"])
    expect(result.operations.Apis!.text).toContain("Id")
  })
})
