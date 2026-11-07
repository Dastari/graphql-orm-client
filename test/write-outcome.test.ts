import { expect, it } from "vitest"
import { createClient, OperationError } from "../src/client.js"
import { markNotSent } from "../src/outcome.js"
import { createHttpNetwork } from "../src/transport.js"
import { ops, mockNetwork } from "./fixtures.js"

it.each([
  [{ data: { UpdateWidget: { Success: true } } }, "confirmed"],
  [{ data: null, errors: [{ message: "denied", extensions: { outcome: "refused" } }] }, "refused"],
  [{ data: null, errors: [{ message: "failed", extensions: { outcome: "failed" } }] }, "failed"],
  [{ data: null, errors: [{ message: "payload denied", extensions: { outcome: "committed", retryable: false } }] }, "unconfirmed"],
  [{ data: null, errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }] }, "unconfirmed"],
  [{ data: { UpdateWidget: { Success: false, Error: "Entity not found after update" } } }, "unconfirmed"],
  [{ data: { UpdateWidget: { Success: true } }, errors: [{ message: "field denied", path: ["UpdateWidget", "Widget"] }] }, "unconfirmed"],
] as const)("classifies only evidence, without changing legacy throws (%s)", async (response, status) => {
  const { network, requests } = mockNetwork(() => response)
  const client = createClient({ network })
  let rereads = 0
  const result = await client.mutateOutcome(ops.RenameWidget!, { Id: "w1", Input: {} }, {
    reconcile: async () => { rereads++; await client.query(ops.WidgetPage!, { Id: "w1" }, { policy: "network-only" }) },
  })
  expect(result.outcome.status).toBe(status)
  expect(rereads).toBe(status === "unconfirmed" ? 1 : 0)
  expect(requests.filter(r => r.kind === "mutation")).toHaveLength(1)
  if (response.data === null) expect(result.error).toBeInstanceOf(OperationError)
})

it("lost responses re-read known records, unknown targets say unavailable, never replay writes", async () => {
  const { network, requests } = mockNetwork(request => {
    if (request.kind === "mutation") throw new TypeError("connection lost")
    return { data: { Widget: { __typename: "Widget", Id: "w1", Name: "committed", RecordVersion: 2 } } }
  })
  const client = createClient({ network })
  const result = await client.mutateOutcome(ops.RenameWidget!, { Id: "w1", Input: {} }, {
    reconcile: () => client.query(ops.WidgetPage!, { Id: "w1" }, { policy: "network-only" }),
  })
  expect(result.outcome).toEqual({ status: "unconfirmed", reconciliation: "reread" })
  expect(requests.map(r => r.kind)).toEqual(["mutation", "query"])
  const unknown = await client.mutateOutcome(ops.RenameWidget!, {})
  expect(unknown.outcome.reconciliation).toBe("unavailable")
  await expect(client.mutate(ops.RenameWidget!, {})).rejects.toThrow("connection lost")
})

it("pre-send failure is failed, cancellation after send is unconfirmed", async () => {
  for (const error of [markNotSent(new Error("headers")), new DOMException("abort", "AbortError")]) {
    const client = createClient({ network: mockNetwork(() => { throw error }).network })
    expect((await client.mutateOutcome(ops.RenameWidget!, {})).outcome.status)
      .toBe((error as Error).message === "headers" ? "failed" : "unconfirmed")
  }
})

it("a response with no data key is refused, and Success false stays unconfirmed", async () => {
  const outcome = async (response: object) => (await createClient({ network: mockNetwork(() => response as never).network }).mutateOutcome(ops.RenameWidget!, {})).outcome.status
  expect(await outcome({ errors: [{ message: "not valid" }] })).toBe("refused")
  expect(await outcome({ data: { UpdateWidget: { __typename: "WidgetResult", Success: false, Error: "no" } } })).toBe("unconfirmed")
})

it("a failed headers function reaches the caller as it was thrown, and counts as not sent", async () => {
  const thrown = new Error("no token")
  const network = createHttpNetwork({ url: "http://example.test", headers: () => { throw thrown }, fetch: (async () => { throw new Error("sent") }) as typeof globalThis.fetch })
  const client = createClient({ network })
  await expect(client.mutate(ops.RenameWidget!, {})).rejects.toBe(thrown)
  expect((await client.mutateOutcome(ops.RenameWidget!, {})).outcome.status).toBe("failed")
})

it("write response bounds are separate from reads", async () => {
  const fetch = async () => new Response(JSON.stringify({ data: { Ping: true } }))
  const network = createHttpNetwork({ url: "http://example.test", fetch: fetch as typeof globalThis.fetch, writes: { maxResponseBytes: 2 } })
  const request = { name: "Ping", text: "mutation Ping { Ping }", hash: "", variables: {} }
  await expect(network.execute({ ...request, kind: "mutation" }, {})).rejects.toThrow(/byte limit/)
  await expect(network.execute({ ...request, kind: "query" }, {})).resolves.toHaveProperty("data.Ping", true)
})

it("a write deadline aborts once and does not impose a read deadline", async () => {
  let sends = 0
  const network = createHttpNetwork({ url: "http://example.test", writes: { deadlineMs: 5 }, fetch: (async (_url, init) => {
    sends++
    if (JSON.parse(String(init?.body)).operationName === "Read") return new Response('{"data":{"ok":true}}')
    return await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
  }) as typeof globalThis.fetch })
  const client = createClient({ network })
  expect((await client.mutateOutcome(ops.RenameWidget!, {})).outcome.status).toBe("unconfirmed")
  expect(sends).toBe(1)
  await expect(network.execute({ kind: "query", name: "Read", text: "", hash: "", variables: {} }, {})).resolves.toHaveProperty("data.ok", true)
})
