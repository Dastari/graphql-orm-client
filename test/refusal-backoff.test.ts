import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient, type Client } from "../src/client.js"
import type { LiveOptions } from "../src/live.js"
import { encodeNodeId } from "../src/node-id.js"
import { compiled, widget, mockNetwork, mockSubscriptions } from "./fixtures.js"

const WINDOW = 5 * 60_000
const widgetId = (id: string) => encodeNodeId("Widget", [id])
const refusal = [{ message: "subscription refused", extensions: { code: "SUBSCRIPTION_NOT_ALLOWED" } }]
const lost = { data: null, errors: [{ message: "lost", extensions: { code: "SUBSCRIPTION_CONTINUITY_LOST" } }] }

/** A clock the test drives: timers are recorded with their delay and fired by hand. */
function clock() {
  const timers = new Map<number, { callback: () => void; ms: number }>()
  const cleared: number[] = []
  let next = 0
  return {
    timers,
    cleared,
    setTimeout: (callback: () => void, ms: number) => (timers.set(++next, { callback, ms }), next),
    clearTimeout: (handle: unknown) => {
      cleared.push(handle as number)
      timers.delete(handle as number)
    },
    /** Timers that wait for a back-off window (the debounce is 0 ms and the jitter is below 1 s). */
    windows: () => [...timers.values()].filter((timer) => timer.ms >= 1000),
    /** Fire the timers a delay stands for, as the passage of that time would. */
    fire(ms: number) {
      for (const [handle, timer] of [...timers]) {
        if (timer.ms !== ms) continue
        timers.delete(handle)
        timer.callback()
      }
    },
    /** Fire the resync timers (random delay below the 1 s jitter). */
    fireResync() {
      for (const [handle, timer] of [...timers]) {
        if (timer.ms >= 1000) continue
        timers.delete(handle)
        timer.callback()
      }
    },
  }
}

function setup(live: Partial<LiveOptions> = {}) {
  const subscriptions = mockSubscriptions()
  const time = clock()
  let sent = 0
  const subscribe: LiveOptions["subscribe"] = (request, sink) => {
    sent += 1
    return subscriptions.subscribe(request, sink)
  }
  const { network } = mockNetwork(() => ({ data: { Widgets: { __typename: "WidgetConnection", Edges: [], PageInfo: null } } }))
  const options: LiveOptions = {
    artifacts: compiled.live,
    subscribe,
    debounceMs: 0,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    ...live,
  }
  const client = createClient({ network, live: options })
  return { client, live: client.live!, subscriptions, time, sent: () => sent, subscribe, network }
}

const hold = (client: Client, ids: readonly string[], holder = "q") =>
  client.live!.hold(holder, new Map([["Widget", new Set(ids.map(widgetId))]]))

/** Hold records, apply it, and refuse the streams that start. */
function refuseAll(subscriptions: ReturnType<typeof mockSubscriptions>, name = "LiveWidget") {
  for (const entry of subscriptions.find(name)) entry.sink.error(refusal)
}

describe("refused-stream back-off", () => {
  it("sends one subscribe per window however often the held records change", () => {
    const { client, live, subscriptions, time, sent } = setup({ refusalBackoff: true })
    hold(client, ["d1"])
    live.flush()
    expect(sent()).toBe(1)
    refuseAll(subscriptions)
    expect(subscriptions.find("LiveWidget")).toHaveLength(0)
    expect(time.windows().map((timer) => timer.ms)).toEqual([WINDOW])

    // Refreshes: the same records again, then others, then none and back.
    for (let round = 0; round < 5; round += 1) {
      hold(client, ["d1"], `q${round}`)
      live.flush()
    }
    hold(client, [])
    live.flush()
    hold(client, ["d1"])
    live.flush()
    expect(sent()).toBe(1)
    expect(live.status().Widget).toMatchObject({ subscriptions: 0, backedOff: true })

    // The window ends: one more subscribe, refused again, and another window starts.
    time.fire(WINDOW)
    expect(sent()).toBe(2)
    refuseAll(subscriptions)
    hold(client, ["d1"], "again")
    live.flush()
    expect(sent()).toBe(2)
    expect(time.windows().map((timer) => timer.ms)).toEqual([WINDOW])
    client.dispose()
  })

  it("recovers by itself once the router admits the stream, and delivers its events", () => {
    const { client, live, subscriptions, time, sent } = setup({ refusalBackoff: true })
    hold(client, ["d1"])
    live.flush()
    refuseAll(subscriptions)
    time.fire(WINDOW)
    // No trigger, no flush: the retry happened on its own, and this time it is admitted.
    expect(sent()).toBe(2)
    const stream = subscriptions.find("LiveWidget")
    expect(stream).toHaveLength(1)
    expect(live.status().Widget).toMatchObject({ subscriptions: 1, backedOff: false })
    expect(time.windows()).toHaveLength(0)

    stream[0]!.sink.next({
      data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: widget("d1", { Name: "after" }) } },
    })
    expect(client.store.get(widgetId("d1"))?.fields.get("Name")).toBe("after")
    // Later changes don't send another subscribe: the stream is open.
    hold(client, ["d1"], "other")
    live.flush()
    expect(sent()).toBe(2)
    client.dispose()
  })

  it("does not retry at the end of a window nothing holds the records for", () => {
    const { client, live, subscriptions, time, sent } = setup({ refusalBackoff: true })
    hold(client, ["d1"])
    live.flush()
    refuseAll(subscriptions)
    hold(client, [])
    live.flush()
    time.fire(WINDOW)
    expect(sent()).toBe(1)
    // The memory is gone with the window: holding the record again subscribes at once.
    hold(client, ["d1"])
    live.flush()
    expect(sent()).toBe(2)
    client.dispose()
  })

  it("restarts at once after a continuity-lost close, with the option on, and never remembers it", () => {
    const { client, live, subscriptions, time, sent } = setup({ refusalBackoff: true })
    hold(client, ["d1"])
    live.flush()
    expect(sent()).toBe(1)
    for (let round = 0; round < 3; round += 1) {
      const stream = subscriptions.find("LiveWidget")[0]!
      stream.sink.next(lost)
      stream.sink.complete()
      expect(time.windows()).toHaveLength(0)
      time.fireResync()
      expect(subscriptions.find("LiveWidget")).toHaveLength(1)
    }
    expect(sent()).toBe(4)
    // SUBSCRIPTION_SOURCE_CLOSED is the same.
    const stream = subscriptions.find("LiveWidget")[0]!
    stream.sink.next({ data: null, errors: [{ message: "closed", extensions: { code: "SUBSCRIPTION_SOURCE_CLOSED" } }] })
    stream.sink.complete()
    time.fireResync()
    expect(sent()).toBe(5)
    expect(live.status().Widget?.backedOff).toBe(false)
    client.dispose()
  })

  it("is off by default: a refused stream starts again on every change", () => {
    const { client, live, subscriptions, time, sent } = setup()
    hold(client, ["d1"])
    live.flush()
    for (let round = 0; round < 4; round += 1) {
      refuseAll(subscriptions)
      hold(client, ["d1"], `q${round}`)
      live.flush()
    }
    expect(sent()).toBe(5)
    expect(time.windows()).toHaveLength(0)
    expect(live.status().Widget?.backedOff).toBe(false)
    client.dispose()
  })

  it("keeps immediate retry for a type opted out, while others back off", () => {
    const { client, live, subscriptions, time, sent } = setup({ refusalBackoff: { ms: WINDOW, types: { Widget: false } } })
    live.hold("q", new Map([["Widget", new Set([widgetId("d1")])], ["Vendor", new Set([encodeNodeId("Vendor", ["acme"])])]]))
    live.flush()
    expect(sent()).toBe(2)
    refuseAll(subscriptions, "LiveWidget")
    refuseAll(subscriptions, "LiveVendor")
    live.hold("q", new Map([["Widget", new Set([widgetId("d1")])], ["Vendor", new Set([encodeNodeId("Vendor", ["acme"])])]]))
    live.flush()
    // Widget started again at once; Vendor waits.
    expect(subscriptions.find("LiveWidget")).toHaveLength(1)
    expect(subscriptions.find("LiveVendor")).toHaveLength(0)
    expect(sent()).toBe(3)
    expect(live.status().Widget?.backedOff).toBe(false)
    expect(live.status().Vendor?.backedOff).toBe(true)
    expect(time.windows().map((timer) => timer.ms)).toEqual([WINDOW])
    client.dispose()
  })

  it("applies a type's own window, and a window for one type alone when there is no default", () => {
    const { client, live, subscriptions, time } = setup({ refusalBackoff: { types: { Widget: 1234_000 } } })
    live.hold("q", new Map([["Widget", new Set([widgetId("d1")])], ["Vendor", new Set([encodeNodeId("Vendor", ["acme"])])]]))
    live.flush()
    refuseAll(subscriptions, "LiveWidget")
    refuseAll(subscriptions, "LiveVendor")
    expect(time.windows().map((timer) => timer.ms)).toEqual([1234_000])
    live.flush()
    expect(subscriptions.find("LiveVendor")).toHaveLength(1)
    client.dispose()
  })

  it("remembers a refusal per record in key mode, so one refused record doesn't hold back another", () => {
    const { client, live, subscriptions, sent } = setup({ refusalBackoff: true })
    hold(client, ["d1", "d2"])
    live.flush()
    subscriptions.find("LiveWidget").find((entry) => entry.request.variables.Key === "d1")!.sink.error(refusal)
    hold(client, ["d1", "d2", "d3"])
    live.flush()
    expect(subscriptions.find("LiveWidget").map((entry) => entry.request.variables.Key).sort()).toEqual(["d2", "d3"])
    expect(sent()).toBe(3)
    client.dispose()
  })

  it("remembers a refusal per type in keys mode, whatever records are held", () => {
    const { client, live, subscriptions, sent } = setup({ refusalBackoff: true })
    const slot = (name: string) => encodeNodeId("Slot", ["site", name])
    live.hold("q", new Map([["Slot", new Set([slot("a")])]]))
    live.flush()
    expect(sent()).toBe(1)
    subscriptions.find("LiveSlot")[0]!.sink.error(refusal)
    // A list refresh holds other keys: a different stream signature, the same refused stream.
    live.hold("q", new Map([["Slot", new Set([slot("a"), slot("b")])]]))
    live.flush()
    live.hold("q", new Map([["Slot", new Set([slot("c")])]]))
    live.flush()
    expect(sent()).toBe(1)
    client.dispose()
  })

  describe("what counts as a refusal", () => {
    const refusals: [string, (stream: { sink: { next(r: any): void; error(e: unknown): void; complete(): void } }) => void][] = [
      ["an error message with GraphQL errors, before any event", (stream) => stream.sink.error(refusal)],
      ["an object carrying GraphQL errors, before any event", (stream) => stream.sink.error({ errors: refusal })],
      [
        "an error-only frame followed by the end of the stream",
        (stream) => {
          stream.sink.next({ data: null, errors: refusal })
          stream.sink.complete()
        },
      ],
    ]
    for (const [name, refuse] of refusals) {
      it(`counts ${name}`, () => {
        const { client, live, subscriptions, sent } = setup({ refusalBackoff: true })
        hold(client, ["d1"])
        live.flush()
        refuse(subscriptions.find("LiveWidget")[0]! as never)
        hold(client, ["d1"], "again")
        live.flush()
        expect(sent()).toBe(1)
        client.dispose()
      })
    }

    const others: [string, (stream: { sink: { next(r: any): void; error(e: unknown): void; complete(): void } }) => void][] = [
      ["a transport failure (an Error)", (stream) => stream.sink.error(new Error("socket gone"))],
      ["a socket close event", (stream) => stream.sink.error({ code: 4500, reason: "internal", wasClean: false })],
      ["a plain end of the stream with no frames", (stream) => stream.sink.complete()],
      [
        "an end after events were delivered",
        (stream) => {
          stream.sink.next({ data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: widget("d1") } } })
          stream.sink.next({ data: null, errors: refusal })
          stream.sink.complete()
        },
      ],
      [
        "GraphQL errors after events were delivered",
        (stream) => {
          stream.sink.next({ data: { WidgetChanged: { __typename: "WidgetChangedEvent", Action: "UPDATED", Widget: widget("d1") } } })
          stream.sink.error(refusal)
        },
      ],
      ["a continuity code on the error channel", (stream) => stream.sink.error([{ message: "lost", extensions: { code: "SUBSCRIPTION_CONTINUITY_LOST" } }])],
    ]
    for (const [name, end] of others) {
      it(`does not count ${name}: the stream starts again on the next change`, () => {
        const { client, live, subscriptions, time, sent } = setup({ refusalBackoff: true })
        hold(client, ["d1"])
        live.flush()
        end(subscriptions.find("LiveWidget")[0]! as never)
        expect(time.windows()).toHaveLength(0)
        hold(client, ["d1"], "again")
        live.flush()
        expect(sent()).toBe(2)
        expect(live.status().Widget?.backedOff).toBe(false)
        client.dispose()
      })
    }
  })

  describe("with the default timers", () => {
    afterEach(() => vi.useRealTimers())

    it("waits five minutes of fake time, then subscribes again by itself", async () => {
      vi.useFakeTimers()
      const subscriptions = mockSubscriptions()
      let sent = 0
      const { network } = mockNetwork(() => ({ data: {} }))
      const client = createClient({
        network,
        live: {
          artifacts: compiled.live,
          subscribe: (request, sink) => (sent++, subscriptions.subscribe(request, sink)),
          debounceMs: 0,
          refusalBackoff: true,
        },
      })
      hold(client, ["d1"])
      await vi.advanceTimersByTimeAsync(1)
      expect(sent).toBe(1)
      refuseAll(subscriptions)
      for (let minute = 0; minute < 4; minute += 1) {
        hold(client, ["d1"], `q${minute}`)
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(sent).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sent).toBe(2)
      client.dispose()
    })
  })

  describe("identity disposal", () => {
    it("clears refusal memory and its timers with the client", () => {
      const { client, live, subscriptions, time, subscribe, network } = setup({ refusalBackoff: true })
      hold(client, ["d1"])
      live.flush()
      refuseAll(subscriptions)
      const [handle] = [...time.timers].find(([, timer]) => timer.ms === WINDOW)!
      client.dispose()
      expect(time.cleared).toContain(handle)
      expect(time.windows()).toHaveLength(0)

      // The next identity gets a client of its own over the same transport and holds the same record:
      // nothing refused for the outgoing identity holds it back.
      let sent = 0
      const next = createClient({
        network,
        live: {
          artifacts: compiled.live,
          subscribe: (request, sink) => (sent++, subscribe(request, sink)),
          debounceMs: 0,
          setTimeout: time.setTimeout,
          clearTimeout: time.clearTimeout,
          refusalBackoff: true,
        },
      })
      hold(next, ["d1"])
      next.live!.flush()
      expect(sent).toBe(1)
      next.dispose()
    })

    it("ignores a refusal that arrives after disposal, and a window that ends after it", () => {
      const { client, live, subscriptions, time, sent } = setup({ refusalBackoff: true })
      hold(client, ["d1", "d2"])
      live.flush()
      const [first, second] = subscriptions.find("LiveWidget")
      first!.sink.error(refusal)
      const pending = [...time.timers.values()].find((timer) => timer.ms === WINDOW)!
      client.dispose()
      second!.sink.error(refusal)
      expect(time.windows()).toHaveLength(0)
      pending.callback()
      expect(sent()).toBe(2)
      expect(subscriptions.open.size).toBe(0)
    })
  })
})
