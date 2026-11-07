import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createClient as createWs } from 'graphql-ws'
import { WebSocket } from 'ws'
import { generate } from '../dist/compiler/index.js'
import { createClient, createHttpNetwork, graphqlWsTransport, readFragment } from '../dist/index.js'
export async function liveSettingCheck({schema,scratch,routerUrl,token,post,until,sleep}) {
 const sources = ['fragment DefaultRow on Widget { Name }', 'fragment FallbackRow on PageInfo { TotalCount }',
  'query DefaultPage { Widget(Id: "w1") { ...DefaultRow } Widgets { PageInfo { ...FallbackRow } } }']
 const modulePath = `${scratch}/default-generated.ts`
 await writeFile(modulePath, generate(schema, sources, {live:'default', importFrom: new URL('../dist/index.js',import.meta.url).pathname, onWarning:()=>{}}))
 const generated = await import(pathToFileURL(modulePath).href)
 assert.deepEqual(generated.liveUnavailable,['PageInfo'])
 const socket = createWs({url:routerUrl.replace('http','ws'),webSocketImpl:WebSocket,connectionParams:{authorization:`Bearer ${token}`}})
 const client = createClient({network:createHttpNetwork({url:routerUrl,headers:{authorization:`Bearer ${token}`}}),live:{artifacts:generated.live,...graphqlWsTransport(socket),debounceMs:0,settleMs:false,onDiagnostic:null}})
 const watch = client.watchQuery(generated.DefaultPageQuery,{})
 try {
  watch.open()
  await until('R1 initial read',()=>watch.getState().status==='ready')
  assert.equal(client.liveTypeHealth('PageInfo').state,'polling')
  assert.equal(client.liveTypeHealth('PageInfo').reason,'no-stream')
  await sleep(300)
  await post('mutation { UpdateWidget(Id: "w1", Input: {Name: "Default mode update"}) { Success } }')
  await until('R1 directive-free stream update',()=>readFragment(generated.DefaultRowFragment,watch.getState().data.Widget).Name==='Default mode update')
  assert.equal(client.liveTypeHealth('Widget').state,'live')
  console.log('PASS R1 generated default-mode project: directive-free Widget stream updates; PageInfo polls with no-stream health')
 } finally {watch.close();client.dispose();await socket.dispose()}
}
