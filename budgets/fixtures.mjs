import { buildSchema } from "graphql"
import { compile } from "../dist/compiler/index.js"

// PascalCase fields, complete Id keys, versioned entities, uniform connections and Changed.
export const smallSDL = `type Query { Tickets(Page: PageInput): TicketConnection! }
type Subscription { TicketChanged(Keys: [String!]): TicketChangedEvent! }
input PageInput { Limit: Int, Offset: Int }
type TicketConnection { Edges: [TicketEdge!]!, PageInfo: PageInfo! }
type TicketEdge { Cursor: String!, Node: Ticket! }
type PageInfo { TotalCount: Int!, HasNextPage: Boolean!, EndCursor: String }
type Ticket { Id: String!, Title: String!, State: String!, RecordVersion: Int! }
type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
enum ChangeAction { CREATED UPDATED DELETED }`
export const documents = [
  "fragment TicketRow on Ticket @live { Title State }",
  "query TicketsPage { Tickets(Page: { Limit: 10000 }) { Edges { Node { ...TicketRow } } PageInfo { TotalCount } } }",
]
export const artifacts = () => compile(buildSchema(smallSDL), documents)
export const row = (i, version = 1) => ({
  __typename: "Ticket", Id: String(i), Title: `ticket-${i}-v${version}`,
  State: "open", RecordVersion: version,
})
export const data = (count) => ({
  Tickets: { __typename: "TicketConnection",
    Edges: Array.from({ length: count }, (_, i) => ({ __typename: "TicketEdge", Node: row(i) })),
    PageInfo: { __typename: "PageInfo", TotalCount: count } },
})

export function largeFixture() {
  const lines = [
    "enum ChangeAction { CREATED UPDATED DELETED }",
    "input PageInput { Limit: Int, Offset: Int }",
    "input StringFilter { Eq: String, Contains: String }",
    "type PageInfo { TotalCount: Int!, HasNextPage: Boolean!, EndCursor: String }",
    "type Query {",
    ...Array.from({ length: 500 }, (_, i) => `  Records${i}(Where: Record${i}WhereInput, Page: PageInput): Record${i}Connection!`),
    "}",
    "type Subscription {",
    ...Array.from({ length: 500 }, (_, i) => `  Record${i}Changed(Keys: [String!]): Record${i}ChangedEvent!`),
    "}",
  ]
  for (let i = 0; i < 500; i++) {
    lines.push(`type Record${i} {`, "  Id: String!", "  RecordVersion: Int!",
      ...Array.from({ length: 72 }, (_, j) => `  Field${j}: String`), "}",
      `input Record${i}WhereInput {`, "  Id: StringFilter", "}",
      `type Record${i}Connection {`, `  Edges: [Record${i}Edge!]!`, "  PageInfo: PageInfo!", "}",
      `type Record${i}Edge { Cursor: String!, Node: Record${i}! }`,
      `type Record${i}ChangedEvent { Action: ChangeAction!, Record${i}: Record${i} }`)
  }
  // Add real schema fields, not blank/comment padding, to reach exactly 45,000 lines.
  const extra = 45000 - lines.length - 2
  if (extra < 0) throw new Error("schema generator exceeded 45,000 lines")
  lines.push("type SchemaMetadata {", ...Array.from({ length: extra }, (_, i) => `  Field${i}: String`), "}")
  const docs = []
  for (let i = 0; i < 125; i++) {
    docs.push(`fragment Row${i} on Record${i} @live { Field0 Field1 Field2 Field3 }`,
      `query Page${i} { Records${i}(Page: { Limit: 100 }) { Edges { Node { ...Row${i} } } PageInfo { TotalCount } } }`)
  }
  return { sdl: lines.join("\n"), documents: docs }
}
