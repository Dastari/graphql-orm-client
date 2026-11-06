import { seedManualHolds } from "./fixtures.js"
import { describe, expect, it } from "vitest"
import { createClient, type GraphQLResponse } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"
import { compiled, mockNetwork, ops, ticket, ticketPage, widget, catalog } from "./fixtures.js"

const id = (key: string) => encodeNodeId("Ticket", [key])
function setup(settleMs?: number | false, maxKeys = 2, limit = Infinity) {
  const clock = createTestClock()
  const streams = createMockStreams()
  let rows = [ticket("b")]
  let response: (() => GraphQLResponse | Promise<GraphQLResponse>) | undefined
  const { network } = mockNetwork(() => response ? response() : { data: ticketPage(rows) })
  const client = createClient({ network, store: { ...clock.store, retainMs: 10 }, polling: clock.polling,
    live: { minRereadMs: 1, artifacts: { Ticket: compiled.live.Ticket! }, subscribe: (request, sink) => {
      if (streams.open.size >= limit) {
        sink.error([{ message: "connection full", extensions: { code: "SUBSCRIPTION_LIMIT_EXCEEDED" } }])
        return () => {}
      }
      return streams.subscribe(request, sink)
    }, ...clock.live,
      connection: { state: () => "connected", subscribe: (listener) => streams.onReconnect(() => listener({ reconnected: true })) },
      debounceMs: 0, resyncJitterMs: 0, maxKeys, settleMs, onDiagnostic: null } })
  seedManualHolds(client)
  const hold = (keys: string[], holder = "manual") => {
    client.live!.hold(holder, keys.length ? new Map([["Ticket", new Set(keys.map(id))]]) : new Map())
    client.live!.flush()
  }
  const open = async (variables = {}) => {
    const query = client.watchQuery(ops.TicketsPage, variables)
    query.open()
    await clock.tick()
    return query
  }
  return { clock, streams, client, hold, open, network, setRows: (next: typeof rows) => { rows = next },
    respond: (next: typeof response) => { response = next }, title: (key = "b") => client.store.get(id(key))?.fields.get("Title") }
}

describe("R4 overlap and confirming reads", () => {
  it("coalesces confirming reads across types and does not reread already streamed records", async () => {
    const clock = createTestClock()
    const streams = createMockStreams()
    const { network } = mockNetwork(() => ({ data: catalog([widget("b")]) }))
    const client = createClient({ network, polling: clock.polling, store: clock.store,
      live: { minRereadMs: 1, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, ...clock.live } })
    const query = client.watchQuery(ops.CatalogPage, {})
    query.open()
    await clock.tick(250)
    expect(streams.open.size).toBe(2)
    expect(network.requests).toHaveLength(2)
    const other = client.watchQuery(ops.CatalogPage, { Where: { Name: { Eq: "b" } } })
    other.open()
    await clock.tick(500)
    expect(network.requests).toHaveLength(3)
    client.dispose()
  })

  it("an unversioned duplicate snapshot does not notify twice", async () => {
    const clock = createTestClock()
    const streams = createMockStreams()
    const value = { __typename: "Slot", Site: "north", Name: "a", State: "free" }
    const { network } = mockNetwork(() => ({ data: { Slot: value } }))
    const client = createClient({ network, polling: clock.polling, store: clock.store,
      live: { minRereadMs: 1, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, ...clock.live } })
    const query = client.watchQuery(ops.SlotPage, { Site: "north", Name: "a" })
    query.open()
    await clock.tick(250)
    const old = streams.one("LiveSlot")
    seedManualHolds(client)
    client.live!.hold("extra", new Map([["Slot", new Set([encodeNodeId("Slot", ["north", "z"])])]]))
    client.live!.flush()
    const candidate = [...streams.open].find((stream) => stream !== old)!
    let notices = 0
    query.subscribe(() => { notices++ })
    old.emit({ ...value, State: "busy" })
    const afterFirst = notices
    candidate.emit({ ...value, State: "busy" })
    expect(notices).toBe(afterFirst)
    expect(client.store.get(encodeNodeId("Slot", ["north", "a"]))?.fields.get("State")).toBe("busy")
    client.dispose()
  })

  it("adds one key to one stable chunk, retaining the other chunks", async () => {
    const c = setup()
    c.hold(["b", "c", "d", "e", "f"])
    await c.clock.tick(250)
    const original = [...c.streams.open]
    c.hold(["a", "b", "c", "d", "e", "f"])
    expect(c.streams.started).toHaveLength(4)
    expect(original.every((stream) => !stream.closed)).toBe(true)
    await c.clock.tick(250)
    expect(original.filter((stream) => stream.closed)).toHaveLength(1)
    c.client.dispose()
  })

  it("writes during replacement, drops older versions, and confirms only once", async () => {
    const c = setup()
    await c.open()
    await c.clock.tick(250)
    const old = c.streams.one("LiveTicket")
    c.setRows([ticket("b"), ticket("a")])
    await c.client.refetchQueries("active")
    await c.clock.tick()
    expect(c.streams.open.size).toBe(2)
    old.emit(ticket("b", { Title: "overlap", RecordVersion: 5 }))
    const next = [...c.streams.open].find((stream) => stream !== old)!
    next.emit(ticket("b", { Title: "older", RecordVersion: 4 }))
    expect(c.title()).toBe("overlap")
    const reads = c.network.requests.length
    await c.clock.tick(250)
    expect(c.network.requests.length).toBe(reads + 1)
    expect(c.title()).toBe("overlap")
    expect(old.closed).toBe(true)
    c.client.dispose()
  })

  for (const failure of ["INVALID_INPUT", "SUBSCRIPTION_LIMIT_EXCEEDED", "complete"]) {
    it(`keeps old coverage when the candidate ends: ${failure}`, async () => {
      const c = setup()
      c.hold(["b"])
      await c.clock.tick(250)
      const old = c.streams.one("LiveTicket")
      c.hold(["a", "b"])
      const candidate = [...c.streams.open].find((stream) => stream !== old)!
      if (failure === "complete") candidate.end()
      else candidate.refuse(failure)
      await c.clock.tick(250)
      expect(old.closed).toBe(false)
      expect(c.client.live!.status().Ticket?.backedOff).toBe(failure === "INVALID_INPUT")
      expect(c.client.live!.status().Ticket?.lastEnd?.reason).toBe(failure === "INVALID_INPUT" ? "refused" : failure === "complete" ? "completed" : "unavailable")
      c.client.dispose()
      expect(c.clock.pending()).toHaveLength(0)
    })
  }

  it("retains 32 operations at the router limit, retries without a refusal window and exposes uncovered keys for polling", async () => {
    const c = setup(undefined, 2, 32)
    const keys = Array.from({ length: 63 }, (_, i) => String(i).padStart(3, "0"))
    c.hold(keys)
    await c.clock.tick(250)
    expect(c.streams.open.size).toBe(32)
    const baseline = [...c.streams.open]
    c.hold([...keys, "z"])
    await c.clock.tick()
    expect(c.streams.open.size).toBe(32)
    expect(baseline.every((stream) => !stream.closed)).toBe(true)
    expect(c.client.live!.status().Ticket?.backedOff).toBe(false)
    expect(c.client.live!.overflows("Ticket")).toBe(true)
    // Releasing a different chunk makes room; no five-minute wait is required.
    c.hold([...keys.slice(2), "z"])
    await c.clock.tick(1500)
    expect(c.client.live!.overflows("Ticket")).toBe(false)
    expect(c.client.live!.status().Ticket?.backedOff).toBe(false)
    c.client.dispose()
    expect(c.clock.pending()).toHaveLength(0)
  })

  it("a first subscribe past the router limit keeps the streams the router accepted", async () => {
    const c = setup(undefined, 2, 32)
    const keys = Array.from({ length: 70 }, (_, i) => String(i).padStart(3, "0"))
    c.hold(keys)
    expect(c.streams.open.size).toBe(32)
    const accepted = [...c.streams.open]
    await c.clock.tick(250)
    expect(accepted.every((stream) => !stream.closed)).toBe(true)
    expect(c.client.live!.status().Ticket?.backedOff).toBe(false)
    expect(c.client.live!.overflows("Ticket")).toBe(true)
    c.client.dispose()
  })

  it("one refused record in key mode leaves the other records' streams open", async () => {
    const clock = createTestClock()
    const streams = createMockStreams()
    const { network } = mockNetwork(() => ({ data: catalog([]) }))
    const client = createClient({ network, polling: clock.polling, store: clock.store,
      live: { minRereadMs: 1, artifacts: { Widget: compiled.live.Widget! }, subscribe: (request, sink) => {
        if (request.variables.Key === "refused") {
          sink.error([{ message: "no", extensions: { code: "INVALID_INPUT" } }])
          return () => {}
        }
        return streams.subscribe(request, sink)
      }, debounceMs: 0, ...clock.live, onDiagnostic: null } })
    seedManualHolds(client)
    client.live!.hold("manual", new Map([["Widget", new Set(["refused", "a", "b"].map((key) => encodeNodeId("Widget", [key])))]]))
    client.live!.flush()
    const opened = [...streams.open]
    expect(opened).toHaveLength(2)
    await clock.tick(250)
    expect(opened.every((stream) => !stream.closed)).toBe(true)
    client.dispose()
  })

  it("a partly failed replacement keeps the candidate that opened", async () => {
    const c = setup(undefined, 2, 2)
    c.hold(["a", "b"])
    await c.clock.tick(250)
    const [old] = [...c.streams.open]
    c.hold(["a", "b", "c", "d", "e"])
    // Chunk a,b is unchanged and one more chunk fits; the third is over the limit.
    expect(c.streams.open.size).toBe(2)
    const candidate = [...c.streams.open].find((stream) => stream !== old)!
    await c.clock.tick(250)
    expect(old!.closed).toBe(false)
    expect(candidate.closed).toBe(false)
    expect(c.client.live!.overflows("Ticket")).toBe(true)
    c.client.dispose()
  })

  it("a stream being replaced stays until a wanted stream covers what it holds", async () => {
    const c = setup(undefined, 3, 1)
    c.hold(["a", "b"])
    await c.clock.tick(250)
    const old = c.streams.one("LiveTicket")
    c.hold(["a", "b", "c"])
    await c.clock.tick(250)
    expect(old.closed).toBe(false)
    expect(c.streams.open.size).toBe(1)
    expect(c.client.live!.overflows("Ticket")).toBe(true)
    c.client.dispose()
  })

  it("bounds rapid replacements to a baseline and a candidate", async () => {
    const c = setup()
    c.hold(["b"])
    await c.clock.tick(250)
    for (let i = 0; i < 30; i++) c.hold(["b", String(i)])
    expect(c.streams.open.size).toBeLessThanOrEqual(2)
    await c.clock.tick(500)
    expect(c.streams.open.size).toBe(1)
    expect([...c.streams.open][0]!.variables.Keys).toEqual(["29", "b"])
    c.client.dispose()
  })

  it("read, subscribe, confirming read recovers a write during the first read", async () => {
    const c = setup()
    c.respond(() => {
      const data = ticketPage([ticket("b")])
      // The read has taken its snapshot, but no subscription exists yet.
      expect(c.streams.open.size).toBe(0)
      c.setRows([ticket("b", { Title: "changed before subscribe", RecordVersion: 2 })])
      c.respond(undefined)
      return { data }
    })
    const query = await c.open()
    expect(c.network.requests).toHaveLength(1)
    expect(c.streams.open.size).toBe(1)
    c.setRows([ticket("b", { Title: "changed before subscribe", RecordVersion: 2 })])
    await c.clock.tick(249)
    expect(c.network.requests).toHaveLength(1)
    await c.clock.tick(1)
    expect(c.network.requests).toHaveLength(2)
    expect(c.title()).toBe("changed before subscribe")
    await query.refetch()
    await c.clock.tick(500)
    expect(c.network.requests).toHaveLength(3)
    c.client.dispose()
  })

  it("settleMs false restores the previous first-load request count", async () => {
    const c = setup(false)
    await c.open()
    await c.clock.tick(1000)
    expect(c.network.requests).toHaveLength(1)
    c.client.dispose()
  })

  it("only re-reads queries holding newly streamed records", async () => {
    const c = setup(undefined, 2)
    await c.open()
    await c.clock.tick(250)
    c.setRows([ticket("z")])
    await c.open({ Where: { State: { Eq: "closed" } } })
    const reads = c.network.requests.length
    await c.clock.tick(250)
    expect(c.network.requests.length).toBe(reads + 1)
    expect(c.network.requests.at(-1)?.variables).toMatchObject({ Where: { State: { Eq: "closed" } } })
    c.client.dispose()
  })

  it("an event during a read and reconnects schedule one more read and preserve its newer version", async () => {
    const c = setup()
    const query = await c.open()
    await c.clock.tick(250)
    let finish!: (result: GraphQLResponse) => void
    c.respond(() => new Promise((resolve) => { finish = resolve }))
    const fetching = query.refetch()
    await c.clock.tick()
    c.streams.one("LiveTicket").emit(ticket("b", { Title: "new event", RecordVersion: 9 }))
    c.streams.reconnect()
    c.streams.reconnect()
    c.respond(undefined)
    const reads = c.network.requests.length
    finish({ data: ticketPage([ticket("b", { Title: "stale", RecordVersion: 2 })]) })
    await fetching
    await c.clock.tick(1)
    expect(c.network.requests.length).toBe(reads + 1)
    expect(c.title()).toBe("new event")
    c.client.dispose()
  })

  it("releasing the last holder closes overlapping streams and collects records", async () => {
    const c = setup()
    const query = await c.open()
    await c.clock.tick(250)
    c.setRows([ticket("a"), ticket("b")])
    await query.refetch()
    await c.clock.tick()
    expect(c.streams.open.size).toBe(2)
    query.close()
    await c.clock.tick(20)
    expect(c.streams.open.size).toBe(0)
    expect(c.title()).toBeUndefined()
    c.client.dispose()
    expect(c.clock.pending()).toHaveLength(0)
  })

  it("disposal cancels overlap and confirmation timers and rejects late events", async () => {
    const c = setup()
    await c.open()
    const stream = c.streams.one("LiveTicket")
    c.client.dispose()
    stream.sink.next({ data: { TicketChanged: { Action: "UPDATED", Ticket: ticket("b") } } })
    await c.clock.tick(1000)
    expect(c.title()).toBeUndefined()
    expect(c.streams.open.size).toBe(0)
    expect(c.clock.pending()).toHaveLength(0)
    const next = setup()
    await next.open()
    expect(next.title()).toBe("ticket-b")
    next.client.dispose()
  })
})
