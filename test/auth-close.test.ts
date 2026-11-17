import { buildSchema } from "graphql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, type Client } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import type { LiveOptions } from "../src/live.js"
import { createMockNetwork, createMockStreams, createTestClock, type MockStreams, type TestClock } from "../src/test/index.js"
import { graphqlWsTransport, type GraphQLWsClientLike } from "../src/transport.js"

// Two live types, so a socket closed for authentication is seen to affect every type, not the one whose stream noticed.
const sdl = `
  type Query { Ticket(Id: ID!): Ticket, Note(Id: ID!): Note }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent!, NoteChanged(Keys: [ID!]): NoteChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
  type NoteChangedEvent { Action: ChangeAction!, Note: Note }
  type Ticket { Id: ID!, Title: String!, RecordVersion: Int! }
  type Note { Id: ID!, Body: String!, RecordVersion: Int! }
`
const schema = buildSchema(sdl)
const compiled = compile(schema, [
  `fragment TicketTitle on Ticket @live { Title }`,
  `fragment NoteBody on Note @live { Body }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`,
  `query NotePage($Id: ID!) { Note(Id: $Id) { ...NoteBody } }`,
], { liveSelection: "as-written" })
const TicketPage = compiled.operations.TicketPage!
const NotePage = compiled.operations.NotePage!
const ticket = (Title: string, RecordVersion = 1, Id = "t1") => ({ __typename: "Ticket", Id, Title, RecordVersion })
const note = (Body: string, RecordVersion = 1, Id = "n1") => ({ __typename: "Note", Id, Body, RecordVersion })
const unauthorized = { code: 4401, reason: "Unauthorized", wasClean: true }

const clients: Client[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  vi.restoreAllMocks()
})

function setup(options: { live?: Partial<LiveOptions>; clock?: TestClock; streams?: MockStreams; title?: () => string } = {}) {
  const clock = options.clock ?? createTestClock()
  const network = createMockNetwork({
    schema,
    operations: {
      TicketPage: (variables) => ({ data: { Ticket: ticket(options.title?.() ?? "first", 1, String(variables.Id)) } }),
      NotePage: (variables) => ({ data: { Note: note("body", 1, String(variables.Id)) } }),
    },
  })
  const streams = options.streams ?? createMockStreams({ schema })
  const client = createClient({
    network,
    store: clock.store,
    polling: clock.polling,
    live: { artifacts: compiled.live, settleMs: false, debounceMs: 0, onDiagnostic: null, subscribe: streams.subscribe, ...clock.live, ...options.live },
  })
  clients.push(client)
  const open = async () => {
    client.watchQuery(TicketPage, { Id: "t1" }).open()
    client.watchQuery(NotePage, { Id: "n1" }).open()
    await clock.tick(1)
  }
  return { client, clock, network, streams, open }
}

describe("a socket closed for authentication", () => {
  it("stops every type's streams, reports why with the close code, and sets no timer to connect again", async () => {
    const { client, clock, network, streams, open } = setup()
    await open()
    expect(streams.open.size).toBe(2)
    const started = streams.started.length
    // graphql-ws ends every operation on the socket with the close event.
    streams.fail(unauthorized)
    for (const type of ["Ticket", "Note"]) {
      expect(client.liveTypeHealth(type)).toMatchObject({ state: "polling", reason: "unauthenticated", code: "4401", retryAt: null, pollMs: 30_000 })
    }
    expect(client.live!.status().Ticket).toMatchObject({ restarting: false, unauthenticated: { reason: "unauthenticated", code: "4401" } })

    // Time passes and the held records change: no stream is asked for again, and the queries poll instead.
    const reads = network.calls("TicketPage").length
    await clock.tick(10 * 60_000)
    client.watchQuery(TicketPage, { Id: "t2" }).open()
    await clock.tick(60_000)
    expect(streams.started.length).toBe(started)
    expect(network.calls("TicketPage").length).toBeGreaterThan(reads + 1)
  })

  it("leaves an UNAUTHENTICATED answer a refusal of that stream, which the router recovers on the same connection", async () => {
    const { client, clock, streams, open } = setup()
    await open()
    streams.one("LiveTicket").refuse("UNAUTHENTICATED")
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "polling", reason: "refused", code: "UNAUTHENTICATED" })
    expect(client.liveTypeHealth("Ticket").retryAt).not.toBeNull()
    expect(client.liveTypeHealth("Note")).toMatchObject({ state: "unconfirmed", reason: null })
    expect(streams.find("LiveNote")).toHaveLength(1)
    // The refusal window ends and the stream is asked for again by itself.
    await clock.tick(7 * 60_000)
    expect(streams.find("LiveTicket")).toHaveLength(1)
  })

  it("starts again and reads what it missed when the application reconnects (reconnect replay)", async () => {
    let title = "first"
    const { client, clock, network, streams, open } = setup({ title: () => title })
    await open()
    streams.fail(unauthorized)
    await clock.tick(1)
    const reads = network.calls("TicketPage").length
    title = "missed"
    client.reconnectLive()
    await clock.tick(1)
    expect(streams.find("LiveTicket")).toHaveLength(1)
    expect(streams.find("LiveNote")).toHaveLength(1)
    expect(network.calls("TicketPage").length).toBe(reads + 1)
    expect(client.liveHealth().reads?.reconnect).toBeGreaterThanOrEqual(2)
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", reason: null, code: null, pollMs: null })
    expect(client.live!.status().Ticket!.unauthenticated).toBeNull()

    // An event newer than the read wins; the read that follows a later reconnect can't take it back (version conflict).
    streams.one("LiveTicket").emit(ticket("event", 5))
    expect(client.liveTypeHealth("Ticket").state).toBe("live")
    // Credentials that still don't work stop it again, still without a timer.
    const started = streams.started.length
    streams.fail(unauthorized)
    expect(client.liveTypeHealth("Ticket").reason).toBe("unauthenticated")
    await clock.tick(10 * 60_000)
    expect(streams.started.length).toBe(started)
  })

  it("does nothing on reconnectLive when it hasn't stopped", async () => {
    const { client, clock, network, streams, open } = setup()
    await open()
    const started = streams.started.length
    const reads = network.requests.length
    client.reconnectLive()
    await clock.tick(1)
    expect(streams.started.length).toBe(started)
    expect(network.requests.length).toBe(reads)
  })

  it("goes with the identity: the next identity's client subscribes at once (identity disposal)", async () => {
    const clock = createTestClock()
    const streams = createMockStreams({ schema })
    const first = setup({ clock, streams })
    await first.open()
    streams.fail(unauthorized)
    first.client.dispose()
    const requests = first.network.requests.length
    const started = streams.started.length
    await clock.tick(10 * 60_000)
    expect(first.network.requests.length).toBe(requests)
    expect(streams.started.length).toBe(started)
    // Its reconnectLive does nothing once disposed.
    first.client.reconnectLive()
    expect(streams.started.length).toBe(started)
    const second = setup({ clock, streams })
    await second.open()
    expect(streams.open.size).toBe(2)
    expect(second.client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", reason: null })
  })

  it("restarts with back-off as before with unauthenticated: \"restart\"", async () => {
    const { client, clock, streams, open } = setup({ live: { unauthenticated: "restart" } })
    await open()
    streams.fail(unauthorized)
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "connecting", reason: "socket-down" })
    await clock.tick(1000)
    expect(streams.open.size).toBe(2)
  })
})

describe("graphqlWsTransport and an authentication close", () => {
  function fake() {
    const handlers = new Map<string, ((...args: any[]) => void)[]>()
    const inner = createMockStreams({ schema })
    const ws: GraphQLWsClientLike = {
      subscribe: (payload, sink) =>
        inner.subscribe({ kind: "subscription", name: payload.operationName ?? "", text: payload.query, hash: "", variables: payload.variables ?? {} }, sink),
      terminate: () => {},
      on: (event, listener) => {
        handlers.set(event, [...(handlers.get(event) ?? []), listener])
        return () => {}
      },
    }
    return { ws, inner, emit: (event: string, ...args: unknown[]) => handlers.get(event)?.forEach((handler) => handler(...args)) }
  }

  it("stops at the close event, before graphql-ws retries a 4403, and starts again once a connection is accepted", async () => {
    const { ws, inner, emit } = fake()
    const { client, clock, network, open } = setup({ live: graphqlWsTransport(ws) })
    await open()
    emit("connected", {}, {}, false)
    expect(inner.open.size).toBe(2)
    // graphql-ws retries a 4403 by itself and keeps the operations open meanwhile; letting go of them ends its retries.
    emit("closed", { code: 4403, reason: "Forbidden", wasClean: true })
    expect(inner.open.size).toBe(0)
    expect(client.liveTypeHealth("Note")).toMatchObject({ state: "polling", reason: "unauthenticated", code: "4403" })
    expect(client.liveHealth().socket).toBe("closed")
    const started = inner.started.length
    await clock.tick(10 * 60_000)
    expect(inner.started.length).toBe(started)

    // Something else on the socket connected with credentials the server accepted.
    const reads = network.calls("NotePage").length
    emit("connected", {}, {}, true)
    await clock.tick(1)
    expect(inner.open.size).toBe(2)
    expect(network.calls("NotePage").length).toBeGreaterThan(reads)
    expect(client.liveTypeHealth("Note")).toMatchObject({ state: "unconfirmed", reason: null })
  })

  it("leaves other close codes to the ordinary handling", async () => {
    const { ws, inner, emit } = fake()
    const { client, open } = setup({ live: graphqlWsTransport(ws) })
    await open()
    emit("connected", {}, {}, false)
    emit("closed", { code: 1006, reason: "", wasClean: false })
    expect(inner.open.size).toBe(2)
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "connecting", reason: "socket-down" })
  })
})
