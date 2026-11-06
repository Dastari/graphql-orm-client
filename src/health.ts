import type { LiveEnd, LiveTypeStatus } from "./live.js"

/**
 * What keeps a type's records fresh right now.
 * - `live`: a stream is open and has delivered an event since it started.
 * - `unconfirmed`: a stream was subscribed and not refused, with no event yet. Nothing confirms a
 *   subscribe, so a quiet stream can't be told from an unanswered one: this is not `live`.
 * - `connecting`: the stream is starting or restarting, or its socket is reconnecting.
 * - `polling`: no stream is covering the records, and a poll refreshes them. `reason` says why.
 * - `refused`: the server refused the stream, and nothing refreshes the records.
 * - `unavailable`: there is no stream, and nothing refreshes the records.
 * - `idle`: nothing is held.
 */
export type LiveState = "live" | "unconfirmed" | "connecting" | "polling" | "refused" | "unavailable" | "idle"

/**
 * Why coverage is degraded (thin fallback can still deliver live events).
 * - `no-live-layer`: the client was created without `live`.
 * - `no-stream`: a `@live` fragment's type has no usable `Changed` subscription.
 * - `selection-refused`: the server refused the stream with `INVALID_INPUT`, the code it gives for a
 *   selection a stream can't carry. It can mean other invalid input too.
 * - `refused`: the server refused the stream with another code.
 * - `identity-mismatch`: the server's `NodeId` isn't what the key fields encode to in any order, so events couldn't
 *   reach the records. Check `keys`, and the types of the key fields.
 * - `over-cap`: more streams or records than a limit allows, on the client or the router.
 * - `socket-down`: the socket failed, or the router answered `SERVICE_UNAVAILABLE`.
 * - `stream-ended`: the stream ended for another reason.
 * - `schema-reload`: the router retired its graph.
 */
export type LiveReason = "no-live-layer" | "no-stream" | "selection-refused" | "refused" | "identity-mismatch" | "over-cap" | "socket-down" | "stream-ended" | "schema-reload"

export type LiveSocketState = "connected" | "connecting" | "closed" | "unknown"

export interface LiveTypeHealth {
  readonly state: LiveState
  /** Null when coverage has no known limitation, or when idle/starting. Thin retains selection-refused. */
  readonly reason: LiveReason | null
  /** The server's `extensions.code` behind `reason`, when it gave one. Null when there's no `reason`. */
  readonly code: string | null
  /** Records of the type that open queries show through `@live` fragments. */
  readonly held: number
  /** The poll behind every query holding the type. Null means at least one has none. */
  readonly pollMs: number | null
  /** The last event for the type. Null means none has arrived, not that it's been quiet. */
  readonly lastEventAt: number | null
  /** The last successful read of a query holding the type. Null means none has completed. */
  readonly lastReadAt: number | null
  /** When a waiting restart or refusal window ends. Null when nothing is waiting. */
  readonly retryAt: number | null
  /** The `@live` fragments held on this type, for naming what can't stay live. */
  readonly fragments: readonly string[]
}

export interface LiveHealth {
  /** `unknown` unless the transport reports it: see `graphqlWsTransport`. */
  readonly socket: LiveSocketState
  /** The worst state of any type. */
  readonly worst: LiveState
  readonly types: Readonly<Record<string, LiveTypeHealth>>
}

/** A `@live` fragment an application shows that can't stay live, reported once per fragment and reason. */
export interface LiveDiagnostic {
  readonly fragment: string
  readonly typename: string
  readonly state: LiveState
  readonly reason: LiveReason | null
  readonly code: string | null
  readonly message: string
}

/** What one open query says about a type it holds. */
export interface LiveHolding {
  readonly held: readonly string[]
  readonly fragments: readonly string[]
  readonly pollMs: number | null
  readonly lastReadAt: number | null
}

const ORDER: readonly LiveState[] = ["idle", "live", "unconfirmed", "connecting", "polling", "refused", "unavailable"]

export function worstOf(states: Iterable<LiveState>): LiveState {
  let worst: LiveState = "idle"
  for (const state of states) if (ORDER.indexOf(state) > ORDER.indexOf(worst)) worst = state
  return worst
}

/** Restarts in a row after which a stream counts as unavailable rather than coming back. */
const UNAVAILABLE_AFTER_ATTEMPTS = 3

function reasonOfEnd(end: LiveEnd | null): LiveReason | null {
  if (end?.code === "SUBSCRIPTION_LIMIT_EXCEEDED") return "over-cap"
  switch (end?.reason) {
    case undefined:
      return null
    case "reload":
      return "schema-reload"
    case "refused":
      return end.code === "INVALID_INPUT" ? "selection-refused" : "refused"
    case "transport":
    case "unavailable":
      return "socket-down"
    default:
      return "stream-ended"
  }
}

/** The health of one type, from what the live layer and the open queries say about it. */
export function typeHealth(status: LiveTypeStatus | undefined, holdings: readonly LiveHolding[], options: { readonly socket: LiveSocketState; readonly hasLiveLayer: boolean }): LiveTypeHealth {
  const fragments = [...new Set(holdings.flatMap((holding) => holding.fragments))].sort()
  const polls = holdings.map((holding) => holding.pollMs)
  const pollMs = polls.length && polls.every((value) => value !== null) ? Math.max(...(polls as number[])) : null
  const reads = holdings.map((holding) => holding.lastReadAt).filter((value): value is number => value !== null)
  const held = status ? status.held : new Set(holdings.flatMap((holding) => holding.held)).size
  const base = {
    held,
    pollMs,
    fragments,
    lastEventAt: status?.lastEventAt ?? null,
    lastReadAt: reads.length ? Math.max(...reads) : null,
    retryAt: status?.retryAt ?? null,
    code: null,
  }
  const code = status?.lastEnd?.code ?? null
  const withPoll = (state: "refused" | "unavailable", reason: LiveReason | null, reasonCode: string | null = code): LiveTypeHealth => ({
    ...base,
    state: pollMs === null ? state : "polling",
    reason,
    code: reasonCode,
  })
  if (held === 0) return { ...base, state: "idle", reason: null }
  if (!status) return withPoll("unavailable", options.hasLiveLayer ? "no-stream" : "no-live-layer")
  if (status.identityMismatch) return withPoll("unavailable", "identity-mismatch", null)
  const reason = reasonOfEnd(status.lastEnd)
  if (status.backedOff) return withPoll("refused", reasonOfEnd(status.lastRefusal), status.lastRefusal?.code ?? null)
  if (status.restarting) {
    if (status.lastEnd?.reason === "refused") return withPoll("refused", reason)
    if (status.restartAttempts >= UNAVAILABLE_AFTER_ATTEMPTS) return withPoll("unavailable", reason)
    return { ...base, state: "connecting", reason, code }
  }
  if (status.overflow > 0) return withPoll("unavailable", "over-cap", null)
  if (status.subscriptions === 0) {
    // Nothing is waiting to bring it back: `restart: false`, an end that stays down until the records change.
    if (status.lastEnd) return withPoll("unavailable", reason)
    return { ...base, state: "connecting", reason: null }
  }
  if (options.socket === "closed" || options.socket === "connecting") return { ...base, state: "connecting", reason: "socket-down" }
  return { ...base, state: status.confirmed ? "live" : "unconfirmed", reason: status.selectionRefused ? "selection-refused" : null }
}

export const IDLE_TYPE_HEALTH: LiveTypeHealth = {
  state: "idle",
  reason: null,
  code: null,
  held: 0,
  pollMs: null,
  lastEventAt: null,
  lastReadAt: null,
  retryAt: null,
  fragments: [],
}

export function diagnosticMessage(fragment: string, typename: string, health: LiveTypeHealth): string {
  const refresh = health.pollMs === null ? "Nothing refreshes it" : `It polls every ${health.pollMs} ms`
  const code = health.code ? ` (${health.code})` : ""
  return `graphql-orm-client: fragment ${fragment} on ${typename} can't stay live: ${health.reason ?? health.state}${code}. ${refresh}.`
}
