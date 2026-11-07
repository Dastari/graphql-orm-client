// @vitest-environment jsdom
import { Component, StrictMode, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import { createClient } from "../src/client.js"
import { ClientProvider, useFragment, useQuery } from "../src/react/index.js"
import { installRelationBatching } from "../src/relations.js"

const schema = buildSchema(`
  type Query { Tickets: [Ticket!]! Vendors(Where: VendorWhere, Page: PageInput): VendorConnection! }
  input VendorWhere { Id: StringFilter }
  input StringFilter { InList: [String!] }
  input PageInput { Limit: Int, Offset: Int }
  type VendorConnection { Edges: [VendorEdge!]! PageInfo: PageInfo! }
  type VendorEdge { Node: Vendor! }
  type PageInfo { TotalCount: Int! HasNextPage: Boolean! }
  type Ticket { Id: String! VendorId: String! Vendor: Vendor }
  type Vendor { Id: String! Name: String! }
`)
const compiled = compile(schema, [
  `fragment Row on Ticket { Id Vendor @batch(foreignKey: "VendorId", root: "Vendors", key: "Id") { Name } }`,
  `query Rows { Tickets { ...Row } }`,
])
const row = (id: number) => ({ __typename: "Ticket", Id: String(id), VendorId: `v${id % 3}` })
function setup() {
  const requests: { kind: string; name: string; ids?: unknown }[] = []
  const client = createClient({
    network: {
      execute: async (request) => {
        requests.push({ kind: request.kind, name: request.name, ids: (request.variables.Where as { Id?: { InList?: unknown } } | undefined)?.Id?.InList })
        if (request.name === "Rows") return { data: { Tickets: Array.from({ length: 12 }, (_, index) => row(index)) } }
        const values = (request.variables.Where as { Id: { InList: string[] } }).Id.InList
        return { data: { Vendors: { __typename: "VendorConnection", Edges: values.map((Id) => ({ __typename: "VendorEdge", Node: { __typename: "Vendor", Id, Name: `name-${Id}` } })), PageInfo: { __typename: "PageInfo", TotalCount: values.length, HasNextPage: false } } } }
      },
    },
  })
  installRelationBatching(client)
  return { client, requests }
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
function RowView({ reference, onRender }: { reference: never; onRender?: (when: "before" | "after") => void }) {
  onRender?.("before")
  const data = useFragment(compiled.fragments.Row!, reference) as { Id: string; Vendor: { status: string; data?: { Name: string } } } | null
  onRender?.("after")
  return <li>{data?.Vendor.status === "ready" ? data.Vendor.data!.Name : data?.Vendor.status}</li>
}
function Rows({ onRender }: { onRender?: (when: "before" | "after") => void }) {
  const { data } = useQuery<{ Tickets: never[] }>(compiled.operations.Rows!, {})
  return <ul>{data?.Tickets.map((reference, index) => <RowView key={index} reference={reference} onRender={onRender} />)}</ul>
}
afterEach(cleanup)

it("sends each id once under StrictMode's double render and double effects", async () => {
  const { client, requests } = setup()
  render(<StrictMode><ClientProvider client={client}><Rows /></ClientProvider></StrictMode>)
  await settle()
  await settle()
  expect(screen.getAllByRole("listitem").every((item) => item.textContent?.startsWith("name-"))).toBe(true)
  const batches = requests.filter((request) => request.name.startsWith("Batch_"))
  expect(batches).toHaveLength(1)
  expect((batches[0]!.ids as string[]).sort()).toEqual(["v0", "v1", "v2"])
  client.dispose()
})

it("writes nothing to the store and notifies nobody during render", async () => {
  const { client } = setup()
  let rendering = false
  const during: string[] = []
  const publish = client.store.publish.bind(client.store)
  const setField = client.store.setField.bind(client.store)
  vi.spyOn(client.store, "publish").mockImplementation(() => { if (rendering) during.push("publish"); publish() })
  vi.spyOn(client.store, "setField").mockImplementation((record, key, value) => { if (rendering) during.push("setField"); setField(record, key, value) })
  render(<ClientProvider client={client}><Rows onRender={(when) => { rendering = when === "before" }} /></ClientProvider>)
  await settle()
  await settle()
  expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0)
  expect(during).toEqual([])
  client.dispose()
})

it("a render React discards leaves only a read, whose result the next render uses", async () => {
  const { client, requests } = setup()
  class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    override state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    override render() { return this.state.failed ? <p>failed</p> : this.props.children }
  }
  await client.query(compiled.operations.Rows!, {})
  const reference = (client.store.lookup({ id: "client:root", selections: compiled.operations.Rows!.selections, variables: {}, fragments: compiled.operations.Rows!.fragments }).data as { Tickets: never[] }).Tickets[0]!
  function Throws(): ReactNode {
    useFragment(compiled.fragments.Row!, reference)
    throw new Error("discarded")
  }
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  const first = render(<ClientProvider client={client}><Boundary><Throws /></Boundary></ClientProvider>)
  await settle()
  consoleError.mockRestore()
  first.unmount()
  // Whatever the discarded render asked for is a read, never a write, and it's only done once.
  expect(requests.every((request) => request.kind === "query")).toBe(true)
  const sent = requests.filter((request) => request.name.startsWith("Batch_")).length
  expect(sent).toBeLessThanOrEqual(1)
  render(<ClientProvider client={client}><RowView reference={reference} /></ClientProvider>)
  await settle()
  expect(screen.getByRole("listitem").textContent).toMatch(/^name-/)
  expect(requests.filter((request) => request.name.startsWith("Batch_")).length).toBe(1)
  client.dispose()
})
