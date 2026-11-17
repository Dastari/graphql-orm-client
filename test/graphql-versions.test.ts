import { buildClientSchema, buildSchema, introspectionFromSchema, lexicographicSortSchema, parse } from "graphql"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { compile, generate } from "../src/compiler/index.js"
import { printSchemaStable, printStable } from "../src/compiler/print.js"

// CI runs these with graphql 16 and with graphql 17. The expected text is what graphql 16 prints, so generated output,
// operation hashes and schema snapshots stay the same whichever version a project installs.

const sdl = `
type Query {
  Items(Where: ItemWhereInput = {Name: {Eq: "a"}}, Page: PageInput = {Limit: 50}, Order: [ItemOrder!] = [{Field: NAME}]): ItemConnection!
  Item(Id: String!): Item
}
input StringFilter { Eq: String, Contains: String }
input ItemWhereInput { Name: StringFilter, Limit: Int = 5 }
input PageInput { Limit: Int, Offset: Int = 0 }
input ItemOrder { Field: ItemField!, Direction: Direction = ASC }
enum ItemField { NAME }
enum Direction { ASC DESC }
type ItemConnection { Edges: [ItemEdge!]! }
type ItemEdge { Node: Item! }
type Item { Id: String!, Name: String! }
`
const schema = buildSchema(sdl)

describe("output that doesn't depend on the graphql version", () => {
  it("prints object values in operation text as graphql 16 does", () => {
    const operation = compile(schema, [`query ItemsPage { Items(Where: {Name: {Eq: "a"}}, Page: {Limit: 10}) { Edges { Node { Name } } } }`]).operations.ItemsPage!
    expect(operation.text).toBe(
      'query ItemsPage {\n  Items(Where: {Name: {Eq: "a"}}, Page: {Limit: 10}) {\n    __typename\n    Edges {\n      __typename\n      Node {\n' +
      "        __typename\n        Id\n        Name\n      }\n    }\n  }\n}",
    )
    expect(operation.hash).toBe(createHash("sha256").update(operation.text).digest("hex"))
  })

  it("wraps arguments where graphql 16 does", () => {
    // 77 characters as graphql 16 prints it; graphql 17's spacing would take it past 80 and onto several lines.
    const field = 'a(first: {someLongFieldName: "a value"}, second: {k: 1}, third: {x: 2}, f: 1)'
    expect(printStable(parse(`{ ${field} { b } }`))).toBe(`{\n  ${field} {\n    b\n  }\n}`)
    expect(printStable(parse("{ a(empty: {}, list: [{k: [{}]}]) }"))).toBe("{\n  a(empty: {}, list: [{k: [{}]}])\n}")
  })

  it("prints schema defaults coerced, as graphql 16 does, before and after introspection", () => {
    expect(printSchemaStable(schema)).toContain(
      'Items(Where: ItemWhereInput = {Name: {Eq: "a"}, Limit: 5}, Page: PageInput = {Limit: 50, Offset: 0}, Order: [ItemOrder!] = [{Field: NAME, Direction: ASC}]): ItemConnection!',
    )
    const pulled = printSchemaStable(lexicographicSortSchema(buildClientSchema(introspectionFromSchema(schema))))
    expect(pulled).toContain(
      'Items(Order: [ItemOrder!] = [{Direction: ASC, Field: NAME}], Page: PageInput = {Limit: 50, Offset: 0}, Where: ItemWhereInput = {Limit: 5, Name: {Eq: "a"}}): ItemConnection!',
    )
    expect(pulled).toContain("input ItemOrder {\n  Direction: Direction = ASC\n  Field: ItemField!\n}")
  })

  it("fingerprints the schema for persistence from the same text", () => {
    const generated = generate(schema, ["fragment ItemRow on Item { Name }"], { persistence: true })
    expect(generated).toContain(`export const schemaHash = ${JSON.stringify(createHash("sha256").update(printSchemaStable(schema)).digest("hex"))}`)
  })
})
