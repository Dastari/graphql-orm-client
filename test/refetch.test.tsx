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
    Widgets(Limit: Int): [Widget!]!
    Slots: [Slot!]!
    Settings: Settings
  }
  interface Node { NodeId: ID! }
  type Widget implements Node {
    NodeId: ID!
    Id: String!
    Name: String!
    Sku: String
    Readings(Last: Int): [Int!]!
  }
  type Slot implements Node {
    NodeId: ID!
    Zone: String!
    Code: String!
    Label: String
  }
  type Settings { Theme: String }
`)

const documents = [
  `fragment WidgetCard on Widget @refetchable { Name Sku }`,
  `fragment WidgetName on Widget { Name }`,
  `query WidgetList { Widgets { ...WidgetCard ...WidgetName } }`,
  `fragment SlotLabel on Slot @refetchable { Label }`,
  `query SlotList { Slots { ...SlotLabel } }`,
]

const compiled = compile(schema, documents)
const WidgetCard = compiled.fragments.WidgetCard!
const WidgetList = compiled.operations.WidgetList!
const nodeId = encodeNodeId("Widget", ["d1"])

const row = (overrides: Record<string, unknown> = {}) => ({
  __typename: "Widget",
  Id: "d1",
  Name: "alpha",
  Sku: "alpha.local",
  ...overrides,
})

describe("@refetchable fragments", () => {
  it("compile a node(NodeId) query and strip the directive", () => {
    expect(WidgetCard.refetch?.name).toBe("WidgetCardRefetch")
    expect(WidgetCard.refetch?.text).toContain("query WidgetCardRefetch($NodeId: ID!)")
    expect(WidgetCard.refetch?.text).toContain("node(NodeId: $NodeId)")
    expect(WidgetCard.refetch?.text).toContain("fragment WidgetCard on Widget {")
    expect(WidgetCard.refetch?.text).not.toContain("@refetchable")
    expect(WidgetList.text).not.toContain("@refetchable")
    expect(compiled.fragments.WidgetName!.refetch).toBeUndefined()
    // The generated query is not one of the application's operations.
    expect(Object.keys(compiled.operations).sort()).toEqual(["SlotList", "WidgetList"])
  })

  it("take a queryName", () => {
    const named = compile(schema, [`fragment WidgetCard on Widget @refetchable(queryName: "CardAgain") { Name }`])
    expect(named.fragments.WidgetCard!.refetch?.name).toBe("CardAgain")
  })

  it("refuse a type without Node, a schema without node, operation variables and name clashes", () => {
    expect(() => compile(schema, [`fragment S on Settings @refetchable { Theme }`])).toThrow(/Settings does not implement Node/)
    const plain = buildSchema(`type Query { Widget: Widget } type Widget { Id: String! Name: String! }`)
    expect(() => compile(plain, [`fragment D on Widget @refetchable { Name }`])).toThrow(/no node\(NodeId\) lookup/)
    expect(() =>
      compile(schema, [`fragment D on Widget @refetchable { Readings(Last: $Last) }`, `query Q($Last: Int) { Widgets { ...D } }`])
    ).toThrow(/can't use operation variables/)
    expect(() =>
      compile(schema, [`fragment D on Widget @refetchable(queryName: "Q") { Name }`, `query Q { Widgets { ...D } }`])
    ).toThrow(CompileError)
  })

  it("refetch one record by NodeId and update every view of it", async () => {
    let name = "alpha"
    const { network, requests } = mockNetwork(({ name: operation, variables }) =>
      operation === "WidgetList"
        ? { data: { Widgets: [row({ Name: name })] } }
        : { data: { node: variables.NodeId === nodeId ? row({ Name: name, Sku: "moved.local" }) : null } }
    )
    const client = createClient({ network })
    const list = client.watchQuery<{ Widgets: object[] }>(WidgetList, {})
    list.open()
    await list.refetch()
    const ref = list.getState().data!.Widgets[0]!
    name = "renamed"
    const result = await client.refetchFragment(WidgetCard, ref)
    expect(result).toEqual({ found: true, errors: [] })
    expect(requests.at(-1)).toMatchObject({ name: "WidgetCardRefetch", variables: { NodeId: nodeId } })
    expect(client.store.get(nodeId)?.fields.get("Sku")).toBe("moved.local")
    expect(client.store.get(nodeId)?.fields.get("Name")).toBe("renamed")
    // The list query was not sent again.
    expect(requests.filter((request) => request.name === "WidgetList")).toHaveLength(1)
  })

  it("identify a record by the server's NodeId when its key is not Id", async () => {
    const SlotLabel = compiled.fragments.SlotLabel!
    expect(compiled.operations.SlotList!.text).toMatch(/Slots \{\s*__typename\s+NodeId/)
    expect(SlotLabel.refetch?.text).toMatch(/node\(NodeId: \$NodeId\) \{\s*__typename\s+NodeId/)
    const slotId = encodeNodeId("Slot", ["north", "a"])
    let label = "first"
    const { network, requests } = mockNetwork(({ name }) => {
      const slot = { __typename: "Slot", NodeId: slotId, Label: label }
      return name === "SlotList" ? { data: { Slots: [slot] } } : { data: { node: slot } }
    })
    const client = createClient({ network })
    const { snapshot } = await client.execute<{ Slots: object[] }>(compiled.operations.SlotList!, {})
    expect(client.store.get(slotId)?.fields.get("Label")).toBe("first")
    label = "second"
    expect(await client.refetchFragment(SlotLabel, snapshot.data.Slots[0]!)).toEqual({ found: true, errors: [] })
    expect(requests.at(-1)).toMatchObject({ name: "SlotLabelRefetch", variables: { NodeId: slotId } })
    expect(client.store.get(slotId)?.fields.get("Label")).toBe("second")
  })

  it("remove a record the lookup no longer returns, and keep it on errors", async () => {
    let answer: { data: unknown; errors?: { message: string }[] } = { data: { node: null }, errors: [{ message: "unavailable" }] }
    const { network } = mockNetwork(({ name }) => (name === "WidgetList" ? { data: { Widgets: [row()] } } : (answer as never)))
    const client = createClient({ network })
    await client.execute(WidgetList, {})
    const { snapshot } = await client.execute<{ Widgets: object[] }>(WidgetList, {})
    const ref = snapshot.data.Widgets[0]!
    const failed = await client.refetchFragment(WidgetCard, ref)
    expect(failed.found).toBe(false)
    expect(failed.errors).toHaveLength(1)
    expect(client.store.get(nodeId)).toBeDefined()
    answer = { data: { node: null } }
    expect((await client.refetchFragment(WidgetCard, ref)).found).toBe(false)
    expect(client.store.get(nodeId)).toBeUndefined()
  })

  it("refuse a fragment that is not @refetchable", async () => {
    const { network } = mockNetwork(() => ({ data: { Widgets: [row()] } }))
    const client = createClient({ network })
    const { snapshot } = await client.execute<{ Widgets: object[] }>(WidgetList, {})
    await expect(client.refetchFragment(compiled.fragments.WidgetName!, snapshot.data.Widgets[0]!)).rejects.toThrow(
      /not @refetchable/
    )
  })

  it("useRefetchableFragment re-renders with the refetched record", async () => {
    let sku = "alpha.local"
    const { network } = mockNetwork(({ name }) =>
      name === "WidgetList" ? { data: { Widgets: [row()] } } : { data: { node: row({ Sku: sku }) } }
    )
    const client = createClient({ network })
    function Card({ widget }: { widget: object }) {
      const { data, refetch, refetching } = useRefetchableFragment<{ Name: string; Sku: string | null }>(WidgetCard, widget)
      return (
        <button onClick={() => void refetch()}>{`${data.Name} ${data.Sku} ${refetching ? "refetching" : "idle"}`}</button>
      )
    }
    function List() {
      const { data } = useQuery<{ Widgets: object[] }>(WidgetList, {})
      return <>{data?.Widgets.map((widget, index) => <Card key={index} widget={widget} />)}</>
    }
    render(
      <ClientProvider client={client}>
        <List />
      </ClientProvider>
    )
    expect(await screen.findByText("alpha alpha.local idle")).toBeTruthy()
    sku = "moved.local"
    await act(async () => {
      fireEvent.click(screen.getByRole("button"))
    })
    expect(await screen.findByText("alpha moved.local idle")).toBeTruthy()
  })
})
