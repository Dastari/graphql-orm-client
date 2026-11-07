import { afterEach, expect, it, vi } from "vitest"
import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import { createClient } from "../src/client.js"
import { Store, ROOT_ID } from "../src/store/store.js"
import { lifetimeTime } from "../src/store/lifetime.js"
import { createMockNetwork, createTestClock } from "../src/test/index.js"
const schema = buildSchema(`type Query { Widget: Widget } type Widget { Id: ID! Name: String Expires: String RecordVersion: Int! }`)
const artifact = compile(schema, [`query One { Widget { Name } }`], { lifetimes: { Widget: { field: "Expires", format: "unix-seconds" } } }).operations.One!
afterEach(() => vi.useRealTimers())
it("selects explicit lifetime fields and leaves unconfigured schemas unchanged", () => {
 expect(artifact.text).toContain("Expires")
 expect(compile(schema,[`query One { Widget { Name } }`]).operations.One!.text).not.toContain("Expires")
 expect(()=>compile(schema,[`query One { Widget { Name } }`],{lifetimes:{Widget:{field:"Missing",format:"unix-seconds"}}})).toThrow(/lifetime/)
})
it.each([['1700000000','unix-seconds',1700000000000],['2026-01-01T00:00:00Z','rfc3339',1767225600000],['2026-01-01 00:00:00','sqlite-utc',1767225600000],['2026-01-01 00:00:00','rfc3339',null],['2026-02-30T00:00:00Z','rfc3339',null],['oops','unix-seconds',null]] as const)("parses %s only as %s", (value, format, expected)=>expect(lifetimeTime(value,format)).toBe(expected))
it("expires with one timer, rereads holders, rejects older versions and clears timers on identity disposal", async()=>{
 vi.useFakeTimers(); vi.setSystemTime(0)
 let version=2, expires="1", name="fresh", reads=0
 const client=createClient({network:{execute:async()=>{reads++;return {data:{Widget:{__typename:"Widget",Id:"w",RecordVersion:version,Name:name,Expires:expires}}}}}})
 const q=client.watchQuery(artifact,{});q.open();await q.refetch()
 expect(vi.getTimerCount()).toBe(1)
 version=1;expires="0";name="older";await q.refetch()
 expect(q.getState().lifetime).toBeUndefined()
 await vi.advanceTimersByTimeAsync(1000)
 expect(reads).toBeGreaterThan(2)
 expect(q.getState().lifetime).toBe("expired")
 version=3;expires="9000000000";await q.refetch()
 expect(q.getState().lifetime).toBeUndefined()
 expect(vi.getTimerCount()).toBe(1)
 client.dispose();expect(vi.getTimerCount()).toBe(0)
 expect(client.store.size).toBe(0)
})
it("reports unknown lifetime without guessing and collects expired retained graphs", async()=>{
 vi.useFakeTimers();vi.setSystemTime(0)
 const diagnostic=vi.fn()
 const store=new Store({retainMs:10,lifetimes:{Widget:{field:"Expires",format:"rfc3339"}},onDiagnostic:diagnostic})
 const record=store.getOrCreate("w","Widget");store.setField(record,"Expires","2026-01-01 00:00:00");store.publish()
 expect(store.lifetime("w")).toBe("unknown");expect(diagnostic).toHaveBeenCalledTimes(1)
 const release=store.retain("root",{id:ROOT_ID,selections:[],variables:{},fragments:{}});release()
 await vi.advanceTimersByTimeAsync(10);expect(store.size).toBe(0);store.dispose()
})
it("shares a timer across records and wakes safely for far-future expiries",async()=>{
 vi.useFakeTimers();vi.setSystemTime(0)
 const store=new Store({lifetimes:{Widget:{field:'Expires',format:'unix-seconds'}}})
 for(const [id,time] of [['soon','1'],['later','9000000000']]) {
  const record=store.getOrCreate(id!,'Widget');store.setField(record,'Expires',time)
 }
 store.publish();expect(vi.getTimerCount()).toBe(1)
 const selector={id:'soon',selections:[],variables:{},fragments:{}}
 const onChange=vi.fn();store.subscribe(store.lookup(selector),onChange)
 await vi.advanceTimersByTimeAsync(1000)
 expect(store.lookup(selector)).toMatchObject({data:null,missing:true,lifetime:'expired'})
 expect(onChange).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(1)
 await vi.advanceTimersByTimeAsync(2147483647)
 expect(store.lifetime('later')).toBe('valid');expect(vi.getTimerCount()).toBe(1)
 store.dispose();expect(vi.getTimerCount()).toBe(0)
})

it("a server that keeps returning an expired row causes one read, not a loop", async () => {
  const clock = createTestClock()
  let now = 1_000_000
  const schema = buildSchema(`type Query { Token: Token } type Token { Id: ID! ExpiresAt: Int! }`)
  const { operations } = compile(schema, [`query One { Token { Id } }`], { lifetimes: { Token: { field: "ExpiresAt", format: "unix-seconds" } } })
  const network = createMockNetwork({ respond: () => ({ data: { Token: { __typename: "Token", Id: "t1", ExpiresAt: 1001 } } }) })
  const client = createClient({ network, store: { ...clock.store, now: () => now } })
  const query = client.watchQuery(operations.One!, {})
  query.open()
  await clock.tick()
  expect(network.requests).toHaveLength(1)
  expect(query.getState().lifetime).toBeUndefined()
  now = 1_002_000
  await clock.tick(1000)
  await clock.tick(5000)
  expect(query.getState().lifetime).toBe("expired")
  expect(network.requests.length).toBeLessThanOrEqual(2)
  await clock.tick(60_000)
  expect(network.requests.length).toBeLessThanOrEqual(2)
  client.dispose()
})

it("a publish looks only at what changed, and the timer still finds the next expiry", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const store = new Store({ lifetimes: { Widget: { field: "Expires", format: "unix-seconds" } } })
  const write = (id: string, expires: string) => { const record = store.getOrCreate(id, "Widget"); store.setField(record, "Expires", expires) }
  for (let index = 0; index < 1000; index++) write(`w${index}`, "1000")
  store.publish()
  const spy = vi.spyOn(store, "lifetime")
  write("w0", "2000")
  store.publish()
  expect(spy.mock.calls.length).toBeLessThan(10)
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  spy.mockClear()
  await vi.advanceTimersByTimeAsync(1_000_000)
  expect(store.lifetime("w1")).toBe("expired")
  expect(store.lifetime("w0")).toBe("valid")
  await vi.advanceTimersByTimeAsync(1_000_000)
  expect(store.lifetime("w0")).toBe("expired")
  store.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
