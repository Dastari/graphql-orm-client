import { OperationError, type GraphQLErrorLike } from "./client.js"
import { hadNoResponse } from "./outcome.js"
import { HttpError } from "./transport.js"

/**
 * What went wrong, by meaning rather than by message text. Each graphql-orm code (from `OrmErrorCode`) has its own kind, router
 * codes map to the nearest one, and `unknown` covers a code this version doesn't know and an error with no code. `unknown` is part
 * of the type, so an exhaustive `switch` has to handle it.
 *
 * - `invalid-input`: `INVALID_INPUT`, or the router's `GRAPHQL_VALIDATION_FAILED` (a document that doesn't fit the deployed schema).
 * - `unauthenticated`, `forbidden`, `not-found`, `conflict`, `constraint-violation`, `cursor-invalid`, `page-limit-exceeded`: the
 *   graphql-orm code of the same name. `NOT_FOUND` also means "not visible to this identity". A generated update or delete passed
 *   `ExpectedVersion` answers `conflict` when the record has moved on, and writes nothing.
 * - `limit-exceeded`: the router's `OPERATION_LIMIT_EXCEEDED` or `SUBSCRIPTION_LIMIT_EXCEEDED`.
 * - `unavailable`: `SERVICE_UNAVAILABLE` (graphql-orm uses it for retryable database failures, such as SQLite busy), the router's
 *   `SUBGRAPH_UNAVAILABLE` and `SUBSCRIPTION_SCHEMA_RELOAD`, or HTTP 429, 502, 503 or 504 with no GraphQL body.
 * - `internal`: `INTERNAL_ERROR`, or the router's `SUBGRAPH_FAILURE`. graphql-orm masks the cause: the message is "internal error",
 *   and the server logs the rest.
 * - `misconfigured`: `AUTHORIZATION_MISCONFIGURED`.
 * - `outcome-unknown`: a write whose error says the server can't tell whether it committed (`extensions.outcome: "unknown"`).
 * - `network`: no response arrived, because the connection failed or the network's deadline passed. `createHttpNetwork` marks
 *   these; a custom network marks them with `markNoResponse`. For a write, the outcome isn't known.
 * - `cancelled`: aborted by the caller's signal.
 */
export type ErrorKind =
  | "invalid-input"
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "constraint-violation"
  | "cursor-invalid"
  | "page-limit-exceeded"
  | "limit-exceeded"
  | "unavailable"
  | "internal"
  | "misconfigured"
  | "outcome-unknown"
  | "network"
  | "cancelled"
  | "unknown"

/** One error, classified. Fields the error doesn't carry are null, never guessed. */
export interface ClassifiedError {
  readonly kind: ErrorKind
  /** `extensions.code` as the server sent it, or null. */
  readonly code: string | null
  readonly message: string
  /** The GraphQL error's path, or null for a pathless or non-GraphQL error. */
  readonly path: readonly (string | number)[] | null
  /** graphql-orm's `extensions.correlationId`, to quote to whoever reads the server log. */
  readonly correlationId: string | null
  /** The HTTP status of an `HttpError`, or null. */
  readonly status: number | null
  /**
   * What the server says about a write: `extensions.outcome`, such as `"committed"` or `"unknown"`, or null when it says nothing.
   * Null doesn't mean nothing was written.
   */
  readonly writeOutcome: string | null
}

const CODES: Readonly<Record<string, ErrorKind>> = {
  INVALID_INPUT: "invalid-input",
  GRAPHQL_VALIDATION_FAILED: "invalid-input",
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not-found",
  CONFLICT: "conflict",
  CONSTRAINT_VIOLATION: "constraint-violation",
  CURSOR_INVALID: "cursor-invalid",
  PAGE_LIMIT_EXCEEDED: "page-limit-exceeded",
  OPERATION_LIMIT_EXCEEDED: "limit-exceeded",
  SUBSCRIPTION_LIMIT_EXCEEDED: "limit-exceeded",
  SERVICE_UNAVAILABLE: "unavailable",
  SUBGRAPH_UNAVAILABLE: "unavailable",
  SUBSCRIPTION_SCHEMA_RELOAD: "unavailable",
  INTERNAL_ERROR: "internal",
  SUBGRAPH_FAILURE: "internal",
  AUTHORIZATION_MISCONFIGURED: "misconfigured",
}
const UNAVAILABLE_STATUS = new Set([429, 502, 503, 504])

function fromGraphQL(error: GraphQLErrorLike): ClassifiedError {
  const extensions = error.extensions ?? {}
  const code = typeof extensions.code === "string" ? extensions.code : null
  const outcome = typeof extensions.outcome === "string" ? extensions.outcome : null
  const kind: ErrorKind = outcome === "unknown" ? "outcome-unknown" : (code !== null && CODES[code]) || "unknown"
  return {
    kind,
    code,
    message: error.message,
    path: error.path ?? null,
    correlationId: typeof extensions.correlationId === "string" ? extensions.correlationId : null,
    status: null,
    writeOutcome: outcome,
  }
}

function plain(kind: ErrorKind, message: string, status: number | null = null): ClassifiedError {
  return { kind, code: null, message, path: null, correlationId: null, status, writeOutcome: null }
}

function isGraphQLError(value: unknown): value is GraphQLErrorLike {
  return typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string" && !(value instanceof Error)
}

/**
 * Classify what a query or mutation failed with: a `QueryState.error`, what `mutate` or `commit` rejected with, a GraphQL error,
 * or `QueryState.errors`. One entry per GraphQL error, in order, or one for an error that isn't GraphQL. Empty for nothing.
 */
export function classifyErrors(error: unknown): readonly ClassifiedError[] {
  if (error === null || error === undefined) return []
  if (Array.isArray(error)) return error.flatMap((item) => classifyErrors(item))
  if (error instanceof OperationError)
    return error.errors.length ? error.errors.map(fromGraphQL) : [plain("unknown", error.message)]
  if (isGraphQLError(error)) return [fromGraphQL(error)]
  if (error instanceof HttpError) {
    const kind: ErrorKind = error.status === 401 ? "unauthenticated" : error.status === 403 ? "forbidden" : UNAVAILABLE_STATUS.has(error.status) ? "unavailable" : "unknown"
    return [plain(kind, error.message, error.status)]
  }
  if (hadNoResponse(error)) return [plain("network", error instanceof Error ? error.message : String(error))]
  if (error instanceof Error) return [plain(error.name === "AbortError" ? "cancelled" : "unknown", error.message)]
  return [plain("unknown", String(error))]
}

/** The first of `classifyErrors(error)`, or null for nothing. */
export function classifyError(error: unknown): ClassifiedError | null {
  return classifyErrors(error)[0] ?? null
}
