import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient, type GraphQLResponse } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"

const types = ["Widget", "Vendor", "Ticket"]
const schema = buildSchema(`type Query { ${types.map(t => `${t}: ${t}`).join(" ")} }
 type Subscription { ${types.map(t => `${t}Changed(Keys: [ID!]): ${t}Event`).join(" ")} }
 ${types.map(t => `type ${t} { Id: ID! Name: String RecordVersion: Int! } type ${t}Event { Action: String! ${t}: ${t} }`).join("\n")}`)
function setup(options: { enabled?: boolean; lists?: boolean; maxWaitMs?: number } = {}) {
  const compiled = compile(schema, [...types.map(t => `fragment ${t}Row on ${t} @live { Name }`), `query Page { ${types.map(t => `${t} { ...${t}Row }`).join(" ")} }`])
  if (options.lists) (compiled.operations.Page! as { lists?: readonly string[] }).lists = types
  const clock = createTestClock(), streams = createMockStreams()
  let reads = 0, active = true, version = 1
  let answer: (() => Promise<GraphQLResponse>) | undefined
  const row = (type: string, v = version) => ({ __typename: type, Id: "a", Name: String(v), RecordVersion: v })
  const data = () => Object.fromEntries(types.map(t => [t, row(t)]))
  const client = createClient({ network: { execute: async () => { reads++; return answer ? answer() : { data: data() } } }, store: { ...clock.store, retainMs: 10 }, polling: { ...clock.polling, isActive: () => active }, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, settleMs: false, debounceMs: 0, resyncJitterMs: 0, onDiagnostic: null, burstRead: options.enabled === false ? false : { maxWaitMs: options.maxWaitMs } } })
  const query = client.watchQuery(compiled.operations.Page!, {})
  const emit = (type = "Widget", count = 32) => { for (let i=0;i<count;i++) streams.one(`Live${type}`).emit(row(type)) }
  return { client, clock, streams, query, emit, row, data, open: async () => { query.open(); await clock.tick() }, reads: () => reads, active: (v: boolean) => { active=v }, version: (v: number) => { version=v }, answer: (v: typeof answer) => { answer=v } }
}
describe("burst repair", () => {
  it("coalesces three types with staggered ends into one read, including old artifacts", async () => {
    const c=setup(); await c.open()
    c.emit(); await c.clock.tick(200); c.emit("Vendor"); await c.clock.tick(200); c.emit("Ticket")
    await c.clock.tick(499); expect(c.reads()).toBe(1)
    await c.clock.tick(1); expect(c.reads()).toBe(2)
    for (const t of types) { expect(c.client.live!.status()[t]!.burstReads).toBe(1); expect(c.client.liveTypeHealth(t).lastBurstReadAt).toBe(1000900) }
    c.client.dispose()
  })
  it("ignores small bursts and permits disabling", async () => {
    for (const enabled of [true,false]) { const c=setup({enabled}); await c.open(); c.emit("Widget",enabled?31:100); await c.clock.tick(2000); expect(c.reads()).toBe(1); expect(c.client.liveTypeHealth("Widget").lastBurstReadAt).toBeNull(); c.client.dispose() }
  })
  it("bounds a sustained stream by maxWaitMs", async () => {
    const c=setup({maxWaitMs:1000}); await c.open()
    for(let i=0;i<10;i++) { c.emit(); await c.clock.tick(100) }
    expect(c.reads()).toBe(2); c.client.dispose()
  })
  it("waits while hidden and follows a read that started before the last event", async () => {
    const c=setup(); await c.open(); c.active(false); c.emit(); await c.clock.tick(3000); expect(c.reads()).toBe(1)
    c.active(true); await c.clock.tick(1000); expect(c.reads()).toBe(2)
    let resolve!: (r: GraphQLResponse)=>void
    c.answer(()=>new Promise(r=>{resolve=r})); const read=c.query.refetch(); c.emit(); await c.clock.tick(2500)
    c.answer(undefined); resolve({data:c.data()}); await read; await c.clock.tick(); expect(c.reads()).toBe(4); c.client.dispose()
  })
  it("adds no read to a list burst with a trailing invalidation already pending", async () => {
    const counts=[]
    for(const enabled of [false,true]) { const c=setup({enabled,lists:true}); await c.open(); c.emit(); await c.clock.tick(2500); counts.push(c.reads()); c.client.dispose() }
    expect(counts).toEqual([3,3])
  })
  it("rejects older snapshots, collects released records, and cancels on identity disposal", async () => {
    const c=setup(); await c.open(); c.version(4); c.emit(); c.streams.one("LiveWidget").emit(c.row("Widget",2)); c.version(3)
    await c.clock.tick(500); expect(c.client.store.get(encodeNodeId("Widget",["a"]))?.fields.get("RecordVersion")).toBe(4)
    c.emit(); c.query.close(); await c.clock.tick(1000); c.client.store.collect(); expect(c.reads()).toBe(2)
    c.client.dispose(); await c.clock.tick(20000); expect(c.streams.open.size).toBe(0); expect(c.client.store.isDisposed).toBe(true)
  })
  it("restart repairs and clears the pending burst without a second read", async () => {
    const c=setup(); await c.open(); c.emit(); c.streams.one("LiveWidget").loseContinuity(); await c.clock.tick(2500); expect(c.reads()).toBe(2); expect(c.client.liveTypeHealth("Widget").burstReads).toBe(0); c.client.dispose()
  })
})
