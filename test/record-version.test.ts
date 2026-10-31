import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { mockNetwork } from "./fixtures.js"

/** graphql-orm 0.87 serves a managed version as `RecordVersion: Int!`. */
const schema = buildSchema(`
  type Query { Ticket(Id: ID!): Ticket, Notes: [Note!]! }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
  type Ticket { NodeId: ID!, Id: ID!, Title: String!, Revision: Int!, RecordVersion: Int! }
  type Note { Id: ID!, Body: String! }
`)

const documents = [
  `fragment TicketTitle on Ticket @live { Title }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`,
  `query NoteList { Notes { Body } }`,
]

describe("RecordVersion", () => {
  it("is selected and used as the type's version, in queries and Changed subscriptions", () => {
    const compiled = compile(schema, documents)
    const page = compiled.operations.TicketPage!
    expect(page.versions).toEqual({ Ticket: "RecordVersion" })
    expect(page.text).toMatch(/Ticket\(Id: \$Id\) \{\s*__typename\s+NodeId\s+Id\s+RecordVersion/)
    expect(compiled.live.Ticket?.operation.text).toMatch(/Ticket \{\s*__typename\s+NodeId\s+Id\s+RecordVersion/)
    // A type without one is unchanged.
    expect(compiled.operations.NoteList!.text).not.toContain("RecordVersion")
    expect(compiled.operations.NoteList!.versions).toEqual({})
  })

  it("keeps a newer record when an older one arrives", async () => {
    const compiled = compile(schema, documents)
    let answer = { RecordVersion: 3, Title: "newer" }
    const { network } = mockNetwork(() => ({
      data: { Ticket: { __typename: "Ticket", NodeId: encodeNodeId("Ticket", ["t1"]), Id: "t1", ...answer } },
    }))
    const client = createClient({ network })
    await client.execute(compiled.operations.TicketPage!, { Id: "t1" })
    answer = { RecordVersion: 2, Title: "older" }
    await client.execute(compiled.operations.TicketPage!, { Id: "t1" })
    expect(client.store.get(encodeNodeId("Ticket", ["t1"]))?.fields.get("Title")).toBe("newer")
  })

  it("gives way to configuration: another field, or null for none", () => {
    const other = compile(schema, documents, { versions: { Ticket: "Revision" } }).operations.TicketPage!
    expect(other.versions).toEqual({ Ticket: "Revision" })
    expect(other.text).not.toContain("RecordVersion")
    const none = compile(schema, documents, { versions: { Ticket: null } })
    expect(none.operations.TicketPage!.versions).toEqual({})
    expect(none.operations.TicketPage!.text).not.toContain("RecordVersion")
    expect(none.live.Ticket?.operation.text).not.toContain("RecordVersion")
  })
})
