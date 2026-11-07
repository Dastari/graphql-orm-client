import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { printSchema, parse, print, visit } from 'graphql'

// Schema snapshots intentionally differ for drift/required-key cases. The
// introspection and admission endpoint is always the running real router.
export async function doctorChecks({schema,scratch,routerUrl,token,post}) {
 const cli=resolve('bin/graphql-orm-client.mjs')
 for(const verdict of ['not-refused','admitted','refused','fallback-not-refused','missing','unknown','invalid']) {
  const dir=`${scratch}/doctor-${verdict}`;await mkdir(`${dir}/src`,{recursive:true})
  const typename=verdict==='missing'?'PageInfo':['refused','fallback-not-refused'].includes(verdict)?'Ticket':'Vendor'
  let sdl=printSchema(schema)
  if(verdict==='admitted'||verdict==='unknown') {
   sdl=print(visit(parse(sdl),{FieldDefinition(node){
    if(node.name.value!=='VendorChanged')return
    if(verdict==='admitted')return {...node,arguments:[]}
    return {...node,arguments:node.arguments.filter(a=>a.name.value==='Key').map(a=>({...a,type:{kind:'NonNullType',type:{kind:'NamedType',name:{kind:'Name',value:'String'}}}}))}
   }}))
  }
  if(verdict==='invalid')sdl+='\nextend type Vendor { Removed: String }'
  await writeFile(`${dir}/schema.graphql`,sdl)
  await writeFile(`${dir}/graphql-orm-client.config.json`,JSON.stringify({schema:'schema.graphql',documents:['src'],out:'src/generated.ts',...(verdict==='refused'?{liveSelection:'as-written'}:{})}))
  const root=verdict==='missing'?'Vendors { PageInfo { ...Row } }':`${typename}(Id: "${typename==='Ticket'?'t1':'v1'}") { ...Row }`
  const selection=verdict==='missing'?'TotalCount':typename==='Ticket'?'Title Summary':`Name ${verdict==='invalid'?'Removed':''}`
  await writeFile(`${dir}/src/app.ts`,'graphql(`fragment Row on '+typename+' @live '+(verdict==='missing'?'@poll(reason: "No stream") ':'')+'{ '+selection+' }`)\ngraphql(`query One { '+root+' }`)')
  let emissionError
  const emitter=verdict==='admitted'?setInterval(()=>post('mutation { UpdateVendor(Id: "v1", Input: {Name: "Tick"}) { Success } }').catch(e=>{emissionError=e}),100):null
  let result
  try {
   result=await new Promise((resolve,reject)=>{
    const c=spawn(process.execPath,[cli,'doctor','--url',routerUrl,'--token-env','CONFORMANCE_TOKEN','--stream-ms','500','--json'],{cwd:dir,env:{...process.env,CONFORMANCE_TOKEN:token}})
    let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('error',reject);c.on('exit',code=>resolve({code,out,err}))
   })
  }finally{if(emitter)clearInterval(emitter)}
  if(emissionError)throw emissionError
  assert(!result.out.includes(token));assert(!result.err.includes(token))
  assert(result.out.trim().startsWith('{'),`doctor ${verdict} exited ${result.code}: ${result.err}`)
  const report=JSON.parse(result.out)
  assert.equal(report.streams[0].verdict,verdict,JSON.stringify(result))
  assert.equal(result.code,['not-refused','admitted','fallback-not-refused'].includes(verdict)?0:1)
  console.log(`PASS doctor CLI ${verdict} against real router${['unknown','invalid'].includes(verdict)?' with a deliberately altered local snapshot':''}`)
 }
}
