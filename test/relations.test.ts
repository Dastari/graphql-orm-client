import { buildSchema, extendSchema, parse } from "graphql"
import { describe, it, expect } from "vitest"
import { compile, generate } from "../src/compiler/index.js"
import { createClient, readFragment, fragmentSelector } from "../src/client.js"
import { installRelationBatching } from "../src/relations.js"
import { createMockStreams } from "../src/test/index.js"
import { normalize, contextOf } from "../src/store/normalize.js"
import { encodeNodeId } from "../src/node-id.js"

const schema = buildSchema(`
 type Query { Tickets: [Ticket!]!, Vendors(Where: VendorWhereInput, Page: PageInput): VendorConnection! }
 type Ticket { Id: String!, VendorId: String, Vendor: Vendor }
 type Vendor { Id: String!, Name: String!, RecordVersion: Int! }
 type VendorConnection { Edges: [VendorEdge!]! }
 type VendorEdge { Node: Vendor! }
 input VendorWhereInput { Id: StringFilter }
 input StringFilter { InList: [String!] }
 input PageInput { Limit: Int }
`)
const sources = [
 `fragment Row on Ticket { Vendor @batch(foreignKey: "VendorId", root: "Vendors", key: "Id") { ...Badge } }`,
 `fragment Badge on Vendor { Name }`,
 `query Rows { Tickets { ...Row } }`,
 `query Other { Tickets { ...Row } }`,
]
const compiled = compile(schema, sources)
const row = (i: number, vendor = String(i)) => ({ __typename: "Ticket", Id: String(i), VendorId: vendor })
const pause = () => new Promise(resolve => setTimeout(resolve, 25))
function setup(rows = Array.from({ length: 200 }, (_, i) => row(i)), fail: boolean | "partial" = false, missing = false, polling?: import("../src/client.js").PollingOptions) {
 let namePrefix = ""
 const requests: string[][] = []
 const client = createClient({ polling, network: { execute: async request => {
  if (!request.name.startsWith("Batch_")) return { data: { Tickets: rows } }
  const ids = ((request.variables.Where as { Id: { InList: string[] } }).Id.InList)
  requests.push(ids)
  if (fail === true) throw new Error("offline")
  return { ...(fail === "partial" ? { errors: [{message:"denied"}] } : {}), data: { Vendors: { __typename: "VendorConnection", Edges: missing ? [] : ids.map(Id => ({ __typename: "VendorEdge", Node: { __typename: "Vendor", Id, Name: namePrefix + Id, RecordVersion: 1 } })) } } }
 } } })
 installRelationBatching(client, { withoutDocument: "read" })
 return { client, requests, setNamePrefix: (value: string) => { namePrefix = value } }
}
const read = (ref: unknown) => readFragment(compiled.fragments.Row!, ref) as { Vendor: { status: string; data?: unknown; error?: unknown } }
describe("batched relations", () => {
 it("removes relation, selects FK and generates masked state types", () => {
  const text = compiled.operations.Rows!.text
  expect(text).toContain("VendorId")
  expect(text).not.toContain("Vendor {")
  expect(generate(schema, sources)).toContain("RelationState<")
 })
 it("200 rows use two bounded reads, pending then shared normal records", async () => {
  const {client,requests} = setup()
  const result = await client.execute(compiled.operations.Rows!, {})
  const refs = (result.snapshot.data as { Tickets: unknown[] }).Tickets
  expect(read(refs[0]).Vendor.status).toBe("pending")
  refs.forEach(read)
  await pause()
  expect(requests.map(x => x.length)).toEqual([100,100])
  expect(read(refs[0]).Vendor.status).toBe("ready")
  expect(readFragment(compiled.fragments.Badge!, read(refs[0]).Vendor.data)).toMatchObject({Name:"0"})
  refs.forEach(read); await pause(); expect(requests).toHaveLength(2)
  client.dispose()
 })
 it("deduplicates across open queries", async () => {
  const {client,requests} = setup([row(1,"a"),row(2,"a")])
  const a = client.watchQuery(compiled.operations.Rows!, {}), b = client.watchQuery(compiled.operations.Other!, {})
  a.open(); b.open()
  await pause(); await pause()
  expect(requests).toEqual([["a"]])
  a.close(); b.close(); client.dispose()
 })
 for (const [label,fail,missing,status] of [["missing",false,true,"missing"],["failed chunk",true,false,"error"]] as const)
 it(label, async () => {
  const {client} = setup([row(1)], fail, missing)
  const result = await client.execute(compiled.operations.Rows!, {})
  const ref = (result.snapshot.data as {Tickets: unknown[]}).Tickets[0]
  read(ref); await pause(); expect(read(ref).Vendor.status).toBe(status); client.dispose()
 })
 it("reports a chunk's GraphQL errors per requested record without failing the parent", async () => {
  const {client}=setup([row(1),row(2)],'partial')
  const result=await client.execute(compiled.operations.Rows!,{})
  const refs=(result.snapshot.data as {Tickets:unknown[]}).Tickets
  expect(result.errors).toEqual([]);refs.forEach(read);await pause()
  expect(refs.map(ref=>read(ref).Vendor.status)).toEqual(['error','error'])
  client.dispose()
 })
 it("mounted fragment subscriptions retain relations and release them", async () => {
  const {client} = setup([row(1)])
  const result = await client.execute(compiled.operations.Rows!, {})
  const ref = (result.snapshot.data as {Tickets: unknown[]}).Tickets[0]
  const {selector} = fragmentSelector(compiled.fragments.Row!, ref)
  const stop = client.store.subscribe(client.store.lookup(selector), () => {})
  await pause(); client.store.collect()
  expect(read(ref).Vendor.status).toBe("ready")
  stop(); client.store.collect()
  expect(client.store.get(encodeNodeId("Vendor",["1"]))).toBeUndefined(); client.dispose()
 })
 it("identity disposal cancels queued reads", async () => {
  const {client,requests} = setup([row(1)])
  const result = await client.execute(compiled.operations.Rows!, {})
  read((result.snapshot.data as {Tickets: unknown[]}).Tickets[0]); client.dispose()
  await pause(); expect(requests).toHaveLength(0); expect(client.store.size).toBe(0)
 })
 it("shares projections from different relation sites", async () => {
  const other = sources.slice(0,2).concat('fragment OtherRow on Ticket { Vendor @batch(foreignKey: "VendorId", root: "Vendors", key: "Id") { Id } }', 'query First { Tickets { ...Row } }','query Second { Tickets { ...OtherRow } }')
  const c = compile(schema, other)
  const {client,requests} = setup([row(1)])
  const a = client.watchQuery(c.operations.First!, {}), b = client.watchQuery(c.operations.Second!, {})
  a.open(); b.open(); await pause(); await pause()
  expect(requests).toEqual([["1"]]); client.dispose()
 })
 it("collecting the store starts no relation read, and an unchanged read notifies nobody", async () => {
  const { client, requests } = setup([row(1)])
  const q = client.watchQuery<{ Tickets: unknown[] }>(compiled.operations.Rows!, {})
  q.open()
  await pause(); await pause()
  const before = requests.length
  // Its relation state is gone, so a read would ask again; a collection must only look.
  for (const id of [...(client.store as unknown as { records: Map<string, unknown> }).records.keys()]) if (id.startsWith("client:batch:")) client.store.delete(id)
  client.store.collect()
  await pause()
  expect(requests.length).toBe(before)
  let notified = 0
  const stop = q.subscribe(() => { notified++ })
  const ticket = client.store.get(encodeNodeId("Ticket", ["1"]))!
  client.store.setField(ticket, "NotSelected", 1)
  client.store.publish()
  expect(notified).toBe(0)
  stop()
  client.dispose()
 })

 it("live foreign-key changes, version conflicts and reconnect recovery", async () => {
  const liveSchema = extendSchema(schema,parse(`
   extend schema { subscription: Subscription }
   type Subscription { TicketChanged(Keys: [String!]): TicketEvent! VendorChanged(Keys: [String!]): VendorEvent! }
   type TicketEvent { Action: String! Ticket: Ticket }
   type VendorEvent { Action: String! Vendor: Vendor }
   extend type Ticket { RecordVersion: Int! }
  `))
  const c = compile(liveSchema, sources.map(s=>s.replace('on Ticket {','on Ticket @live {').replace('on Vendor {','on Vendor @live {')))
  const streams = createMockStreams()
  let key = 'a', version = 1, name = 'first'
  const ids: string[][] = []
  const client = createClient({network:{execute:async r=>{
   if(!r.name.startsWith('Batch_'))return {data:{Tickets:[{...row(1,key),RecordVersion:version}]}}
   const values=(r.variables.Where as {Id:{InList:string[]}}).Id.InList
   ids.push(values)
   return {data:{Vendors:{__typename:'VendorConnection',Edges:values.map(Id=>({__typename:'VendorEdge',Node:{__typename:'Vendor',Id,Name:name,RecordVersion:version}}))}}}
  }},live:{artifacts:c.live,subscribe:streams.subscribe,settleMs:false,debounceMs:0,minRereadMs:1,onDiagnostic:null}})
  installRelationBatching(client, { withoutDocument: "read" })
  const q=client.watchQuery<{Tickets:unknown[]}>(c.operations.Rows!,{});q.open()
  await pause(); await pause()
  const shown=()=>readFragment(c.fragments.Row!,q.getState().data!.Tickets[0]) as {Vendor:{status:string;data:unknown}}
  expect(shown().Vendor.status).toBe('ready')
  expect(streams.one('LiveVendor')).toBeDefined()
  key='b';version=3
  streams.one('LiveTicket').emit({...row(1,key),RecordVersion:version})
  expect(shown().Vendor.status).toBe('pending')
  await pause();await pause()
  expect(ids.flat()).toContain('b')
  streams.one('LiveTicket').emit({...row(1,'old'),RecordVersion:2})
  await pause();expect(ids.flat()).not.toContain('old')
  const vendorId=encodeNodeId('Vendor',['b'])
  streams.one('LiveVendor').emit({__typename:'Vendor',Id:'b',Name:'newer',RecordVersion:5})
  const batch=(c.fragments.Row!.selections.find(s=>s.kind==='link') as import('../src/artifact.js').LinkSelection).batch!.operation
  normalize(client.store,batch.normalization,{Vendors:{__typename:'VendorConnection',Edges:[{__typename:'VendorEdge',Node:{__typename:'Vendor',Id:'b',Name:'older',RecordVersion:4}}]}},contextOf(batch,{}));client.store.publish()
  expect(client.store.get(vendorId)?.fields.get('Name')).toBe('newer')
  name='recovered';version=6
  streams.one('LiveVendor').loseContinuity()
  await expect.poll(()=>client.store.get(vendorId)?.fields.get('Name'),{timeout:4000}).toBe('recovered')
  client.dispose()
 })
 it("explicit lower chunk limit and null keys", async () => {
  const c=compile(schema,sources.map(s=>s.replace('key: "Id")','key: "Id", limit: 2)')))
  const {client,requests}=setup(Array.from({length:5},(_,i)=>row(i)))
  const q=client.watchQuery(c.operations.Rows!,{});q.open();await pause();await pause()
  expect(requests.map(ids=>ids.length)).toEqual([2,2,1]);client.dispose()
  const other=setup([{__typename:'Ticket',Id:'null',VendorId:null} as unknown as ReturnType<typeof row>])
  const result=await other.client.execute(compiled.operations.Rows!,{})
  expect(read((result.snapshot.data as {Tickets:unknown[]}).Tickets[0]).Vendor.status).toBe('missing')
  await pause();expect(other.requests).toHaveLength(0);other.client.dispose()
 })
 it("disposal aborts an in-flight chunk and ignores its late response", async () => {
  let finish: ((value: import('../src/client.js').GraphQLResponse)=>void) | undefined
  let signal: AbortSignal | undefined
  const client=createClient({network:{execute:async (r,o)=>{
   if(!r.name.startsWith('Batch_'))return {data:{Tickets:[row(1)]}}
   signal=o.signal
   return new Promise(resolve=>{finish=resolve})
  }}})
  installRelationBatching(client, { withoutDocument: "read" })
  const result=await client.execute(compiled.operations.Rows!,{})
  read((result.snapshot.data as {Tickets:unknown[]}).Tickets[0]);await pause()
  expect(finish).toBeDefined();client.dispose();expect(signal?.aborted).toBe(true)
  finish!({data:{Vendors:{__typename:'VendorConnection',Edges:[]}}});await pause()
  expect(client.store.size).toBe(0)
 })
 it("polling refreshes cached related records", async () => {
  let poll: (()=>void) | undefined
  const {client,setNamePrefix}=setup([row(1)],false,false,{undeclared:'off',setInterval:cb=>{poll=cb;return 1},clearInterval:()=>{}})
  const q=client.watchQuery<{Tickets:unknown[]}>(compiled.operations.Rows!,{},{pollMs:100})
  q.open();await pause();await pause()
  setNamePrefix('fresh:');poll!();await pause();await pause()
  const relation=read(q.getState().data!.Tickets[0]).Vendor
  expect(readFragment(compiled.fragments.Badge!,relation.data)).toMatchObject({Name:'fresh:1'})
  client.dispose()
 })
 it("rejects unsupported key/filter and oversized chunks at build time", () => {
  for (const source of [sources[0]!.replace('key: "Id"','key: "Name"'), sources[0]!.replace('key: "Id"','key: "Id", limit: 101'), sources[0]!.replace('root: "Vendors"','root: "Tickets"'), sources[0]!.replace('{ ...Badge }','@skip(if: true) { ...Badge }'), sources[0]!.replace('{ ...Badge }','{ Name @batch(foreignKey: "VendorId", root: "Vendors", key: "Id") }')])
   expect(() => compile(schema, [source,sources[1]!])).toThrow(/Ticket\.Vendor|@skip is unsupported/)
 })
})
