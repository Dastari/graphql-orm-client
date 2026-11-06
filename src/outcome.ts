import type { GraphQLResponse } from "./client.js"

/** A write's certainty, independent of whether the legacy API returns or throws. */
export type WriteStatus = "confirmed" | "refused" | "failed" | "unconfirmed"
/** Reconciliation never retries the write. */
export interface WriteOutcome {
  readonly status: WriteStatus
  readonly reconciliation: "not-needed" | "unavailable" | "reread" | "failed"
}
/** Explicit transport evidence that no request was sent. */
export class WriteNotSentError extends Error {
  constructor(override readonly cause: unknown) {
    super("The write was not sent")
    this.name = "WriteNotSentError"
  }
}

/** Conservative: null data, HTTP status and free-form error messages prove no write outcome. */
export function writeStatus(response: GraphQLResponse): WriteStatus {
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
