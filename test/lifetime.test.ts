import { afterEach, expect, it, vi } from "vitest"
import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import { createClient } from "../src/client.js"
import { Store, ROOT_ID } from "../src/store/store.js"
import { lifetimeTime } from "../src/store/lifetime.js"
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
