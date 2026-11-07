// @vitest-environment node
import { renderToString } from "react-dom/server"
import { expect, it } from "vitest"
import { buildSchema } from "graphql"
import { compile } from "../src/compiler/index.js"
import { createClient, readFragment } from "../src/client.js"
import { ClientProvider, useFragment } from "../src/react/index.js"
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

it("sends no relation read while rendering on a server, where private reads must never run", async () => {
  expect(typeof document).toBe("undefined")
  const requests: string[] = []
  const client = createClient({ network: { execute: async (request) => {
    requests.push(request.name)
    return { data: { Tickets: [{ __typename: "Ticket", Id: "t1", VendorId: "v1" }] } }
  } } })
  installRelationBatching(client)
  const { data } = await client.query<{ Tickets: never[] }, Record<string, never>>(compiled.operations.Rows!, {})
  const reference = data.Tickets[0]!
  function RowView() {
    const row = useFragment(compiled.fragments.Row!, reference) as { Vendor: { status: string } }
    return <p>{row.Vendor.status}</p>
  }
  const html = renderToString(<ClientProvider client={client}><RowView /></ClientProvider>)
  expect(html).toContain("pending")
  expect((readFragment(compiled.fragments.Row!, reference) as { Vendor: { status: string } }).Vendor.status).toBe("pending")
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(requests).toEqual(["Rows"])
  client.dispose()
})

it("a non-browser client can opt in to reading", async () => {
  const requests: string[] = []
  const client = createClient({ network: { execute: async (request) => {
    requests.push(request.name)
    if (request.name === "Rows") return { data: { Tickets: [{ __typename: "Ticket", Id: "t1", VendorId: "v1" }] } }
    return { data: { Vendors: { __typename: "VendorConnection", Edges: [{ __typename: "VendorEdge", Node: { __typename: "Vendor", Id: "v1", Name: "Name" } }], PageInfo: { __typename: "PageInfo", TotalCount: 1, HasNextPage: false } } } }
  } } })
  installRelationBatching(client, { withoutDocument: "read" })
  const { data } = await client.query<{ Tickets: never[] }, Record<string, never>>(compiled.operations.Rows!, {})
  readFragment(compiled.fragments.Row!, data.Tickets[0]!)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(requests).toEqual(["Rows", "Batch_Ticket_Vendor"])
  client.dispose()
})
