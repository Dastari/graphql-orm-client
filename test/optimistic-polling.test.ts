import { describe, expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { compiled, widget, catalog, frags, mockNetwork, mockSubscriptions, ops } from "./fixtures.js"

type CatalogData = { Widgets: { Edges: { Node: object }[] } }
const rowName = (data: CatalogData | undefined, index = 0) =>
  readFragment<{ Name: string }>(frags.WidgetRow, data!.Widgets.Edges[index]!.Node).Name

function renameResponse(id: string, name: string, version: number) {
  return {
    UpdateWidget: {
      __typename: "WidgetResult",
      Success: true,
      Entity: { ...widget(id, { Name: name }), Sku: null, RowVersion: version, Spec: null },
    },
  }
}

describe("optimistic mutations", () => {
  it("shows the expected result at once and replaces it with the server's", async () => {
    let respond!: (name: string) => void
    const { network } = mockNetwork(({ name }) =>
      name === "CatalogPage"
        ? { data: catalog([widget("d1")]) }
        : new Promise((resolve) => (respond = (serverName) => resolve({ data: renameResponse("d1", serverName, 2) })))
    )
    const client = createClient({ network })
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    const pending = client.mutate(ops.RenameWidget, { Id: "d1", Name: "guess" }, {
      optimisticResponse: renameResponse("d1", "guess", 1),
    })
    expect(rowName(list.getState().data)).toBe("guess")
    respond("server-name")
    await pending
    expect(rowName(list.getState().data)).toBe("server-name")
  })

  it("rolls back on failure", async () => {
    const { network } = mockNetwork(({ name }) =>
      name === "CatalogPage" ? { data: catalog([widget("d1")]) } : { data: null, errors: [{ message: "denied" }] }
    )
    const client = createClient({ network })
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    await expect(
      client.mutate(ops.RenameWidget, { Id: "d1", Name: "guess" }, { optimisticResponse: renameResponse("d1", "guess", 1) })
    ).rejects.toThrow("denied")
    expect(rowName(list.getState().data)).toBe("widget-d1")
  })

  it("never rolls back over a newer write", async () => {
    let fail!: () => void
    const subscriptions = mockSubscriptions()
    const { network } = mockNetwork(({ name }) =>
      name === "CatalogPage"
        ? { data: catalog([widget("d1")]) }
        : new Promise((resolve) => (fail = () => resolve({ data: null, errors: [{ message: "denied" }] })))
    )
    const client = createClient({
      network,
      live: { artifacts: compiled.live, subscribe: subscriptions.subscribe, setTimeout: () => 0, clearTimeout: () => {} },
    })
    const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    const pending = client.mutate(ops.RenameWidget, { Id: "d1", Name: "guess" }, {
      optimisticResponse: renameResponse("d1", "guess", 1),
    })
    // A live event renames the widget while the mutation is in flight.
    const stream = subscriptions.find("LiveWidget")[0]!
    stream.sink.next({ data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: widget("d1", { Name: "from-live" }) } } })
    fail()
    await expect(pending).rejects.toThrow()
    expect(rowName(list.getState().data)).toBe("from-live")
  })
})

describe("polling", () => {
  function timers() {
    const intervals = new Map<number, { callback: () => void; ms: number }>()
    let next = 0
    return {
      intervals,
      setInterval: (callback: () => void, ms: number) => {
        intervals.set(++next, { callback, ms })
        return next
      },
      clearInterval: (handle: unknown) => {
        intervals.delete(handle as number)
      },
      tick: () => [...intervals.values()].forEach((entry) => entry.callback()),
    }
  }

  it("polls on a requested interval while open and visible", async () => {
    const clock = timers()
    let active = true
    const { network, requests } = mockNetwork(() => ({ data: { Slot: { __typename: "Slot", Site: "n", Name: "a", State: "free" } } }))
    const client = createClient({ network, polling: { ...clock, isActive: () => active, liveFallbackMs: null } })
    const slot = client.watchQuery(ops.SlotPage, { Site: "n", Name: "a" }, { pollMs: 5000 })
    slot.open()
    await slot.refetch()
    expect([...clock.intervals.values()].map((entry) => entry.ms)).toEqual([5000])
    clock.tick()
    await Promise.resolve()
    expect(requests).toHaveLength(2)
    active = false
    clock.tick()
    expect(requests).toHaveLength(2)
    slot.close()
    expect(clock.intervals.size).toBe(0)
  })

  it("falls back to polling for @live records no subscription covers", async () => {
    const clock = timers()
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1"), widget("d2"), widget("d3")]) }))
    const subscriptions = mockSubscriptions()
    const client = createClient({
      network,
      polling: { ...clock, liveFallbackMs: 15_000 },
      live: {
        artifacts: { ...compiled.live, Widget: { ...compiled.live.Widget!, keyOptional: false } },
        subscribe: subscriptions.subscribe,
        maxKeyedSubscriptions: 2,
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
    })
    const list = client.watchQuery(ops.CatalogPage, {})
    list.open()
    await list.refetch()
    // Three widgets with a cap of two per-record subscriptions: the query polls.
    expect([...clock.intervals.values()].map((entry) => entry.ms)).toEqual([15_000])

    const withoutLive = createClient({ network, polling: { ...clock, liveFallbackMs: 20_000 } })
    clock.intervals.clear()
    const other = withoutLive.watchQuery(ops.CatalogPage, {})
    other.open()
    await other.refetch()
    // No live layer at all: every @live record is uncovered.
    expect([...clock.intervals.values()].map((entry) => entry.ms)).toEqual([20_000])
  })
})
