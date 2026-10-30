// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { CompileError, compile } from "../src/compiler/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { ClientProvider, useQuery, useRefetchableFragment } from "../src/react/index.js"
import { mockNetwork } from "./fixtures.js"

/** The router's API schema once entities opt in to NodeId: `interface Node` and `node`/`nodes`. */
const schema = buildSchema(`
  type Query {
    node(NodeId: ID!): Node
    nodes(NodeIds: [ID!]!): [Node]!
    Devices(Limit: Int): [Device!]!
    Settings: Settings
  }
  interface Node { NodeId: ID! }
  type Device implements Node {
    NodeId: ID!
    Id: String!
    Name: String!
    Hostname: String
    Readings(Last: Int): [Int!]!
  }
  type Settings { Theme: String }
`)

const documents = [
  `fragment DeviceCard on Device @refetchable { Name Hostname }`,
  `fragment DeviceName on Device { Name }`,
  `query DeviceList { Devices { ...DeviceCard ...DeviceName } }`,
]

const compiled = compile(schema, documents)
const DeviceCard = compiled.fragments.DeviceCard!
const DeviceList = compiled.operations.DeviceList!
const nodeId = encodeNodeId("Device", ["d1"])

const row = (overrides: Record<string, unknown> = {}) => ({
  __typename: "Device",
  Id: "d1",
  Name: "alpha",
  Hostname: "alpha.local",
  ...overrides,
})

describe("@refetchable fragments", () => {
  it("compile a node(NodeId) query and strip the directive", () => {
    expect(DeviceCard.refetch?.name).toBe("DeviceCardRefetch")
    expect(DeviceCard.refetch?.text).toContain("query DeviceCardRefetch($NodeId: ID!)")
    expect(DeviceCard.refetch?.text).toContain("node(NodeId: $NodeId)")
    expect(DeviceCard.refetch?.text).toContain("fragment DeviceCard on Device {")
    expect(DeviceCard.refetch?.text).not.toContain("@refetchable")
    expect(DeviceList.text).not.toContain("@refetchable")
    expect(compiled.fragments.DeviceName!.refetch).toBeUndefined()
    // The generated query is not one of the application's operations.
    expect(Object.keys(compiled.operations)).toEqual(["DeviceList"])
  })

  it("take a queryName", () => {
    const named = compile(schema, [`fragment DeviceCard on Device @refetchable(queryName: "CardAgain") { Name }`])
    expect(named.fragments.DeviceCard!.refetch?.name).toBe("CardAgain")
  })

  it("refuse a type without Node, a schema without node, operation variables and name clashes", () => {
    expect(() => compile(schema, [`fragment S on Settings @refetchable { Theme }`])).toThrow(/Settings does not implement Node/)
    const plain = buildSchema(`type Query { Device: Device } type Device { Id: String! Name: String! }`)
    expect(() => compile(plain, [`fragment D on Device @refetchable { Name }`])).toThrow(/no node\(NodeId\) lookup/)
    expect(() =>
      compile(schema, [`fragment D on Device @refetchable { Readings(Last: $Last) }`, `query Q($Last: Int) { Devices { ...D } }`])
    ).toThrow(/can't use operation variables/)
    expect(() =>
      compile(schema, [`fragment D on Device @refetchable(queryName: "Q") { Name }`, `query Q { Devices { ...D } }`])
    ).toThrow(CompileError)
  })

  it("refetch one record by NodeId and update every view of it", async () => {
    let name = "alpha"
    const { network, requests } = mockNetwork(({ name: operation, variables }) =>
      operation === "DeviceList"
        ? { data: { Devices: [row({ Name: name })] } }
        : { data: { node: variables.NodeId === nodeId ? row({ Name: name, Hostname: "moved.local" }) : null } }
    )
    const client = createClient({ network })
    const list = client.watchQuery<{ Devices: object[] }>(DeviceList, {})
    list.open()
    await list.refetch()
    const ref = list.getState().data!.Devices[0]!
    name = "renamed"
    const result = await client.refetchFragment(DeviceCard, ref)
    expect(result).toEqual({ found: true, errors: [] })
    expect(requests.at(-1)).toMatchObject({ name: "DeviceCardRefetch", variables: { NodeId: nodeId } })
    expect(client.store.get(nodeId)?.fields.get("Hostname")).toBe("moved.local")
    expect(client.store.get(nodeId)?.fields.get("Name")).toBe("renamed")
    // The list query was not sent again.
    expect(requests.filter((request) => request.name === "DeviceList")).toHaveLength(1)
  })

  it("remove a record the lookup no longer returns, and keep it on errors", async () => {
    let answer: { data: unknown; errors?: { message: string }[] } = { data: { node: null }, errors: [{ message: "unavailable" }] }
    const { network } = mockNetwork(({ name }) => (name === "DeviceList" ? { data: { Devices: [row()] } } : (answer as never)))
    const client = createClient({ network })
    await client.execute(DeviceList, {})
    const { snapshot } = await client.execute<{ Devices: object[] }>(DeviceList, {})
    const ref = snapshot.data.Devices[0]!
    const failed = await client.refetchFragment(DeviceCard, ref)
    expect(failed.found).toBe(false)
    expect(failed.errors).toHaveLength(1)
    expect(client.store.get(nodeId)).toBeDefined()
    answer = { data: { node: null } }
    expect((await client.refetchFragment(DeviceCard, ref)).found).toBe(false)
    expect(client.store.get(nodeId)).toBeUndefined()
  })

  it("refuse a fragment that is not @refetchable", async () => {
    const { network } = mockNetwork(() => ({ data: { Devices: [row()] } }))
    const client = createClient({ network })
    const { snapshot } = await client.execute<{ Devices: object[] }>(DeviceList, {})
    await expect(client.refetchFragment(compiled.fragments.DeviceName!, snapshot.data.Devices[0]!)).rejects.toThrow(
      /not @refetchable/
    )
  })

  it("useRefetchableFragment re-renders with the refetched record", async () => {
    let hostname = "alpha.local"
    const { network } = mockNetwork(({ name }) =>
      name === "DeviceList" ? { data: { Devices: [row()] } } : { data: { node: row({ Hostname: hostname }) } }
    )
    const client = createClient({ network })
    function Card({ device }: { device: object }) {
      const { data, refetch, refetching } = useRefetchableFragment<{ Name: string; Hostname: string | null }>(DeviceCard, device)
      return (
        <button onClick={() => void refetch()}>{`${data.Name} ${data.Hostname} ${refetching ? "refetching" : "idle"}`}</button>
      )
    }
    function List() {
      const { data } = useQuery<{ Devices: object[] }>(DeviceList, {})
      return <>{data?.Devices.map((device, index) => <Card key={index} device={device} />)}</>
    }
    render(
      <ClientProvider client={client}>
        <List />
      </ClientProvider>
    )
    expect(await screen.findByText("alpha alpha.local idle")).toBeTruthy()
    hostname = "moved.local"
    await act(async () => {
      fireEvent.click(screen.getByRole("button"))
    })
    expect(await screen.findByText("alpha moved.local idle")).toBeTruthy()
  })
})
