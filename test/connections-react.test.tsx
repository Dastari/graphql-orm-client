// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { buildSchema } from "graphql"
import { expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { ClientProvider, useFragmentList, useQuery } from "../src/react/index.js"
import { createMockNetwork } from "../src/test/index.js"

const schema = buildSchema(`
  input CursorInput { limit: Int after: String }
  type Widget { NodeId: ID! Id: ID! Name: String! }
  type PageInfo { HasNextPage: Boolean! EndCursor: String }
  type Edge { Node: Widget! Cursor: String! }
  type Result { Edges: [Edge!]! PageInfo: PageInfo! }
  type Query { Open(Page: CursorInput): Result! Closed(Page: CursorInput): Result! }
`)
const compiled = compile(schema, [
  `fragment Row on Widget { Name }`,
  `query Two($OpenPage: CursorInput, $ClosedPage: CursorInput) {
    Open(Page: $OpenPage) @connection(key: "open") { Edges { Node { ...Row } } }
    Closed(Page: $ClosedPage) @connection(key: "closed") { Edges { Node { ...Row } } }
  }`,
])

it("useQuery loads more of a list by its key, shows each list's state, and restarts one", async () => {
  const lists: Record<string, string[]> = { Open: ["a", "b", "c"], Closed: ["p", "q", "r"] }
  const network = createMockNetwork({
    respond: (request) => {
      const data: Record<string, unknown> = {}
      for (const [root, variable] of [["Open", "OpenPage"], ["Closed", "ClosedPage"]] as const) {
        const page = (request.variables[variable] as { after?: string; limit?: number } | undefined) ?? {}
        const ids = lists[root]!
        const offset = page.after ? ids.indexOf(page.after) + 1 : 0
        const shown = ids.slice(offset, offset + (page.limit ?? 2))
        data[root] = { __typename: "Result", Edges: shown.map((id) => ({ __typename: "Edge", Cursor: id, Node: { __typename: "Widget", NodeId: encodeNodeId("Widget", [id]), Id: id, Name: id } })), PageInfo: { __typename: "PageInfo", HasNextPage: offset + shown.length < ids.length, EndCursor: shown.at(-1) ?? null } }
      }
      return { data }
    },
  })
  const client = createClient({ network })
  type Data = { Open: { Edges: { Node: object }[] }; Closed: { Edges: { Node: object }[] } }
  function Lists() {
    const query = useQuery<Data>(compiled.operations.Two!, { OpenPage: { limit: 2 }, ClosedPage: { limit: 2 } })
    const open = useFragmentList<{ Name: string }>(compiled.fragments.Row!, query.data?.Open.Edges.map((edge) => edge.Node))
    const closed = useFragmentList<{ Name: string }>(compiled.fragments.Row!, query.data?.Closed.Edges.map((edge) => edge.Node))
    return (
      <>
        <p>{`open ${open.map((row) => row.Name).join("")} ${query.connections?.open?.hasMore ? "more" : "end"}`}</p>
        <p>{`closed ${closed.map((row) => row.Name).join("")} ${query.connections?.closed?.hasMore ? "more" : "end"}`}</p>
        <button onClick={() => void query.loadMore({ connection: "closed" })}>more closed</button>
        <button onClick={() => void query.restart({ connection: "closed" })}>restart closed</button>
      </>
    )
  }
  render(<ClientProvider client={client}><Lists /></ClientProvider>)
  expect(await screen.findByText("closed pq more")).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByText("more closed")) })
  expect(await screen.findByText("closed pqr end")).toBeTruthy()
  expect(screen.getByText("open ab more")).toBeTruthy()
  lists.Closed = ["s", "p", "q", "r"]
  await act(async () => { fireEvent.click(screen.getByText("restart closed")) })
  // The loaded range, the room on its last page included, is read again from the first page.
  expect(await screen.findByText("closed spqr end")).toBeTruthy()
  expect(network.requests.at(-1)!.variables).toEqual({ OpenPage: { limit: 2 }, ClosedPage: { limit: 4 } })
  client.dispose()
})
