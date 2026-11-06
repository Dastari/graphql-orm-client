// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { buildSchema } from "graphql"
import { createClient } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { ClientProvider, useFragment, useQuery } from "../src/react/index.js"
import { createMockNetwork, createMockStreams, createTestClock, graphQLErrors } from "../src/test/index.js"
import type { SubscriptionSink } from "../src/live.js"

const sdl = `
  type Query { Ticket(Id: ID!): Ticket }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
  type Ticket { Id: ID!, Title: String!, RecordVersion: Int! }
`
const schema = buildSchema(sdl)
const compiled = compile(schema, [
  `fragment TicketTitle on Ticket @live { Title }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`,
])
const TicketPage = compiled.operations.TicketPage!
const TicketTitle = compiled.fragments.TicketTitle!
const ticket = (Title: string, RecordVersion: number) => ({ __typename: "Ticket", Id: "t1", Title, RecordVersion })
const page = (Title: string, RecordVersion: number) => ({ data: { Ticket: ticket(Title, RecordVersion) } })

afterEach(cleanup)

describe("createMockNetwork", () => {
  const request = (text: string, variables: Record<string, unknown> = {}, name = "Q") => ({ kind: "query" as const, name, text, hash: "", variables })

  it("answers by operation name, with a value or a function of the variables", async () => {
    const network = createMockNetwork({
      operations: { Fixed: { data: { a: 1 } }, Echo: (variables) => ({ data: variables }) },
    })
    expect(await network.execute(request("{ a }", {}, "Fixed"), {})).toEqual({ data: { a: 1 } })
    expect(await network.execute(request("{ a }", { b: 2 }, "Echo"), {})).toEqual({ data: { b: 2 } })
    expect(network.calls("Echo")).toHaveLength(1)
    expect(network.requests).toHaveLength(2)
  })

  it("fails an operation with no answer, so nothing passes by accident", async () => {
    const network = createMockNetwork({ operations: {} })
    await expect(network.execute(request("{ a }"), {})).rejects.toThrow("No mock answer for operation Q")
    expect(network.failures).toEqual(["No mock answer for operation Q"])
  })

  it("fails a document that doesn't fit the schema, and bad variables", async () => {
    const network = createMockNetwork({ schema: sdl, operations: { Q: { data: {} } } })
    await expect(network.execute(request("query Q { Nope }"), {})).rejects.toThrow(/doesn't fit the schema.*Nope/)
    await expect(network.execute(request("query Q($Id: ID!) { Ticket(Id: $Id) { Title } }"), {})).rejects.toThrow(/doesn't fit the schema.*\$Id/)
    expect(network.failures).toHaveLength(2)
    await expect(network.execute(request("query Q($Id: ID!) { Ticket(Id: $Id) { Title } }", { Id: "t1" }), {})).resolves.toEqual({ data: {} })
  })

  it("accepts what the compiler emits", async () => {
    const network = createMockNetwork({ schema, operations: { TicketPage: page("a", 1) } })
    const client = createClient({ network })
    await client.query(TicketPage, { Id: "t1" })
    expect(network.failures).toEqual([])
    client.dispose()
  })

  it("lets a test replace an answer, and a rejected function fail the request", async () => {
    const network = createMockNetwork({ operations: { Q: { data: { a: 1 } } } })
    network.answer("Q", () => {
      throw new Error("router down")
    })
    await expect(network.execute(request("{ a }"), {})).rejects.toThrow("router down")
    // Not a failure of the kit.
    expect(network.failures).toEqual([])
  })
})

describe("createMockStreams", () => {
  const request = { kind: "subscription" as const, name: "LiveTicket", text: "subscription LiveTicket($Keys: [ID!]) { TicketChanged(Keys: $Keys) { Action } }", hash: "", variables: { Keys: ["t1"] } }
  function recording() {
    const frames: unknown[][] = []
    const sink: SubscriptionSink = {
      next: (value) => void frames.push(["next", value]),
      error: (error) => void frames.push(["error", error]),
      complete: () => void frames.push(["complete"]),
    }
    return { frames, sink }
  }

  const cases: [string, (stream: ReturnType<ReturnType<typeof createMockStreams>["one"]>) => void, unknown[][]][] = [
    ["reload", (s) => s.reload(), [["error", graphQLErrors("SUBSCRIPTION_SCHEMA_RELOAD", "subscription has been closed due to a schema reload")]]],
    ["unavailable", (s) => s.unavailable(), [["error", graphQLErrors("SERVICE_UNAVAILABLE", "Supergraph used by this connection has been retired")]]],
    ["refuse as an error frame", (s) => s.refuse("X"), [["error", graphQLErrors("X")]]],
    ["refuse as a frame then complete", (s) => s.refuse("X", { frame: "next" }), [["next", { data: null, errors: graphQLErrors("X") }], ["complete"]]],
    ["loseContinuity", (s) => s.loseContinuity(), [["next", { data: null, errors: graphQLErrors("SUBSCRIPTION_CONTINUITY_LOST") }], ["complete"]]],
    ["fail", (s) => s.fail(), [["error", { code: 1006, reason: "", wasClean: false }]]],
    ["end", (s) => s.end(), [["complete"]]],
  ]
  for (const [name, act, frames] of cases) {
    it(`${name} sends the router's frames and closes the stream`, () => {
      const streams = createMockStreams()
      const recorded = recording()
      streams.subscribe(request, recorded.sink)
      const stream = streams.one("LiveTicket")
      act(stream)
      expect(recorded.frames).toEqual(frames)
      expect(stream.closed).toBe(true)
      expect(streams.open.size).toBe(0)
      // A closed stream is silent, as a real one is.
      stream.end()
      stream.emit({})
      expect(recorded.frames).toEqual(frames)
    })
  }

  it("emits an event in graphql-orm's shape", () => {
    const streams = createMockStreams()
    const recorded = recording()
    streams.subscribe(request, recorded.sink)
    streams.one("LiveTicket").emit({ Id: "t1" }, { action: "DELETED" })
    expect(recorded.frames).toEqual([["next", { data: { TicketChanged: { __typename: "TicketChangedEvent", Action: "DELETED", Ticket: { Id: "t1" } } } }]])
  })

  it("finds by operation and variables, and says so when it isn't exactly one", () => {
    const streams = createMockStreams()
    streams.subscribe(request, recording().sink)
    streams.subscribe({ ...request, variables: { Keys: ["t2"] } }, recording().sink)
    expect(() => streams.one("LiveTicket")).toThrow("found 2")
    expect(() => streams.one("Other")).toThrow("found 0")
    expect(streams.one("LiveTicket", { Keys: ["t2"] }).variables).toEqual({ Keys: ["t2"] })
    expect(streams.find("LiveTicket")).toHaveLength(2)
    streams.reload()
    expect(streams.open.size).toBe(0)
    expect(streams.started).toHaveLength(2)
  })

  it("stops when the client stops it", () => {
    const streams = createMockStreams()
    const stop = streams.subscribe(request, recording().sink)
    const stream = streams.one("LiveTicket")
    stop()
    expect(stream.closed).toBe(true)
    expect(streams.find("LiveTicket")).toHaveLength(0)
  })

  it("throws on a subscribe that doesn't fit the schema", () => {
    const streams = createMockStreams({ schema: sdl })
    expect(() => streams.subscribe({ ...request, text: "subscription LiveTicket { Nope }", variables: {} }, recording().sink)).toThrow(/doesn't fit the schema/)
    expect(() => streams.subscribe(request, recording().sink)).not.toThrow()
  })
})

describe("createTestClock", () => {
  it("fires what falls due in time order, and passes the time", () => {
    const clock = createTestClock(100)
    const fired: string[] = []
    clock.setTimeout(() => fired.push(`b@${clock.now()}`), 20)
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 10)
    clock.setTimeout(() => fired.push("late"), 31)
    clock.advance(30)
    expect(fired).toEqual(["a@110", "b@120"])
    expect(clock.now()).toBe(130)
    expect(clock.pending()).toEqual([{ ms: 31, at: 131, repeats: false }])
  })

  it("fires a timer another timer sets, if it falls due", () => {
    const clock = createTestClock()
    const fired: number[] = []
    clock.setTimeout(() => {
      fired.push(1)
      clock.setTimeout(() => fired.push(2), 5)
      clock.setTimeout(() => fired.push(3), 50)
    }, 5)
    clock.advance(10)
    expect(fired).toEqual([1, 2])
  })

  it("repeats an interval until cleared, and cancels a timeout", () => {
    const clock = createTestClock()
    let ticks = 0
    const interval = clock.setInterval(() => (ticks += 1), 10)
    const timeout = clock.setTimeout(() => (ticks += 100), 5)
    clock.clearTimeout(timeout)
    clock.advance(35)
    expect(ticks).toBe(3)
    clock.clearInterval(interval)
    clock.advance(100)
    expect(ticks).toBe(3)
  })

  it("lets requests settle between timers with tick", async () => {
    const clock = createTestClock()
    const seen: string[] = []
    clock.setTimeout(() => void Promise.resolve().then(() => seen.push("promise")), 1)
    clock.setTimeout(() => seen.push("second timer"), 2)
    await clock.tick(2)
    expect(seen).toEqual(["promise", "second timer"])
  })
})

describe("testing a component's freshness", () => {
  function setup() {
    const clock = createTestClock()
    let server = page("first", 1)
    const network = createMockNetwork({ schema, operations: { TicketPage: () => server } })
    const streams = createMockStreams({ schema })
    const client = createClient({
      network,
      store: clock.store,
      polling: clock.polling,
      live: { artifacts: compiled.live, subscribe: streams.subscribe, ...clock.live },
    })
    function Row({ ticket: reference }: { ticket: never }) {
      return <span data-testid="title">{useFragment<{ Title: string }>(TicketTitle, reference).Title}</span>
    }
    function Page() {
      const { data } = useQuery<{ Ticket: never | null }, { Id: string }>(TicketPage, { Id: "t1" })
      return data?.Ticket ? <Row ticket={data.Ticket} /> : <span>loading</span>
    }
    render(
      <ClientProvider client={client}>
        <Page />
      </ClientProvider>
    )
    return { clock, network, streams, client, setServer: (next: typeof server) => void (server = next) }
  }
  const settled = (context: ReturnType<typeof setup>, ms = 100) => act(() => context.clock.tick(ms))
  const title = () => screen.getByTestId("title").textContent

  it("follows an event, recovers from a reload with what changed in the gap, and is not fooled by stale data", async () => {
    const context = setup()
    await settled(context)
    expect(title()).toBe("first")
    expect(context.network.failures).toEqual([])

    await act(async () => context.streams.one("LiveTicket").emit(ticket("second", 2)))
    expect(title()).toBe("second")

    context.setServer(page("changed during the gap", 3))
    await act(async () => context.streams.reload())
    expect(context.client.live!.status().Ticket).toMatchObject({ restarting: true, lastEnd: { reason: "reload" } })
    expect(title()).toBe("second")
    await settled(context, 1000)
    expect(title()).toBe("changed during the gap")
    expect(context.streams.find("LiveTicket")).toHaveLength(1)

    // An event that overtakes an older read stays.
    context.setServer(page("older", 1))
    await act(async () => context.streams.one("LiveTicket").emit(ticket("newest", 9)))
    await act(() => context.client.refetchActive())
    expect(title()).toBe("newest")
    context.client.dispose()
  })

  it("lets a test drive a reconnect the transport recovers from by itself", async () => {
    const context = setup()
    await settled(context)
    const reads = context.network.calls("TicketPage").length
    const stop = context.streams.onReconnect(() => void context.client.refetchActive())
    context.setServer(page("missed", 2))
    await act(async () => context.streams.reconnect())
    await settled(context)
    expect(context.network.calls("TicketPage")).toHaveLength(reads + 1)
    expect(title()).toBe("missed")
    stop()
    context.client.dispose()
  })
})
