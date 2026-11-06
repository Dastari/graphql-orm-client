import { describe, expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { compiled, widget, catalog, frags, mockNetwork, mockSubscriptions, ops } from "./fixtures.js"

type CatalogData = { Widgets: { Edges: { Node: object }[] } }

function setup(
  responder: Parameters<typeof mockNetwork>[0],
  live: { maxKeyedSubscriptions?: number; artifacts?: typeof compiled.live } = {}
) {
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
    expect(compiled.live.Widget?.mode).toBe("key")
    expect(compiled.live.Slot?.mode).toBe("keys")
    expect(compiled.live.Vendor?.mode).toBe("unkeyed")
    expect(compiled.live.Widget?.entityField).toBe("Widget")
    expect(compiled.live.Widget?.operation.text).toMatch(/subscription LiveWidget\(\$Key: String\) \{\s+WidgetChanged\(Key: \$Key\)/)
    expect(compiled.live.Widget?.operation.text).toContain("fragment WidgetRow on Widget")
    expect(compiled.liveUnavailable).toEqual([])
  })

  it("subscribes for exactly the held records and writes events into the store", async () => {
    const { client, subscriptions } = setup(() => ({ data: catalog([widget("d1"), widget("d2")]) }))
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()

    const keyed = subscriptions.find("LiveWidget")
    expect(keyed.map((entry) => entry.request.variables.Key).sort()).toEqual(["d1", "d2"])
    // Vendor badges are live through an unkeyed stream.
    expect(subscriptions.find("LiveVendor")).toHaveLength(1)

    const d1 = keyed.find((entry) => entry.request.variables.Key === "d1")!
    d1.sink.next({
      data: {
        WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: widget("d1", { StockState: "offline" }) },
      },
    })
    const node = list.getState().data!.Widgets.Edges[0]!.Node
    expect(readFragment<{ StockState: string }>(frags.WidgetRow, node).StockState).toBe("offline")

    list.close()
    client.live!.flush()
    expect(subscriptions.open.size).toBe(0)
  })

  it("ignores unkeyed events for records nobody holds", async () => {
    const { client, subscriptions } = setup(() => ({ data: catalog([widget("d1")]) }))
    const list = client.watchQuery(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    const [stream] = subscriptions.find("LiveVendor")
    stream!.sink.next({
      data: {
        VendorChanged: {
          __typename: "VendorChangedEvent",
          Action: "UPDATED",
          Vendor: { __typename: "Vendor", Id: "other", DisplayName: "Other" },
        },
      },
    })
    expect(client.store.get(encodeNodeId("Vendor", ["other"]))).toBeUndefined()
    stream!.sink.next({
      data: {
        VendorChanged: {
          __typename: "VendorChangedEvent",
          Action: "UPDATED",
          Vendor: { __typename: "Vendor", Id: "acme", DisplayName: "Acme Ltd" },
        },
      },
    })
    expect(client.store.get(encodeNodeId("Vendor", ["acme"]))?.fields.get("DisplayName")).toBe("Acme Ltd")
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

  it("caps per-record subscriptions and reports the overflow when a key is required", async () => {
    const { client, subscriptions } = setup(() => ({ data: catalog([widget("d1"), widget("d2"), widget("d3")]) }), {
      maxKeyedSubscriptions: 2,
      artifacts: { ...compiled.live, Widget: { ...compiled.live.Widget!, keyOptional: false } },
    })
    const list = client.watchQuery(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    expect(subscriptions.find("LiveWidget")).toHaveLength(2)
    expect(client.live!.status().Widget).toMatchObject({ mode: "key", held: 3, subscriptions: 2, overflow: 1 })
  })

  it("past the cap, an optional key uses one stream that writes only held records", async () => {
    const { client, subscriptions } = setup(() => ({ data: catalog([widget("d1"), widget("d2"), widget("d3")]) }), {
      maxKeyedSubscriptions: 2,
    })
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    const streams = subscriptions.find("LiveWidget")
    expect(streams).toHaveLength(1)
    expect(streams[0]!.request.variables).toEqual({})
    expect(client.live!.status().Widget).toMatchObject({ mode: "key", held: 3, subscriptions: 1, overflow: 0 })
    expect(client.live!.overflows("Widget")).toBe(false)

    streams[0]!.sink.next({
      data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: widget("elsewhere") } },
    })
    expect(client.store.get(encodeNodeId("Widget", ["elsewhere"]))).toBeUndefined()
    streams[0]!.sink.next({
      data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: { ...widget("d2"), Name: "Renamed" } } },
    })
    expect(client.store.get(encodeNodeId("Widget", ["d2"]))?.fields.get("Name")).toBe("Renamed")
  })

  it("a DELETED event removes the record, and the query reads again", async () => {
    let widgets = [widget("d1"), widget("d2")]
    const { client, subscriptions } = setup(() => ({ data: catalog(widgets) }))
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    widgets = [widget("d2")]
    const d1 = subscriptions.find("LiveWidget").find((entry) => entry.request.variables.Key === "d1")!
    d1.sink.next({ data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "DELETED", Widget: widget("d1") } } })
    expect(client.store.get(encodeNodeId("Widget", ["d1"]))).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(list.getState().data!.Widgets.Edges).toHaveLength(1)
  })

  it("after lost events, subscribes again and then refetches what shows the type", async () => {
    const order: string[] = []
    let name = "first"
    const { network } = mockNetwork(({ name: operation }) => {
      order.push(operation)
      return { data: catalog([widget("d1", { Name: name })]) }
    })
    const subscriptions = mockSubscriptions()
    const timers: { callback: () => void; ms: number }[] = []
    const client = createClient({
      network,
      live: {
        artifacts: compiled.live,
        subscribe: (request, sink) => {
          order.push(request.name)
          return subscriptions.subscribe(request, sink)
        },
        debounceMs: 0,
        resyncJitterMs: 400,
        setTimeout: (callback, ms) => timers.push({ callback, ms }),
        clearTimeout: () => {},
      },
    })
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    timers.length = 0
    order.length = 0

    const widget1 = subscriptions.find("LiveWidget")[0]!
    widget1.sink.next({ data: null, errors: [{ message: "lost", extensions: { code: "SUBSCRIPTION_CONTINUITY_LOST" } }] })
    widget1.sink.complete()
    // The ended stream is released at once; recovery waits for a random delay below the jitter.
    expect(client.live!.status().Widget?.subscriptions).toBe(0)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBeLessThan(400)

    name = "second"
    timers[0]!.callback()
    await list.refetch()
    expect(order.slice(0, 2)).toEqual(["LiveWidget", "CatalogPage"])
    expect(subscriptions.find("LiveWidget")).toHaveLength(1)
    expect(readFragment<{ Name: string }>(frags.WidgetRow, list.getState().data!.Widgets.Edges[0]!.Node).Name).toBe("second")
    client.dispose()
  })

  it("recovers from SUBSCRIPTION_SOURCE_CLOSED and a transport failure the same way", () => {
    const subscriptions = mockSubscriptions()
    const timers: (() => void)[] = []
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({
      network,
      live: {
        artifacts: compiled.live,
        subscribe: subscriptions.subscribe,
        debounceMs: 0,
        setTimeout: (callback) => timers.push(callback),
        clearTimeout: () => {},
      },
    })
    const live = client.live!
    live.hold("q", new Map([["Widget", new Set([encodeNodeId("Widget", ["d1"])])]]))
    live.flush()
    timers.length = 0

    subscriptions.find("LiveWidget")[0]!.sink.error(new Error("socket gone"))
    expect(subscriptions.find("LiveWidget")).toHaveLength(0)
    expect(timers).toHaveLength(1)
    timers.shift()!()
    expect(subscriptions.find("LiveWidget")).toHaveLength(1)

    subscriptions.find("LiveWidget")[0]!.sink.next({
      data: null,
      errors: [{ message: "closed", extensions: { code: "SUBSCRIPTION_SOURCE_CLOSED" } }],
    })
    expect(subscriptions.find("LiveWidget")).toHaveLength(0)
    expect(timers).toHaveLength(1)
    timers.shift()!()
    expect(subscriptions.find("LiveWidget")).toHaveLength(1)
    client.dispose()
  })

  it("disposing the client closes every subscription", async () => {
    const { client, subscriptions } = setup(() => ({ data: catalog([widget("d1")]) }))
    const list = client.watchQuery(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    expect(subscriptions.open.size).toBeGreaterThan(0)
    client.dispose()
    expect(subscriptions.open.size).toBe(0)
  })
})
