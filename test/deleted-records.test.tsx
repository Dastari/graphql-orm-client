// @vitest-environment jsdom
import { act, render, screen, cleanup } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { useFragment } from "../src/react/index.js"
import { compile } from "../src/compiler/index.js"
import { schema, catalog, widget, frags, mockNetwork, ops } from "./fixtures.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"
afterEach(cleanup)
it("confirms legacy removed-reference behaviour and offers typed null while the list is still mounted", async () => {
 const clock = createTestClock(), streams = createMockStreams()
 let release!: () => void
 const blocked = new Promise<void>(r => { release = r })
 let gone = false
 const mock = mockNetwork(async () => { if (gone) await blocked; return { data: catalog(gone ? [] : [widget("a", { RowVersion: 9 })]) } })
 const compiled = compile(schema, [`fragment DeleteRow on Widget @live { Name }`, `query Deletable { Widgets { Edges { Node { ...DeleteRow } } } }`], { versions: { Widget: "RowVersion" } })
 const client = createClient({ network: mock.network, store: { ...clock.store, deletedRecords: "omit" }, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, connection: { state: () => "connected", subscribe: listener => streams.onReconnect(() => listener({ reconnected: true })) }, resyncJitterMs: 0, settleMs: false, debounceMs: 0, minRereadMs: 0, onDiagnostic: null } })
 const query = client.watchQuery<any>(compiled.operations.Deletable!, {})
 query.open(); await clock.tick()
 const ref = query.getState().data.Widgets.Edges[0].Node
 const fragment = compiled.fragments.DeleteRow!
 function Row() { const data = useFragment<{ Name: string }>(fragment, ref, { deleted: "null" }); return <p>{data ? data.Name : "deleted"}</p> }
 render(<Row />)
 expect(screen.getByText("widget-a")).toBeTruthy()
 await act(async () => { streams.one("LiveWidget").emit(widget("a", { Name: "older", RowVersion: 1 })); await clock.tick() })
 expect(screen.getByText("widget-a")).toBeTruthy()
 gone = true
 await act(async () => { streams.one("LiveWidget").emit(widget("a"), { action: "DELETED", changeKind: "DIRECT" }); await clock.tick() })
 expect(screen.getByText("deleted")).toBeTruthy()
 expect(readFragment(fragment, ref)).toBeNull()
 expect(readFragment(fragment, ref, { deleted: "null" })).toBeNull()
 expect(client.store.get(encodeNodeId("Widget", ["a"]))).toBeUndefined()
 // The row is mounted using its old reference, before the owning list's reread finishes.
 expect(query.getState().data.Widgets.Edges).toEqual([])
 await act(async () => { release(); await clock.tick() })
 expect(screen.getByText("deleted")).toBeTruthy()
 await act(async () => { streams.reconnect(); await clock.tick() })
 expect(readFragment(fragment, ref, { deleted: "null" })).toBeNull()
 expect(query.getState().data.Widgets.Edges).toEqual([])
 query.close(); client.store.collect(); client.dispose()
})
it("nullable fragments retain the live shape and become null after collection or identity disposal", async () => {
 const client = createClient({ network: mockNetwork(() => ({ data: catalog([widget("a")]) })).network })
 const result = await client.execute<any>(ops.CatalogPage, {})
 const ref = result.snapshot.data.Widgets.Edges[0].Node
 expect(readFragment(frags.WidgetRow, ref, { deleted: "null" })).toEqual(readFragment(frags.WidgetRow, ref))
 client.store.collect()
 expect(readFragment(frags.WidgetRow, ref, { deleted: "null" })).toBeNull()
 client.dispose()
 expect(readFragment(frags.WidgetRow, ref, { deleted: "null" })).toBeNull()
})
