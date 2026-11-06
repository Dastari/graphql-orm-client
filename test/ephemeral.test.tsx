// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { buildSchema } from "graphql"
import { createClient } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import type { OperationArtifact } from "../src/artifact.js"
import { useEphemeralStream } from "../src/react/index.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`type Query { ok: Boolean } type Subscription { output(after: Int): Output! } type Output { seq: Int!, text: String! }`)
type Item = { seq: number; text: string }
const artifact = compile(schema, [`subscription Output($after: Int) { output(after: $after) { seq text } }`]).operations.Output! as OperationArtifact<{ output: Item }, { after?: number }>
function setup() {
  const clock = createTestClock()
  const streams = createMockStreams({ schema })
  const client = createClient({ network: createMockNetwork(), live: { ...clock.live, subscribe: streams.subscribe, connection: { state: () => "connected", subscribe: (fn) => streams.onReconnect(() => fn({ reconnected: true })) }, restart: { minMs: 10, maxMs: 100 } } })
  const sequence = { value: (item: Item) => item.seq, after: 0, cursor: (item: Item) => item.seq, resume: (_: { after?: number }, after: number) => ({ after }) }
  const stream = client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 1200, sequence })
  const emit = (seq: number) => streams.one("Output").next({ data: { output: { seq, text: String(seq) } } })
  return { client, stream, streams, clock, emit, sequence }
}
afterEach(cleanup)
it("coalesces React renders and replays 1000 items across a socket reconnect without duplicates or omissions", () => {
  const { client, stream, streams, clock, emit } = setup()
  let renders = 0
  function View() { renders++; const state = useEphemeralStream(stream); return <span>{state.items.length}</span> }
  const view = render(<View />)
  stream.open()
  act(() => { for (let n = 1; n <= 500; n++) emit(n); clock.advance(16) })
  const stale = streams.one("Output").sink
  act(() => { streams.reconnect(); clock.advance(100) })
  expect(streams.one("Output").variables).toEqual({ after: 500 })
  act(() => {
    stale.next({ data: { output: { seq: 9999, text: "old socket" } } })
    for (let n = 490; n <= 1000; n++) emit(n)
    clock.advance(16)
  })
  expect(stream.getState().items.map((item) => item.seq)).toEqual(Array.from({ length: 1000 }, (_, n) => n + 1))
  expect(stream.getState().gap).toBeNull()
  expect(renders).toBeLessThan(10)
  expect(view.container.textContent).toBe("1000")
  expect(client.store.size).toBe(0)
  client.dispose()
  expect(clock.pending()).toHaveLength(0)
})
it("reports a declared gap when a service cannot replay", () => {
  const { client, streams, clock, sequence } = setup()
  const stream = client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 10, sequence: { value: sequence.value, after: 0 } })
  stream.open()
  streams.one("Output").next({ data: { output: { seq: 1, text: "a" } } })
  streams.reconnect(); clock.advance(100)
  streams.one("Output").next({ data: { output: { seq: 4, text: "d" } } })
  clock.advance(16)
  expect(stream.getState()).toMatchObject({ status: "open", continuity: "gap", gap: { expected: 2, received: 4 } })
  client.dispose()
})
it("reports unprovable continuity without sequence and never deduplicates by guessing", () => {
  const { client, streams, clock } = setup()
  const stream = client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 10 })
  stream.open()
  for (let n = 0; n < 2; n++) streams.one("Output").next({ data: { output: { seq: 1, text: "a" } } })
  clock.advance(16)
  expect(stream.getState()).toMatchObject({ continuity: "unprovable", items: [{ seq: 1, text: "a" }, { seq: 1, text: "a" }] })
  client.dispose()
})
it("counts buffer overflow without confusing eviction with a transport gap", () => {
  const { client, streams, clock, sequence } = setup()
  const stream = client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 2, sequence })
  stream.open()
  for (let seq = 1; seq <= 5; seq++) streams.one("Output").next({ data: { output: { seq, text: "a" } } })
  clock.advance(16)
  expect(stream.getState()).toMatchObject({ dropped: 3, gap: null, items: [{ seq: 4, text: "a" }, { seq: 5, text: "a" }] })
  client.dispose()
})
it("erases identity data synchronously, ignores late frames and cancels every timer", () => {
  const { client, stream, streams, clock, emit } = setup()
  stream.open(); emit(1); clock.advance(16)
  const sink = streams.one("Output").sink
  streams.fail()
  client.dispose()
  sink.next({ data: { output: { seq: 2, text: "late" } } })
  expect(stream.getState()).toMatchObject({ status: "ended", items: [], cursor: undefined, sequence: undefined })
  expect(streams.open.size).toBe(0)
  expect(clock.pending()).toHaveLength(0)
  expect(() => client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 2 })).toThrow(/disposed/)
})
it("fails a refusal without a retry storm, including next-errors followed by complete", () => {
  for (const frame of ["error", "next"] as const) {
    const { client, stream, streams, clock } = setup()
    stream.open(); streams.one("Output").refuse("INVALID_INPUT", { frame }); clock.advance(3_600_000)
    expect(stream.getState().status).toBe("failed")
    expect(streams.started).toHaveLength(1)
    client.dispose(); expect(clock.pending()).toHaveLength(0)
  }
})
it("bounds delayed retries even if every subscribe fails synchronously", () => {
  const clock = createTestClock()
  let attempts = 0
  const client = createClient({ network: createMockNetwork(), live: { ...clock.live, subscribe() { attempts++; throw new Error("offline") }, restart: { minMs: 1, maxMs: 2 } } })
  const stream = client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 1, maxRetries: 3 })
  stream.open(); expect(attempts).toBe(1)
  clock.advance(100)
  expect(attempts).toBe(4)
  expect(stream.getState().status).toBe("failed")
  client.dispose(); expect(clock.pending()).toHaveLength(0)
})
it("ends on completion and rejects invalid configuration and sequence values", () => {
  const { client, stream, streams, clock, emit } = setup()
  expect(() => client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 0 })).toThrow(/bufferSize/)
  stream.open(); emit(1); streams.one("Output").end(); clock.advance(16)
  expect(stream.getState().status).toBe("ended")
  client.dispose()
  const other = setup(); other.stream.open(); other.emit(1.5); other.clock.advance(16)
  expect(other.stream.getState().status).toBe("failed"); other.client.dispose()
})
it("handles synchronous socket notifications while stopping a stream without recursion", () => {
  const clock = createTestClock()
  let signal: ((change: { reconnected: boolean }) => void) | undefined
  let socket: "closed" | "connected" = "connected"
  let starts = 0
  const client = createClient({ network: createMockNetwork(), live: {
    ...clock.live,
    connection: { state: () => socket, subscribe(fn) { signal = fn; return () => { signal = undefined } } },
    subscribe() { starts++; return () => { socket = "closed"; signal?.({ reconnected: false }) } },
  } })
  const stream = client.stream(artifact, {}, { select: (data) => data.output, bufferSize: 10 })
  stream.open(); signal?.({ reconnected: true })
  expect(starts).toBe(1)
  expect(clock.pending().filter((timer) => timer.ms > 16)).toHaveLength(1)
  client.dispose(); expect(clock.pending()).toHaveLength(0)
})
