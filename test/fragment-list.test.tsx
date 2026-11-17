// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { StrictMode, useLayoutEffect, useState, type ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createClient, type Client } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { ClientProvider, useFragment, useFragmentList, useQuery } from "../src/react/index.js"
import { Store, type Selector } from "../src/store/store.js"
import { catalog, frags, mockNetwork, ops, widget } from "./fixtures.js"

type CatalogData = { Widgets: { Edges: { Cursor: string; Node: object }[] } }
type Row = { Name: string; StockState: string }

// Counts the store work done for WidgetRow selectors only: reads, subscriptions and their disposals.
const work = { reads: [] as string[], subscribed: [] as string[], disposed: [] as string[], toDisposedStore: 0 }
const isRow = (selector: Selector) => selector.selections === frags.WidgetRow!.selections
beforeEach(() => {
  reset()
  const lookup = Store.prototype.lookup
  const subscribe = Store.prototype.subscribe
  vi.spyOn(Store.prototype, "lookup").mockImplementation(function (this: Store, selector) {
    if (isRow(selector)) work.reads.push(selector.id)
    return lookup.call(this, selector)
  })
  vi.spyOn(Store.prototype, "subscribe").mockImplementation(function (this: Store, snapshot, callback) {
    if (this.isDisposed) work.toDisposedStore += 1
    const dispose = subscribe.call(this, snapshot, callback)
    if (!isRow(snapshot.selector)) return dispose
    work.subscribed.push(snapshot.selector.id)
    return () => {
      work.disposed.push(snapshot.selector.id)
      dispose()
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function reset() {
  work.reads = []
  work.subscribed = []
  work.disposed = []
  work.toDisposedStore = 0
}

const id = (key: string) => encodeNodeId("Widget", [key])
let rerender: () => void = () => {}
let shown: readonly Row[] = []
/** Runs in a layout effect of a sibling, in the commit where the rows first show: after render, before the list subscribes. */
let beforeSubscribe: (() => void) | null = null

function Sibling({ ready }: { ready: boolean }) {
  useLayoutEffect(() => {
    if (ready) beforeSubscribe?.()
  }, [ready])
  return null
}

function Table() {
  const [, setTick] = useState(0)
  rerender = () => setTick((tick) => tick + 1)
  const { data } = useQuery<CatalogData>(ops.CatalogPage!, {})
  // A new array on every render, as the documented usage passes.
  const rows = useFragmentList<Row>(frags.WidgetRow!, data?.Widgets.Edges.map((edge) => edge.Node))
  shown = rows
  return (
    <>
      <p>{rows.map((row) => row?.Name ?? "-").join(",") || "empty"}</p>
      <Sibling ready={rows.length > 0} />
    </>
  )
}

function setup(keys: string[], wrap: (node: ReactElement) => ReactElement = (node) => node) {
  let current = keys
  const { network } = mockNetwork(({ name, variables }) =>
    name === "CatalogPage"
      ? { data: catalog(current.map((key) => widget(key))) }
      : { data: { Widget: { ...widget(String(variables.Id), { Name: `renamed-${String(variables.Id)}` }), Sku: null, RowVersion: 9, Spec: null } } }
  )
  const client = createClient({ network })
  const view = render(wrap(<ClientProvider client={client}><Table /></ClientProvider>))
  return { client, view, setKeys: (next: string[]) => (current = next) }
}

const keys = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`)

describe("useFragmentList", () => {
  it("makes no store subscription changes and no reads when the parent renders again with the same rows", async () => {
    setup(keys(5))
    await screen.findByText(keys(5).map((key) => `widget-${key}`).join(","))
    const before = shown
    reset()
    act(() => rerender())
    act(() => rerender())
    expect(work).toEqual({ reads: [], subscribed: [], disposed: [], toDisposedStore: 0 })
    expect(shown).toBe(before)
  })

  it("reads only the row that changed, and keeps every other row's object", async () => {
    const { client } = setup(keys(5))
    await screen.findByText(keys(5).map((key) => `widget-${key}`).join(","))
    const before = shown
    reset()
    await act(() => client.execute(ops.WidgetPage!, { Id: "w2" }))
    expect(screen.getByText("widget-w0,widget-w1,renamed-w2,widget-w3,widget-w4")).toBeTruthy()
    expect(work.reads).toEqual([id("w2")])
    expect(work.subscribed).toEqual([])
    expect(work.disposed).toEqual([])
    expect(shown).not.toBe(before)
    for (const index of [0, 1, 3, 4]) expect(shown[index]).toBe(before[index])
  })

  it("subscribes only an added row and disposes only a removed one", async () => {
    const { client, setKeys } = setup(["w0", "w1", "w2"])
    await screen.findByText("widget-w0,widget-w1,widget-w2")
    reset()
    setKeys(["w0", "w1", "w2", "w3"])
    await act(() => client.execute(ops.CatalogPage!, {}))
    await screen.findByText("widget-w0,widget-w1,widget-w2,widget-w3")
    expect(work.subscribed).toEqual([id("w3")])
    expect(work.disposed).toEqual([])
    expect(work.reads).toEqual([id("w3")])

    reset()
    setKeys(["w0", "w2", "w3"])
    await act(() => client.execute(ops.CatalogPage!, {}))
    await screen.findByText("widget-w0,widget-w2,widget-w3")
    expect(work.subscribed).toEqual([])
    expect(work.disposed).toEqual([id("w1")])
    expect(work.reads).toEqual([])
  })

  it("disposes every row's subscription on unmount, and works under StrictMode", async () => {
    const { view, client } = setup(["w0", "w1"], (node) => <StrictMode>{node}</StrictMode>)
    await screen.findByText("widget-w0,widget-w1")
    await act(() => client.execute(ops.WidgetPage!, { Id: "w1" }))
    expect(screen.getByText("widget-w0,renamed-w1")).toBeTruthy()
    const live = work.subscribed.length - work.disposed.length
    expect(live).toBe(2)
    reset()
    view.unmount()
    await Promise.resolve()
    expect([...work.disposed].sort()).toEqual([id("w0"), id("w1")])
  })

  it("reads a row again when a publish changed it between render and commit", async () => {
    let client: Client | null = null
    beforeSubscribe = () => {
      const store = client!.store
      store.setField(store.get(id("w1"))!, "Name", "changed")
      store.publish()
    }
    try {
      client = setup(["w0", "w1"]).client
      await screen.findByText("widget-w0,changed")
    } finally {
      beforeSubscribe = null
    }
    // Read during render, then once more at commit for the publish; the row that changed is the one shown.
    expect(work.reads.filter((read) => read === id("w1"))).toHaveLength(2)
    expect(work.reads.filter((read) => read === id("w0"))).toHaveLength(2)
  })

  it("reads nothing more at commit when nothing was published between render and commit", async () => {
    setup(["w0", "w1"])
    await screen.findByText("widget-w0,widget-w1")
    expect(work.reads.filter((read) => read === id("w1"))).toHaveLength(1)
  })

  it("never shows a disposed client's rows, and never subscribes to its store (identity disposal)", async () => {
    const { client } = setup(["w0", "w1"])
    await screen.findByText("widget-w0,widget-w1")
    const before = shown
    reset()
    client.dispose()
    // The parent renders again with a new array of the same references.
    act(() => rerender())
    expect(screen.queryByText("widget-w0,widget-w1")).toBeNull()
    expect(shown).not.toBe(before)
    act(() => rerender())
    expect(screen.queryByText("widget-w0,widget-w1")).toBeNull()
    expect(work.toDisposedStore).toBe(0)
  })

  it("useFragment never shows a disposed client's record either", async () => {
    function Row({ widget: ref }: { widget: object }) {
      const row = useFragment<Row>(frags.WidgetRow!, ref)
      return <li>{row?.Name ?? "-"}</li>
    }
    let again: () => void = () => {}
    function Page() {
      const [, setTick] = useState(0)
      again = () => setTick((tick) => tick + 1)
      const { data } = useQuery<CatalogData>(ops.CatalogPage!, {})
      return <ul>{data?.Widgets.Edges.map((edge) => <Row key={edge.Cursor} widget={edge.Node} />)}</ul>
    }
    const client = createClient({ network: mockNetwork(() => ({ data: catalog([widget("w0")]) })).network })
    render(<ClientProvider client={client}><Page /></ClientProvider>)
    await screen.findByText("widget-w0")
    reset()
    client.dispose()
    act(() => again())
    expect(screen.queryByText("widget-w0")).toBeNull()
    expect(work.toDisposedStore).toBe(0)
  })

  it("reads the rows of a new identity's client and never shows the previous one's", async () => {
    const make = (name: string): Client =>
      createClient({ network: mockNetwork(() => ({ data: catalog([widget("w0", { Name: name })]) })).network })
    const first = make("first")
    function Switch() {
      const [client, setClient] = useState(first)
      rerender = () => {
        client.dispose()
        setClient(make("second"))
      }
      return <ClientProvider client={client}><Inner /></ClientProvider>
    }
    function Inner() {
      const { data } = useQuery<CatalogData>(ops.CatalogPage!, {})
      const rows = useFragmentList<Row>(frags.WidgetRow!, data?.Widgets.Edges.map((edge) => edge.Node))
      return <p>{rows.map((row) => row.Name).join(",") || "empty"}</p>
    }
    render(<Switch />)
    await screen.findByText("first")
    act(() => rerender())
    expect(screen.queryByText("first")).toBeNull()
    await screen.findByText("second")
  })
})
