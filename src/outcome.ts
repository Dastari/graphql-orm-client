import type { GraphQLResponse } from "./client.js"

/** A write's certainty, independent of whether the legacy API returns or throws. */
export type WriteStatus = "confirmed" | "refused" | "failed" | "unconfirmed"
/** Reconciliation never retries the write. */
export interface WriteOutcome {
  readonly status: WriteStatus
  readonly reconciliation: "not-needed" | "unavailable" | "reread" | "failed"
}
const notSent = new WeakSet<object>()

/**
 * A transport says this error came before the request was sent. The error itself is left as it is, so what
 * `mutate` throws doesn't change.
 */
export function markNotSent<E>(error: E): E {
  if (typeof error === "object" && error !== null) notSent.add(error)
  return error
}

/** Whether a transport marked this error as coming before the request was sent. */
export function wasNotSent(error: unknown): boolean {
  return typeof error === "object" && error !== null && notSent.has(error)
}

const noResponse = new WeakSet<object>()

/**
 * A transport says no response arrived for this request: the connection failed, or its deadline passed. For a write, that means
 * the outcome isn't known. `createHttpNetwork` marks these itself; a custom network can call this so `classifyError` reports
 * `network`. The error itself is left as it is.
 */
export function markNoResponse<E>(error: E): E {
  if (typeof error === "object" && error !== null) noResponse.add(error)
  return error
}

/** Whether a transport marked this error as one where no response arrived. */
export function hadNoResponse(error: unknown): boolean {
  return typeof error === "object" && error !== null && noResponse.has(error)
}

/**
 * Error codes that, on a response with no `data` key, mean the operation was never executed. Read from Hive Router 0.2.19,
 * which graphql-orm-router 0.8.1 and 0.15.5 pin (`pipeline/error.rs`, `http_utils/body.rs`, and graphql-tools 0.5.8's
 * validation rule names, which Hive sends as the code), and from graphql-orm-router's hooks at both versions (`server.rs`:
 * `UNAUTHENTICATED`, `FORBIDDEN` and `OPERATION_LIMIT_EXCEEDED`, answered before any subgraph is called). Hive's other
 * request errors are ones `createHttpNetwork` doesn't cause (method, content type, GET, CSRF), or come from its JWT and cost
 * checks, which graphql-orm-router replaces with its own; they stay unconfirmed, for size. So do `GATEWAY_TIMEOUT`, whose timer covers
 * execution, and every other code, such as `PLAN_EXECUTION_FAILED`, which may follow a commit.
 */
const PRE_EXECUTION_CODES: ReadonlySet<string> = new Set((
  // Request body, parsing, variables and validation.
  "BAD_REQUEST PAYLOAD_TOO_LARGE_CONTENT_LENGTH PAYLOAD_TOO_LARGE_BODY_STREAM GRAPHQL_PARSE_FAILED OPERATION_RESOLUTION_FAILURE " +
  "BAD_USER_INPUT GRAPHQL_VALIDATION_FAILED FieldsOnCorrectType FragmentsOnCompositeTypes KnownArgumentNames KnownDirectives " +
  "KnownFragmentNames KnownTypeNames LeafFieldSelections LoneAnonymousOperation NoFragmentsCycle NoUndefinedVariables " +
  "NoUnusedFragments NoUnusedVariables OverlappingFieldsCanBeMerged PossibleFragmentSpreads ProvidedRequiredArguments " +
  "SingleFieldSubscriptions UniqueArgumentNames UniqueDirectivesPerLocation UniqueFragmentNames UniqueInputFieldNames " +
  "UniqueOperationNames UniqueVariableNames ValuesOfCorrectType VariablesAreInputTypes VariablesInAllowedPosition " +
  // Authentication, authorization, persisted documents and limits.
  "UNAUTHENTICATED FORBIDDEN UNAUTHORIZED_FIELD_OR_TYPE PERSISTED_DOCUMENT_NOT_FOUND PERSISTED_DOCUMENT_ID_REQUIRED " +
  "PERSISTED_DOCUMENT_EXTRACTION_FAILED OPERATION_LIMIT_EXCEEDED"
).split(" "))

/** What counts as evidence of a write's outcome beyond what the client reads by default. Internal; see `MutateOptions`. */
export interface WriteEvidence {
  readonly confirm?: ((data: Record<string, unknown>) => boolean) | undefined
  readonly refusedCodes?: readonly string[] | undefined
  readonly withoutData?: "by-code" | "refused"
}

const rootsOf = (data: Record<string, unknown> | null | undefined) => Object.values(data ?? {}).filter(v => v !== "Mutation")

/**
 * Conservative: null data, HTTP status and free-form error messages prove no write outcome. A response with no `data` key
 * is refused only when every error's code says execution never started: a router can answer an execution failure, after a
 * subgraph committed, without `data` too.
 */
export function writeStatus(response: GraphQLResponse, evidence: WriteEvidence = {}): WriteStatus {
  const withoutData = !("data" in response)
  if (withoutData && evidence.withoutData === "refused") return "refused"
  const errors = response.errors ?? []
  if (errors.length) {
    const outcomes = errors.map(e => e.extensions?.outcome)
    if (outcomes.every(o => o === "refused")) return "refused"
    if (outcomes.every(o => o === "failed")) return "failed"
    const refused = evidence.refusedCodes ?? []
    // What the server says about the outcome wins over any code. A root that returned a value may have committed before a
    // nested field failed.
    return outcomes.every(o => o === undefined) && (withoutData || rootsOf(response.data).every(v => v === null)) &&
      errors.every(({ extensions: e }) => typeof e?.code === "string" &&
        (refused.includes(e.code) || withoutData && PRE_EXECUTION_CODES.has(e.code))) ? "refused" : "unconfirmed"
  }
  if (evidence.confirm && response.data) {
    try { return evidence.confirm(response.data) === true ? "confirmed" : "unconfirmed" }
    catch { return "unconfirmed" }
  }
  const roots = rootsOf(response.data)
  return roots.length && roots.every(v => typeof v === "object" && v !== null && (v as any).Success === true)
    ? "confirmed" : "unconfirmed"
}
