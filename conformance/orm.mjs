import assert from 'node:assert/strict'
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
import { createClient, createHttpNetwork, graphqlWsTransport, encodeNodeId } from '../dist/index.js'

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
let revision = 0, originalSdl, originalDescriptor
async function post(query, variables={}, url=routerUrl, allowErrors=false) {
  const result = await (await fetch(url,{method:'POST',headers,body:JSON.stringify({query,variables})})).json()
  if (!allowErrors) assert(!result.errors,JSON.stringify(result))
  return result
}
const front = createServer(async(req,res)=>{
  try {
    if(req.url==='/jwks') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({keys:[jwk]})) }
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
 for (const [label,q] of [['federated',stream('', 'Id RemoteName')],['NodeId',stream('', 'Id NodeId')],['computed RecordVersion','subscription { TicketChanged { Ticket { Id RecordVersion } } }'],['computed','subscription { TicketChanged { Ticket { Id Summary } } }'],['relation','subscription { TicketChanged { Ticket { Id Vendor { Id } } } }']]) {
  const id=a.subscribe(q);await until(`${label} refusal`,()=>a.frames.some(x=>x.id===id))
  const frame=a.frames.find(x=>x.id===id);assert.equal((frame.payload.errors??frame.payload)[0].extensions.code,'INVALID_INPUT',JSON.stringify(frame));console.log(`${label} refusal frame: ${frame.type}`)
 }
 pass('NodeId, hand-written RecordVersion, computed and relation selections refused INVALID_INPUT; managed RecordVersion delivered')
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
 pass('federated scalar with persisted Id key is admitted and fetched per event; NodeId-key federation is refused')
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
 const old = (await post('{ Widget(Id: "w1") { __typename Id Name NodeId RecordVersion } }')).data.Widget
 const newer = await update('Newest')
 assert(newer.RecordVersion > old.RecordVersion)
 const compiled = compile(schema,[`fragment Row on Widget @live { Name }`,`query One { Widget(Id: "w1") { ...Row } }`])
 // A generated stream is admitted as it stands, and doesn't select what the server refuses.
 assert(!/\bNodeId\b/.test(compiled.live.Widget.operation.text))
 const generated=await raw(), generatedId=generated.subscribe(compiled.live.Widget.operation.text,{Keys:[]})
 await sleep(300)
 assert.equal(generated.frames.filter(f=>f.id===generatedId).length,0)
 generated.ws.close()
 pass('generated stream selection is admitted on an entity with NodeId and a managed version')
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
 await doctorChecks({schema,scratch,routerUrl,token,post})
 try {await browserRecovery({scratch,compiled,query,routerUrl,frontUrl,token,reload:()=>revision++,stopRouter,startRouter,updateDirect,update,until,sleep})}catch(e){failures.push(`Chromium: ${e.message}`);console.error(e)}
 if(failures.length)throw Error(`Conformance failures:\n${failures.join('\n')}`)
 console.log(`PASS ${passed} groups against ${process.env.GRAPHQL_ORM_TAG??'graphql-orm-v0.90.1'} / real router`)
} finally {
 for(const s of sockets)s.terminate()
 for(const p of children)p.kill('SIGKILL')
 front.closeAllConnections();front.close();remote.closeAllConnections();remote.close()
}
