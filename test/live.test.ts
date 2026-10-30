import { describe, expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { compiled, device, fleet, frags, mockNetwork, mockSubscriptions, ops } from "./fixtures.js"

type FleetData = { Devices: { Edges: { Node: object }[] } }

function setup(responder: Parameters<typeof mockNetwork>[0], live: { maxKeyedSubscriptions?: number } = {}) {
  const { network } = mockNetwork(responder)
  const subscriptions = mockSubscriptions()
  const client = createClient({
    network,
    live: {
      artifacts: compiled.live,
      subscribe: subscriptions.subscribe,
      debounceMs: 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
      ...live,
    },
  })
  return { client, subscriptions }
}

describe("live layer", () => {
  it("compiles one subscription per type with @live fragments, choosing the mode from the schema", () => {
    expect(compiled.live.Device?.mode).toBe("key")
    expect(compiled.live.Slot?.mode).toBe("keys")
    expect(compiled.live.Organisation?.mode).toBe("unkeyed")
    expect(compiled.live.Device?.entityField).toBe("Device")
    expect(compiled.live.Device?.operation.text).toMatch(/subscription LiveDevice\(\$Key: String\) \{\s+DeviceChanged\(Key: \$Key\)/)
    expect(compiled.live.Device?.operation.text).toContain("fragment DeviceRow on Device")
    expect(compiled.liveUnavailable).toEqual([])
  })

  it("subscribes for exactly the held records and writes events into the store", async () => {
    const { client, subscriptions } = setup(() => ({ data: fleet([device("d1"), device("d2")]) }))
    const list = client.watchQuery<FleetData>(ops.FleetPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()

    const keyed = subscriptions.find("LiveDevice")
    expect(keyed.map((entry) => entry.request.variables.Key).sort()).toEqual(["d1", "d2"])
    // Organisation badges are live through an unkeyed stream.
    expect(subscriptions.find("LiveOrganisation")).toHaveLength(1)

    const d1 = keyed.find((entry) => entry.request.variables.Key === "d1")!
    d1.sink.next({
      data: {
        DeviceChanged: { __typename: "DeviceChangedEvent", Action: "UPDATED", Device: device("d1", { ConnectionState: "offline" }) },
      },
    })
    const node = list.getState().data!.Devices.Edges[0]!.Node
    expect(readFragment<{ ConnectionState: string }>(frags.DeviceRow, node).ConnectionState).toBe("offline")

    list.close()
    client.live!.flush()
    expect(subscriptions.open.size).toBe(0)
  })

  it("ignores unkeyed events for records nobody holds", async () => {
    const { client, subscriptions } = setup(() => ({ data: fleet([device("d1")]) }))
    const list = client.watchQuery(ops.FleetPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    const [stream] = subscriptions.find("LiveOrganisation")
    stream!.sink.next({
      data: {
        OrganisationChanged: {
          __typename: "OrganisationChangedEvent",
          Action: "UPDATED",
          Organisation: { __typename: "Organisation", Id: "other", DisplayName: "Other" },
        },
      },
    })
    expect(client.store.get(encodeNodeId("Organisation", ["other"]))).toBeUndefined()
    stream!.sink.next({
      data: {
        OrganisationChanged: {
          __typename: "OrganisationChangedEvent",
          Action: "UPDATED",
          Organisation: { __typename: "Organisation", Id: "acme", DisplayName: "Acme Ltd" },
        },
      },
    })
    expect(client.store.get(encodeNodeId("Organisation", ["acme"]))?.fields.get("DisplayName")).toBe("Acme Ltd")
  })

  it("sends composite keys as one Keys list", async () => {
    const { client, subscriptions } = setup(({ variables }) => ({
      data: { Slot: { __typename: "Slot", Site: variables.Site, Name: variables.Name, State: "free" } },
    }))
    const slot = client.watchQuery(ops.SlotPage, { Site: "north", Name: "a" })
    slot.open()
    await slot.refetch()
    client.live!.flush()
    const [stream] = subscriptions.find("LiveSlot")
    expect(stream!.request.variables).toEqual({ Keys: [{ Site: "north", Name: "a" }] })
  })

  it("caps per-record subscriptions and reports the overflow", async () => {
    const { client, subscriptions } = setup(() => ({ data: fleet([device("d1"), device("d2"), device("d3")]) }), {
      maxKeyedSubscriptions: 2,
    })
    const list = client.watchQuery(ops.FleetPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    expect(subscriptions.find("LiveDevice")).toHaveLength(2)
    expect(client.live!.status().Device).toMatchObject({ mode: "key", held: 3, subscriptions: 2, overflow: 1 })
  })

  it("a DELETED event removes the record, and the query reads again", async () => {
    let devices = [device("d1"), device("d2")]
    const { client, subscriptions } = setup(() => ({ data: fleet(devices) }))
    const list = client.watchQuery<FleetData>(ops.FleetPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    devices = [device("d2")]
    const d1 = subscriptions.find("LiveDevice").find((entry) => entry.request.variables.Key === "d1")!
    d1.sink.next({ data: { DeviceChanged: { __typename: "DeviceChangedEvent", Action: "DELETED", Device: device("d1") } } })
    expect(client.store.get(encodeNodeId("Device", ["d1"]))).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(list.getState().data!.Devices.Edges).toHaveLength(1)
  })

  it("disposing the client closes every subscription", async () => {
    const { client, subscriptions } = setup(() => ({ data: fleet([device("d1")]) }))
    const list = client.watchQuery(ops.FleetPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    expect(subscriptions.open.size).toBeGreaterThan(0)
    client.dispose()
    expect(subscriptions.open.size).toBe(0)
  })
})
