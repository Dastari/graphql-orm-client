import { buildSchema } from "graphql"
import { createClient as createWsClient, type Client as GraphQLWsClient } from "graphql-ws"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import { createClient, type Client } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { createMockNetwork } from "../src/test/index.js"
import { graphqlWsSubscribe, graphqlWsTransport } from "../src/transport.js"

// A real graphql-ws 6 client against a minimal graphql-transport-ws server, to check what graphql-ws does with 4401 and 4403.
const schema = buildSchema(`
  type Query { Ticket(Id: ID!): Ticket }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
  type Ticket { Id: ID!, Title: String!, RecordVersion: Int! }
`)
const compiled = compile(schema, [`fragment TicketTitle on Ticket @live { Title }`, `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`], { liveSelection: "as-written" })
const TicketPage = compiled.operations.TicketPage!

type Mode = "accept" | "close-on-init" | "close-on-subscribe"

async function server(code: number) {
  let mode: Mode = "accept"
  let connections = 0
  let subscribes = 0
  let wss: WebSocketServer | null = null
  let port = 0
  // Ports 42000–42099 only; try a few in case another run holds one.
  for (let attempt = 0; attempt < 20 && !wss; attempt += 1) {
    port = 42000 + Math.floor(Math.random() * 100)
    wss = await new Promise<WebSocketServer | null>((resolve) => {
      const candidate = new WebSocketServer({ port, handleProtocols: () => "graphql-transport-ws" })
      candidate.once("listening", () => resolve(candidate))
      candidate.once("error", () => resolve(null))
    })
  }
  if (!wss) throw new Error("No free port in 42000–42099")
  wss.on("connection", (socket) => {
    connections += 1
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; id?: string }
      if (message.type === "connection_init") {
        if (mode === "close-on-init") return socket.close(code, code === 4403 ? "Forbidden" : "Unauthorized")
        return socket.send(JSON.stringify({ type: "connection_ack" }))
      }
      if (message.type === "subscribe") {
        subscribes += 1
        if (mode === "close-on-subscribe") socket.close(code, code === 4403 ? "Forbidden" : "Unauthorized")
      }
    })
  })
  return {
    url: `ws://127.0.0.1:${port}`,
    set: (next: Mode) => void (mode = next),
    get connections() { return connections },
    get subscribes() { return subscribes },
    close: () => new Promise<void>((resolve) => { for (const client of wss!.clients) client.terminate(); wss!.close(() => resolve()) }),
  }
}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out")
    await wait(5)
  }
}

function clientOver(ws: GraphQLWsClient, transport: "transport" | "subscribe"): Client {
  const network = createMockNetwork({ schema, operations: { TicketPage: { data: { Ticket: { __typename: "Ticket", Id: "t1", Title: "a", RecordVersion: 1 } } } } })
  const live = transport === "transport" ? graphqlWsTransport(ws) : { subscribe: graphqlWsSubscribe(ws) }
  const client = createClient({ network, polling: { liveFallbackMs: null }, live: { artifacts: compiled.live, settleMs: false, debounceMs: 0, onDiagnostic: null, ...live } })
  cleanups.push(() => client.dispose())
  client.watchQuery(TicketPage, { Id: "t1" }).open()
  return client
}

describe("graphql-ws 6 and a socket closed for authentication", () => {
  it("4401: graphql-ws doesn't retry it, and the client doesn't either until reconnectLive", async () => {
    const socket = await server(4401)
    cleanups.push(socket.close)
    socket.set("close-on-subscribe")
    const ws = createWsClient({ url: socket.url, webSocketImpl: WebSocket, retryWait: () => wait(10) })
    cleanups.push(() => ws.dispose())
    // graphqlWsSubscribe alone sees the close event graphql-ws hands each operation's sink.
    const client = clientOver(ws, "subscribe")
    await until(() => client.liveTypeHealth("Ticket").reason === "unauthenticated")
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unavailable", code: "4401", retryAt: null })
    await wait(300)
    expect(socket.connections).toBe(1)

    socket.set("accept")
    client.reconnectLive()
    await until(() => socket.subscribes === 2)
    expect(socket.connections).toBe(2)
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", reason: null })
  })

  it("4403: graphql-ws would retry it, and graphqlWsTransport stops those retries at the close event", async () => {
    const socket = await server(4403)
    cleanups.push(socket.close)
    socket.set("close-on-init")
    const ws = createWsClient({ url: socket.url, webSocketImpl: WebSocket, retryWait: () => wait(10) })
    cleanups.push(() => ws.dispose())
    const client = clientOver(ws, "transport")
    await until(() => client.liveTypeHealth("Ticket").reason === "unauthenticated")
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unavailable", code: "4403" })
    await wait(300)
    // Without the stop, graphql-ws reconnects five times (its default `retryAttempts`) with these credentials.
    expect(socket.connections).toBe(1)

    socket.set("accept")
    client.reconnectLive()
    await until(() => socket.subscribes === 1)
    expect(client.liveHealth().socket).toBe("connected")
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", reason: null })
  })
})
