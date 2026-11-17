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

const coded = (code: string, extra: object = {}) => ({ message: "Internal server error", extensions: { code, ...extra } })

it.each([
  [[coded("GRAPHQL_PARSE_FAILED")], "refused"],
  [[coded("FieldsOnCorrectType"), coded("KnownArgumentNames")], "refused"],
  [[coded("BAD_USER_INPUT")], "refused"],
  [[coded("UNAUTHENTICATED")], "refused"],
  [[coded("FORBIDDEN")], "refused"],
  [[coded("PERSISTED_DOCUMENT_NOT_FOUND")], "refused"],
  [[coded("OPERATION_LIMIT_EXCEEDED")], "refused"],
  [[coded("PLAN_EXECUTION_FAILED")], "unconfirmed"],
  [[coded("SUBGRAPH_EXECUTION_FAILURE")], "unconfirmed"],
  [[coded("GATEWAY_TIMEOUT")], "unconfirmed"],
  [[coded("GRAPHQL_VALIDATION_FAILED"), coded("PLAN_EXECUTION_FAILED")], "unconfirmed"],
  [[{ message: "not valid" }], "unconfirmed"],
  [[coded("FORBIDDEN", { outcome: "committed" })], "unconfirmed"],
  [[coded("FORBIDDEN", { outcome: "refused" })], "refused"],
  [[], "unconfirmed"],
] as const)("a response with no data key is refused only for pre-execution codes (%j)", async (errors, status) => {
  const { network, requests } = mockNetwork(() => ({ errors }) as never)
  const client = createClient({ network })
  let rereads = 0
  const result = await client.mutateOutcome(ops.RenameWidget!, { Id: "w1", Name: "n" }, { reconcile: async () => { rereads++ } })
  expect(result.outcome.status).toBe(status)
  expect(rereads).toBe(status === "unconfirmed" ? 1 : 0)
  expect(requests).toHaveLength(1)
  // What mutate throws is unchanged.
  await expect(client.mutate(ops.RenameWidget!, { Id: "w1", Name: "n" })).rejects.toBeInstanceOf(OperationError)
})

it("writeWithoutData: refused restores the earlier classification", async () => {
  const network = mockNetwork(() => ({ errors: [coded("PLAN_EXECUTION_FAILED")] }) as never).network
  expect((await createClient({ network }).mutateOutcome(ops.RenameWidget!, {})).outcome.status).toBe("unconfirmed")
  expect((await createClient({ network, writeWithoutData: "refused" }).mutateOutcome(ops.RenameWidget!, {})).outcome.status).toBe("refused")
  const empty = mockNetwork(() => ({}) as never).network
  expect((await createClient({ network: empty, writeWithoutData: "refused" }).mutateOutcome(ops.RenameWidget!, {})).outcome.status).toBe("refused")
})

it("Success false stays unconfirmed", async () => {
  const response = { data: { UpdateWidget: { __typename: "WidgetResult", Success: false, Error: "no" } } }
  const client = createClient({ network: mockNetwork(() => response as never).network })
  expect((await client.mutateOutcome(ops.RenameWidget!, {})).outcome.status).toBe("unconfirmed")
})

it("confirm decides for a result with no Success field, and never sees a response with errors", async () => {
  let reply: object = { data: { UpdateWidget: { __typename: "WidgetResult", Entity: { __typename: "Widget", Id: "w1", Name: "n", RowVersion: 2 } } } }
  const { network } = mockNetwork(() => reply as never)
  const client = createClient({ network })
  const seen: unknown[] = []
  const confirm = (data: any) => { seen.push(data); return data.UpdateWidget?.Entity?.Id != null }
  let rereads = 0
  const reconcile = async () => { rereads++ }
  expect((await client.mutateOutcome(ops.RenameWidget!, { Id: "w1", Name: "n" })).outcome.status).toBe("unconfirmed")
  const confirmed = await client.mutateOutcome(ops.RenameWidget!, { Id: "w1", Name: "n" }, { confirm, reconcile })
  expect(confirmed.outcome).toEqual({ status: "confirmed", reconciliation: "not-needed" })
  expect(rereads).toBe(0)
  // The data as the server sent it, fields of spread fragments included.
  expect(seen).toEqual([{ UpdateWidget: { __typename: "WidgetResult", Entity: { __typename: "Widget", Id: "w1", Name: "n", RowVersion: 2 } } }])

  // It replaces the Success rule.
  reply = { data: { UpdateWidget: { __typename: "WidgetResult", Success: true, Entity: null } } }
  expect((await client.mutateOutcome(ops.RenameWidget!, {}, { confirm })).outcome.status).toBe("unconfirmed")

  // Partial errors stay unconfirmed, and confirm isn't asked.
  seen.length = 0
  reply = { data: { UpdateWidget: { __typename: "WidgetResult", Entity: { __typename: "Widget", Id: "w1" } } }, errors: [{ message: "denied", path: ["UpdateWidget", "Entity", "Name"] }] }
  expect((await client.mutateOutcome(ops.RenameWidget!, {}, { confirm, reconcile })).outcome.status).toBe("unconfirmed")
  expect(seen).toEqual([])
  expect(rereads).toBe(1)
})

it("a confirm that throws leaves the write unconfirmed and doesn't change what mutate returns", async () => {
  const response = { data: { UpdateWidget: { __typename: "WidgetResult", Entity: null } } }
  const client = createClient({ network: mockNetwork(() => response as never).network })
  const confirm = () => { throw new Error("bad rule") }
  let outcome: unknown
  const result = await client.mutate(ops.RenameWidget!, {}, { confirm, onOutcome: value => { outcome = value } })
  expect(result.errors).toEqual([])
  expect(outcome).toEqual({ status: "unconfirmed", reconciliation: "unavailable" })
  expect((await client.mutateOutcome(ops.RenameWidget!, {}, { confirm })).error).toBeUndefined()
})

it.each([
  [{ data: null, errors: [coded("NOT_FOUND")] }, "refused"],
  [{ data: { UpdateWidget: null }, errors: [{ ...coded("CONFLICT"), path: ["UpdateWidget"] }] }, "refused"],
  [{ errors: [coded("APP_REJECTED")] }, "refused"],
  [{ data: null, errors: [coded("NOT_FOUND"), coded("INTERNAL_ERROR")] }, "unconfirmed"],
  [{ data: null, errors: [coded("NOT_FOUND"), { message: "no code" }] }, "unconfirmed"],
  [{ data: null, errors: [coded("NOT_FOUND", { outcome: "committed" })] }, "unconfirmed"],
  [{ data: null, errors: [coded("NOT_FOUND", { outcome: "unknown" })] }, "unconfirmed"],
  [{ data: { UpdateWidget: { __typename: "WidgetResult", Success: true } }, errors: [{ ...coded("NOT_FOUND"), path: ["UpdateWidget", "Entity"] }] }, "unconfirmed"],
] as const)("refusedCodes refuse only when the server says nothing else and no root returned (%j)", async (response, status) => {
  const { network } = mockNetwork(() => response as never)
  const client = createClient({ network })
  let rereads = 0
  const result = await client.mutateOutcome(ops.RenameWidget!, {}, {
    refusedCodes: ["NOT_FOUND", "CONFLICT", "APP_REJECTED"],
    reconcile: async () => { rereads++ },
  })
  expect(result.outcome.status).toBe(status)
  expect(rereads).toBe(status === "unconfirmed" ? 1 : 0)
  // Without them, a code is no evidence.
  expect((await client.mutateOutcome(ops.RenameWidget!, {})).outcome.status).toBe("unconfirmed")
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
