import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'
import { build } from 'esbuild'

// Invoked by the ORM runner while the real service and router are alive.
export async function browserRecovery({ scratch, compiled, query, routerUrl, frontUrl, token, reload, stopRouter, startRouter, updateDirect, update, until, sleep }) {
 const out=`${scratch}/browser.js`
 await build({stdin:{contents:`
 import {persistClient,indexedDBAdapter} from './dist/persistence/index.js';
 import {createClient,graphqlWsTransport} from './dist/index.js';
 import {createClient as createWs} from 'graphql-ws';
 window.persistenceBoot=async(compiled,identity,extra)=>{
  const client=createClient({network:{execute:r=>window.read(r)}});
  const adapter=indexedDBAdapter('r17-conformance');
  const persistence=persistClient(client,{adapter,identityKey:identity,schemaHash:'conformance-schema',serverRelease:'conformance-release',...extra});
  await persistence.ready;
  const q=client.watchQuery(compiled.operations.One,{});
  window.persistenceState=()=>q.getState();
  window.persistenceRead=()=>client.execute(compiled.operations.One,{});
  window.persistencePrivate=()=>client.query({...compiled.operations.One,sensitive:true},{});
  window.persistenceFlush=()=>persistence.flush();
  window.persistencePayload=()=>adapter.get('graphql-orm-client:'+JSON.stringify(identity));
  window.persistenceDispose=()=>client.dispose();
  window.persistenceClear=()=>persistence.clear();
  return q.getState();
 };
 window.boot=(cfg,compiled)=>{
  const ws=createWs({url:cfg.url,connectionParams:{authorization:'Bearer '+cfg.token},retryAttempts:1,retryWait:()=>new Promise(r=>setTimeout(r,100))});
  const client=createClient({network:{execute:r=>window.read(r)},live:{artifacts:compiled.live,...graphqlWsTransport(ws),onDiagnostic:null,restart:{minMs:100,maxMs:500}}});
  const q=client.watchQuery(compiled.operations.One,{});q.open();
  window.ended=()=>client.live.status().Widget?.lastEnd?.reason;
  window.shown=()=>client.store.get(cfg.id)?.fields.get('Name');
  window.shutdown=async()=>{q.close();client.dispose();await ws.dispose()};
 }`,resolveDir:resolve('.')},bundle:true,format:'iife',platform:'browser',outfile:out,define:{'process.env.NODE_ENV':'"production"'},logLevel:'error'})
 const errors=[]
 for(const [label,type,variable,args] of [['Chromium',chromium,'CHROME',['--no-sandbox']],['Firefox',firefox,'FIREFOX',[]],['WebKit',webkit,'WEBKIT',[]]]) {
  const executablePath=process.env[variable]??type.executablePath()
  if(!existsSync(executablePath)) {
   console.log(`NOT RUN ${label} recovery: install with pnpm exec playwright-core install ${type.name()}, or set ${variable}`)
   if(process.env.CI)errors.push(`${label} is required in CI`)
   continue
  }
  try {await inBrowser(label,await type.launch({executablePath,args}))}catch(e){errors.push(`${label}: ${e.message}`);console.error(e)}
 }
 if(errors.length)throw Error(errors.join('\n'))
 async function inBrowser(label,browser){
 console.log(`Browser: ${label} ${browser.version()}`)
 try {
  const windows=await browser.newContext()
  const persistedPage=await windows.newPage()
  await persistedPage.exposeFunction('read',async r=>(await(await fetch(routerUrl,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:r.text,variables:r.variables,operationName:r.name})})).json()))
  const bootPersistence=async identity=>{
   await persistedPage.goto(`${frontUrl}/page`);await persistedPage.addScriptTag({path:out})
   return persistedPage.evaluate(([c,id])=>window.persistenceBoot(c,id),[compiled,identity])
  }
  // Same browser context, so the same IndexedDB and BroadcastChannel, as a pop-out window has.
  const openWindow=async(identity,extra)=>{
   const page=await windows.newPage()
   await page.exposeFunction('read',async r=>(await(await fetch(routerUrl,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:r.text,variables:r.variables,operationName:r.name})})).json()))
   await page.goto(`${frontUrl}/page`);await page.addScriptTag({path:out})
   const state=await page.evaluate(([c,id,o])=>window.persistenceBoot(c,id,o),[compiled,identity,extra])
   return {page,state,payload:()=>page.evaluate(()=>window.persistencePayload()),saveAfterRead:async()=>{await page.evaluate(()=>window.persistenceRead());await page.evaluate(()=>window.persistenceFlush())}}
  }
  await bootPersistence('identity-a')
  await persistedPage.evaluate(()=>window.persistenceRead())
  await persistedPage.evaluate(()=>window.persistenceFlush())
  await persistedPage.reload();await persistedPage.addScriptTag({path:out})
  const restored=await persistedPage.evaluate(c=>window.persistenceBoot(c,'identity-a'),compiled)
  assert.equal(restored.stale,true);assert.ok(restored.data)
  const other=await bootPersistence('identity-b');assert.equal(other.data,undefined)
  await update('PRIVATE_BROWSER_MARKER_17')
  await persistedPage.evaluate(()=>window.persistencePrivate())
  await update('public-browser-value')
  await persistedPage.evaluate(()=>window.persistenceRead());await persistedPage.evaluate(()=>window.persistenceFlush())
  assert(!(await persistedPage.evaluate(()=>window.persistencePayload())).includes('PRIVATE_BROWSER_MARKER_17'))
  await persistedPage.evaluate(()=>window.persistenceDispose())
  console.log(`PASS ${label} IndexedDB: reload restores stale data, identity separation, sensitive exclusion`)

  await bootPersistence('identity-windows')
  await persistedPage.evaluate(()=>window.persistenceRead());await persistedPage.evaluate(()=>window.persistenceFlush())
  const saved=await persistedPage.evaluate(()=>window.persistencePayload())
  assert.ok(saved)
  const readOnly=await openWindow('identity-windows',{readOnly:true})
  assert.equal(readOnly.state.stale,true);assert.ok(readOnly.state.data)
  await update('read-only-window-value');await readOnly.saveAfterRead()
  assert.equal(await readOnly.payload(),saved,'a read-only window wrote')
  await readOnly.page.evaluate(()=>window.persistenceDispose());await readOnly.page.close()
  assert.equal(await persistedPage.evaluate(()=>window.persistencePayload()),saved,'a read-only window changed what was saved')
  const popout=await openWindow('identity-windows')
  await popout.page.evaluate(()=>window.persistenceDispose());await popout.page.close()
  assert.equal(await persistedPage.evaluate(()=>window.persistencePayload()),saved,'disposing a pop-out changed what was saved')
  await persistedPage.reload();await persistedPage.addScriptTag({path:out})
  const reopened=await persistedPage.evaluate(c=>window.persistenceBoot(c,'identity-windows'),compiled)
  assert.equal(reopened.stale,true);assert.ok(reopened.data)
  const stillOpen=await openWindow('identity-windows')
  await persistedPage.evaluate(()=>window.persistenceClear())
  assert.equal(await persistedPage.evaluate(()=>window.persistencePayload()),null)
  await sleep(100)
  await stillOpen.saveAfterRead();await sleep(400)
  assert.equal(await stillOpen.payload(),null,'another window saved after a sign-out')
  await stillOpen.page.evaluate(()=>window.persistenceDispose());await stillOpen.page.close()
  await persistedPage.evaluate(()=>window.persistenceDispose())
  await persistedPage.close()
  console.log(`PASS ${label} two windows: a pop-out disposing leaves saved data, read-only writes nothing, sign-out stops other windows saving`)
  for(let repeat=0;repeat<8;repeat++)for(const scenario of ['reload','kill']) {
   console.log(`RUN ${label} repeat=${repeat+1} ${scenario}`)
   const page=await browser.newPage()
   const errors=[];page.on('pageerror',e=>errors.push(String(e)))
   await page.exposeFunction('read',async r=>(await(await fetch(routerUrl,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:r.text,variables:r.variables,operationName:r.name})})).json()))
   await page.goto(`${frontUrl}/page`);await page.addScriptTag({path:out})
   await page.evaluate(([cfg,c])=>window.boot(cfg,c),[{url:routerUrl.replace('http','ws'),token,id:Buffer.from(JSON.stringify(['Widget','w1'])).toString('base64url')},compiled])
   const shown=()=>page.evaluate(()=>window.shown())
   await until('browser initial read',async()=>!!await shown());await sleep(300)
   const marker=`browser-${repeat}-${scenario}`
   if(scenario==='reload'){reload();await until('browser reload observed',async()=>await page.evaluate(()=>window.ended())==='reload');await updateDirect(marker)}
   else{await stopRouter();await updateDirect(marker);await sleep(600);await startRouter()}
   await until('browser recovery read',async()=>await shown()===marker,20000)
   await sleep(300);await update(marker+'-event')
   await until('browser recovery event',async()=>await shown()===marker+'-event',10000)
   assert.deepEqual(errors,[])
   await page.evaluate(()=>window.shutdown());await page.close()
  }
  console.log(`PASS ${label}: 8 reload + 8 router-kill recoveries`)
 } finally{await browser.close()}
 }
}
