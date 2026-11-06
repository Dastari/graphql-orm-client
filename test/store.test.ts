import { describe, expect, it, vi } from "vitest"
import { OperationError, createClient, fragmentSelector, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { widget, catalog, frags, mockNetwork, ops, vendor } from "./fixtures.js"

type CatalogData = { Widgets: { Edges: { Cursor: string; Node: object }[]; PageInfo: { TotalCount: number } } }
type WidgetData = { Widget: object | null }

describe("store and client", () => {
  it("stores one record per NodeId and shares it between queries", async () => {
    const { network } = mockNetwork(({ name }) =>
      name === "CatalogPage"
        ? { data: catalog([widget("d1"), widget("d2")]) }
        : { data: { Widget: { ...widget("d1", { Name: "renamed" }), Sku: "h1", RowVersion: 1, Spec: null } } }
    )
    const client = createClient({ network })
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    const before = list.getState().data!
    const firstRow = before.Widgets.Edges[0]!.Node
    expect(readFragment<{ Name: string }>(frags.WidgetRow, firstRow).Name).toBe("widget-d1")

    const listListener = vi.fn()
    list.subscribe(listListener)
    const rowListener = vi.fn()
    const { store, selector } = fragmentSelector(frags.WidgetRow, firstRow)
    store.subscribe(store.lookup(selector), rowListener)
    await client.execute(ops.WidgetPage, { Id: "d1" })
    // Only the row's own fragment changed: the list's own data (references) did not.
    expect(rowListener).toHaveBeenCalledTimes(1)
    expect(listListener).not.toHaveBeenCalled()
    const after = list.getState().data!
    expect(readFragment<{ Name: string }>(frags.WidgetRow, after.Widgets.Edges[0]!.Node).Name).toBe("renamed")
    // The second row did not change, so it keeps its identity.
    expect(after.Widgets.Edges[1]).toBe(before.Widgets.Edges[1])
    expect(client.store.get(encodeNodeId("Widget", ["d1"]))).toBeDefined()
  })

  it("masks child fragments: roots see references, not fields", async () => {
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network })
    const { snapshot } = await client.execute<CatalogData>(ops.CatalogPage, {})
    const node = snapshot.data.Widgets.Edges[0]!.Node as Record<string, unknown>
    expect(Object.keys(node).sort()).toEqual(["Id", "__typename"])
    expect(() => readFragment(frags.WidgetDetail, node)).toThrow(/not produced by a spread of WidgetDetail/)
    const row = readFragment<{ Vendor: object }>(frags.WidgetRow, node)
    expect(readFragment<{ DisplayName: string }>(frags.VendorBadge, row.Vendor).DisplayName).toBe("Acme")
    expect(readFragment(frags.WidgetRow, null)).toBeNull()
  })

  it("never lets an older record version replace a newer one", async () => {
    let version = 5
    let name = "current"
    const { network } = mockNetwork(() => ({
      data: { Widget: { ...widget("d1", { Name: name }), Sku: null, RowVersion: version, Spec: null } },
    }))
    const client = createClient({ network })
    await client.execute(ops.WidgetPage, { Id: "d1" })
    version = 4
    name = "stale"
    const { snapshot } = await client.execute<WidgetData>(ops.WidgetPage, { Id: "d1" })
    expect(readFragment<{ Name: string; RowVersion: number }>(frags.WidgetDetail, snapshot.data.Widget)).toMatchObject({
      Name: "current",
      RowVersion: 5,
    })
    version = 6
    name = "newer"
    const latest = await client.execute<WidgetData>(ops.WidgetPage, { Id: "d1" })
    expect(readFragment<{ Name: string }>(frags.WidgetDetail, latest.snapshot.data.Widget).Name).toBe("newer")
  })

  it("stores lists per argument set, and composite keys as one record", async () => {
    const { network } = mockNetwork(({ name, variables }) => {
      if (name === "SlotPage") return { data: { Slot: { __typename: "Slot", Site: variables.Site, Name: variables.Name, State: "free" } } }
      const where = variables.Where as { Name?: { Eq?: string } } | undefined
      return { data: catalog(where?.Name?.Eq === "a" ? [widget("a")] : [widget("a"), widget("b")]) }
    })
    const client = createClient({ network })
    const all = await client.execute<CatalogData>(ops.CatalogPage, {})
    const filtered = await client.execute<CatalogData>(ops.CatalogPage, { Where: { Name: { Eq: "a" } } })
    expect(all.snapshot.data.Widgets.PageInfo.TotalCount).toBe(2)
    expect(filtered.snapshot.data.Widgets.PageInfo.TotalCount).toBe(1)
    // Argument order does not matter.
    const reordered = client.store.lookup<CatalogData>({
      id: "client:root",
      selections: ops.CatalogPage.selections,
      variables: { Where: { Name: { Eq: "a" } } },
      fragments: ops.CatalogPage.fragments,
    })
    expect(reordered.missing).toBe(false)
    await client.execute(ops.SlotPage, { Site: "north", Name: "a" })
    expect(client.store.get(encodeNodeId("Slot", ["north", "a"]))?.fields.get("State")).toBe("free")
  })

  it("reads unions and keeps keyless objects under their parent", async () => {
    const { network } = mockNetwork(() => ({
      data: { Search: [widget("d1"), vendor("acme", "Acme")] },
    }))
    const client = createClient({ network })
    const { snapshot } = await client.execute<{ Search: Record<string, unknown>[] }>(ops.SearchPage, { Text: "a" })
    expect(snapshot.data.Search[0]).toMatchObject({ __typename: "Widget", Name: "widget-d1" })
    expect(snapshot.data.Search[1]).toMatchObject({ __typename: "Vendor", DisplayName: "Acme" })
    expect(snapshot.data.Search[1]).not.toHaveProperty("Name")
  })

  it("collects records once nothing retains them", async () => {
    const timers: (() => void)[] = []
    const { network } = mockNetwork(({ name }) =>
      name === "CatalogPage"
        ? { data: catalog([widget("d1"), widget("d2")]) }
        : { data: { Widget: { ...widget("d1"), Sku: null, RowVersion: 1, Spec: null } } }
    )
    const client = createClient({
      network,
      store: { retainMs: 1000, setTimeout: (callback) => timers.push(callback), clearTimeout: () => {} },
    })
    const list = client.watchQuery(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    const detail = client.watchQuery(ops.WidgetPage, { Id: "d1" })
    detail.open()
    await detail.refetch()

    list.close()
    timers.shift()!()
    // d1 is still retained by the detail query; d2 is collected.
    expect(client.store.get(encodeNodeId("Widget", ["d1"]))).toBeDefined()
    expect(client.store.get(encodeNodeId("Widget", ["d2"]))).toBeUndefined()

    detail.close()
    timers.shift()!()
    expect(client.store.get(encodeNodeId("Widget", ["d1"]))).toBeUndefined()
  })

  it("reopening within the retention period serves the stored data", async () => {
    const { network, requests } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network, store: { setTimeout: () => 0, clearTimeout: () => {} } })
    const first = client.watchQuery(ops.CatalogPage, {}, "store-or-network")
    first.open()
    await first.refetch()
    first.close()
    const second = client.watchQuery(ops.CatalogPage, {}, "store-or-network")
    expect(second.getState().status).toBe("ready")
    second.open()
    expect(requests).toHaveLength(1)
  })

  it("throws OperationError when the server returns no data", async () => {
    const { network } = mockNetwork(() => ({ data: null, errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }] }))
    const client = createClient({ network })
    await expect(client.execute(ops.CatalogPage, {})).rejects.toBeInstanceOf(OperationError)
  })

  it("disposing clears the store and drops responses still in flight", async () => {
    let release!: () => void
    const { network } = mockNetwork(
      () => new Promise((resolve) => (release = () => resolve({ data: catalog([widget("d1")]) })))
    )
    const client = createClient({ network })
    const pending = client.execute(ops.CatalogPage, {})
    client.dispose()
    release()
    await expect(pending).rejects.toThrow()
    expect(client.store.size).toBe(0)
    await expect(client.execute(ops.CatalogPage, {})).rejects.toThrow(/disposed/)
  })

  it("mutation responses update every view of the record", async () => {
    const { network } = mockNetwork(({ name, variables }) =>
      name === "CatalogPage"
        ? { data: catalog([widget("d1")]) }
        : {
            data: {
              UpdateWidget: {
                __typename: "WidgetResult",
                Success: true,
                Entity: { ...widget("d1", { Name: variables.Name }), Sku: null, RowVersion: 2, Spec: null },
              },
            },
          }
    )
    const client = createClient({ network })
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    const { data } = await client.mutate<{ UpdateWidget: { Success: boolean } }>(ops.RenameWidget, { Id: "d1", Name: "new" })
    expect(data.UpdateWidget.Success).toBe(true)
    const node = list.getState().data!.Widgets.Edges[0]!.Node
    expect(readFragment<{ Name: string }>(frags.WidgetRow, node).Name).toBe("new")
    // Mutation roots are not kept.
    expect([...Array(5).keys()].some((n) => client.store.get(`client:mutation:${n}`))).toBe(false)
  })
})
