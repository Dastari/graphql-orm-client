// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react"
import { StrictMode } from "react"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { ClientProvider, useFragment, useFragmentList, useQuery } from "../src/react/index.js"
import { widget, catalog, frags, mockNetwork, ops } from "./fixtures.js"

type CatalogData = { Widgets: { Edges: { Cursor: string; Node: object }[] } }
type Row = { Name: string; StockState: string }

const renders = new Map<string, number>()
const count = (key: string) => renders.set(key, (renders.get(key) ?? 0) + 1)

function WidgetRow({ widget: ref }: { widget: object }) {
  const row = useFragment<Row & { Id?: string }>(frags.WidgetRow, ref)
  count(`row:${row.Name}`)
  return <li>{`${row.Name} ${row.StockState}`}</li>
}

function CatalogPage({ where }: { where: Record<string, unknown> | null }) {
  const { status, data } = useQuery<CatalogData>(ops.CatalogPage, where)
  count("page")
  if (status === "loading" || !data) return <p>{status}</p>
  return (
    <ul>
      {data.Widgets.Edges.map((edge) => (
        <WidgetRow key={edge.Cursor} widget={edge.Node} />
      ))}
    </ul>
  )
}

function CatalogTable() {
  const { data } = useQuery<CatalogData>(ops.CatalogPage, {})
  const rows = useFragmentList<Row>(frags.WidgetRow, data?.Widgets.Edges.map((edge) => edge.Node))
  return <p>{rows.map((row) => row.Name).join(",") || "empty"}</p>
}

describe("React bindings", () => {
  it("loads a root query and re-renders only the row whose fragment changed", async () => {
    renders.clear()
    let first = true
    const { network } = mockNetwork(({ name }) => {
      if (name === "CatalogPage") return { data: catalog([widget("d1"), widget("d2")]) }
      const renamed = { ...widget("d1", { Name: first ? "renamed" : "x" }), Sku: null, RowVersion: 2, Spec: null }
      first = false
      return { data: { Widget: renamed } }
    })
    const client = createClient({ network })
    render(
      <ClientProvider client={client}>
        <CatalogPage where={{}} />
      </ClientProvider>
    )
    expect(screen.getByText("loading")).toBeTruthy()
    await screen.findByText("widget-d1 online")
    const pageRenders = renders.get("page")!
    const d2Renders = renders.get("row:widget-d2")!

    await act(() => client.execute(ops.WidgetPage, { Id: "d1" }))
    expect(screen.getByText("renamed online")).toBeTruthy()
    expect(renders.get("page")).toBe(pageRenders)
    expect(renders.get("row:widget-d2")).toBe(d2Renders)
  })

  it("loads under StrictMode, which closes and reopens the query in one commit", async () => {
    const { network, requests } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network })
    render(
      <StrictMode>
        <ClientProvider client={client}>
          <CatalogPage where={{}} />
        </ClientProvider>
      </StrictMode>
    )
    await screen.findByText("widget-d1 online")
    expect(requests).toHaveLength(2)
  })

  it("skips the query when variables are null", () => {
    const { network, requests } = mockNetwork(() => ({ data: catalog([]) }))
    render(
      <ClientProvider client={createClient({ network })}>
        <CatalogPage where={null} />
      </ClientProvider>
    )
    expect(screen.getByText("idle")).toBeTruthy()
    expect(requests).toHaveLength(0)
  })

  it("useFragmentList returns view models and follows row changes", async () => {
    const { network } = mockNetwork(({ name }) =>
      name === "CatalogPage"
        ? { data: catalog([widget("d1"), widget("d2")]) }
        : { data: { Widget: { ...widget("d2", { Name: "two" }), Sku: null, RowVersion: 3, Spec: null } } }
    )
    const client = createClient({ network })
    render(
      <ClientProvider client={client}>
        <CatalogTable />
      </ClientProvider>
    )
    await screen.findByText("widget-d1,widget-d2")
    await act(() => client.execute(ops.WidgetPage, { Id: "d2" }))
    expect(screen.getByText("widget-d1,two")).toBeTruthy()
  })
})
