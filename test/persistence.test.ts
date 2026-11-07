import { afterEach, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createClient } from "../src/client.js"
import { persistClient, PERSISTENCE_PACKAGE_VERSION, type PersistenceAdapter } from "../src/persistence/index.js"
import { ROOT_ID } from "../src/store/store.js"
import { compile } from "../src/compiler/index.js"
import { schema, ops, widget, catalog } from "./fixtures.js"
const options = {identityKey:"a",schemaHash:"schema",serverRelease:"release",throttleMs:10}
function adapter() {
 const values=new Map<string,string>()
 return {values,get:vi.fn(async(k:string)=>values.get(k)??null),set:vi.fn(async(k:string,v:string)=>{values.set(k,v)}),delete:vi.fn(async(k:string)=>{values.delete(k)})}
}
function client() {return createClient({network:{execute:async()=>({data:{Widget:widget("w")}})}})}
async function seed(a:PersistenceAdapter) {
 const c=client();const p=persistClient(c,{...options,adapter:a});await p.ready
 await c.execute(ops.WidgetPage!,{Id:"w"});await p.flush();return {c,p}
}
afterEach(()=>vi.useRealTimers())
it("envelope package version matches the package",()=>expect(PERSISTENCE_PACKAGE_VERSION).toBe(JSON.parse(readFileSync('package.json','utf8')).version))
it("requires an identity and scopes storage by identity",async()=>{
 const a=adapter(), c=client();await persistClient(c,{...options,identityKey:undefined,adapter:a}).ready
 await c.execute(ops.WidgetPage!,{Id:"w"});expect(a.get).not.toHaveBeenCalled();expect(a.set).not.toHaveBeenCalled()
 const first=await seed(a);const other=client();await persistClient(other,{...options,identityKey:"b",adapter:a}).ready
 expect(other.store.size).toBe(0);other.dispose();first.c.dispose();c.dispose()
})
it("restores stale data, re-reads even cache-first, and disposal makes references unreadable and keeps storage",async()=>{
 const a=adapter();const first=await seed(a);const c=client(), p=persistClient(c,{...options,adapter:a});await p.ready
 const q=c.watchQuery(ops.WidgetPage!,{Id:"w"},"store-or-network")
 expect(q.getState().stale).toBe(true);q.open();await q.refetch();expect(q.getState().stale).toBeUndefined()
 c.dispose();await p.flush();await new Promise(r=>setTimeout(r,0));expect(a.values.size).toBe(1);expect(c.store.get(ROOT_ID)).toBeUndefined();first.c.dispose()
})
it.each(["schemaHash","serverRelease"] as const)("discards a different %s without restoring cursors",async(field)=>{
 const a=adapter();const first=await seed(a);const c=client();await persistClient(c,{...options,[field]:"other",adapter:a}).ready
 expect(c.store.size).toBe(0);expect(a.values.size).toBe(0);c.dispose();first.c.dispose()
})
it.each(["corrupt","oversized","unavailable"])("diagnoses %s storage and continues reading",async(kind)=>{
 const a=adapter();a.get.mockImplementation(async()=>{if(kind==="unavailable")throw Error('offline');return kind==="corrupt"?"{":"x".repeat(200)})
 const diagnostic=vi.fn(),c=client();await persistClient(c,{...options,adapter:a,maxBytes:100,onDiagnostic:diagnostic}).ready
 expect(diagnostic).toHaveBeenCalled();await expect(c.execute(ops.WidgetPage!,{Id:"w"})).resolves.toBeDefined();c.dispose()
})
it("searches the complete payload for sensitive and no-store markers",async()=>{
 const a=adapter(), marker="PRIVATE_MARKER_17"
 const docs=compile(schema,[`query Private @sensitive { LookupName(Text: "x") }`,`mutation PrivateMutation { IssueToken(Id: "w") { Secret } }`])
 const c=createClient({network:{execute:async r=>r.name==='Private'?{data:{LookupName:marker}}:r.name==='PrivateMutation'?{data:{IssueToken:{__typename:"TokenResult",Secret:marker}}}:{data:{Widget:widget("w")}}}})
 const p=persistClient(c,{...options,adapter:a});await p.ready
 await c.query(docs.operations.Private!,{});await c.mutate(docs.operations.PrivateMutation!,{},{policy:"no-store"})
 await c.execute(ops.WidgetPage!,{Id:"w"});await p.flush()
 expect([...a.values.values()].join('')).not.toContain(marker);expect(a.set).toHaveBeenCalled();c.dispose()
})
it("coalesces writes and never persists unconfirmed optimistic values",async()=>{
 vi.useFakeTimers();const a=adapter(), {c,p}=await seed(a);a.set.mockClear()
 const r=c.store.getOrCreate("temporary","Widget")
 const layer=c.store.optimistic(()=>c.store.setField(r,"Name","OPTIMISTIC_MARKER"))
 await p.flush();expect(a.set).not.toHaveBeenCalled()
 c.store.rollback(layer);c.store.setField(r,"Name","confirmed");c.store.publish();c.store.setField(r,"Name","confirmed-again");c.store.publish()
 await vi.advanceTimersByTimeAsync(10);expect(a.set).toHaveBeenCalledTimes(1)
 expect([...a.values.values()].join('')).not.toContain("OPTIMISTIC_MARKER");c.dispose()
})
it("a read or live write during restore wins even against a higher persisted version",async()=>{
 const a=adapter();const first=await seed(a);let release!:(v:string|null)=>void
 const payload=[...a.values.values()][0]!
 a.get.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
 const c=client(),p=persistClient(c,{...options,adapter:a})
 await c.execute(ops.WidgetPage!,{Id:"w"})
 const id=JSON.parse(payload).records.find((record: {typename:string})=>record.typename==='Widget').id
 const r=c.store.getOrCreate(id,"Widget");c.store.setField(r,"RowVersion",10);c.store.setField(r,"Name","event");c.store.publish()
 release(payload);await p.ready
 expect(c.store.get(id)?.fields.get("Name")).toBe("event");expect(c.store.isRestored(ROOT_ID)).toBe(false);c.dispose();first.c.dispose()
})
it.each([
 ["clear()",(p:{clear():Promise<void>})=>{void p.clear()},{}],
 ["disposal with deleteOnDispose",(_:unknown,c:{dispose():void})=>c.dispose(),{deleteOnDispose:true}],
] as const)("serializes deletion after a write racing %s",async(_name,act,extra)=>{
 const a=adapter();let finish!:()=>void
 a.set.mockImplementation(async(k,v)=>{await new Promise<void>(r=>{finish=r});a.values.set(k,v)})
 const c=client(),p=persistClient(c,{...options,...extra,adapter:a});await p.ready;await c.execute(ops.WidgetPage!,{Id:"w"})
 const flushing=p.flush();await Promise.resolve();await Promise.resolve();act(p as never,c);finish();await flushing
 await new Promise(r=>setTimeout(r,0));expect(a.values.size).toBe(0);if(!c.store.isDisposed)c.dispose()
})
it("a pop-out disposing on close leaves the main window's saved data",async()=>{
 const a=adapter(),main=await seed(a),saved=[...a.values.values()][0]
 const popout=client(),p=persistClient(popout,{...options,adapter:a});await p.ready
 expect(popout.store.size).toBeGreaterThan(0);popout.dispose();await new Promise(r=>setTimeout(r,0))
 expect([...a.values.values()][0]).toBe(saved);expect(a.delete).not.toHaveBeenCalled()
 // The main window carries on saving.
 main.c.store.setField(main.c.store.getOrCreate("another","Widget"),"Name","later");main.c.store.publish();await main.p.flush()
 expect([...a.values.values()][0]).toContain("later");main.c.dispose()
})
it("a read-only window restores, and never writes or deletes",async()=>{
 const a=adapter(),main=await seed(a),saved=[...a.values.values()][0];a.set.mockClear()
 const popout=client(),p=persistClient(popout,{...options,readOnly:true,deleteOnDispose:true,adapter:a});await p.ready
 expect(popout.store.size).toBeGreaterThan(0)
 await popout.execute(ops.WidgetPage!,{Id:"other"});await p.flush();await new Promise(r=>setTimeout(r,20))
 expect(a.set).not.toHaveBeenCalled()
 popout.dispose();await new Promise(r=>setTimeout(r,0))
 expect([...a.values.values()][0]).toBe(saved);expect(a.delete).not.toHaveBeenCalled();main.c.dispose()
})
it("a read-only window on another release leaves the saved data, without restoring it",async()=>{
 const a=adapter(),main=await seed(a),diagnostic=vi.fn()
 const popout=client();await persistClient(popout,{...options,serverRelease:"other",readOnly:true,adapter:a,onDiagnostic:diagnostic}).ready
 expect(popout.store.size).toBe(0);expect(diagnostic).toHaveBeenCalled();expect(a.values.size).toBe(1);expect(a.delete).not.toHaveBeenCalled()
 popout.dispose();main.c.dispose()
})
it("clear deletes what's saved and stops saving, before or after disposal",async()=>{
 const a=adapter(),{c,p}=await seed(a);await p.clear();expect(a.values.size).toBe(0)
 await c.execute(ops.WidgetPage!,{Id:"later"});await p.flush();await new Promise(r=>setTimeout(r,20));expect(a.values.size).toBe(0);c.dispose()
 const again=await seed(a);again.c.dispose();expect(a.values.size).toBe(1);await again.p.clear();expect(a.values.size).toBe(0)
})
it("a sign-out in one window stops the others saving, and deletes after a write of theirs already under way",async()=>{
 // A second adapter object over the same storage, as another window has: windows share no write queue.
 const a=adapter(),main=await seed(a),other=await seed({...a});await new Promise(r=>setTimeout(r,0))
 let finish!:()=>void;a.set.mockImplementation(async(k,v)=>{await new Promise<void>(r=>{finish=r});a.values.set(k,v)})
 other.c.store.setField(other.c.store.getOrCreate("another","Widget"),"Name","in flight");other.c.store.publish()
 const flushing=other.p.flush();await new Promise(r=>setTimeout(r,0))
 await main.p.clear();finish();await flushing;await new Promise(r=>setTimeout(r,20))
 expect(a.values.size).toBe(0);a.set.mockClear()
 other.c.store.setField(other.c.store.getOrCreate("another","Widget"),"Name","after");other.c.store.publish();await other.p.flush();await new Promise(r=>setTimeout(r,20))
 expect(a.set).not.toHaveBeenCalled();expect(a.values.size).toBe(0);main.c.dispose();other.c.dispose()
})
it("no identity has nothing to clear",async()=>{
 const a=adapter(),c=client();await persistClient(c,{...options,identityKey:undefined,adapter:a}).clear();expect(a.delete).not.toHaveBeenCalled();c.dispose()
})
it("reports quota and snapshot budget failures without rejecting a read",async()=>{
 const a=adapter();a.set.mockRejectedValue(Error("quota"));const diagnostic=vi.fn(),c=client(),p=persistClient(c,{...options,adapter:a,onDiagnostic:diagnostic});await p.ready
 await c.execute(ops.WidgetPage!,{Id:"w"});await p.flush();expect(diagnostic).toHaveBeenCalled();c.dispose()
})
it("a restore resolving after disposal never repopulates memory",async()=>{
 const a=adapter();const first=await seed(a);const payload=[...a.values.values()][0]!
 let complete!:(value:string)=>void;a.get.mockImplementation(()=>new Promise(resolve=>{complete=resolve}))
 const c=client(),p=persistClient(c,{...options,adapter:a});c.dispose();complete(payload);await p.ready
 expect(c.store.size).toBe(0);expect(c.store.get(ROOT_ID)).toBeUndefined();first.c.dispose()
})
it("restored newer versions reject older reads and collection removes unretained restored records",async()=>{
 const a=adapter();const c=createClient({network:{execute:async()=>({data:{Widget:widget("w",{RowVersion:9,Name:"newer"})}})}})
 const p=persistClient(c,{...options,adapter:a});await p.ready;await c.execute(ops.WidgetPage!,{Id:"w"});await p.flush()
 const older=createClient({network:{execute:async()=>({data:{Widget:widget("w",{RowVersion:1,Name:"older"})}})}})
 const restored=persistClient(older,{...options,adapter:a});await restored.ready
 await older.execute(ops.WidgetPage!,{Id:"w"})
 const record=older.store.persistenceSnapshot()!.find(r=>r.typename==='Widget')!
 expect(new Map(record.fields).get('Name')).toBe('newer')
 older.store.collect();expect(older.store.size).toBe(1);older.dispose();c.dispose()
})
it("applies generated lifetimes before drawing restored data",async()=>{
 const a=adapter();const first=await seed(a);const c=client();await persistClient(c,{...options,adapter:a}).ready
 const expired={...ops.WidgetPage!,lifetimes:{Widget:{field:'Name',format:'unix-seconds' as const}}}
 const q=c.watchQuery(expired,{Id:'w'})
 expect(q.getState().lifetime).toBe('unknown');expect(q.getState().stale).toBe(true)
 c.dispose();first.c.dispose()
})
it("a deletion during restore cannot resurrect the deleted record",async()=>{
 const a=adapter(),first=await seed(a);const payload=[...a.values.values()][0]!
 const id=first.c.store.persistenceSnapshot()!.find(r=>r.typename==='Widget')!.id
 let complete!:(value:string)=>void;a.get.mockImplementation(()=>new Promise(resolve=>{complete=resolve}))
 const c=client(),p=persistClient(c,{...options,adapter:a});c.store.delete(id);complete(payload);await p.ready
 expect(c.store.get(id)).toBeUndefined();c.dispose();first.c.dispose()
})

it("keeps connection cursors only within the same declared server release",async()=>{
 const a=adapter(),c=createClient({network:{execute:async()=>({data:catalog([widget("w")],{endCursor:"RELEASE_CURSOR"})})}})
 const p=persistClient(c,{...options,adapter:a});await p.ready;await c.execute(ops.CatalogPage!,{});await p.flush()
 expect([...a.values.values()].join('')).toContain('RELEASE_CURSOR')
 const same=client();await persistClient(same,{...options,adapter:a}).ready
 expect(JSON.stringify(same.store.persistenceSnapshot())).toContain('RELEASE_CURSOR')
 const next=client();await persistClient(next,{...options,serverRelease:'next-release',adapter:a}).ready
 expect(next.store.size).toBe(0);c.dispose();same.dispose();next.dispose()
})
