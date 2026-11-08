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
 * Conservative: null data, HTTP status and free-form error messages prove no write outcome. A response with no
 * `data` key does: per GraphQL over HTTP, execution never started.
 */
export function writeStatus(response: GraphQLResponse): WriteStatus {
  if (!("data" in response)) return "refused"
  const errors = response.errors ?? []
  if (errors.length) {
    const outcomes = errors.map(e => e.extensions?.outcome)
    if (outcomes.every(o => o === "refused")) return "refused"
    if (outcomes.every(o => o === "failed")) return "failed"
    return "unconfirmed"
  }
  const roots = Object.values(response.data ?? {}).filter(v => v !== "Mutation")
  if (roots.length && roots.every(v => typeof v === "object" && v !== null && (v as any).Success === true))
    return "confirmed"
  return "unconfirmed"
}
