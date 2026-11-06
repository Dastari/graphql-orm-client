// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { buildSchema } from "graphql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, type ClientOptions } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import type { LiveDiagnostic } from "../src/health.js"
import type { LiveOptions } from "../src/live.js"
import { ClientProvider, useLiveHealth } from "../src/react/index.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"
import { graphqlWsSubscribe, graphqlWsTransport, type GraphQLWsClientLike } from "../src/transport.js"

const sdl = `
  type Query { Ticket(Id: ID!): Ticket, Note(Id: ID!): Note }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
  type Ticket { Id: ID!, Title: String!, RecordVersion: Int! }
  type Note { Id: ID!, Body: String! }
`
const schema = buildSchema(sdl)
const compiled = compile(schema, [
  `fragment TicketTitle on Ticket @live { Title }`,
  `fragment NoteBody on Note @live { Body }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`,
  `query NotePage($Id: ID!) { Note(Id: $Id) { ...NoteBody } }`,
])
const TicketPage = compiled.operations.TicketPage!
const NotePage = compiled.operations.NotePage!
const ticket = (Title: string, RecordVersion = 1, Id = "t1") => ({ __typename: "Ticket", Id, Title, RecordVersion })

function setup(options: { live?: Partial<LiveOptions> | false; polling?: ClientOptions["polling"]; title?: () => string; version?: () => number } = {}) {
  const clock = createTestClock()
  const network = createMockNetwork({
    schema,
    operations: {
      TicketPage: (variables) => ({ data: { Ticket: ticket(options.title?.() ?? "first", options.version?.() ?? 1, String(variables.Id)) } }),
      NotePage: { data: { Note: { __typename: "Note", Id: "n1", Body: "b" } } },
    },
  })
  const streams = createMockStreams({ schema })
  const diagnostics: LiveDiagnostic[] = []
  const client = createClient({
    network,
    store: clock.store,
    polling: { ...clock.polling, ...options.polling },
    ...(options.live === false
      ? {}
      : { live: { artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic), ...clock.live, ...options.live } }),
  })
  const open = async (id = "t1") => {
    const query = client.watchQuery(TicketPage, { Id: id })
    query.open()
    await clock.tick(1)
    return query
  }
  return { client, clock, network, streams, diagnostics, open }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("client.liveHealth", () => {
  it("is idle with nothing held", () => {
    const { client } = setup()
    expect(client.liveHealth()).toMatchObject({ socket: "unknown", worst: "idle", types: { Ticket: { state: "idle", held: 0, reason: null } } })
    expect(client.liveTypeHealth("Nothing").state).toBe("idle")
    client.dispose()
  })

  it("never calls a quiet stream live: unconfirmed until an event, and again after a restart", async () => {
    const { client, clock, streams, open } = setup()
    await open()
    expect(streams.find("LiveTicket")).toHaveLength(1)
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", reason: null, held: 1, lastEventAt: null, fragments: ["TicketTitle"] })

    streams.one("LiveTicket").emit(ticket("second", 2))
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "live", lastEventAt: clock.now() })
    expect(client.liveHealth().worst).toBe("live")

    streams.reload()
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "connecting", reason: "schema-reload", code: "SUBSCRIPTION_SCHEMA_RELOAD" })
    expect(client.liveTypeHealth("Ticket").retryAt).toBeGreaterThanOrEqual(clock.now())

    clock.advance(1)
    await clock.tick(1000)
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", retryAt: null })
    expect(client.liveTypeHealth("Ticket").lastEventAt).not.toBeNull()
    clock.advance(5)
    streams.one("LiveTicket").emit(ticket("third", 3))
    expect(client.liveTypeHealth("Ticket").state).toBe("live")
    client.dispose()
  })

  it("reports a read, and null until one has completed", async () => {
    const { client, clock, open } = setup()
    const query = client.watchQuery(TicketPage, { Id: "t1" })
    query.open()
    expect(client.liveTypeHealth("Ticket").lastReadAt).toBeNull()
    query.close()
    await open()
    expect(client.liveTypeHealth("Ticket").lastReadAt).toBeLessThanOrEqual(clock.now())
    expect(client.liveTypeHealth("Ticket").lastReadAt).not.toBeNull()
    client.dispose()
  })

  describe("refused", () => {
    it("reports the window, the code and what it's waiting for", async () => {
      const { client, clock, streams, open } = setup({ live: { refusalBackoff: true }, polling: { liveFallbackMs: null } })
      await open()
      streams.one("LiveTicket").refuse("INVALID_INPUT")
      expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "refused", reason: "selection-refused", code: "INVALID_INPUT", pollMs: null, retryAt: clock.now() + 5 * 60_000 })
      expect(client.liveHealth().worst).toBe("refused")
      client.dispose()
    })

    it("names another code as a plain refusal, on the ordinary back-off too", async () => {
      const { client, streams, open } = setup()
      await open()
      streams.one("LiveTicket").refuse("FORBIDDEN", { frame: "next" })
      expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "refused", reason: "refused", code: "FORBIDDEN" })
      client.dispose()
    })

    it("names a router's limit", async () => {
      const { client, streams, open } = setup()
      await open()
      streams.one("LiveTicket").refuse("SUBSCRIPTION_LIMIT_EXCEEDED")
      expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "refused", reason: "over-cap" })
      client.dispose()
    })
  })

  describe("a failing stream", () => {
    it("is connecting at first and unavailable once restarts keep failing", async () => {
      const { client, clock, streams, open } = setup()
      await open()
      const states: string[] = []
      for (let round = 0; round < 4; round += 1) {
        streams.fail()
        states.push(client.liveTypeHealth("Ticket").state)
        await clock.tick(60_000)
      }
      expect(states).toEqual(["connecting", "connecting", "unavailable", "unavailable"])
      expect(client.liveTypeHealth("Ticket").state).toBe("unconfirmed")
      streams.fail()
      expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unavailable", reason: "socket-down", code: null })
      client.dispose()
    })

    it("says so when nothing will bring it back, with restart off", async () => {
      const { client, streams, open } = setup({ live: { restart: false }, polling: { liveFallbackMs: null } })
      await open()
      streams.one("LiveTicket").end()
      expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "unavailable", reason: "stream-ended", retryAt: null })
      client.dispose()
    })
  })

  describe("no stream", () => {
    it("reports a type with no stream as polling, with the poll that covers it", async () => {
      const { client, clock, diagnostics } = setup()
      const query = client.watchQuery(NotePage, { Id: "n1" })
      query.open()
      await clock.tick(1)
      expect(client.liveTypeHealth("Note")).toMatchObject({ state: "polling", reason: "no-stream", pollMs: 30_000, held: 1, fragments: ["NoteBody"] })
      expect(diagnostics.map((entry) => [entry.fragment, entry.typename, entry.reason])).toEqual([["NoteBody", "Note", "no-stream"]])
      client.dispose()
    })

    it("reports unavailable when the fallback poll is off: nothing refreshes it", async () => {
      const { client, clock } = setup({ polling: { liveFallbackMs: null } })
      const query = client.watchQuery(NotePage, { Id: "n1" })
      query.open()
      await clock.tick(1)
      expect(client.liveTypeHealth("Note")).toMatchObject({ state: "unavailable", reason: "no-stream", pollMs: null })
      expect(client.liveHealth().worst).toBe("unavailable")
      client.dispose()
    })

    it("works with no live layer", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const { client, clock } = setup({ live: false, polling: { liveFallbackMs: null } })
      const query = client.watchQuery(TicketPage, { Id: "t1" })
      query.open()
      await clock.tick(1)
      expect(client.liveHealth()).toMatchObject({ socket: "unknown", worst: "unavailable", types: { Ticket: { state: "unavailable", reason: "no-live-layer" } } })
      expect(warn).toHaveBeenCalledTimes(1)
      client.dispose()
    })

    it("shows no poll if any query holding the type has none", async () => {
      const { client, clock, open } = setup({ polling: { liveFallbackMs: null } })
      await open("t1")
      const polled = client.watchQuery(TicketPage, { Id: "t2" }, { pollMs: 5000 })
      polled.open()
      await clock.tick(1)
      clock.advance(0)
      expect(client.liveTypeHealth("Ticket").pollMs).toBeNull()
      client.dispose()
    })
  })

  describe("over the per-record cap", () => {
    it("is polling when a required key leaves records without a stream", async () => {
      const artifacts = { Ticket: { ...compiled.live.Ticket!, mode: "key" as const, keyArgument: "Key", keyOptional: false } }
      const { client, clock, open } = setup({ live: { artifacts, maxKeyedSubscriptions: 0 } })
      await open()
      clock.advance(0)
      expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "polling", reason: "over-cap", pollMs: 30_000 })
      client.dispose()
    })
  })

  describe("snapshots and listeners", () => {
    it("keeps its identity while nothing has changed", async () => {
      const { client, open, streams } = setup()
      await open()
      const before = client.liveHealth()
      expect(client.liveHealth()).toBe(before)
      streams.one("LiveTicket").emit(ticket("second", 2))
      expect(client.liveHealth()).not.toBe(before)
      client.dispose()
    })

    it("tells a listener once per tick, when the state changes", async () => {
      const { client, streams, clock, open } = setup()
      await open()
      const listener = vi.fn()
      client.subscribeLiveHealth(listener)
      await clock.tick(1)
      listener.mockClear()
      streams.reload()
      await clock.tick()
      expect(listener).toHaveBeenCalledTimes(1)
      client.dispose()
    })

    it("tells a listener about a burst of events at most once a second, but at once for the first", async () => {
      const { client, streams, clock, open } = setup()
      await open()
      await clock.tick(1)
      const listener = vi.fn()
      client.subscribeLiveHealth(listener)
      for (let event = 0; event < 100; event += 1) {
        streams.one("LiveTicket").emit(ticket(`e${event}`, event + 2))
        await clock.tick(1)
      }
      expect(listener.mock.calls.length).toBe(1)
      await clock.tick(1000)
      streams.one("LiveTicket").emit(ticket("later", 500))
      await clock.tick()
      expect(listener.mock.calls.length).toBe(2)
      client.dispose()
    })

    it("stops when unsubscribed", async () => {
      const { client, streams, clock, open } = setup()
      await open()
      const listener = vi.fn()
      const stop = client.subscribeLiveHealth(listener)
      await clock.tick(1)
      listener.mockClear()
      stop()
      streams.reload()
      await clock.tick()
      expect(listener).not.toHaveBeenCalled()
      client.dispose()
    })
  })

  describe("identity disposal", () => {
    it("tells nobody after disposal, and the next client starts clean", async () => {
      const { client, streams, clock, open, diagnostics } = setup({ polling: { liveFallbackMs: null } })
      await open()
      const listener = vi.fn()
      client.subscribeLiveHealth(listener)
      await clock.tick(1)
      listener.mockClear()
      streams.one("LiveTicket").refuse("INVALID_INPUT")
      client.dispose()
      await clock.tick()
      expect(listener).not.toHaveBeenCalled()
      expect(diagnostics).toHaveLength(0)

      const next = setup()
      expect(next.client.liveHealth().worst).toBe("idle")
      await next.open()
      expect(next.client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", lastEventAt: null, code: null })
      next.client.dispose()
    })
  })

  describe("garbage collection", () => {
    it("goes back to idle when the query closes, and holds nothing", async () => {
      const { client, clock, open } = setup()
      const query = await open()
      expect(client.liveTypeHealth("Ticket").held).toBe(1)
      query.close()
      await clock.tick(1)
      expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "idle", held: 0, fragments: [] })
      client.dispose()
    })
  })

  describe("diagnostics", () => {
    it("reports once per fragment and reason, naming the fragment and how it refreshes", async () => {
      const { client, streams, clock, diagnostics, open } = setup({ live: { refusalBackoff: { ms: 10 } }, polling: { liveFallbackMs: null } })
      await open()
      for (let round = 0; round < 3; round += 1) {
        streams.one("LiveTicket").refuse("INVALID_INPUT")
        await clock.tick(20)
      }
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ fragment: "TicketTitle", typename: "Ticket", state: "refused", reason: "selection-refused", code: "INVALID_INPUT" })
      expect(diagnostics[0]!.message).toBe("graphql-orm-client: fragment TicketTitle on Ticket can't stay live: selection-refused (INVALID_INPUT). Nothing refreshes it.")
      streams.one("LiveTicket").reload()
      await clock.tick()
      // A restart under way isn't lasting.
      expect(diagnostics).toHaveLength(1)
      client.dispose()
    })

    it("uses console.warn by default, and nothing in production or when turned off", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const run = async (live: Partial<LiveOptions>) => {
        const clock = createTestClock()
        const client = createClient({
          network: createMockNetwork({ operations: { NotePage: { data: { Note: { __typename: "Note", Id: "n1", Body: "b" } } } } }),
          polling: clock.polling,
          store: clock.store,
          live: { artifacts: compiled.live, subscribe: createMockStreams().subscribe, debounceMs: 0, ...clock.live, ...live },
        })
        client.watchQuery(NotePage, { Id: "n1" }).open()
        await clock.tick(1)
        client.dispose()
      }
      await run({})
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain("fragment NoteBody on Note")
      await run({ onDiagnostic: null })
      expect(warn).toHaveBeenCalledTimes(1)
      vi.stubEnv("NODE_ENV", "production")
      await run({})
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })
})

describe("graphqlWsTransport", () => {
  function fake() {
    const handlers = new Map<string, ((...args: any[]) => void)[]>()
    const inner = createMockStreams()
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

  function clientOver(ws: GraphQLWsClientLike, title: () => string = () => "first", version: () => number = () => 1) {
    const clock = createTestClock()
    const network = createMockNetwork({ operations: { TicketPage: () => ({ data: { Ticket: ticket(title(), version()) } }) } })
    const client = createClient({ network, store: clock.store, live: { artifacts: compiled.live, debounceMs: 0, onDiagnostic: null, ...graphqlWsTransport(ws), ...clock.live } })
    return { client, clock, network }
  }

  it("reports the socket, and a stream on a reconnecting socket isn't live", async () => {
    const { ws, inner, emit } = fake()
    const { client, clock } = clientOver(ws)
    expect(client.liveHealth().socket).toBe("closed")
    client.watchQuery(TicketPage, { Id: "t1" }).open()
    await clock.tick(1)
    emit("connecting", false)
    expect(client.liveHealth().socket).toBe("connecting")
    emit("connected", {}, {}, false)
    expect(client.liveHealth().socket).toBe("connected")
    inner.one("LiveTicket").emit(ticket("second", 2))
    expect(client.liveTypeHealth("Ticket").state).toBe("live")
    emit("closed", {})
    expect(client.liveTypeHealth("Ticket")).toMatchObject({ state: "connecting", reason: "socket-down" })
    client.dispose()
  })

  it("reads again after a socket recovers by itself, since events in the gap are gone (reconnect replay)", async () => {
    const { ws, emit } = fake()
    let title = "first"
    const { client, clock, network } = clientOver(ws, () => title)
    const query = client.watchQuery(TicketPage, { Id: "t1" })
    query.open()
    await clock.tick(1)
    emit("connected", {}, {}, false)
    await clock.tick()
    expect(network.calls("TicketPage")).toHaveLength(1)
    title = "missed"
    emit("closed", {})
    emit("connected", {}, {}, true)
    await clock.tick()
    expect(network.calls("TicketPage")).toHaveLength(2)
    expect(client.store.get([...(client.store as unknown as { records: Map<string, unknown> }).records.keys()].find((key) => key !== "client:root")!)?.fields.get("Title")).toBe("missed")
    client.dispose()
  })

  it("keeps a newer event when that read answers older (version conflict)", async () => {
    const { ws, inner, emit } = fake()
    const { client, clock } = clientOver(ws, () => "old", () => 1)
    client.watchQuery(TicketPage, { Id: "t1" }).open()
    await clock.tick(1)
    inner.one("LiveTicket").emit(ticket("new", 5))
    emit("connected", {}, {}, true)
    await clock.tick()
    expect(client.store.get([...(client.store as unknown as { records: Map<string, unknown> }).records.keys()].find((key) => key !== "client:root")!)?.fields.get("Title")).toBe("new")
    client.dispose()
  })

  it("does nothing after disposal", async () => {
    const { ws, emit } = fake()
    const { client, clock, network } = clientOver(ws)
    client.watchQuery(TicketPage, { Id: "t1" }).open()
    await clock.tick(1)
    const reads = network.calls("TicketPage").length
    client.dispose()
    emit("connected", {}, {}, true)
    await clock.tick()
    expect(network.calls("TicketPage")).toHaveLength(reads)
  })

  it("reports unknown for a client without events, and graphqlWsSubscribe alone stays unknown", async () => {
    const clock = createTestClock()
    const ws: GraphQLWsClientLike = { subscribe: () => () => {} }
    const options = { network: createMockNetwork(), store: clock.store, onDiagnostic: null }
    const withTransport = createClient({ network: options.network, store: clock.store, live: { artifacts: compiled.live, onDiagnostic: null, ...graphqlWsTransport(ws) } })
    expect(withTransport.liveHealth().socket).toBe("unknown")
    withTransport.dispose()
    const plain = createClient({ network: options.network, store: clock.store, live: { artifacts: compiled.live, onDiagnostic: null, subscribe: graphqlWsSubscribe(ws) } })
    expect(plain.liveHealth().socket).toBe("unknown")
    plain.dispose()
  })
})

describe("useLiveHealth", () => {
  it("draws refused and unavailable with no bookkeeping, and follows changes", async () => {
    const { client, clock, streams, open } = setup({ live: { refusalBackoff: true }, polling: { liveFallbackMs: null } })
    const renders: string[] = []
    function Badge() {
      const health = useLiveHealth("Ticket")
      renders.push(health.state)
      return <span data-testid="state">{`${health.state}:${health.reason ?? ""}`}</span>
    }
    function Overall() {
      return <span data-testid="worst">{useLiveHealth().worst}</span>
    }
    render(
      <ClientProvider client={client}>
        <Badge />
        <Overall />
      </ClientProvider>
    )
    expect(screen.getByTestId("state").textContent).toBe("idle:")
    await act(async () => {
      await open()
    })
    expect(screen.getByTestId("state").textContent).toBe("unconfirmed:")
    await act(async () => {
      streams.one("LiveTicket").refuse("INVALID_INPUT")
      await clock.tick()
    })
    expect(screen.getByTestId("state").textContent).toBe("refused:selection-refused")
    expect(screen.getByTestId("worst").textContent).toBe("refused")
    const count = renders.length
    await act(async () => {
      await clock.tick()
    })
    expect(renders.length).toBe(count)
    client.dispose()
  })
})
