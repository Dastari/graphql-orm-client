import { describe, expect, it, vi } from "vitest"
import { OperationError, createClient, fragmentSelector, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { device, fleet, frags, mockNetwork, ops, org } from "./fixtures.js"

type FleetData = { Devices: { Edges: { Cursor: string; Node: object }[]; PageInfo: { TotalCount: number } } }
type DeviceData = { Device: object | null }

describe("store and client", () => {
  it("stores one record per NodeId and shares it between queries", async () => {
    const { network } = mockNetwork(({ name }) =>
      name === "FleetPage"
        ? { data: fleet([device("d1"), device("d2")]) }
        : { data: { Device: { ...device("d1", { Name: "renamed" }), Hostname: "h1", RowVersion: 1, Hardware: null } } }
    )
    const client = createClient({ network })
    const list = client.watchQuery<FleetData>(ops.FleetPage, {})
    list.open()
    await list.refetch()
    const before = list.getState().data!
    const firstRow = before.Devices.Edges[0]!.Node
    expect(readFragment<{ Name: string }>(frags.DeviceRow, firstRow).Name).toBe("device-d1")

    const listListener = vi.fn()
    list.subscribe(listListener)
    const rowListener = vi.fn()
    const { store, selector } = fragmentSelector(frags.DeviceRow, firstRow)
    store.subscribe(store.lookup(selector), rowListener)
    await client.execute(ops.DevicePage, { Id: "d1" })
    // Only the row's own fragment changed: the list's own data (references) did not.
    expect(rowListener).toHaveBeenCalledTimes(1)
    expect(listListener).not.toHaveBeenCalled()
    const after = list.getState().data!
    expect(readFragment<{ Name: string }>(frags.DeviceRow, after.Devices.Edges[0]!.Node).Name).toBe("renamed")
    // The second row did not change, so it keeps its identity.
    expect(after.Devices.Edges[1]).toBe(before.Devices.Edges[1])
    expect(client.store.get(encodeNodeId("Device", ["d1"]))).toBeDefined()
  })

  it("masks child fragments: roots see references, not fields", async () => {
    const { network } = mockNetwork(() => ({ data: fleet([device("d1")]) }))
    const client = createClient({ network })
    const { snapshot } = await client.execute<FleetData>(ops.FleetPage, {})
    const node = snapshot.data.Devices.Edges[0]!.Node as Record<string, unknown>
    expect(Object.keys(node).sort()).toEqual(["Id", "__typename"])
    expect(() => readFragment(frags.DeviceDetail, node)).toThrow(/not produced by a spread of DeviceDetail/)
    const row = readFragment<{ Organisation: object }>(frags.DeviceRow, node)
    expect(readFragment<{ DisplayName: string }>(frags.OrganisationBadge, row.Organisation).DisplayName).toBe("Acme")
    expect(readFragment(frags.DeviceRow, null)).toBeNull()
  })

  it("never lets an older record version replace a newer one", async () => {
    let version = 5
    let name = "current"
    const { network } = mockNetwork(() => ({
      data: { Device: { ...device("d1", { Name: name }), Hostname: null, RowVersion: version, Hardware: null } },
    }))
    const client = createClient({ network })
    await client.execute(ops.DevicePage, { Id: "d1" })
    version = 4
    name = "stale"
    const { snapshot } = await client.execute<DeviceData>(ops.DevicePage, { Id: "d1" })
    expect(readFragment<{ Name: string; RowVersion: number }>(frags.DeviceDetail, snapshot.data.Device)).toMatchObject({
      Name: "current",
      RowVersion: 5,
    })
    version = 6
    name = "newer"
    const latest = await client.execute<DeviceData>(ops.DevicePage, { Id: "d1" })
    expect(readFragment<{ Name: string }>(frags.DeviceDetail, latest.snapshot.data.Device).Name).toBe("newer")
  })

  it("stores lists per argument set, and composite keys as one record", async () => {
    const { network } = mockNetwork(({ name, variables }) => {
      if (name === "SlotPage") return { data: { Slot: { __typename: "Slot", Site: variables.Site, Name: variables.Name, State: "free" } } }
      const where = variables.Where as { Name?: { Eq?: string } } | undefined
      return { data: fleet(where?.Name?.Eq === "a" ? [device("a")] : [device("a"), device("b")]) }
    })
    const client = createClient({ network })
    const all = await client.execute<FleetData>(ops.FleetPage, {})
    const filtered = await client.execute<FleetData>(ops.FleetPage, { Where: { Name: { Eq: "a" } } })
    expect(all.snapshot.data.Devices.PageInfo.TotalCount).toBe(2)
    expect(filtered.snapshot.data.Devices.PageInfo.TotalCount).toBe(1)
    // Argument order does not matter.
    const reordered = client.store.lookup<FleetData>({
      id: "client:root",
      selections: ops.FleetPage.selections,
      variables: { Where: { Name: { Eq: "a" } } },
      fragments: ops.FleetPage.fragments,
    })
    expect(reordered.missing).toBe(false)
    await client.execute(ops.SlotPage, { Site: "north", Name: "a" })
    expect(client.store.get(encodeNodeId("Slot", ["north", "a"]))?.fields.get("State")).toBe("free")
  })

  it("reads unions and keeps keyless objects under their parent", async () => {
    const { network } = mockNetwork(() => ({
      data: { Search: [device("d1"), org("acme", "Acme")] },
    }))
    const client = createClient({ network })
    const { snapshot } = await client.execute<{ Search: Record<string, unknown>[] }>(ops.SearchPage, { Text: "a" })
    expect(snapshot.data.Search[0]).toMatchObject({ __typename: "Device", Name: "device-d1" })
    expect(snapshot.data.Search[1]).toMatchObject({ __typename: "Organisation", DisplayName: "Acme" })
    expect(snapshot.data.Search[1]).not.toHaveProperty("Name")
  })

  it("collects records once nothing retains them", async () => {
    const timers: (() => void)[] = []
    const { network } = mockNetwork(({ name }) =>
      name === "FleetPage"
        ? { data: fleet([device("d1"), device("d2")]) }
        : { data: { Device: { ...device("d1"), Hostname: null, RowVersion: 1, Hardware: null } } }
    )
    const client = createClient({
      network,
      store: { retainMs: 1000, setTimeout: (callback) => timers.push(callback), clearTimeout: () => {} },
    })
    const list = client.watchQuery(ops.FleetPage, {})
    list.open()
    await list.refetch()
    const detail = client.watchQuery(ops.DevicePage, { Id: "d1" })
    detail.open()
    await detail.refetch()

    list.close()
    timers.shift()!()
    // d1 is still retained by the detail query; d2 is collected.
    expect(client.store.get(encodeNodeId("Device", ["d1"]))).toBeDefined()
    expect(client.store.get(encodeNodeId("Device", ["d2"]))).toBeUndefined()

    detail.close()
    timers.shift()!()
    expect(client.store.get(encodeNodeId("Device", ["d1"]))).toBeUndefined()
  })

  it("reopening within the retention period serves the stored data", async () => {
    const { network, requests } = mockNetwork(() => ({ data: fleet([device("d1")]) }))
    const client = createClient({ network, store: { setTimeout: () => 0, clearTimeout: () => {} } })
    const first = client.watchQuery(ops.FleetPage, {}, "store-or-network")
    first.open()
    await first.refetch()
    first.close()
    const second = client.watchQuery(ops.FleetPage, {}, "store-or-network")
    expect(second.getState().status).toBe("ready")
    second.open()
    expect(requests).toHaveLength(1)
  })

  it("throws OperationError when the server returns no data", async () => {
    const { network } = mockNetwork(() => ({ data: null, errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }] }))
    const client = createClient({ network })
    await expect(client.execute(ops.FleetPage, {})).rejects.toBeInstanceOf(OperationError)
  })

  it("disposing clears the store and drops responses still in flight", async () => {
    let release!: () => void
    const { network } = mockNetwork(
      () => new Promise((resolve) => (release = () => resolve({ data: fleet([device("d1")]) })))
    )
    const client = createClient({ network })
    const pending = client.execute(ops.FleetPage, {})
    client.dispose()
    release()
    await expect(pending).rejects.toThrow()
    expect(client.store.size).toBe(0)
    await expect(client.execute(ops.FleetPage, {})).rejects.toThrow(/disposed/)
  })

  it("mutation responses update every view of the record", async () => {
    const { network } = mockNetwork(({ name, variables }) =>
      name === "FleetPage"
        ? { data: fleet([device("d1")]) }
        : {
            data: {
              UpdateDevice: {
                __typename: "DeviceResult",
                Success: true,
                Entity: { ...device("d1", { Name: variables.Name }), Hostname: null, RowVersion: 2, Hardware: null },
              },
            },
          }
    )
    const client = createClient({ network })
    const list = client.watchQuery<FleetData>(ops.FleetPage, {})
    list.open()
    await list.refetch()
    const { data } = await client.mutate<{ UpdateDevice: { Success: boolean } }>(ops.RenameDevice, { Id: "d1", Name: "new" })
    expect(data.UpdateDevice.Success).toBe(true)
    const node = list.getState().data!.Devices.Edges[0]!.Node
    expect(readFragment<{ Name: string }>(frags.DeviceRow, node).Name).toBe("new")
    // Mutation roots are not kept.
    expect([...Array(5).keys()].some((n) => client.store.get(`client:mutation:${n}`))).toBe(false)
  })
})
