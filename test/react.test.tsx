// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { ClientProvider, useFragment, useFragmentList, useQuery } from "../src/react/index.js"
import { device, fleet, frags, mockNetwork, ops } from "./fixtures.js"

type FleetData = { Devices: { Edges: { Cursor: string; Node: object }[] } }
type Row = { Name: string; ConnectionState: string }

const renders = new Map<string, number>()
const count = (key: string) => renders.set(key, (renders.get(key) ?? 0) + 1)

function DeviceRow({ device: ref }: { device: object }) {
  const row = useFragment<Row & { Id?: string }>(frags.DeviceRow, ref)
  count(`row:${row.Name}`)
  return <li>{`${row.Name} ${row.ConnectionState}`}</li>
}

function FleetPage({ where }: { where: Record<string, unknown> | null }) {
  const { status, data } = useQuery<FleetData>(ops.FleetPage, where)
  count("page")
  if (status === "loading" || !data) return <p>{status}</p>
  return (
    <ul>
      {data.Devices.Edges.map((edge) => (
        <DeviceRow key={edge.Cursor} device={edge.Node} />
      ))}
    </ul>
  )
}

function FleetTable() {
  const { data } = useQuery<FleetData>(ops.FleetPage, {})
  const rows = useFragmentList<Row>(frags.DeviceRow, data?.Devices.Edges.map((edge) => edge.Node))
  return <p>{rows.map((row) => row.Name).join(",") || "empty"}</p>
}

describe("React bindings", () => {
  it("loads a root query and re-renders only the row whose fragment changed", async () => {
    renders.clear()
    let first = true
    const { network } = mockNetwork(({ name }) => {
      if (name === "FleetPage") return { data: fleet([device("d1"), device("d2")]) }
      const renamed = { ...device("d1", { Name: first ? "renamed" : "x" }), Hostname: null, RowVersion: 2, Hardware: null }
      first = false
      return { data: { Device: renamed } }
    })
    const client = createClient({ network })
    render(
      <ClientProvider client={client}>
        <FleetPage where={{}} />
      </ClientProvider>
    )
    expect(screen.getByText("loading")).toBeTruthy()
    await screen.findByText("device-d1 online")
    const pageRenders = renders.get("page")!
    const d2Renders = renders.get("row:device-d2")!

    await act(() => client.execute(ops.DevicePage, { Id: "d1" }))
    expect(screen.getByText("renamed online")).toBeTruthy()
    expect(renders.get("page")).toBe(pageRenders)
    expect(renders.get("row:device-d2")).toBe(d2Renders)
  })

  it("skips the query when variables are null", () => {
    const { network, requests } = mockNetwork(() => ({ data: fleet([]) }))
    render(
      <ClientProvider client={createClient({ network })}>
        <FleetPage where={null} />
      </ClientProvider>
    )
    expect(screen.getByText("loading")).toBeTruthy()
    expect(requests).toHaveLength(0)
  })

  it("useFragmentList returns view models and follows row changes", async () => {
    const { network } = mockNetwork(({ name }) =>
      name === "FleetPage"
        ? { data: fleet([device("d1"), device("d2")]) }
        : { data: { Device: { ...device("d2", { Name: "two" }), Hostname: null, RowVersion: 3, Hardware: null } } }
    )
    const client = createClient({ network })
    render(
      <ClientProvider client={client}>
        <FleetTable />
      </ClientProvider>
    )
    await screen.findByText("device-d1,device-d2")
    await act(() => client.execute(ops.DevicePage, { Id: "d2" }))
    expect(screen.getByText("device-d1,two")).toBeTruthy()
  })
})
