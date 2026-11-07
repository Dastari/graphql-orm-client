import assert from 'node:assert/strict'
import { installRelationBatching } from '../dist/relations.js'
import { readAll } from '../dist/read-all.js'
import { liveSettingCheck } from './live-setting.mjs'
import { doctorChecks } from './doctor.mjs'
import { browserRecovery } from './browser.mjs'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync=promisify(execFile)
import { createServer } from 'node:http'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { WebSocket } from 'ws'
import { createClient as createWs } from 'graphql-ws'
import { buildSchema, execute, parse, print, buildClientSchema, getIntrospectionQuery } from 'graphql'
import { compile } from '../dist/compiler/index.js'
import { createClient, createHttpNetwork, graphqlWsTransport, encodeNodeId, readFragment } from '../dist/index.js'

const scratch = process.env.CONFORMANCE_SCRATCH
const base = Number(process.env.PORT_BASE ?? 42000)
assert(base >= 42000 && base + 4 <= 42099)
const serviceUrl = `http://127.0.0.1:${base+1}`
const routerUrl = `http://127.0.0.1:${base+2}/graphql`
const frontUrl = `http://127.0.0.1:${base+3}`
const children = new Set(), sockets = new Set()
process.on('exit',()=>{for(const p of children)p.kill('SIGKILL')})
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>process.exit(1))
function listen(server,port) {return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(label, f, ms = 15000) {
  const end = Date.now()+ms
  while (Date.now()<end) { if (await f()) return; await sleep(25) }
  throw Error(`Timed out: ${label}`)
}
function child(bin, args, env={}) {
  const p = spawn(bin,args,{env:{...process.env,...env},stdio:['ignore','ignore','inherit']}); children.add(p)
  p.on('error', e => { console.error(e); process.exitCode=1 }); p.once('exit',()=>children.delete(p)); return p
}
const { publicKey, privateKey } = generateKeyPairSync('rsa',{modulusLength:2048})
const jwk = {...publicKey.export({format:'jwk'}),kid:'test',use:'sig',alg:'RS256'}
const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url')
const unsigned = `${b64({alg:'RS256',kid:'test'})}.${b64({sub:'conformance',iss:'https://conformance.local',aud:['graphql-router'],exp:Math.floor(Date.now()/1000)+3600})}`
const token = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`
const headers = {'content-type':'application/json',authorization:`Bearer ${token}`}
const batchRouterReads = []
let revision = 0, originalSdl, originalDescriptor
async function post(query, variables={}, url=routerUrl, allowErrors=false) {
  const result = await (await fetch(url,{method:'POST',headers,body:JSON.stringify({query,variables})})).json()
  if (!allowErrors) assert(!result.errors,JSON.stringify(result))
  return result
}
const front = createServer(async(req,res)=>{
  try {
    if(req.url==='/jwks') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({keys:[jwk]})) }
    if(req.url==='/batch') {
      let body=''; for await(const chunk of req) body+=chunk
      const request=JSON.parse(body)
      const response=await fetch(routerUrl,{method:'POST',headers,body})
      batchRouterReads.push({name:request.operationName,variables:request.variables})
      res.statusCode=response.status;res.setHeader('content-type','application/json')
      return res.end(await response.text())
    }
    if(req.url==='/page') return res.end('<!doctype html><title>Conformance</title>')
    const sdl = originalSdl + (revision ? `\nextend type Widget { Revision${revision}: String }\n` : '')
    if(req.url==='/sdl') return res.end(sdl)
    if(req.url==='/.well-known/graphql-router') {
      // 0.90.1 catalogue omits ExpectedVersion on managed writes. Keep the fixture's
      // descriptor arguments equal to its SDL (see README); no client workaround.
      const descriptor = structuredClone(originalDescriptor)
      const defs = parse(sdl).definitions
      for (const op of descriptor.operations) {
        const root = {query:'Query', mutation:'Mutation', subscription:'Subscription'}[op.rootType]
        const field = defs.find(d=>d.name?.value===root)?.fields?.find(f=>f.name.value===op.fieldName)
        if(field) op.arguments=field.arguments.map(a=>({name:a.name.value,graphqlType:print(a.type),required:a.type.kind==='NonNullType'&&!a.defaultValue}))
      }
      await writeFile(`${scratch}/descriptor.json`,JSON.stringify(descriptor)); await writeFile(`${scratch}/schema.graphql`,sdl)
      const {stdout:d} = await execFileAsync(process.env.SERVICE_BIN,['--fingerprint',`${scratch}/descriptor.json`,`${scratch}/schema.graphql`])
      res.setHeader('content-type','application/json');return res.end(d)
    }
    res.statusCode=404;res.end()
  } catch(e) { res.statusCode=500;res.end(String(e)) }
})
const remoteUrl=`http://127.0.0.1:${base+4}`
const remoteSdl=`extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key", "@external"])
 type Widget @key(fields: "NodeId") { NodeId: ID! @external RemoteName: String! }
 type Vendor @key(fields: "Id") { Id: String! @external RemoteName: String! }
 type Query { ConformanceRemote: String }`
const remoteSchema=buildSchema(`scalar _Any
 union _Entity = Widget | Vendor
 type Vendor { Id: String! RemoteName: String! }
 type Widget { NodeId: ID! RemoteName: String! }
 type Query { ConformanceRemote: String _entities(representations: [_Any!]!): [_Entity]! }`)
const remote=createServer(async(req,res)=>{
 try {
  if(req.url==='/sdl')return res.end(remoteSdl)
  if(req.url==='/.well-known/graphql-router') {
   const d=structuredClone(originalDescriptor)
   d.subgraph={id:'remote',name:'remote'};d.graphql={http:`${remoteUrl}/graphql`};d.schema={url:`${remoteUrl}/sdl`};d.capabilities.subscriptions=false
   d.operations=[{rootType:'query',fieldName:'ConformanceRemote',arguments:[],authorization:{kind:'public'}}]
   await writeFile(`${scratch}/remote.json`,JSON.stringify(d));await writeFile(`${scratch}/remote.graphql`,remoteSdl)
   const {stdout}=await execFileAsync(process.env.SERVICE_BIN,['--fingerprint',`${scratch}/remote.json`,`${scratch}/remote.graphql`])
   res.setHeader('content-type','application/json');return res.end(stdout)
  }
  let body='';for await(const c of req)body+=c
  const {query,variables}=JSON.parse(body)
  const result=await execute({schema:remoteSchema,document:parse(query),variableValues:variables,rootValue:{_entities:({representations})=>representations.map(r=>({...r,__typename:r.__typename,RemoteName:'Remote'}))}})
  res.setHeader('content-type','application/json');res.end(JSON.stringify(result))
 }catch(e){res.statusCode=500;res.end(String(e))}
})
let router
async function startRouter() {
 router=child(process.env.ROUTER_BIN,['--config',`${scratch}/router.json`])
 await until('router ready',async()=>{if(router.exitCode!==null)throw Error(`Router exited ${router.exitCode}`);try{return !!(await post('{__typename}')).data}catch{return false}})
}
async function stopRouter() { const p=router; await new Promise(r=>{p.once('exit',r);p.kill('SIGKILL')}) }
async function raw() {
 const ws=new WebSocket(routerUrl.replace('http','ws'),'graphql-transport-ws');sockets.add(ws)
 const frames=[];ws.on('message',d=>frames.push(JSON.parse(d)))
 await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)})
 ws.send(JSON.stringify({type:'connection_init',payload:{authorization:`Bearer ${token}`}}))
 await until('connection ack',()=>frames.some(x=>x.type==='connection_ack'))
 let n=0
 return {ws,frames,subscribe(query,variables={}){const id=String(++n);ws.send(JSON.stringify({id,type:'subscribe',payload:{query,variables}}));return id}}
}
const stream = (args='',fields='Id Name RecordVersion') => `subscription { WidgetChanged${args} { Action Id Widget { ${fields} } } }`
const failures=[]
let passed=0
function pass(label){passed++;console.log(`PASS ${label}`)}
try {
 await listen(front,base+3)
 await listen(remote,base+4)
 child(process.env.SERVICE_BIN,[],{SERVICE_PORT:String(base+1)})
 await until('service ready',async()=>{try{originalSdl=await(await fetch(`${serviceUrl}/sdl`)).text();originalDescriptor=await(await fetch(`${serviceUrl}/.well-known/graphql-router`)).json();return true}catch{return false}})
 await writeFile(`${scratch}/router.json`,JSON.stringify({listener:`127.0.0.1:${base+2}`,graphqlPath:'/graphql',nodeLookup:{},authentication:{jwksUrl:`${frontUrl}/jwks`,issuer:'https://conformance.local',audiences:['graphql-router'],allowInsecureLoopbackJwks:true},subscriptions:{maxOperationsPerConnection:32},schemaPollIntervalMs:200,gracefulShutdownTimeoutSeconds:1,subgraphs:[{name:'widgets',graphqlUrl:`${serviceUrl}/graphql`,sdlUrl:`${frontUrl}/sdl`,protocolUrl:`${frontUrl}/.well-known/graphql-router`},{name:'remote',graphqlUrl:`${remoteUrl}/graphql`,sdlUrl:`${remoteUrl}/sdl`,protocolUrl:`${remoteUrl}/.well-known/graphql-router`}]}))
 await startRouter()
 const schema=buildClientSchema((await post(getIntrospectionQuery())).data)
 await writeFile(`${scratch}/introspection.json`,JSON.stringify((await post(getIntrospectionQuery())).data))
 await writeFile(`${scratch}/served.graphql`,originalSdl)
 console.log('Service SDL saved in scratch')
 // R13: 200 Ticket rows, two parent pages, two bounded Vendor reads.
 for (let i=0;i<200;i++) {
  await post('mutation($Input: CreateVendorInput!) { CreateVendor(Input: $Input) { Success } }',{Input:{Id:`batch-v${i}`,Name:`Vendor ${i}`}})
  await post('mutation($Input: CreateTicketInput!) { CreateTicket(Input: $Input) { Success } }',{Input:{Id:`batch-t${i}`,VendorId:`batch-v${i}`,Title:'Batch'}})
 }
 const batched=compile(schema,[
  'fragment BatchBadge on Vendor { Name }',
  'fragment BatchRow on Ticket { Vendor @batch(foreignKey: "VendorId", root: "Vendors", key: "Id") { ...BatchBadge } }',
  'query BatchTickets($Page: PageInput, $Where: TicketWhereInput) { Tickets(Page: $Page, Where: $Where) { Edges { Node { ...BatchRow } } } }',
 ])
 const routerReads=batchRouterReads
 const batchNetwork=createHttpNetwork({url:`${frontUrl}/batch`,headers})
 const batchClient=createClient({network:batchNetwork})
 installRelationBatching(batchClient, { withoutDocument: "read" })
 const batchRefs=[]
 for(const Offset of [0,100]) {
  const result=await batchClient.execute(batched.operations.BatchTickets,{Page:{Limit:100,Offset},Where:{Id:{InList:Array.from({length:200},(_,i)=>`batch-t${i}`)}}})
  batchRefs.push(...result.snapshot.data.Tickets.Edges.map(edge=>edge.Node))
 }
 assert.equal(batchRefs.length,200)
 assert.equal(readFragment(batched.fragments.BatchRow,batchRefs[0]).Vendor.status,'pending')
 batchRefs.forEach(ref=>readFragment(batched.fragments.BatchRow,ref))
 await until('batched related names',()=>batchRefs.every(ref=>readFragment(batched.fragments.BatchRow,ref).Vendor.status==='ready'))
 assert.equal(routerReads.length,4)
 assert.deepEqual(routerReads.filter(r=>r.name.startsWith('Batch_')).map(r=>r.variables.Where.Id.InList.length),[100,100])
 for(const ref of batchRefs) assert.match(readFragment(batched.fragments.BatchBadge,readFragment(batched.fragments.BatchRow,ref).Vendor.data).Name,/^Vendor /)
 batchClient.dispose()
 // Restore fixture cardinality for the existing list assertions.
 for(let i=0;i<200;i++) {
  await post(`mutation { DeleteTicket(Id: "batch-t${i}") { Success } }`)
  await post(`mutation { DeleteVendor(Id: "batch-v${i}") { Success } }`)
 }
 pass('R13: 200 rows, two parent pages and two batched relation reads through the router')
 const a=await raw()
 const all=a.subscribe(stream()), empty=a.subscribe(stream('(Keys: [])')), keys=a.subscribe(stream('(Keys: ["w1"])')), key=a.subscribe(stream('(Key: "w1")'))
 await sleep(300)
 const create=(id,name)=>post('mutation($Input: CreateWidgetInput!) { CreateWidget(Input: $Input) { Success Error Widget { __typename Id Name NodeId RecordVersion } } }',{Input:{Id:id,Name:name}})
 const w1=(await create('w1','Alpha')).data.CreateWidget.Widget
 await until('created delivery',()=>a.frames.filter(x=>x.type==='next').length>=3)
 assert.equal(a.frames.filter(x=>x.id===empty).length,0)
 for(const id of [all,keys,key])assert.equal(a.frames.find(x=>x.id===id).payload.data.WidgetChanged.Id,'w1')
 await create('w2','Beta');await sleep(300)
 assert.equal(a.frames.filter(x=>x.id===all).length,2)
 for(const id of [keys,key])assert.equal(a.frames.filter(x=>x.id===id).length,1)
 pass('Keys empty matches no rows; keys/key/unkeyed CREATED delivery')
 assert.equal(w1.NodeId,encodeNodeId('Widget',['w1']))
 const node=(await post('query($id: ID!) { node(NodeId: $id) { ... on Widget { Id Name NodeId } } }',{id:w1.NodeId})).data.node
 assert.equal(node.Id,'w1');assert.equal(node.NodeId,w1.NodeId)
 const slot=(await post('{ Slot(Site: "north", Name: "a") { NodeId } }')).data.Slot
 assert.equal(slot.NodeId,encodeNodeId('Slot',['north','a']))
 assert.equal((await post('query($id: ID!) { node(NodeId: $id) { ... on Slot { Site Name } } }',{id:slot.NodeId})).data.node.Site,'north')
 pass('single and composite server NodeIds agree with client; router node lookup')
 // From 0.92.0 a stream admits NodeId, and so a federated field keyed on it (#312).
 const minor=Number((process.env.GRAPHQL_ORM_TAG??'').match(/v0\.(\d+)/)?.[1]??0)
 const nodeIdAdmitted=minor>=92
 for (const [label,q] of [...(nodeIdAdmitted?[]:[['federated',stream('', 'Id RemoteName')],['NodeId',stream('', 'Id NodeId')]]),['computed RecordVersion','subscription { TicketChanged { Ticket { Id RecordVersion } } }'],['computed','subscription { TicketChanged { Ticket { Id Summary } } }'],['relation','subscription { TicketChanged { Ticket { Id Vendor { Id } } } }']]) {
  const id=a.subscribe(q);await until(`${label} refusal`,()=>a.frames.some(x=>x.id===id))
  const frame=a.frames.find(x=>x.id===id);assert.equal((frame.payload.errors??frame.payload)[0].extensions.code,'INVALID_INPUT',JSON.stringify(frame));console.log(`${label} refusal frame: ${frame.type}`)
 }
 if(nodeIdAdmitted){
  const admitted=await raw(), nodeIdStream=admitted.subscribe(stream('', 'Id NodeId'))
  await sleep(300)
  await post('mutation { UpdateWidget(Id: "w1", Input: {Name: "NodeId carried"}) { Success } }')
  await until('NodeId event',()=>admitted.frames.some(f=>f.id===nodeIdStream))
  const carried=admitted.frames.find(f=>f.id===nodeIdStream)
  assert.equal(carried.type,'next');assert.equal(carried.payload.data.WidgetChanged.Widget.NodeId,encodeNodeId('Widget',['w1']))
  admitted.ws.close()
 }
 pass(`${nodeIdAdmitted?'NodeId delivered in a stream; ':'NodeId refused INVALID_INPUT; '}hand-written RecordVersion, computed and relation selections refused INVALID_INPUT; managed RecordVersion delivered`)
 for(const [field,code] of [['ContinuityLost','SUBSCRIPTION_CONTINUITY_LOST'],['SourceClosed','SUBSCRIPTION_SOURCE_CLOSED']]) {
  const id=a.subscribe(`subscription { ${field} }`)
  await until(code,()=>a.frames.some(f=>f.id===id&&f.type==='complete'))
  const frames=a.frames.filter(f=>f.id===id)
  assert.equal(frames[0].type,'next');assert.equal(frames[0].payload.errors[0].extensions.code,code);assert.equal(frames[1].type,'complete')
 }
 pass('ORM continuity adapter: lost/closed channel next error then complete through router')
 const federated=a.subscribe('subscription { VendorChanged { Vendor { Id RemoteName } } }')
 await sleep(300)
 await post('mutation { UpdateVendor(Id: "v1", Input: {Name: "Changed"}) { Success } }')
 await until('persisted-key federation event',()=>a.frames.some(f=>f.id===federated))
 const federatedFrame=a.frames.find(f=>f.id===federated)
 assert.equal(federatedFrame.type,'next');assert(!federatedFrame.payload.errors,JSON.stringify(federatedFrame))
 assert.equal(federatedFrame.payload.data.VendorChanged.Vendor.RemoteName,'Remote')
 pass(`federated scalar with persisted Id key is admitted and fetched per event${nodeIdAdmitted?'':'; NodeId-key federation is refused'}`)
 // The raw frame path proves the protocol violation separately from graphql-ws recovery.
 revision++
 await until('reload error',()=>a.frames.some(x=>x.id===all&&x.type==='error'))
 const reload=a.frames.filter(x=>x.id===all).slice(-2)
 assert.equal(reload[0].payload[0].extensions.code,'SUBSCRIPTION_SCHEMA_RELOAD');assert.equal(reload[1].type,'complete')
 const retired=a.subscribe(stream());await until('retired refusal',()=>a.frames.some(x=>x.id===retired))
 assert.equal(a.frames.find(x=>x.id===retired).payload[0].extensions.code,'SERVICE_UNAVAILABLE')
 a.ws.close();pass('reload error then complete; retired connection SERVICE_UNAVAILABLE')
 const limit=await raw();for(let i=0;i<33;i++)limit.subscribe(stream('(Keys: [])'))
 await until('operation limit',()=>limit.frames.some(x=>JSON.stringify(x).includes('SUBSCRIPTION_LIMIT_EXCEEDED')))
 assert.equal(limit.frames.filter(x=>JSON.stringify(x).includes('SUBSCRIPTION_LIMIT_EXCEEDED')).length,1)
 limit.ws.close();pass('32 admitted operations; operation 33 SUBSCRIPTION_LIMIT_EXCEEDED')
 const updateDirect = name => post('mutation($Input: UpdateWidgetInput!) { UpdateWidget(Id: \"w1\", Input: $Input) { Success } }',{Input:{Name:name}},`${serviceUrl}/graphql`)
 const update = async name => (await post('mutation($Input: UpdateWidgetInput!) { UpdateWidget(Id: "w1", Input: $Input) { Success Widget { __typename Id Name NodeId RecordVersion } } }',{Input:{Name:name}})).data.UpdateWidget.Widget
 // A generated service burst through the real router. Frame loss is timing-dependent.
 {
  const docs=compile(schema,[`fragment BurstRow on Widget @live { Name }`,`query BurstHeld { Widget(Id: "w1") { ...BurstRow } }`])
  const ws=createWs({url:routerUrl.replace('http:','ws:'),webSocketImpl:WebSocket,connectionParams:{authorization:`Bearer ${token}`},retryAttempts:Infinity})
  const transport=graphqlWsTransport(ws)
  let frames=0
  const c=createClient({network:createHttpNetwork({url:routerUrl,headers}),live:{artifacts:docs.live,...transport,settleMs:false,debounceMs:0,onDiagnostic:null,
   subscribe:(request,sink)=>transport.subscribe(request,{...sink,next:r=>{if(r.data?.WidgetChanged) frames++;sink.next(r)}})}})
  const q=c.watchQuery(docs.operations.BurstHeld,{})
  q.open(); await until('burst holder ready',()=>q.getState().status==='ready')
  await sleep(500)
  await update('burst-ready'); await until('burst stream admitted',()=>frames>0)
  await Promise.all(Array.from({length:8},(_,worker)=>(async()=>{
   for(let i=0;i<125;i++) {
    const result=await updateDirect(`burst-${worker}-${i}`)
    assert.equal(result.data.UpdateWidget.Success,true)
   }
  })()))
  const finalWriteAt=Date.now()
  const final=await update('burst-final')
  try { await until('burst repair request',()=>c.live.status().Widget.lastBurstReadAt>=finalWriteAt,20000) }
  catch(error) { console.error('Burst failure', JSON.stringify({frames,health:c.liveHealth(),status:c.live.status()},null,2));throw error }
  await until('burst repair completed',()=>q.getState().status==='ready')
  await until('burst final row',()=>c.store.get(encodeNodeId('Widget',['w1']))?.fields.get('RecordVersion')===final.RecordVersion,20000)
  assert.equal(c.store.get(encodeNodeId('Widget',['w1'])).fields.get('Name'),'burst-final')
  console.log(`Burst: ${frames}/1002 frames arrived; burstReads=${c.live.status().Widget.burstReads}`)
  c.dispose(); await ws.dispose()
  pass('burst repair reaches final generated row through router, with counted repair read')
 }
 const old = (await post('{ Widget(Id: "w1") { __typename Id Name NodeId RecordVersion } }')).data.Widget
 const newer = await update('Newest')
 assert(newer.RecordVersion > old.RecordVersion)
 const counts = compile(schema, [
   `fragment CountLive on Widget @live { Name }`,
   `query Counts { first: Widgets { PageInfo { n: TotalCount } } second: Widgets { PageInfo { TotalCount } }
     summary: WidgetsAggregate(GroupBy: [], Metrics: [{Operator: COUNT}], GroupLimit: 1) { Metrics { Kind Value } } }`
 ])
 assert.deepEqual(counts.operations.Counts.lists, ['Widget'])
 const countWs = createWs({ url: routerUrl.replace('http:', 'ws:'), webSocketImpl: WebSocket, connectionParams: {authorization: `Bearer ${token}`}, retryAttempts: Infinity })
 const countClient = createClient({ network: createHttpNetwork({url:routerUrl,headers}), live: { artifacts: counts.live, ...graphqlWsTransport(countWs), minRereadMs: 0, debounceMs: 0, settleMs: false, onDiagnostic: null } })
 const countQuery = countClient.watchQuery(counts.operations.Counts, {})
 countQuery.open()
 await until('initial counts', () => countQuery.getState().data?.first.PageInfo.n != null)
 await sleep(300)
 const beforeCount = countQuery.getState().data.first.PageInfo.n
 await create('count-new', 'Count new')
 await until('aliased count and aggregate creation', () => {
   const data = countQuery.getState().data
   return data?.first.PageInfo.n === beforeCount + 1 && data.second.PageInfo.TotalCount === beforeCount + 1 && data.summary[0].Metrics[0].Value === String(beforeCount + 1)
 })
 countQuery.close(); countClient.dispose(); await countWs.dispose()
 await post('mutation { DeleteWidget(Id: "count-new") { Success } }')
 pass('R15 aliased counts and generated aggregate refresh after external creation')
 // A real create above rows on a page with room keeps them all, and a rename elsewhere reaches a row still shown.
 {
  const roomy=compile(schema,[`fragment RoomyRow on Widget @live { Name }`,`query Roomy($Page: PageInput) { Widgets(OrderBy: [{ Name: ASC }, { Id: ASC }], Page: $Page) @connection(key: "roomy") { Edges { Node { Id ...RoomyRow } } } }`])
  const socket=createWs({url:routerUrl.replace('http','ws'),webSocketImpl:WebSocket,connectionParams:{authorization:`Bearer ${token}`}})
  const client=createClient({network:createHttpNetwork({url:routerUrl,headers}),live:{artifacts:roomy.live,...graphqlWsTransport(socket),onDiagnostic:null}})
  const list=client.watchQuery(roomy.operations.Roomy,{Page:{Limit:100,Offset:0}})
  list.open()
  await until('roomy read',()=>list.getState().status==='ready')
  await sleep(1000)
  const names=()=>list.getState().data.Widgets.Edges.map(edge=>readFragment(roomy.fragments.RoomyRow,edge.Node).Name)
  const before=names()
  await post('mutation { CreateWidget(Input: {Id: "roomy-first", Name: "!First in the list"}) { Success } }')
  await until('created row appears',()=>names().includes('!First in the list'))
  assert(before.every(name=>names().includes(name)),`a new row pushed one out: ${JSON.stringify(names())}`)
  await post('mutation { UpdateWidget(Id: "roomy-first", Input: {Name: "!Renamed in the list"}) { Success } }')
  await until('rename appears',()=>names().includes('!Renamed in the list'))
  list.close();client.dispose();await socket.dispose()
  // Later checks count the rows, so leave none behind.
  await post('mutation { DeleteWidget(Id: "roomy-first") { Success } }')
  pass('a page with room keeps its rows when one is created above them, and a rename elsewhere reaches a row')
 }
 // A keyset list loaded in three pages, the last partly filled, refreshes in one real request, and a row created inside it appears.
 {
  for (const id of ['ks-a','ks-b','ks-c']) await post(`mutation { CreateWidget(Input: {Id: "${id}", Name: "${id}"}) { Success } }`)
  const keyset=compile(schema,[`fragment KeysetRow on Widget @live { Name }`,`query Keyset($Page: KeysetPageInput!) { WidgetsKeyset(Page: $Page) @connection(key: "keyset") { Edges { Node { Id ...KeysetRow } } PageInfo { EndCursor HasNextPage } } }`])
  const socket=createWs({url:routerUrl.replace('http','ws'),webSocketImpl:WebSocket,connectionParams:{authorization:`Bearer ${token}`}})
  const http=createHttpNetwork({url:routerUrl,headers}), pages=[]
  const client=createClient({network:{execute:(r,o)=>{ if (r.name==='Keyset') pages.push(r.variables.Page); return http.execute(r,o) }},live:{artifacts:keyset.live,...graphqlWsTransport(socket),minRereadMs:0,debounceMs:0,settleMs:false,onDiagnostic:null}})
  const list=client.watchQuery(keyset.operations.Keyset,{Page:{limit:2}})
  list.open()
  await until('keyset read',()=>list.getState().status==='ready')
  await list.loadMore(); await list.loadMore()
  const ids=()=>list.getState().data.WidgetsKeyset.Edges.map(edge=>edge.Node.Id)
  assert.deepEqual(ids(),['ks-a','ks-b','ks-c','w1','w2']); assert.equal(list.getState().hasMore,false)
  await sleep(500); pages.length=0
  await list.refetch()
  assert.deepEqual(pages,[{limit:6}],`refetch sent ${JSON.stringify(pages)}`)
  pages.length=0
  await post('mutation { CreateWidget(Input: {Id: "ks-d", Name: "ks-d"}) { Success } }')
  await until('created keyset row appears',()=>ids().includes('ks-d'))
  await sleep(500)
  assert.deepEqual(ids(),['ks-a','ks-b','ks-c','ks-d','w1','w2'])
  assert(pages.length>=1&&pages.every(page=>JSON.stringify(page)==='{"limit":6}'),`live re-reads sent ${JSON.stringify(pages)}`)
  assert.equal(list.getState().listRefreshTruncated,false)
  list.close();client.dispose();await socket.dispose()
  for (const id of ['ks-a','ks-b','ks-c','ks-d']) await post(`mutation { DeleteWidget(Id: "${id}") { Success } }`)
  pass('a keyset list loaded in three pages refreshes in one request, and a row created inside it appears')
 }
 const readAllArtifact = compile(schema, [`query Bounded($Page: PageInput) {
   Widgets(Page: $Page) @connection(key: "bounded") { Edges { Node { Id Name } } PageInfo { TotalCount } }
 }`]).operations.Bounded
 const boundedClient = createClient({ network: createHttpNetwork({ url: routerUrl, headers }) })
 const bounded = await readAll(boundedClient, readAllArtifact, {}, { limit: 1 })
 assert.equal(bounded.rows.length, 1); assert(bounded.total > 1); assert.equal(bounded.truncated, true)
 const complete = await readAll(boundedClient, readAllArtifact, {}, { limit: 100, pageSize: 1 })
 assert.equal(complete.rows.length, complete.total); assert.equal(complete.truncated, false)
 boundedClient.dispose(); pass('R14 bounded readAll: real offset pages, exact total and truncation')
 const compiled = compile(schema,[`fragment Row on Widget @live { Name }`,`query One { Widget(Id: "w1") { ...Row } }`])
 // A generated stream is admitted as it stands, and doesn't select what the server refuses.
 assert(!/\bNodeId\b/.test(compiled.live.Widget.operation.text))
 const generated=await raw(), generatedId=generated.subscribe(compiled.live.Widget.operation.text,{Keys:[]})
 await sleep(300)
 assert.equal(generated.frames.filter(f=>f.id===generatedId).length,0)
 generated.ws.close()
 pass('generated stream selection is admitted on an entity with NodeId and a managed version')
 // R18: the loader and later mount use one real router read; no stream/settle read is enabled here.
 {
  let reads = 0
  const http = createHttpNetwork({url:routerUrl,headers})
  const loaderClient = createClient({network:{execute:(r,o)=>{ reads++; return http.execute(r,o) }}})
  const loaded = loaderClient.loadQuery(compiled.operations.One,{})
  await loaded.ready
  assert.equal(loaded.getState().status,'ready')
  const release = loaded.mount()
  assert.equal(reads,1)
  assert.equal(loaderClient.store.get(encodeNodeId('Widget',['w1']))?.fields.get('Name'),'Newest')
  release(); await Promise.resolve(); loaderClient.dispose()
  pass('route preload mounted later: one HTTP request reaches the real router')
 }
 const query = compiled.operations.One
 // Deliver older server data after the newer snapshot through the network.
 const sequence=[newer,old]
 const ordered=createClient({network:{execute:async()=>({data:{Widget:sequence.shift()}})}})
 await ordered.query(query,{}, {policy:'network-only'})
 await ordered.query(query,{}, {policy:'network-only'})
 assert.equal(ordered.store.get(encodeNodeId('Widget',['w1']))?.fields.get('Name'),'Newest')
 ordered.dispose()
 pass('managed server versions advance; client rejects delayed older server snapshot')
 // The served schema doesn't give a composite key's order; the client takes it from the record's NodeId.
 const composite=compile(schema,[`fragment SlotRow on Slot @live { Label }`,`query OneSlot { Slot(Site: "north", Name: "a") { ...SlotRow } }`])
 assert.deepEqual(composite.live.Slot.keyFields,['Name','Site'])
 {
  const socket=createWs({url:routerUrl.replace('http','ws'),webSocketImpl:WebSocket,connectionParams:{authorization:`Bearer ${token}`}})
  const transport=graphqlWsTransport(socket)
  const client=createClient({network:createHttpNetwork({url:routerUrl,headers}),live:{artifacts:composite.live,...transport,onDiagnostic:null}})
  const slotQuery=client.watchQuery(composite.operations.OneSlot,{})
  slotQuery.open()
  await until('composite stream',()=>client.live.status().Slot?.subscriptions===1)
  await sleep(500) // past the confirming read, so what follows can only be the event
  const before=client.live.status().Slot.lastEventAt
  assert.equal(before,null)
  await fetch(`${serviceUrl}/slot`,{method:'POST',body:'Updated by event'})
  await until('composite event reaches the record',()=>client.store.get(encodeNodeId('Slot',['north','a']))?.fields.get('Label')==='Updated by event')
  assert.notEqual(client.live.status().Slot.lastEventAt,null)
  assert.equal(client.liveTypeHealth('Slot').reason,null)
  slotQuery.close();client.dispose();await socket.dispose()
 }
 pass('a composite-key event reaches its record though the served schema lists the key in another order')
 // Deleting a child under a relation with propagate_change = "up". From 0.93.0 this notifies the parent (#290), and the
 // parent must stay. Before that, nothing is sent.
 const parents=compile(schema,[`fragment VendorRow on Vendor @live { Name }`,`query OneVendor($Id: String!) { Vendor(Id: $Id) { ...VendorRow } }`])
 assert(/\bChangeKind\b/.test(parents.live.Vendor.operation.text))
 {
  await post('mutation { CreateVendor(Input: {Id: "parent", Name: "Parent"}) { Success } }')
  for(const id of ['c1','c2','c3','c4','c5','c6']) await post(`mutation { CreateTicket(Input: {Id: "${id}", VendorId: "parent", Title: "Child"}) { Success } }`)
  const socket=createWs({url:routerUrl.replace('http','ws'),webSocketImpl:WebSocket,connectionParams:{authorization:`Bearer ${token}`}})
  const transport=graphqlWsTransport(socket)
  let reads=0
  const network=createHttpNetwork({url:routerUrl,headers})
  const frames=[]
  const client=createClient({network:{execute:(r,o)=>{reads++;return network.execute(r,o)}},live:{artifacts:parents.live,...transport,onDiagnostic:null,subscribe:(request,sink)=>transport.subscribe(request,{...sink,next:r=>{frames.push(r.data?.VendorChanged);sink.next(r)}})}})
  const parent=client.watchQuery(parents.operations.OneVendor,{Id:'parent'})
  parent.open()
  const parentId=encodeNodeId('Vendor',['parent'])
  await until('parent streams',()=>client.live.status().Vendor?.subscriptions>=1&&client.store.get(parentId))
  await sleep(1000)
  const propagatedDeletes=()=>frames.filter(f=>f?.Action==='DELETED'&&f.ChangeKind==='PROPAGATED'&&f.Vendor?.Id==='parent').length
  await post('mutation { DeleteTicket(Id: "c1") { Success } }')
  if(minor>=93){
   const before=reads
   await until('propagated delete',()=>propagatedDeletes()===1)
   assert(client.store.get(parentId),'a propagated delete keeps the parent')
   await until('parent read again',()=>reads>before)
   assert(parent.getState().data?.Vendor)
   await sleep(2100)
   const burst=reads
   await Promise.all(['c2','c3','c4','c5','c6'].map(id=>post(`mutation { DeleteTicket(Id: "${id}") { Success } }`)))
   await until('5 propagated deletes',()=>propagatedDeletes()===6)
   await sleep(2300)
   assert(reads-burst<=2,`5 propagated deletes caused ${reads-burst} reads`)
   assert(client.store.get(parentId))
   pass('without a preimage grant, a child delete keeps the parent and reads it again, and a burst coalesces')
  } else {
   await sleep(500)
   assert.equal(propagatedDeletes(),0)
   assert(client.store.get(parentId))
   pass('before 0.93.0 a child delete sends the parent nothing')
  }
  parent.close();client.dispose();await socket.dispose()
 }
 const list=(await post('{ Widgets(Where: {Name: {InList: ["Newest", "Beta"]}}, OrderBy: [{Name: DESC}], Page: {Limit: 1, Offset: 1}) { Edges { Node { Id Name } } PageInfo { TotalCount HasNextPage } } }')).data.Widgets
 assert.equal(list.PageInfo.TotalCount,2);assert.equal(list.Edges[0].Node.Name,'Beta')
 const first=(await post('{ WidgetsKeyset(Page: {limit: 1, includeTotalCount: true}) { Edges { Node { Id } } PageInfo { EndCursor TotalCount HasNextPage } } }')).data.WidgetsKeyset
 assert.equal(first.PageInfo.TotalCount,2);assert.equal(first.Edges[0].Node.Id,'w1');assert(first.PageInfo.HasNextPage)
 const second=(await post('query($p: KeysetPageInput!) { WidgetsKeyset(Page: $p) { Edges { Node { Id } } PageInfo { HasNextPage } } }',{p:{after:first.PageInfo.EndCursor,limit:1}})).data.WidgetsKeyset
 assert.equal(second.Edges[0].Node.Id,'w2');assert.equal(second.PageInfo.HasNextPage,false)
 pass('filter, descending sort, TotalCount, offset and keyset pages')
 const deletion=await raw(), del=deletion.subscribe(stream())
 await sleep(200)
 await post('mutation { DeleteWidget(Id: "w2") { Success } }')
 await sleep(200);assert.equal(deletion.frames.filter(f=>f.id===del).length,0)
 await fetch(`${serviceUrl}/preimage`,{method:'POST'})
 await create('delete-me','Temporary');await sleep(100)
 await post('mutation { DeleteWidget(Id: "delete-me") { Success } }')
 await until('delete preimage',()=>deletion.frames.some(f=>f.payload?.data?.WidgetChanged?.Action==='DELETED'))
 deletion.ws.close();pass('DELETED suppressed without grant, delivered with can_read_deleted_preimage')
 // A parent deleted directly is removed, on the same generated stream that keeps it for a child delete.
 {
  await post('mutation { CreateVendor(Input: {Id: "gone", Name: "Gone"}) { Success } }')
  const socket=createWs({url:routerUrl.replace('http','ws'),webSocketImpl:WebSocket,connectionParams:{authorization:`Bearer ${token}`}})
  const transport=graphqlWsTransport(socket)
  const client=createClient({network:createHttpNetwork({url:routerUrl,headers}),live:{artifacts:parents.live,...transport,onDiagnostic:null}})
  const gone=client.watchQuery(parents.operations.OneVendor,{Id:'gone'});gone.open()
  const goneId=encodeNodeId('Vendor',['gone'])
  await until('direct delete stream',()=>client.live.status().Vendor?.subscriptions>=1&&client.store.get(goneId))
  await sleep(1000)
  assert.equal(client.live.status().Vendor.lastEventAt,null)
  await post('mutation { DeleteVendor(Id: "gone") { Success } }')
  await until('direct delete event',()=>client.live.status().Vendor.lastEventAt!==null)
  assert(!client.store.get(goneId)||gone.getState().data?.Vendor==null,'a direct delete removes the record')
  gone.close();client.dispose();await socket.dispose()
  pass('a direct delete of a parent removes the record')
 }
 const deleteDocs = compile(schema, [`fragment DeletedRow on Widget @live { Name }`, `query DeleteList { Widgets { Edges { Node { ...DeletedRow } } } }`])
 await create('held-delete', 'Held delete')
 const deleteWs = createWs({url:routerUrl.replace('http','ws'), webSocketImpl:WebSocket, connectionParams:{authorization:`Bearer ${token}`}})
 const deleteClient = createClient({ network:createHttpNetwork({url:routerUrl,headers}), store:{deletedRecords:'omit'}, live:{artifacts:deleteDocs.live,...graphqlWsTransport(deleteWs),minRereadMs:0,debounceMs:0,settleMs:false,onDiagnostic:null} })
 const deleteQuery=deleteClient.watchQuery(deleteDocs.operations.DeleteList,{})
 deleteQuery.open()
 await until('held delete loaded',()=>deleteQuery.getState().data?.Widgets.Edges.some(e=>readFragment(deleteDocs.fragments.DeletedRow,e.Node)?.Name==='Held delete'))
 const deleteRef=deleteQuery.getState().data.Widgets.Edges.find(e=>readFragment(deleteDocs.fragments.DeletedRow,e.Node)?.Name==='Held delete').Node
 await sleep(300)
 await post('mutation { DeleteWidget(Id: "held-delete") { Success } }')
 await until('held delete fragment',()=>readFragment(deleteDocs.fragments.DeletedRow,deleteRef,{deleted:'null'})===null)
 await until('held delete list',()=>deleteQuery.getState().data.Widgets.Edges.every(e=>readFragment(deleteDocs.fragments.DeletedRow,e.Node)?.Name!=='Held delete'))
 assert.equal(deleteClient.store.get(encodeNodeId('Widget',['held-delete'])),undefined)
 deleteQuery.close();deleteClient.dispose();await deleteWs.dispose()
 pass('R16 real direct delete removes held record and list node; old reference reads null')
 for(const synchronous of [true,false]) {
  for(let repeat=0;repeat<8;repeat++) {
   for(const scenario of ['reload','kill','refuse']) {
    console.log(`RUN ws synchronous=${synchronous} repeat=${repeat+1} ${scenario}`)
    class Socket extends WebSocket { constructor(url,protocols){super(url,protocols,{allowSynchronousEvents:synchronous})} }
    if(scenario==='refuse')await fetch(`${serviceUrl}/refuse`,{method:'POST'})
    const ws=createWs({url:routerUrl.replace('http','ws'),webSocketImpl:Socket,connectionParams:{authorization:`Bearer ${token}`},retryAttempts:1,retryWait:()=>sleep(100)})
    const transport=graphqlWsTransport(ws)
    let reads=0
    const network=createHttpNetwork({url:routerUrl,headers})
    const c=createClient({network:{execute:(r,o)=>{reads++;return network.execute(r,o)}},live:{artifacts:compiled.live,...transport,onDiagnostic:null,refusalBackoff:{ms:500},restart:{minMs:100,maxMs:500}}})
    const q=c.watchQuery(query,{});q.open()
    try {
    const shown=()=>c.store.get(encodeNodeId('Widget',['w1']))?.fields.get('Name')
    await until('initial read',()=>shown()!=null)
    await sleep(300)
    const marker=`${synchronous}-${repeat}-${scenario}`
    if(scenario==='reload') { revision++;await until('reload observed by client',()=>c.live.status().Widget?.lastEnd?.reason==='reload');await updateDirect(marker) }
    else if(scenario==='refuse'){await until('refused health',()=>c.live.status().Widget?.lastRefusal!=null);await update(marker);await fetch(`${serviceUrl}/accept`,{method:'POST'})}
    else {await stopRouter();await updateDirect(marker);await sleep(600);await startRouter()}
    await until('recovery reread',()=>shown()===marker,20000)
    await sleep(300);await update(marker+'-event')
    try {await until('post-recovery event',()=>shown()===marker+'-event',10000)}catch(e){console.error({scenario,synchronous,repeat,health:c.liveHealth(),status:c.live.status(),shown:shown(),reads});throw e}
    assert(reads>=2)
    } catch(e) { failures.push(`ws synchronous=${synchronous} repeat=${repeat+1} ${scenario}: ${e.message}`);console.error('FAIL',failures.at(-1)) } finally {q.close();c.dispose();await ws.dispose()}
   }
  }
  if(!failures.some(f=>f.startsWith(`ws synchronous=${synchronous}`)))pass(`8 reload + 8 router-kill + 8 refusal recoveries, ws allowSynchronousEvents=${synchronous}`)
 }
 const expiry = String(Date.now()/1000 + 3)
 await update(expiry)
 const lifetimeQuery=compile(schema,[`query Lifetime { Widget(Id: "w1") { Name } }`],{lifetimes:{Widget:{field:'Name',format:'unix-seconds'}}}).operations.Lifetime
 const lifetimeNetwork=createHttpNetwork({url:routerUrl,headers});let lifetimeReads=0
 const lifetimeClient=createClient({network:{execute:(...args)=>{lifetimeReads++;return lifetimeNetwork.execute(...args)}}})
 const lifetimeWatch=lifetimeClient.watchQuery(lifetimeQuery,{});lifetimeWatch.open();await lifetimeWatch.refetch()
 assert.equal(lifetimeWatch.getState().lifetime,undefined)
 await until('lifetime expiry',()=>lifetimeWatch.getState().lifetime==='expired' && lifetimeReads>=2)
 lifetimeWatch.close();lifetimeClient.dispose();pass('explicit String lifetime expires and holders re-read')
 await liveSettingCheck({schema,scratch,routerUrl,token,post,until,sleep})
 await doctorChecks({schema,scratch,routerUrl,token,post})
 try {await browserRecovery({scratch,compiled,query,routerUrl,frontUrl,token,reload:()=>revision++,stopRouter,startRouter,updateDirect,update,until,sleep})}catch(e){failures.push(`Browser: ${e.message}`);console.error(e)}
 if(failures.length)throw Error(`Conformance failures:\n${failures.join('\n')}`)
 console.log(`PASS ${passed} groups against ${process.env.GRAPHQL_ORM_TAG??'graphql-orm-v0.90.1'} / real router`)
} finally {
 for(const s of sockets)s.terminate()
 for(const p of children)p.kill('SIGKILL')
 front.closeAllConnections();front.close();remote.closeAllConnections();remote.close()
}
