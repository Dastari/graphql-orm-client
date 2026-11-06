import { createClient, graphqlWsTransport } from "../dist/index.js"
import { createClient as createWsClient } from "graphql-ws"

const compiled = await (await fetch("/artifacts")).json()
const ws = createWsClient({ url: `ws://${location.host}/graphql`, lazy: false, retryAttempts: 0 })
const count = 10000
const client = createClient({
  network: { execute: async () => ({ data: {
    Tickets: { __typename: "TicketConnection",
      Edges: Array.from({ length: count }, (_, i) => ({ __typename: "TicketEdge", Node: {
        __typename: "Ticket", Id: String(i), Title: `ticket-${i}`, State: "open", RecordVersion: 1,
      } })),
      PageInfo: { __typename: "PageInfo", TotalCount: count } },
  } }) },
  live: { artifacts: compiled.live, ...graphqlWsTransport(ws) },
})
const query = client.watchQuery(compiled.operations.TicketsPage, {})
query.open()
await query.refetch()
client.live.flush()
window.budget = { client, query, ws, rows: query.getState().data.Tickets.Edges.length }
window.openTool = () => window.open("/tool", "_blank", "popup,width=640,height=480")
