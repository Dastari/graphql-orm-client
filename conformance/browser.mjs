import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { build } from 'esbuild'

// Invoked by the ORM runner while the real service and router are alive.
export async function browserRecovery({ scratch, compiled, query, routerUrl, frontUrl, token, reload, stopRouter, startRouter, updateDirect, update, until, sleep }) {
 const executablePath=process.env.CHROME??chromium.executablePath()
 if(!existsSync(executablePath)) {
  console.log('NOT RUN Chromium recovery: install with pnpm exec playwright-core install chromium, or set CHROME')
  if(process.env.CI)throw Error('Chromium is required in CI')
  return
 }
 const out=`${scratch}/browser.js`
 await build({stdin:{contents:`
 import {persistClient,indexedDBAdapter} from './dist/persistence/index.js';
 import {createClient,graphqlWsTransport} from './dist/index.js';
 import {createClient as createWs} from 'graphql-ws';
 window.persistenceBoot=async(compiled,identity)=>{
  const client=createClient({network:{execute:r=>window.read(r)}});
  const adapter=indexedDBAdapter('r17-conformance');
  const persistence=persistClient(client,{adapter,identityKey:identity,schemaHash:'conformance-schema',serverRelease:'conformance-release'});
  await persistence.ready;
  const q=client.watchQuery(compiled.operations.One,{});
  window.persistenceState=()=>q.getState();
  window.persistenceRead=()=>client.execute(compiled.operations.One,{});
  window.persistencePrivate=()=>client.query({...compiled.operations.One,sensitive:true},{});
  window.persistenceFlush=()=>persistence.flush();
  window.persistencePayload=()=>adapter.get('graphql-orm-client:'+JSON.stringify(identity));
  window.persistenceDispose=()=>client.dispose();
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
 const browser=await chromium.launch({executablePath,args:['--no-sandbox']})
 try {
  const persistedPage=await browser.newPage()
  await persistedPage.exposeFunction('read',async r=>(await(await fetch(routerUrl,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:r.text,variables:r.variables,operationName:r.name})})).json()))
  const bootPersistence=async identity=>{
   await persistedPage.goto(`${frontUrl}/page`);await persistedPage.addScriptTag({path:out})
   return persistedPage.evaluate(([c,id])=>window.persistenceBoot(c,id),[compiled,identity])
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
  await persistedPage.close()
  console.log('PASS Chromium IndexedDB: reload restores stale data, identity separation, sensitive exclusion')
  for(let repeat=0;repeat<8;repeat++)for(const scenario of ['reload','kill']) {
   console.log(`RUN Chromium repeat=${repeat+1} ${scenario}`)
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
  console.log('PASS Chromium: 8 reload + 8 router-kill recoveries')
 } finally{await browser.close()}
}
