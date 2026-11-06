import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import type { LiveOptions } from "../src/live.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  type Query { Ticket(Id: ID!): Ticket }
  type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
  enum ChangeAction { CREATED UPDATED DELETED }
  type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
  type Ticket { Id: ID!, Title: String!, RecordVersion: Int! }
`)
const compiled = compile(schema, [`fragment TicketTitle on Ticket @live { Title }`, `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`], { liveSelection: "as-written" })
const TicketPage = compiled.operations.TicketPage!
const nodeId = encodeNodeId("Ticket", ["t1"])
const FIVE_MINUTES = 5 * 60_000

function setup(options: { live?: Partial<LiveOptions>; liveFallbackMs?: number | null } = {}) {
  const clock = createTestClock()
  let title = "first"
  let version = 1
  const network = createMockNetwork({ schema, operations: { TicketPage: () => ({ data: { Ticket: { __typename: "Ticket", Id: "t1", Title: title, RecordVersion: version } } }) } })
  const streams = createMockStreams({ schema })
  const client = createClient({
    network,
    store: clock.store,
    polling: { ...clock.polling, isActive: () => true, ...(options.liveFallbackMs === undefined ? {} : { liveFallbackMs: options.liveFallbackMs }) },
    live: { artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, onDiagnostic: null, ...clock.live, ...options.live },
  })
  const query = client.watchQuery(TicketPage, { Id: "t1" })
  query.open()
  return {
    client,
    clock,
    network,
    streams,
    query,
    reads: () => network.calls("TicketPage").length,
    change: (next: string) => {
      title = next
      version += 1
    },
    title: () => client.store.get(nodeId)?.fields.get("Title"),
  }
}

describe("a refused stream, with no configuration", () => {
  it("sends a bounded number of subscribes per hour, however often its lists refetch", async () => {
    const context = setup()
    await context.clock.tick(1)
    for (let elapsed = 0; elapsed < 3_600_000; elapsed += 10_000) {
      for (const stream of context.streams.find("LiveTicket")) stream.refuse("INVALID_INPUT")
      void context.query.refetch()
      await context.clock.tick(10_000)
    }
    // Windows are at least four minutes.
    expect(context.streams.started.length).toBeLessThanOrEqual(16)
    expect(context.streams.started.length).toBeGreaterThanOrEqual(10)
    context.client.dispose()
  }, 30_000)

  it("still refreshes its records, by polling while it waits", async () => {
    const context = setup()
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    await context.clock.tick()
    expect(context.client.liveTypeHealth("Ticket")).toMatchObject({ state: "polling", reason: "selection-refused", pollMs: 30_000 })
    context.change("changed while refused")
    await context.clock.tick(30_000)
    expect(context.title()).toBe("changed while refused")
    context.client.dispose()
  })

  it("starts working with no reload once the server accepts it: the poll stops and it reads what it missed", async () => {
    const context = setup()
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    await context.clock.tick(6 * 60_000)
    const stream = context.streams.one("LiveTicket")
    expect(context.client.liveTypeHealth("Ticket")).toMatchObject({ state: "unconfirmed", pollMs: null, retryAt: null })
    const reads = context.reads()
    await context.clock.tick(5 * 60_000)
    expect(context.reads()).toBe(reads)
    stream.emit({ __typename: "Ticket", Id: "t1", Title: "accepted", RecordVersion: 99 })
    expect(context.title()).toBe("accepted")
    expect(context.client.liveTypeHealth("Ticket").state).toBe("live")
    context.client.dispose()
  })

  it("reads when the window ends, even with the poll off", async () => {
    const context = setup({ liveFallbackMs: null })
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    await context.clock.tick()
    expect(context.client.liveTypeHealth("Ticket")).toMatchObject({ state: "refused", pollMs: null })
    context.change("after the window")
    await context.clock.tick(6 * 60_000)
    expect(context.title()).toBe("after the window")
    context.client.dispose()
  })

  it("spreads windows by 20% either way", async () => {
    const seen = new Set<number>()
    for (let round = 0; round < 20; round += 1) {
      const context = setup({ liveFallbackMs: null })
      await context.clock.tick(1)
      context.streams.one("LiveTicket").refuse("INVALID_INPUT")
      const window = context.clock.pending().find((timer) => timer.ms > 60_000)!.ms
      expect(window).toBeGreaterThanOrEqual(FIVE_MINUTES * 0.8)
      expect(window).toBeLessThanOrEqual(FIVE_MINUTES * 1.2)
      seen.add(window)
      context.client.dispose()
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  for (const code of ["SUBSCRIPTION_SCHEMA_RELOAD", "SERVICE_UNAVAILABLE", "SUBGRAPH_UNAVAILABLE"]) {
    it(`takes ${code} for an outage, not a refusal`, async () => {
      const context = setup()
      await context.clock.tick(1)
      context.streams.one("LiveTicket").refuse(code)
      expect(context.client.live!.status().Ticket).toMatchObject({ backedOff: false, restarting: true })
      await context.clock.tick(1000)
      expect(context.streams.find("LiveTicket")).toHaveLength(1)
      context.client.dispose()
    })
  }

  it("stops polling when the query closes during a window, and starts nothing afterwards (garbage collection)", async () => {
    const context = setup()
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    await context.clock.tick()
    context.query.close()
    await context.clock.tick()
    const reads = context.reads()
    await context.clock.tick(FIVE_MINUTES * 2)
    expect(context.reads()).toBe(reads)
    expect(context.streams.find("LiveTicket")).toHaveLength(0)
    context.clock.advance(FIVE_MINUTES)
    expect(context.client.store.get(nodeId)).toBeUndefined()
    context.client.dispose()
  })

  it("clears the window and the poll with the identity", async () => {
    const context = setup()
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    await context.clock.tick()
    const reads = context.reads()
    context.client.dispose()
    await context.clock.tick(FIVE_MINUTES * 2)
    expect(context.reads()).toBe(reads)
    expect(context.streams.open.size).toBe(0)
  })

  it("keeps a newer event when a poll answers older (version conflict and ordering)", async () => {
    const context = setup()
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    await context.clock.tick(6 * 60_000)
    context.streams.one("LiveTicket").emit({ __typename: "Ticket", Id: "t1", Title: "event", RecordVersion: 50 })
    await context.query.refetch()
    expect(context.title()).toBe("event")
    context.client.dispose()
  })

  it("reads what a window missed (reconnect replay)", async () => {
    const context = setup()
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    await context.clock.tick()
    context.change("missed")
    await context.clock.tick(6 * 60_000)
    expect(context.title()).toBe("missed")
    context.client.dispose()
  })
})

describe("refusalBackoff: false", () => {
  it("is the 0.1.0-alpha.8 behaviour: the ordinary back-off, no window and no poll", async () => {
    const context = setup({ live: { refusalBackoff: false } })
    await context.clock.tick(1)
    context.streams.one("LiveTicket").refuse("INVALID_INPUT")
    expect(context.client.live!.status().Ticket).toMatchObject({ backedOff: false, restarting: true })
    expect(context.client.liveTypeHealth("Ticket").pollMs).toBeNull()
    await context.clock.tick(1000)
    expect(context.streams.find("LiveTicket")).toHaveLength(1)
    context.client.dispose()
  })
})
