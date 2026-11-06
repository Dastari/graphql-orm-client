import { seedManualHolds } from "./fixtures.js"
import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import type { LiveOptions } from "../src/live.js"
import { encodeNodeId } from "../src/node-id.js"
import { graphqlWsSubscribe, type GraphQLWsClientLike } from "../src/transport.js"
import { createTestClock } from "../src/test/index.js"
import { compiled, widget, catalog, frags, mockNetwork, mockSubscriptions, ops } from "./fixtures.js"

type CatalogData = { Widgets: { Edges: { Node: object }[] } }
type Stream = { sink: { next(r: unknown): void; error(e: unknown): void; complete(): void } }

const widgetId = (id: string) => encodeNodeId("Widget", [id])
const errors = (code: string) => [{ message: code, extensions: { code } }]
const event = (id: string, fields: Record<string, unknown> = {}) => ({
  data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: widget(id, fields) } },
})

function setup(live: Partial<LiveOptions> = {}, responder?: Parameters<typeof mockNetwork>[0]) {
  const time = createTestClock()
  const subscriptions = mockSubscriptions()
  const order: string[] = []
  let reads = 0
  let subscribes = 0
  const { network } = mockNetwork((request) => {
    reads += 1
    order.push(request.name)
    return responder ? responder(request) : { data: catalog([widget("d1")]) }
  })
  const client = createClient({
    network,
    live: {
      minRereadMs: 1, artifacts: compiled.live,
      settleMs: false,
      subscribe: (request, sink) => {
        subscribes += 1
        order.push(request.name)
        return subscriptions.subscribe(request, sink)
      },
      debounceMs: 0,
      ...time.live,
      ...live,
    },
    store: time.store,
  })
  return { client, live: client.live!, subscriptions, time, order, reads: () => reads, subscribes: () => subscribes }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function open(context: ReturnType<typeof setup>) {
  const list = context.client.watchQuery<CatalogData>(ops.CatalogPage, {})
  list.open()
  await list.refetch()
  context.live.flush()
  context.time.advance(0)
  context.order.length = 0
  return list
}

const liveWidget = (context: ReturnType<typeof setup>) => context.subscriptions.find("LiveWidget")[0]! as unknown as Stream
const name = (list: { getState(): { data?: CatalogData } }) =>
  readFragment<{ Name: string }>(frags.WidgetRow, list.getState().data!.Widgets.Edges[0]!.Node).Name

const ends: [string, string, string | null, (stream: Stream) => void][] = [
  ["a schema reload (error, then complete)", "reload", "SUBSCRIPTION_SCHEMA_RELOAD", (s) => (s.sink.error(errors("SUBSCRIPTION_SCHEMA_RELOAD")), s.sink.complete())],
  ["a schema reload in a frame", "reload", "SUBSCRIPTION_SCHEMA_RELOAD", (s) => (s.sink.next({ data: null, errors: errors("SUBSCRIPTION_SCHEMA_RELOAD") }), s.sink.complete())],
  ["lost continuity", "lost", "SUBSCRIPTION_CONTINUITY_LOST", (s) => (s.sink.next({ data: null, errors: errors("SUBSCRIPTION_CONTINUITY_LOST") }), s.sink.complete())],
  ["lost continuity on the error channel", "lost", "SUBSCRIPTION_SOURCE_CLOSED", (s) => s.sink.error(errors("SUBSCRIPTION_SOURCE_CLOSED"))],
  ["a retired connection", "unavailable", "SERVICE_UNAVAILABLE", (s) => s.sink.error(errors("SERVICE_UNAVAILABLE"))],
  ["a refusal", "refused", "INVALID_INPUT", (s) => s.sink.error(errors("INVALID_INPUT"))],
  ["a refusal in a frame", "refused", "INVALID_INPUT", (s) => (s.sink.next({ data: null, errors: errors("INVALID_INPUT") }), s.sink.complete())],
  ["errors after events", "errored", "INTERNAL", (s) => (s.sink.next(event("d1")), s.sink.error(errors("INTERNAL")))],
  ["a socket failure", "transport", null, (s) => s.sink.error(new Error("socket gone"))],
  ["a socket close event", "transport", null, (s) => s.sink.error({ code: 1006, reason: "", wasClean: false })],
  ["a plain complete", "completed", null, (s) => s.sink.complete()],
  ["a complete after events", "completed", null, (s) => (s.sink.next(event("d1")), s.sink.complete())],
]

describe("a stream that ends without the client asking", () => {
  for (const [label, reason, code, end] of ends) {
    it(`restarts and reads again after ${label}, and status says why`, async () => {
      const context = setup({ refusalBackoff: false })
      const list = await open(context)
      const { live, subscriptions, time } = context
      end(liveWidget(context))
      expect(subscriptions.find("LiveWidget")).toHaveLength(0)
      expect(live.status().Widget).toMatchObject({ held: 1, subscriptions: 0, restarting: true, restartAttempts: 1, lastEnd: { reason, code, at: time.now() } })
      expect(time.pending().every((timer) => timer.ms < 1000)).toBe(true)
      time.advance(1000)
      expect(subscriptions.find("LiveWidget")).toHaveLength(1)
      // Subscribe first, then read, so no change falls between the two.
      expect(context.order).toEqual(["LiveWidget", "CatalogPage"])
      await settle()
      expect(live.status().Widget).toMatchObject({ subscriptions: 1, restarting: false })
      list.close()
      context.client.dispose()
    })
  }

  it("shows a change missed during the gap (reconnect replay)", async () => {
    let current = "before"
    const context = setup({}, () => ({ data: catalog([widget("d1", { Name: current })]) }))
    const list = await open(context)
    expect(name(list)).toBe("before")
    liveWidget(context).sink.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
    current = "changed during the gap"
    context.time.advance(1000)
    await settle()
    expect(name(list)).toBe("changed during the gap")
    // The new stream delivers.
    liveWidget(context).sink.next(event("d1", { Name: "after" }))
    expect(name(list)).toBe("after")
    context.client.dispose()
  })

  it("restarts a type's streams together: one read when they all end at once", async () => {
    const context = setup({}, () => ({ data: catalog([widget("d1"), widget("d2"), widget("d3")]) }))
    await open(context)
    const before = context.reads()
    const streams = context.subscriptions.find("LiveWidget")
    expect(streams).toHaveLength(3)
    for (const stream of streams) (stream as unknown as Stream).sink.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
    expect(context.time.pending().length).toBe(1)
    context.time.advance(1000)
    await settle()
    expect(context.subscriptions.find("LiveWidget")).toHaveLength(3)
    expect(context.reads()).toBe(before + 1)
    context.client.dispose()
  })

  describe("back-off", () => {
    it("waits longer after each end in a row, up to the longest delay", async () => {
      const context = setup({ restart: { minMs: 1000, maxMs: 8000 } })
      await open(context)
      const seen: number[] = []
      for (let round = 0; round < 7; round += 1) {
        liveWidget(context).sink.error(errors("SERVICE_UNAVAILABLE"))
        seen.push(context.time.pending()[0]!.ms!)
        context.time.advance(8000)
      }
      expect(seen[0]).toBeLessThan(1000)
      for (const [index, top] of [1000, 2000, 4000, 8000, 8000, 8000].entries()) {
        expect(seen[index + 1]).toBeGreaterThanOrEqual(top / 2)
        expect(seen[index + 1]).toBeLessThanOrEqual(top)
      }
      context.client.dispose()
    })

    it("sends a bounded number of requests against a router that fails for an hour", async () => {
      const context = setup()
      await open(context)
      const reads = context.reads()
      for (let elapsed = 0; elapsed < 3_600_000; elapsed += 60_000) {
        for (const stream of context.subscriptions.find("LiveWidget")) (stream as unknown as Stream).sink.error(new Error("socket gone"))
        context.time.advance(60_000)
        await settle()
      }
      // At most one per minute once it has backed off, however it fails.
      expect(context.subscribes()).toBeLessThanOrEqual(125)
      expect(context.reads() - reads).toBeLessThanOrEqual(125)
      context.client.dispose()
    })

    it("isn't shortened by changes to the held records", async () => {
      const context = setup()
      await open(context)
      seedManualHolds(context.client)
      const { live, subscriptions } = context
      liveWidget(context).sink.error(new Error("socket gone"))
      const subscribes = context.subscribes()
      for (let round = 0; round < 10; round += 1) {
        live.hold(`other${round}`, new Map([["Widget", new Set([widgetId(`x${round}`), widgetId("d1")])]]))
        live.flush()
      }
      expect(context.subscribes()).toBe(subscribes)
      expect(subscriptions.find("LiveWidget")).toHaveLength(0)
      context.client.dispose()
    })

    it("starts from the shortest delay again once a stream has stayed open", async () => {
      const context = setup({ restart: { minMs: 1000, maxMs: 8000 } })
      await open(context)
      const { live, time } = context
      for (let round = 0; round < 3; round += 1) {
        liveWidget(context).sink.complete()
        time.advance(8000)
      }
      expect(live.status().Widget?.restartAttempts).toBe(3)
      time.advance(8000)
      expect(live.status().Widget?.restartAttempts).toBe(0)
      liveWidget(context).sink.complete()
      expect(time.pending()[0]!.ms).toBeLessThan(1000)
      context.client.dispose()
    })

    it("backs off a stream that fails beside others that stay open", async () => {
      const context = setup({ restart: { minMs: 1000, maxMs: 8000 } }, () => ({ data: catalog([widget("d1"), widget("d2")]) }))
      await open(context)
      const { subscriptions, time } = context
      time.advance(20_000)
      const failing = () => subscriptions.find("LiveWidget").find((entry) => entry.request.variables.Key === "d1")! as unknown as Stream
      const seen: number[] = []
      for (let round = 0; round < 4; round += 1) {
        failing().sink.error(new Error("socket gone"))
        seen.push(time.pending()[0]!.ms!)
        time.advance(8000)
      }
      expect(seen[3]).toBeGreaterThanOrEqual(2000)
      context.client.dispose()
    })
  })

  describe("refusalBackoff", () => {
    it("never takes a schema reload or a retired connection for a refusal", async () => {
      const context = setup({ refusalBackoff: true })
      await open(context)
      const { live, subscriptions, time } = context
      liveWidget(context).sink.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
      expect(live.status().Widget).toMatchObject({ backedOff: false, restarting: true })
      time.advance(1000)
      liveWidget(context).sink.error(errors("SERVICE_UNAVAILABLE"))
      expect(live.status().Widget).toMatchObject({ backedOff: false, restarting: true })
      time.advance(1000)
      expect(subscriptions.find("LiveWidget")).toHaveLength(1)
      context.client.dispose()
    })

    it("waits out the window for a refusal, then restarts and reads again", async () => {
      const context = setup({ refusalBackoff: true })
      await open(context)
      const { live, subscriptions, time } = context
      const reads = context.reads()
      liveWidget(context).sink.error(errors("INVALID_INPUT"))
      expect(live.status().Widget).toMatchObject({ backedOff: true, restarting: false, lastEnd: { reason: "refused" } })
      time.advance(4 * 60_000 - 1)
      expect(subscriptions.find("LiveWidget")).toHaveLength(0)
      expect(context.reads()).toBe(reads)
      time.advance(2 * 60_000 + 1)
      expect(subscriptions.find("LiveWidget")).toHaveLength(1)
      await settle()
      expect(context.reads()).toBe(reads + 1)
      context.client.dispose()
    })
  })

  describe("reads", () => {
    it("reads once more after a read already under way, whose answer may predate the gap", async () => {
      const answers: ((value: unknown) => void)[] = []
      let current = "first"
      const time = createTestClock()
      const subscriptions = mockSubscriptions()
      let reads = 0
      const client = createClient({
        network: {
          execute: () => {
            reads += 1
            const value = { data: catalog([widget("d1", { Name: current })]) }
            return new Promise((resolve) => answers.push(() => resolve(value)))
          },
        },
        live: {
          minRereadMs: 1, artifacts: compiled.live,
          settleMs: false,
          subscribe: subscriptions.subscribe,
          debounceMs: 0,
          ...time.live,
        },
      })
      const list = client.watchQuery<CatalogData>(ops.CatalogPage, {})
      list.open()
      answers.shift()!(null)
      await settle()
      client.live!.flush()
      time.advance(0)

      // A read leaves before the gap and its answer comes back after the restart.
      void list.refetch()
      expect(reads).toBe(2)
      subscriptions.find("LiveWidget")[0]!.sink.error(new Error("socket gone"))
      current = "changed during the gap"
      time.advance(1000)
      expect(reads).toBe(2)
      answers.shift()!(null)
      await settle()
      expect(reads).toBe(3)
      answers.shift()!(null)
      await settle()
      expect(name(list)).toBe("changed during the gap")
      client.dispose()
    })

    it("doesn't let a read's older version replace an event's newer one (version conflict)", async () => {
      const compiled = compile(
        buildSchema(`
          type Query { Ticket(Id: ID!): Ticket }
          type Subscription { TicketChanged(Keys: [ID!]): TicketChangedEvent! }
          enum ChangeAction { CREATED UPDATED DELETED }
          type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
          type Ticket { NodeId: ID!, Id: ID!, Title: String!, RecordVersion: Int! }
        `),
        [`fragment TicketTitle on Ticket @live { Title }`, `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`]
      )
      const nodeId = encodeNodeId("Ticket", ["t1"])
      const ticket = (Title: string, RecordVersion: number) => ({ __typename: "Ticket", NodeId: nodeId, Id: "t1", Title, RecordVersion })
      const time = createTestClock()
      const subscriptions = mockSubscriptions()
      const answers: (() => void)[] = []
      const client = createClient({
        network: {
          execute: () => new Promise((resolve) => answers.push(() => resolve({ data: { Ticket: ticket("old", 1) } }))),
        },
        live: {
          minRereadMs: 1, artifacts: compiled.live,
          settleMs: false,
          subscribe: subscriptions.subscribe,
          debounceMs: 0,
          ...time.live,
        },
      })
      const page = client.watchQuery<{ Ticket: object }>(compiled.operations.TicketPage!, { Id: "t1" })
      page.open()
      answers.shift()!()
      await settle()
      client.live!.flush()
      time.advance(0)
      subscriptions.find("LiveTicket")[0]!.sink.error(new Error("socket gone"))
      time.advance(1000)
      // The restarted stream delivers version 5 while the read, answered at version 1, is on its way back.
      subscriptions.find("LiveTicket")[0]!.sink.next({ data: { TicketChanged: { __typename: "TicketChangedEvent", Action: "UPDATED", Ticket: ticket("new", 5) } } })
      answers.shift()!()
      await settle()
      expect(readFragment<{ Title: string }>(compiled.fragments.TicketTitle!, page.getState().data!.Ticket).Title).toBe("new")
      client.dispose()
    })

    it("keeps the data on screen when the read fails, and reports the error", async () => {
      let up = true
      const context = setup({}, () => {
        if (!up) throw new Error("router down")
        return { data: catalog([widget("d1")]) }
      })
      const list = await open(context)
      up = false
      liveWidget(context).sink.error(new Error("socket gone"))
      context.time.advance(1000)
      await settle()
      expect(list.getState().status).toBe("error")
      expect(name(list)).toBe(widget("d1").Name)
      context.client.dispose()
    })
  })

  describe("identity disposal", () => {
    it("clears the waiting restart: nothing starts or reads afterwards", async () => {
      const context = setup()
      await open(context)
      const { client, subscriptions, time } = context
      liveWidget(context).sink.error(new Error("socket gone"))
      const reads = context.reads()
      const subscribes = context.subscribes()
      client.dispose()
      expect(time.pending().length).toBe(0)
      time.advance(3_600_000)
      await settle()
      expect(context.reads()).toBe(reads)
      expect(context.subscribes()).toBe(subscribes)
      expect(subscriptions.open.size).toBe(0)
    })

    it("ignores an end that arrives after disposal", async () => {
      const context = setup()
      await open(context)
      const stream = liveWidget(context)
      context.client.dispose()
      stream.sink.error(new Error("socket gone"))
      expect(context.time.pending().length).toBe(0)
    })

    it("starts nothing for the next identity from the last one's failures", async () => {
      const first = setup()
      await open(first)
      liveWidget(first).sink.error(new Error("socket gone"))
      first.client.dispose()
      const next = setup()
      await open(next)
      expect(next.live.status().Widget).toMatchObject({ subscriptions: 1, restarting: false, restartAttempts: 0, lastEnd: null })
      next.client.dispose()
    })
  })

  describe("garbage collection", () => {
    it("doesn't restart or read for a query closed during the wait, and its records can be collected", async () => {
      const context = setup()
      const list = await open(context)
      const { client, live, subscriptions, time } = context
      liveWidget(context).sink.error(new Error("socket gone"))
      const reads = context.reads()
      list.close()
      live.flush()
      time.advance(1000)
      await settle()
      expect(subscriptions.find("LiveWidget")).toHaveLength(0)
      expect(context.reads()).toBe(reads)
      expect(live.status().Widget).toMatchObject({ held: 0, restarting: false, restartAttempts: 0, lastEnd: null })
      time.advance(5 * 60_000)
      expect(client.store.get(widgetId("d1"))).toBeUndefined()
      client.dispose()
    })

    it("a stopped stream that reports its end later isn't an end to restart", async () => {
      const context = setup()
      const list = await open(context)
      const stream = liveWidget(context)
      list.close()
      context.live.flush()
      context.time.advance(0)
      stream.sink.error(new Error("closed by us"))
      expect(context.live.status().Widget).toMatchObject({ restarting: false, lastEnd: null })
      context.client.dispose()
    })
  })

  describe("restart: false", () => {
    it("is the 0.1.0-alpha.6 behaviour: the stream waits for the next change and nothing is read", async () => {
      const context = setup({ restart: false })
      await open(context)
      const { live, subscriptions, time } = context
      const reads = context.reads()
      liveWidget(context).sink.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
      expect(time.pending().length).toBe(0)
      time.advance(3_600_000)
      await settle()
      expect(subscriptions.find("LiveWidget")).toHaveLength(0)
      expect(context.reads()).toBe(reads)
      expect(live.status().Widget).toMatchObject({ restarting: false, lastEnd: { reason: "reload" } })
      live.hold("other", new Map([["Widget", new Set([widgetId("d1")])]]))
      live.flush()
      expect(subscriptions.find("LiveWidget")).toHaveLength(1)
      context.client.dispose()
    })

    it("still restarts lost events, at the same delay every time", async () => {
      const context = setup({ restart: false })
      await open(context)
      for (let round = 0; round < 4; round += 1) {
        liveWidget(context).sink.next({ data: null, errors: errors("SUBSCRIPTION_CONTINUITY_LOST") })
        expect(context.time.pending()[0]!.ms).toBeLessThan(1000)
        context.time.advance(1000)
      }
      expect(context.subscriptions.find("LiveWidget")).toHaveLength(1)
      context.client.dispose()
    })
  })
})

describe("graphqlWsSubscribe and a retired connection", () => {
  const task = () => new Promise((resolve) => setTimeout(resolve, 0))
  function fake(withTerminate = true) {
    const sinks: { next(value: unknown): void; error(error: unknown): void; complete(): void }[] = []
    let terminated = 0
    const ws: GraphQLWsClientLike = {
      subscribe: (_payload, sink) => (sinks.push(sink), () => {}),
      ...(withTerminate ? { terminate: () => void (terminated += 1) } : {}),
    }
    const sink = () => ({ next() {}, error() {}, complete() {} })
    const request = { kind: "subscription" as const, name: "LiveWidget", text: "", hash: "", variables: {} }
    return { sinks, subscribe: () => graphqlWsSubscribe(ws), sink, request, terminated: () => terminated }
  }

  for (const code of ["SUBSCRIPTION_SCHEMA_RELOAD", "SERVICE_UNAVAILABLE"]) {
    it(`opens a fresh connection once the last operation has ended after ${code}`, async () => {
      const { sinks, subscribe, sink, request, terminated } = fake()
      const transport = subscribe()
      transport(request, sink())
      transport(request, sink())
      sinks[0]!.error(errors(code))
      await task()
      expect(terminated()).toBe(0)
      sinks[1]!.error(errors(code))
      await task()
      expect(terminated()).toBe(1)
    })
  }

  it("waits a task, so graphql-ws finishes releasing the operation before the socket goes", async () => {
    const { sinks, subscribe, sink, request, terminated } = fake()
    subscribe()(request, sink())
    sinks[0]!.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
    // Not during the error callback, and not in the microtasks after it, where graphql-ws releases.
    expect(terminated()).toBe(0)
    await Promise.resolve()
    expect(terminated()).toBe(0)
    await task()
    expect(terminated()).toBe(1)
  })

  it("leaves the socket alone if an operation opens before the task runs", async () => {
    const { sinks, subscribe, sink, request, terminated } = fake()
    const transport = subscribe()
    transport(request, sink())
    sinks[0]!.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
    transport(request, sink())
    await task()
    expect(terminated()).toBe(0)
    // That operation answers from the retired connection in turn, and then it goes.
    sinks[1]!.error(errors("SERVICE_UNAVAILABLE"))
    await task()
    expect(terminated()).toBe(1)
  })

  it("terminates once, however many operations end in the same task", async () => {
    const { sinks, subscribe, sink, request, terminated } = fake()
    const transport = subscribe()
    transport(request, sink())
    transport(request, sink())
    sinks[0]!.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
    sinks[1]!.complete()
    await task()
    await task()
    expect(terminated()).toBe(1)
  })

  it("leaves the socket alone for any other end", async () => {
    const { sinks, subscribe, sink, request, terminated } = fake()
    const transport = subscribe()
    for (let index = 0; index < 3; index += 1) transport(request, sink())
    sinks[0]!.error(errors("INVALID_INPUT"))
    sinks[1]!.complete()
    sinks[2]!.error(new Error("socket gone"))
    await task()
    expect(terminated()).toBe(0)
  })

  it("works with a client that has no terminate", async () => {
    const { sinks, subscribe, sink, request } = fake(false)
    subscribe()(request, sink())
    sinks[0]!.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
    await expect(task()).resolves.toBeUndefined()
  })

  it("counts an operation the application stopped as ended", async () => {
    const { sinks, subscribe, sink, request, terminated } = fake()
    const transport = subscribe()
    const stop = transport(request, sink())
    transport(request, sink())
    sinks[1]!.error(errors("SUBSCRIPTION_SCHEMA_RELOAD"))
    await task()
    expect(terminated()).toBe(0)
    stop()
    stop()
    await task()
    expect(terminated()).toBe(1)
  })
})
