import { extendSchema, parse } from "graphql"
import { inspect } from "node:util"
import { expect, it } from "vitest"
import { compile, generate } from "../src/compiler/index.js"
import { createClient, readFragment } from "../src/client.js"
import { schema, mockNetwork, ticket, ops, frags } from "./fixtures.js"

it.each(["query", "mutation"])("sensitive %s never stores values, versions or fragment references", async kind => {
  const document = kind === "query"
    ? "query Secret @sensitive { Ticket(Id: \"t1\") { ...Row } }"
    : "mutation Secret @sensitive { IssueToken(Id: \"t1\") { Secret Ticket { ...Row } } }"
  const { operations } = compile(extendSchema(schema, parse("extend type Query { Ticket(Id: String!): Ticket }")), [document, "fragment Row on Ticket { Title RecordVersion }"])
  const marker = "sensitive-marker-never-store"
  const { network } = mockNetwork(() => ({ data: kind === "query"
    ? { Ticket: ticket("t1", { Title: marker, RecordVersion: 99 }) }
    : { IssueToken: { Secret: marker, Ticket: ticket("t1", { Title: marker, RecordVersion: 99 }) } } }))
  const client = createClient({ network })
  const operation = operations.Secret!
  expect(operation.sensitive).toBe(true)
  expect(operation.text).not.toContain("@sensitive")
  const result = kind === "query" ? await client.query<any>(operation, {}) : await client.mutate<any>(operation, {}, { policy: "store" })
  const row = kind === "query" ? result.data.Ticket : result.data.IssueToken.Ticket
  expect(row.Title).toBe(marker)
  expect(() => readFragment(frags.TicketRow, row)).toThrow()
  // Inspect every record and all private properties, including references an inspector follows.
  expect(inspect(client, { depth: null })).not.toContain(marker)
  expect(JSON.stringify([...(client.store as any).records].map(([id, record]: any) => [id, [...record.fields]]))).not.toContain(marker)
  client.store.collect()
  expect(inspect(client, { depth: null })).not.toContain(marker)
  client.dispose()
  expect(inspect(client, { depth: null })).not.toContain(marker)
})

it("rejects live fragments (including nested spreads), live operations and optimistic sensitive writes", async () => {
  expect(() => compile(extendSchema(schema, parse("extend type Query { Ticket(Id: String!): Ticket }")), ["query Q @sensitive { Ticket(Id: \"t1\") { ...A } }", "fragment A on Ticket { ...B }", "fragment B on Ticket @live { Title }"])).toThrow(/sensitive/)
  expect(() => compile(extendSchema(schema, parse("extend type Query { Ticket(Id: String!): Ticket }")), ["query Q @sensitive @live { Ticket(Id: \"t1\") { Title } }"])).toThrow()
  const client = createClient({ network: mockNetwork(() => ({ data: {} })).network })
  await expect(client.mutate({ ...ops.IssueToken!, sensitive: true }, {}, { optimisticResponse: {} })).rejects.toThrow()
})

it("generation expands sensitive fragment fields and records the policy", () => {
  const source = generate(schema, [
    'query Q @sensitive { Widget(Id: "w1") { ...Row } }',
    'fragment Row on Widget { Name }',
  ])
  const type = source.split('export type QQuery = ')[1]!.split('\n')[0]!
  expect(type).toContain('readonly Name: string')
  expect(type).not.toContain('FragmentRefs')
  expect(source).toContain('"sensitive":true')
})
