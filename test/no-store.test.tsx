// @vitest-environment jsdom
import { inspect } from "node:util"
import { act, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { createClient, readFragment, type Client } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { ClientProvider, useMutation } from "../src/react/index.js"
import { frags, mockNetwork, ops, ticket, ticketPage } from "./fixtures.js"

const SECRET = "SECRET-SENTINEL-7f3a91"
const AUDIT_SECRET = "AUDIT-SENTINEL-c20b44"
const KEYED_SECRET = "KEYED-SENTINEL-95d1e8"

type TokenData = {
  IssueToken: { Secret: string; Ticket: object | null; Audit: { At: string; By: string }[] }
}

const issued = (id = "t1", title = KEYED_SECRET) => ({
  IssueToken: {
    __typename: "TokenResult",
    Secret: SECRET,
    Ticket: ticket(id, { Title: title, RecordVersion: 5 }),
    Audit: [{ __typename: "AuditEntry", At: "2026-11-06T10:00:00Z", By: AUDIT_SECRET }],
  },
})

/** Everything the store holds, as text: every record, every field, every link. */
function dumpStore(client: Client): string {
  const records = (client.store as unknown as { records: Map<string, { __typename: string; fields: Map<string, unknown> }> }).records
  return JSON.stringify([...records].map(([id, record]) => [id, record.__typename, [...record.fields]]))
}

/** The client's debug output: what `console.log(client)` or a devtools inspector would print. */
const debugOutput = (client: Client) => inspect(client, { depth: null, showHidden: true, maxArrayLength: null, maxStringLength: null })

function seeded() {
  const { network, requests } = mockNetwork(({ name }) => {
    if (name === "TicketsPage") return { data: ticketPage([ticket("t1", { Title: "original" })]) }
    return { data: issued() }
  })
  const client = createClient({ network })
  return { client, requests }
}

describe("mutate policy: no-store", () => {
  it("control: by default the payload is written to the store and stays", async () => {
    const { client } = seeded()
    await client.mutate(ops.IssueToken, { Id: "t1" })
    expect(dumpStore(client)).toContain(SECRET)
    expect(debugOutput(client)).toContain(AUDIT_SECRET)
    // An explicit "store" is the default.
    const other = seeded().client
    await other.mutate(ops.IssueToken, { Id: "t1" }, { policy: "store" })
    expect(dumpStore(other)).toContain(SECRET)
  })

  it("returns the full typed result and leaves nothing of the payload in the store or its debug output", async () => {
    const { client } = seeded()
    const before = client.store.size
    const { data, errors } = await client.mutate<TokenData>(ops.IssueToken, { Id: "t1" }, { policy: "no-store" })

    expect(errors).toEqual([])
    expect(data.IssueToken.Secret).toBe(SECRET)
    expect(data.IssueToken.Audit).toEqual([{ __typename: "AuditEntry", At: "2026-11-06T10:00:00Z", By: AUDIT_SECRET }])
    // Fragment references in the result still open.
    expect(readFragment<{ Title: string }>(frags.TicketRow, data.IssueToken.Ticket as never).Title).toBe(KEYED_SECRET)

    expect(client.store.size).toBe(before)
    for (const sentinel of [SECRET, AUDIT_SECRET, KEYED_SECRET]) {
      expect(dumpStore(client)).not.toContain(sentinel)
      expect(debugOutput(client)).not.toContain(sentinel)
    }
    expect(dumpStore(client)).not.toContain("client:mutation")
    client.store.collect()
    expect(client.store.size).toBe(before)
  })

  it("does not merge keyed records of the payload: other views of the record keep their data", async () => {
    const { client } = seeded()
    const list = client.watchQuery<{ Tickets: { Edges: { Node: object }[] } }>(ops.TicketsPage, { Page: { Limit: 5, Offset: 0 } })
    list.open()
    await list.refetch()
    const title = () => readFragment<{ Title: string }>(frags.TicketRow, list.getState().data!.Tickets.Edges[0]!.Node as never).Title
    expect(title()).toBe("original")
    const before = client.store.size

    const { data } = await client.mutate<TokenData>(ops.IssueToken, { Id: "t1" }, { policy: "no-store" })
    // The stored record is untouched, including its version; the caller's copy is the response.
    expect(title()).toBe("original")
    expect(dumpStore(client)).not.toContain(KEYED_SECRET)
    expect(readFragment<{ Title: string }>(frags.TicketRow, data.IssueToken.Ticket as never).Title).toBe(KEYED_SECRET)

    // A keyed record the store never held is not created either.
    await client.mutate(ops.IssueToken, { Id: "t9" }, { policy: "no-store" })
    expect(client.store.get(encodeNodeId("Ticket", ["t9"]))).toBeUndefined()
    expect(client.store.size).toBe(before)
    list.close()
  })

  it("sends its own request for every call and shares nothing between results", async () => {
    let count = 0
    const { network, requests } = mockNetwork(() => ({
      data: { IssueToken: { ...issued().IssueToken, Secret: `${SECRET}-${++count}` } },
    }))
    const client = createClient({ network })
    const [a, b] = await Promise.all([
      client.mutate<TokenData>(ops.IssueToken, { Id: "t1" }, { policy: "no-store" }),
      client.mutate<TokenData>(ops.IssueToken, { Id: "t1" }, { policy: "no-store" }),
    ])
    expect(requests).toHaveLength(2)
    expect([a.data.IssueToken.Secret, b.data.IssueToken.Secret].sort()).toEqual([`${SECRET}-1`, `${SECRET}-2`])
    expect(dumpStore(client)).not.toContain(SECRET)
  })

  it("keeps errors with the result and stores nothing when the server returns errors without data", async () => {
    const withErrors = mockNetwork(() => ({ data: issued(), errors: [{ message: "partial", extensions: { code: "DENIED" } }] }))
    const client = createClient({ network: withErrors.network })
    const { data, errors } = await client.mutate<TokenData>(ops.IssueToken, { Id: "t1" }, { policy: "no-store" })
    expect(data.IssueToken.Secret).toBe(SECRET)
    expect(errors[0]?.extensions?.code).toBe("DENIED")
    expect(dumpStore(client)).not.toContain(SECRET)

    const failing = createClient({ network: mockNetwork(() => ({ errors: [{ message: "no", extensions: { code: "DENIED" } }] })).network })
    await expect(failing.mutate(ops.IssueToken, { Id: "t1" }, { policy: "no-store" })).rejects.toMatchObject({ name: "OperationError" })
    expect(failing.store.size).toBe(0)
  })

  it("rejects an unknown policy instead of storing the result", async () => {
    const { client, requests } = seeded()
    await expect(client.mutate(ops.IssueToken, { Id: "t1" }, { policy: "nostore" as never })).rejects.toThrow(/unknown mutation policy/)
    expect(requests).toHaveLength(0)
  })

  it("refuses an optimistic response, sending nothing", async () => {
    const { client, requests } = seeded()
    await expect(
      client.mutate(ops.IssueToken, { Id: "t1" }, { policy: "no-store", optimisticResponse: issued() })
    ).rejects.toThrow(/optimisticResponse/)
    expect(requests).toHaveLength(0)
    expect(client.store.size).toBe(0)
  })

  it("still refetches open queries afterwards, from the network", async () => {
    let title = "original"
    const { network, requests } = mockNetwork(({ name }) =>
      name === "TicketsPage" ? { data: ticketPage([ticket("t1", { Title: title })]) } : { data: issued() }
    )
    const client = createClient({ network })
    const list = client.watchQuery<{ Tickets: { Edges: { Node: object }[] } }>(ops.TicketsPage, { Page: { Limit: 5, Offset: 0 } })
    list.open()
    await list.refetch()
    title = "changed on the server"
    await client.mutate(ops.IssueToken, { Id: "t1" }, { policy: "no-store", refetchQueries: [ops.TicketsPage] })
    expect(requests.map((request) => request.name)).toEqual(["TicketsPage", "IssueToken", "TicketsPage"])
    const row = list.getState().data!.Tickets.Edges[0]!.Node
    expect(readFragment<{ Title: string }>(frags.TicketRow, row as never).Title).toBe("changed on the server")
    expect(dumpStore(client)).not.toContain(SECRET)
    list.close()
  })

  it("writes nothing when the client is disposed while the request is in flight", async () => {
    let release!: () => void
    const { network } = mockNetwork(() => new Promise((resolve) => (release = () => resolve({ data: issued() }))))
    const client = createClient({ network })
    const pending = client.mutate(ops.IssueToken, { Id: "t1" }, { policy: "no-store" })
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    client.dispose()
    release()
    await outcome
    expect(dumpStore(client)).not.toContain(SECRET)
  })

  it("works through useMutation: the caller gets the result, the store and the hook state hold none of it", async () => {
    const { network } = mockNetwork(() => ({ data: issued() }))
    const client = createClient({ network })
    let received: TokenData | null = null
    function Issue() {
      const mutation = useMutation<TokenData>(ops.IssueToken)
      return (
        <>
          <button onClick={() => void mutation.commit({ Id: "t1" }, { policy: "no-store" }).then((result) => (received = result.data))}>issue</button>
          <p>{`inFlight:${mutation.inFlight} error:${mutation.error === null ? "none" : "some"}`}</p>
          <p>{inspect(mutation, { depth: null })}</p>
        </>
      )
    }
    const view = render(
      <ClientProvider client={client}>
        <Issue />
      </ClientProvider>
    )
    await act(async () => screen.getByText("issue").click())
    await screen.findByText("inFlight:false error:none")
    expect((received as TokenData | null)?.IssueToken.Secret).toBe(SECRET)
    expect(dumpStore(client)).not.toContain(SECRET)
    expect(debugOutput(client)).not.toContain(SECRET)
    expect(view.container.textContent).not.toContain(SECRET)
  })
})
