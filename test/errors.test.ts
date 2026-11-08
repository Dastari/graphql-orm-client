import { describe, expect, it } from "vitest"
import { OperationError, classifyError, classifyErrors, createHttpNetwork, HttpError, markNoResponse } from "../src/index.js"

const coded = (code: string, extra: Record<string, unknown> = {}) => ({ message: code.toLowerCase(), path: ["Root"], extensions: { code, ...extra } })

describe("classifyError", () => {
  it.each([
    // graphql-orm's OrmErrorCode, every value (errors.rs, 0.95.0)
    ["INVALID_INPUT", "invalid-input"],
    ["UNAUTHENTICATED", "unauthenticated"],
    ["FORBIDDEN", "forbidden"],
    ["NOT_FOUND", "not-found"],
    ["CONFLICT", "conflict"],
    ["CONSTRAINT_VIOLATION", "constraint-violation"],
    ["CURSOR_INVALID", "cursor-invalid"],
    ["PAGE_LIMIT_EXCEEDED", "page-limit-exceeded"],
    ["SERVICE_UNAVAILABLE", "unavailable"],
    ["INTERNAL_ERROR", "internal"],
    ["AUTHORIZATION_MISCONFIGURED", "misconfigured"],
    // the router's
    ["GRAPHQL_VALIDATION_FAILED", "invalid-input"],
    ["OPERATION_LIMIT_EXCEEDED", "limit-exceeded"],
    ["SUBSCRIPTION_LIMIT_EXCEEDED", "limit-exceeded"],
    ["SUBGRAPH_UNAVAILABLE", "unavailable"],
    ["SUBSCRIPTION_SCHEMA_RELOAD", "unavailable"],
    ["SUBGRAPH_FAILURE", "internal"],
  ])("%s is %s, keeping the code and path", (code, kind) => {
    expect(classifyError(coded(code))).toEqual({ kind, code, message: code.toLowerCase(), path: ["Root"], correlationId: null, status: null, writeOutcome: null })
  })

  it("a code it doesn't know, or none, is unknown, and the code is kept as sent", () => {
    expect(classifyError(coded("AI_CONFLICT"))).toMatchObject({ kind: "unknown", code: "AI_CONFLICT" })
    expect(classifyError({ message: "Unknown field \"Nmae\"" })).toMatchObject({ kind: "unknown", code: null, path: null })
    expect(classifyError(coded("conflict"))).toMatchObject({ kind: "unknown", code: "conflict" })
  })

  it("a write the server can't confirm is outcome-unknown, whatever its code", () => {
    expect(classifyError({ message: "mutation_outcome_unknown", extensions: { outcome: "unknown", retryable: false } })).toMatchObject({ kind: "outcome-unknown", writeOutcome: "unknown" })
    expect(classifyError(coded("INTERNAL_ERROR", { outcome: "committed" }))).toMatchObject({ kind: "internal", writeOutcome: "committed" })
  })

  it("keeps graphql-orm's correlation id", () => {
    expect(classifyError(coded("INTERNAL_ERROR", { correlationId: "c-1" }))!.correlationId).toBe("c-1")
  })

  it("an OperationError gives one entry per GraphQL error, in order", () => {
    const error = new OperationError("Save", [coded("CONFLICT"), coded("FORBIDDEN")])
    expect(classifyErrors(error).map((e) => e.kind)).toEqual(["conflict", "forbidden"])
    expect(classifyError(error)!.kind).toBe("conflict")
    expect(classifyErrors(new OperationError("Save", []))).toMatchObject([{ kind: "unknown", message: "Save returned no data" }])
  })

  it("takes QueryState.errors as it is, and nothing gives nothing", () => {
    expect(classifyErrors([coded("NOT_FOUND"), coded("CURSOR_INVALID")]).map((e) => e.kind)).toEqual(["not-found", "cursor-invalid"])
    expect(classifyErrors([])).toEqual([])
    expect(classifyErrors(null)).toEqual([])
    expect(classifyError(undefined)).toBeNull()
  })

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [429, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
    [504, "unavailable"],
    [500, "unknown"],
    [404, "unknown"],
  ])("HTTP %i with no GraphQL body is %s", (status, kind) => {
    expect(classifyError(new HttpError(status))).toMatchObject({ kind, status, code: null })
  })

  it("an error that isn't GraphQL or HTTP isn't guessed at", () => {
    expect(classifyError(new TypeError("x is not a function"))!.kind).toBe("unknown")
    expect(classifyError(new Error("boom"))!.kind).toBe("unknown")
    expect(classifyError("text")).toMatchObject({ kind: "unknown", message: "text" })
    expect(classifyError(new DOMException("stopped", "AbortError"))!.kind).toBe("cancelled")
    expect(classifyError(markNoResponse(new TypeError("Failed to fetch")))!.kind).toBe("network")
  })
})

describe("createHttpNetwork marks a request with no response", () => {
  const request = { kind: "query" as const, name: "Q", text: "query Q { a }", hash: "h", variables: {} }
  const failing = (error: unknown) => createHttpNetwork({ url: "http://x/graphql", fetch: async (_input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason
    await new Promise((resolve, reject) => {
      if (error === "wait") init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      else reject(error)
    })
    return new Response()
  } })
  it("a failed connection is network", async () => {
    const error = await failing(new TypeError("Failed to fetch")).execute(request, {}).catch((e) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect(classifyError(error)!.kind).toBe("network")
  })
  it("a passed deadline is network", async () => {
    const network = createHttpNetwork({ url: "http://x/graphql", reads: { deadlineMs: 1 }, fetch: (_input, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))) })
    const error = await network.execute(request, {}).catch((e) => e)
    expect(error.name).toBe("TimeoutError")
    expect(classifyError(error)!.kind).toBe("network")
  })
  it("the caller's own abort is cancelled", async () => {
    const controller = new AbortController()
    const pending = failing("wait").execute(request, { signal: controller.signal }).catch((e) => e)
    controller.abort(new DOMException("stopped", "AbortError"))
    expect(classifyError(await pending)!.kind).toBe("cancelled")
  })
  it("a 400 with GraphQL errors comes back as a response, with its codes", async () => {
    const network = createHttpNetwork({ url: "http://x/graphql", fetch: async () => new Response(JSON.stringify({ errors: [coded("CURSOR_INVALID")] }), { status: 400 }) })
    const response = await network.execute(request, {})
    expect(classifyErrors(response.errors).map((e) => e.kind)).toEqual(["cursor-invalid"])
  })
})
