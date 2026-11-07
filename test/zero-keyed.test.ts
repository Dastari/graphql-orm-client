import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { createClient } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"

const types=["Widget","Vendor","Ticket"]
function setup(mode: "key"|"keys"|"unkeyed", live: "explicit"|"default", required=false, cap=0) {
  const argument=mode==="unkeyed"?"":mode==="key"?"(Key: ID)":`(Keys: [ID!]${required?"!":""}, Key: ID)`
  const schema=buildSchema(`type Query { ${types.map(t=>`${t}: ${t}`).join(" ")} }
    type Subscription { ${types.map(t=>`${t}Changed${argument}: ${t}Event`).join(" ")} }
    ${types.map(t=>`type ${t} { Id: ID! Name: String RecordVersion: Int! } type ${t}Event { Action: String ${t}: ${t} }`).join("\n")}`)
  const docs=compile(schema,[...types.map(t=>`fragment ${t}Row on ${t} ${live==="explicit"?"@live":""} { Name }`),`query Page { ${types.map(t=>`${t} { ...${t}Row }`).join(" ")} }`],{live})
  const clock=createTestClock(), streams=createMockStreams()
  let id="a", reads=0
  const row=(type: string,version=1)=>({__typename:type,Id:id,Name:`v${version}`,RecordVersion:version})
  const client=createClient({network:{execute:async()=>{reads++;return {data:Object.fromEntries(types.map(t=>[t,row(t)]))}}},store:{...clock.store,retainMs:10},polling:clock.polling,live:{...clock.live,artifacts:docs.live,subscribe:streams.subscribe,connection:{state:()=>"connected",subscribe:listener=>streams.onReconnect(()=>listener({reconnected:true}))},maxKeyedSubscriptions:cap,settleMs:false,debounceMs:0,minRereadMs:1,resyncJitterMs:0,onDiagnostic:null}})
  const query=client.watchQuery(docs.operations.Page!,{})
  return {client,clock,streams,query,row,docs,reads:()=>reads,id:(value:string)=>{id=value},open:async()=>{query.open();await clock.tick()}}
}
describe("zero keyed cap",()=>{
  for(const mode of ["key","keys","unkeyed"] as const) for(const live of ["explicit","default"] as const) {
    it(`${mode} / ${live} keeps exactly N streams through disjoint held sets and recovers`,async()=>{
      const c=setup(mode,live);await c.open()
      expect(c.streams.open.size).toBe(3); expect(c.client.liveHealth().streams).toBe(3)
      for(const stream of c.streams.open) expect(stream.request.variables).toEqual({})
      for(const id of ["b","c","d"]) {
        c.id(id); await c.query.refetch(); await c.clock.tick(300)
        expect(c.streams.open.size).toBe(3);expect(c.streams.started).toHaveLength(3)
      }
      for(const type of types) {
        const stream=c.streams.one(`Live${type}`)
        stream.emit(c.row(type,4)); stream.emit(c.row(type,2))
        expect(c.client.store.get(encodeNodeId(type,["d"]))?.fields.get("RecordVersion")).toBe(4)
        stream.emit({...c.row(type),Id:"unheld"}); expect(c.client.store.get(encodeNodeId(type,["unheld"]))).toBeUndefined()
      }
      const before=c.reads(); c.streams.reconnect();await c.clock.tick();expect(c.reads()).toBe(before+1)
      c.streams.one("LiveWidget").loseContinuity();await c.clock.tick();expect(c.streams.open.size).toBe(3)
      expect(c.client.store.get(encodeNodeId("Widget",["d"]))?.fields.get("RecordVersion")).toBe(4)
      c.query.close();await c.clock.tick(300);c.client.store.collect();expect(c.streams.open.size).toBe(0)
      expect(c.client.store.get(encodeNodeId("Widget",["d"])) ).toBeUndefined()
      c.client.dispose();await c.clock.tick(20000);expect(c.client.store.isDisposed).toBe(true)
    })
  }
  it("required Keys remains narrowed and reports the limitation",async()=>{
    const c=setup("keys","explicit",true);await c.open()
    expect(c.docs.live.Widget!.mode).toBe("keys")
    expect(c.streams.one("LiveWidget").request.variables).toEqual({Keys:["a"]})
    expect(c.client.live!.status().Widget!.keyRequired).toBe(true)
    expect(c.client.liveTypeHealth("Widget").keyRequired).toBe(true);c.client.dispose()
  })
  it("nonzero caps remain ignored in Keys mode",async()=>{
    const c=setup("keys","default",false,1);await c.open()
    expect(c.streams.one("LiveWidget").request.variables).toEqual({Keys:["a"]})
    expect(c.client.liveTypeHealth("Widget").keyRequired).toBe(false);c.client.dispose()
  })
})
