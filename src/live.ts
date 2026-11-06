import type { LiveArtifact, LiveMode } from "./artifact.js"
import type { GraphQLResponse, OperationRequest } from "./client.js"
import type { LiveDiagnostic, LiveSocketState } from "./health.js"
import { decodeNodeId } from "./node-id.js"
import { contextOf, identify, normalize } from "./store/normalize.js"
import type { Store } from "./store/store.js"

export interface SubscriptionSink {
  next(response: GraphQLResponse): void
  error(error: unknown): void
  complete(): void
}

/** How long a refused stream waits before it is subscribed again: five minutes. */
export const DEFAULT_REFUSAL_BACKOFF_MS = 5 * 60_000

/**
 * Back-off for streams the server refuses. A refused stream is not subscribed again for a window,
 * however often the records it covers change, and is then subscribed again by itself.
 */
export interface RefusalBackoff {
  /**
   * Window in milliseconds for every type not listed in `types`. Omit it to leave other types on
   * the ordinary back-off.
   */
  readonly ms?: number
  /**
   * Per type (the generated `<Type>Changed` subscription is the operation). A number sets that
   * type's window, `true` uses `DEFAULT_REFUSAL_BACKOFF_MS` and `false` leaves the type on the
   * ordinary back-off (`LiveOptions.restart`), as without the option. Use `false` for a stream with
   * no poll behind it.
   */
  readonly types?: Readonly<Record<string, number | boolean>>
}

/** Back-off for a stream that ended without the client asking. See `LiveOptions.restart`. */
export interface StreamRestart {
  /** The delay after the second end in a row; it doubles after each further end. Default 1000 ms. */
  readonly minMs?: number
  /**
   * The longest delay, default 60000 ms. A stream that stays open this long has recovered, so its
   * next end starts again from the shortest delay.
   */
  readonly maxMs?: number
}

/**
 * Why a stream ended without the client asking.
 * - `reload`: the router retired the graph the connection selected (`SUBSCRIPTION_SCHEMA_RELOAD`).
 * - `lost`: events were lost (`SUBSCRIPTION_CONTINUITY_LOST`, `SUBSCRIPTION_SOURCE_CLOSED`).
 * - `unavailable`: the router can't serve it now (`SERVICE_UNAVAILABLE`), as a retired connection answers.
 * - `refused`: GraphQL errors answered the subscribe and no event ever arrived.
 * - `errored`: GraphQL errors ended a stream that had delivered events.
 * - `transport`: the socket failed, or its reconnect attempts ran out.
 * - `completed`: the server ended the stream with no error.
 */
export type LiveEndReason = "reload" | "lost" | "unavailable" | "refused" | "errored" | "transport" | "completed"

/** The last time a type's stream ended without the client asking. */
export interface LiveEnd {
  readonly reason: LiveEndReason
  /** The GraphQL error code, when the server gave one. */
  readonly code: string | null
  /** When it ended, in milliseconds since the epoch. */
  readonly at: number
}

/** What a transport can say about its socket. `graphqlWsTransport` provides it. */
export interface LiveConnection {
  /** The socket's state now. */
  state(): LiveSocketState
  /** Call `listener` when it changes; `reconnected` is true on a connect that recovered a lost socket. */
  subscribe(listener: (change: { readonly reconnected: boolean }) => void): () => void
}

export interface LiveOptions {
  /**
   * Compiled live artifacts per type (`compile(...).live`). Leave it out to use `subscribe` only
   * for plain subscriptions (`client.subscribe`).
   */
  readonly artifacts?: Readonly<Record<string, LiveArtifact>>
  /**
   * Start a subscription (for example through graphql-ws); returns its disposer. The live layer
   * and `client.subscribe` both use it.
   */
  readonly subscribe: (request: OperationRequest, sink: SubscriptionSink) => () => void
  /**
   * Per-record subscriptions allowed per type in `key` mode. Past it, a field whose key is
   * optional uses one stream of the type; otherwise the rest overflow. Default 50.
   */
  readonly maxKeyedSubscriptions?: number
  /** Largest `Keys` list per subscription in `keys` mode. Default 500. */
  readonly maxKeys?: number
  /** Delay before changes to the held records reach the server. Default 50 ms. */
  readonly debounceMs?: number
  /**
   * Longest random delay before resubscribing and refetching after a subscription lost events.
   * Spreads the load when one burst ends every client's subscription at once. Default 1000 ms.
   */
  readonly resyncJitterMs?: number
  /**
   * What happens when a stream ends and the client didn't ask, for any reason. By default (`true`)
   * the type's streams start again and the queries showing the type read again, after a random
   * delay below `resyncJitterMs`; further ends in a row wait longer, from `minMs` doubling to `maxMs`
   * with jitter, so a failing router sees no storm. A refused stream under `refusalBackoff` waits
   * out its window instead. `false` is the 0.1.0-alpha.6 behaviour, for migration: an ended stream
   * stays down, with nothing read, until the held records next change, and only lost events restart
   * it. Data can stay stale indefinitely with `false`.
   */
  readonly restart?: boolean | StreamRestart
  /**
   * Off by default. When a stream ends because the server refused it (see `docs/design.md`), the
   * live layer remembers that for a window, starts no request for it however often the held
   * records change, and subscribes again and reads what shows the type when the window ends. `true` is five minutes for every
   * type; see `RefusalBackoff` for a window per type and opting a type out. A close that reports
   * lost events (`SUBSCRIPTION_CONTINUITY_LOST`, `SUBSCRIPTION_SOURCE_CLOSED`), a schema reload
   * (`SUBSCRIPTION_SCHEMA_RELOAD`), `SERVICE_UNAVAILABLE` and a transport failure are never remembered. The memory belongs to the client and goes with it when the
   * identity changes. Uses `setTimeout` and `clearTimeout` below, so tests can drive the window.
   */
  readonly refusalBackoff?: boolean | RefusalBackoff
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  /** Clock seam for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * The socket's state, for `client.liveHealth()`. With it, a socket that recovers by itself also reads
   * the queries that hold live records, because events in the gap weren't replayed.
   */
  readonly connection?: LiveConnection
  /**
   * Called once per fragment and reason when a `@live` fragment can't stay live. Defaults to `console.warn`
   * unless `process.env.NODE_ENV` is `production`. `null` turns it off.
   */
  readonly onDiagnostic?: ((diagnostic: LiveDiagnostic) => void) | null
}

export interface LiveTypeStatus {
  readonly mode: LiveMode
  readonly held: number
  readonly subscriptions: number
  /** Records held but not covered by a subscription; their holders must poll. */
  readonly overflow: number
  /** At least one of the type's streams is waiting out a refusal window (`refusalBackoff`). */
  readonly backedOff: boolean
  /** A stream of the type ended without the client asking, and its restart is waiting. */
  readonly restarting: boolean
  /** Ends in a row with no stream staying open for the longest delay. 0 when it is healthy. */
  readonly restartAttempts: number
  /** The last end the client didn't ask for; null if there has been none. */
  readonly lastEnd: LiveEnd | null
  /** The last event delivered for the type; null if none has been. */
  readonly lastEventAt: number | null
  /** When a waiting restart or refusal window ends; null if nothing is waiting. */
  readonly retryAt: number | null
  /** An event has arrived since the type's streams last started. Nothing else confirms a stream. */
  readonly confirmed: boolean
}

type Targets = ReadonlyMap<string, ReadonlySet<string>>

interface ActiveType {
  /** Subscription key → disposer. Keys are record ids (`key` mode) or chunk signatures. */
  readonly subscriptions: Map<string, () => void>
  overflow: number
}

/**
 * graphql-orm (0.88) ends a generated `Changed` stream with one of these codes when events were
 * lost: the subscriber fell behind the event channel, or the channel closed.
 */
const CONTINUITY_CODES = new Set(["SUBSCRIPTION_CONTINUITY_LOST", "SUBSCRIPTION_SOURCE_CLOSED"])

function lostContinuity(response: GraphQLResponse): boolean {
  return (response.errors ?? []).some((error) => CONTINUITY_CODES.has(String(error.extensions?.code)))
}

type GraphQLErrors = readonly { readonly message: string; readonly extensions?: Readonly<Record<string, unknown>> }[]

/**
 * The GraphQL errors a stream failed with, if the failure was the server answering with errors
 * (graphql-ws delivers a rejected subscribe as an array; an `OperationError` carries `errors`).
 * An `Error` without errors, or a socket close event, is a transport failure: null.
 */
function graphQLErrorsOf(failure: unknown): GraphQLErrors | null {
  const list = Array.isArray(failure) ? failure : (failure as { errors?: unknown } | null)?.errors
  if (!Array.isArray(list) || list.length === 0) return null
  const errors = list as Record<string, unknown>[]
  return errors.every((entry) => typeof entry === "object" && entry !== null && typeof entry.message === "string") ? (errors as unknown as GraphQLErrors) : null
}

const hasCode = (errors: GraphQLErrors, codes: ReadonlySet<string>) => errors.some((error) => codes.has(String(error.extensions?.code)))
const firstCode = (errors: GraphQLErrors | null): string | null => {
  const code = errors?.find((error) => error.extensions?.code !== undefined)?.extensions?.code
  return code === undefined ? null : String(code)
}

/** The router retired the graph this connection selected, and ends its streams with this code. */
const RELOAD_CODES = new Set(["SUBSCRIPTION_SCHEMA_RELOAD"])
/** The router can't serve the stream right now. A connection on a retired graph answers this. */
const UNAVAILABLE_CODES = new Set(["SERVICE_UNAVAILABLE"])

const DEFAULT_RESTART_MIN_MS = 1000
const DEFAULT_RESTART_MAX_MS = 60_000

/** Why a stream that failed with these errors ended (null: not GraphQL errors, the transport). */
function reasonFor(errors: GraphQLErrors | null, delivered: boolean): LiveEndReason {
  if (errors === null) return "transport"
  if (hasCode(errors, CONTINUITY_CODES)) return "lost"
  if (hasCode(errors, RELOAD_CODES)) return "reload"
  if (hasCode(errors, UNAVAILABLE_CODES)) return "unavailable"
  return delivered ? "errored" : "refused"
}

/** A type's restart: the waiting timer, the ends in a row, and when its streams last started. */
interface RestartState {
  handle: unknown
  attempts: number
  startedAt: number
  lastEnd: LiveEnd | null
  retryAt: number | null
  lastEventAt: number | null
}

/**
 * Keeps generated `<Type>Changed` subscriptions open for exactly the records that readers of
 * `@live` fragments currently hold, and writes each event's entity into the store.
 */
export class LiveManager {
  private readonly holders = new Map<string, Targets>()
  private readonly active = new Map<string, ActiveType>()
  private timer: unknown = null
  private disposed = false
  private subscriptionCount = 0
  private readonly restarts = new Map<string, RestartState>()
  /** Streams waiting out a refusal window, by identity, with the timer that ends the wait. */
  private readonly refused = new Map<string, { readonly typename: string; readonly handle: unknown; readonly until: number }>()
  private lastEventNotice = -Infinity
  private readonly artifacts: Readonly<Record<string, LiveArtifact>>

  /**
   * `resync` receives the holders that show records of a type whose events were lost, after the
   * type's subscriptions have been started again; the client refetches them.
   */
  constructor(
    private readonly store: Store,
    private readonly options: LiveOptions,
    private readonly resync: (holders: ReadonlySet<string>) => void = () => {},
    private readonly onChange: (timing?: boolean) => void = () => {}
  ) {
    this.artifacts = options.artifacts ?? {}
    this.disconnect =
      options.connection?.subscribe(({ reconnected }) => {
        this.onChange()
        if (reconnected && !this.disposed && this.holders.size) this.resync(new Set(this.holders.keys()))
      }) ?? null
  }

  private readonly disconnect: (() => void) | null

  /** The socket's state, or `unknown` when the transport doesn't report it. */
  get socket(): LiveSocketState {
    return this.options.connection?.state() ?? "unknown"
  }

  /** Whether a type has a usable live subscription. */
  covers(typename: string): boolean {
    return typename in this.artifacts
  }

  /** Whether some held records of a type have no subscription (beyond the per-record cap). */
  overflows(typename: string): boolean {
    const artifact = this.artifacts[typename]
    if (artifact?.mode !== "key" || artifact.keyOptional) return false
    return (this.held().get(typename)?.size ?? 0) > (this.options.maxKeyedSubscriptions ?? 50)
  }

  /** Replace the records one holder (a watched query) keeps live. Empty targets release it. */
  hold(holder: string, targets: Targets): void {
    if (this.disposed) return
    if (targets.size === 0) this.holders.delete(holder)
    else this.holders.set(holder, targets)
    this.schedule()
    this.onChange()
  }

  status(): Readonly<Record<string, LiveTypeStatus>> {
    const held = this.held()
    return Object.fromEntries(
      Object.values(this.artifacts).map((artifact) => {
        const active = this.active.get(artifact.typename)
        const restart = this.restarts.get(artifact.typename)
        return [
          artifact.typename,
          {
            mode: artifact.mode,
            held: held.get(artifact.typename)?.size ?? 0,
            subscriptions: active?.subscriptions.size ?? 0,
            overflow: active?.overflow ?? 0,
            backedOff: [...this.refused.values()].some((entry) => entry.typename === artifact.typename),
            restarting: (restart?.handle ?? null) !== null,
            restartAttempts: restart && (restart.handle !== null || this.now() - restart.startedAt < this.restartMaxMs()) ? restart.attempts : 0,
            lastEnd: restart?.lastEnd ?? null,
            lastEventAt: restart?.lastEventAt ?? null,
            retryAt: this.retryAt(artifact.typename),
            confirmed: restart !== undefined && restart.lastEventAt !== null && restart.lastEventAt >= restart.startedAt,
          },
        ]
      })
    )
  }

  /** Apply pending changes now (tests and shutdown). */
  flush(): void {
    if (this.timer !== null) (this.options.clearTimeout ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
    this.reconcile()
  }

  dispose(): void {
    this.disposed = true
    this.disconnect?.()
    if (this.timer !== null) (this.options.clearTimeout ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    for (const restart of this.restarts.values()) {
      if (restart.handle !== null) (this.options.clearTimeout ?? clearTimeout)(restart.handle as ReturnType<typeof setTimeout>)
    }
    this.restarts.clear()
    for (const entry of this.refused.values()) (this.options.clearTimeout ?? clearTimeout)(entry.handle as ReturnType<typeof setTimeout>)
    this.refused.clear()
    for (const active of this.active.values()) for (const stop of active.subscriptions.values()) stop()
    this.active.clear()
    this.holders.clear()
  }

  private schedule(): void {
    if (this.timer !== null) return
    const set = this.options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
    this.timer = set(() => {
      this.timer = null
      this.reconcile()
    }, this.options.debounceMs ?? 50)
  }

  private held(): Map<string, Set<string>> {
    const union = new Map<string, Set<string>>()
    for (const targets of this.holders.values()) {
      for (const [typename, ids] of targets) {
        const set = union.get(typename) ?? new Set<string>()
        for (const id of ids) set.add(id)
        union.set(typename, set)
      }
    }
    return union
  }

  private reconcile(): void {
    if (this.disposed) return
    const held = this.held()
    for (const artifact of Object.values(this.artifacts)) {
      const ids = [...(held.get(artifact.typename) ?? [])].sort()
      const active = this.active.get(artifact.typename) ?? { subscriptions: new Map(), overflow: 0 }
      this.active.set(artifact.typename, active)
      const wanted = new Map<string, Record<string, unknown>>()
      active.overflow = 0
      if (ids.length > 0) {
        if (artifact.mode === "unkeyed") {
          wanted.set("all", {})
        } else if (artifact.mode === "key") {
          const max = this.options.maxKeyedSubscriptions ?? 50
          if (ids.length > max && artifact.keyOptional) {
            wanted.set("all", {})
          } else {
            for (const id of ids.slice(0, max)) wanted.set(id, { [artifact.keyArgument!]: keyValue(artifact, id) })
            active.overflow = Math.max(0, ids.length - max)
          }
        } else {
          const max = this.options.maxKeys ?? 500
          for (let start = 0; start < ids.length; start += max) {
            const chunk = ids.slice(start, start + max)
            wanted.set(`keys:${chunk.join(",")}`, { [artifact.keyArgument!]: chunk.map((id) => keyValue(artifact, id)) })
          }
        }
      }
      for (const [key, stop] of [...active.subscriptions]) {
        if (!wanted.has(key)) {
          stop()
          active.subscriptions.delete(key)
        }
      }
      // A restart is waiting out its delay: no change to the held records may shorten it.
      if ((this.restarts.get(artifact.typename)?.handle ?? null) !== null) continue
      for (const [key, variables] of wanted) {
        if (active.subscriptions.has(key)) continue
        this.start(artifact, active, key, variables)
      }
    }
    this.onChange()
  }

  private start(artifact: LiveArtifact, active: ActiveType, key: string, variables: Record<string, unknown>): void {
    const { operation } = artifact
    const identity = refusalIdentity(artifact, key)
    // A refused stream is not asked for again until its window ends; the end of the window
    // reconciles, so it starts again by itself if the records are still held.
    if (this.refused.has(identity)) return
    this.markStarted(artifact.typename)
    let ended = false
    let stopped = false
    let delivered = false
    let answered: GraphQLErrors | null = null
    let dispose: (() => void) | null = null
    const stop = () => {
      stopped = true
      dispose?.()
    }
    const end = (reason: LiveEndReason, code: string | null) => {
      if (ended) return
      ended = true
      const requested = stopped
      if (active.subscriptions.get(key) === stop) active.subscriptions.delete(key)
      stop()
      if (requested) return
      this.ended(artifact, identity, reason, code)
      this.onChange()
    }
    active.subscriptions.set(key, stop)
    dispose = this.options.subscribe(
      { kind: "subscription", name: operation.name, text: operation.text, hash: operation.hash, variables },
      {
        next: (response) => {
          const errors = response.errors ?? []
          if (hasCode(errors, CONTINUITY_CODES) || hasCode(errors, RELOAD_CODES)) return end(reasonFor(errors, delivered), firstCode(errors))
          if (response.data) delivered = true
          else if (errors.length) answered = errors
          this.receive(artifact, response, variables)
        },
        error: (failure) => {
          const errors = graphQLErrorsOf(failure)
          end(reasonFor(errors, delivered), firstCode(errors))
        },
        complete: () => end(answered ? reasonFor(answered, delivered) : "completed", firstCode(answered)),
      }
    )
    if (ended) dispose()
  }

  /** A stream ended and nothing asked it to: remember a refusal, or restart the type. */
  private ended(artifact: LiveArtifact, identity: string, reason: LiveEndReason, code: string | null): void {
    if (this.disposed) return
    const state = this.restartState(artifact.typename)
    state.lastEnd = { reason, code, at: this.now() }
    if (reason === "refused" && this.backoffMs(artifact.typename) > 0) return this.remember(artifact, identity)
    // With `restart: false` only lost events restart a stream, as in 0.1.0-alpha.6.
    if (this.options.restart === false && reason !== "lost") return
    this.scheduleRestart(artifact.typename)
  }

  private restartMaxMs(): number {
    return (typeof this.options.restart === "object" ? this.options.restart.maxMs : undefined) ?? DEFAULT_RESTART_MAX_MS
  }

  private retryAt(typename: string): number | null {
    const windows = [...this.refused.values()].filter((entry) => entry.typename === typename).map((entry) => entry.until)
    const restart = this.restarts.get(typename)?.retryAt
    const all = restart === undefined || restart === null ? windows : [...windows, restart]
    return all.length ? Math.min(...all) : null
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private restartState(typename: string): RestartState {
    const existing = this.restarts.get(typename)
    if (existing) return existing
    const state: RestartState = { handle: null, attempts: 0, startedAt: this.now(), lastEnd: null, retryAt: null, lastEventAt: null }
    this.restarts.set(typename, state)
    return state
  }

  private markStarted(typename: string): void {
    const state = this.restartState(typename)
    // A stream already open keeps the clock running; only a start after a quiet spell moves it.
    const active = this.active.get(typename)
    if (!active || active.subscriptions.size === 0) state.startedAt = this.now()
  }

  /** The window for a type's refused streams, in ms; 0 for the ordinary back-off. */
  private backoffMs(typename: string): number {
    const config = this.options.refusalBackoff
    if (!config) return 0
    const own = config === true ? undefined : config.types?.[typename]
    const fallback = config === true ? DEFAULT_REFUSAL_BACKOFF_MS : config.ms
    const value = own === undefined ? fallback : own
    if (value === true) return DEFAULT_REFUSAL_BACKOFF_MS
    return typeof value === "number" && value > 0 ? value : 0
  }

  /** Remember that a stream was refused: no request for it until the window ends. */
  private remember(artifact: LiveArtifact, identity: string): void {
    const ms = this.backoffMs(artifact.typename)
    if (this.disposed || ms === 0 || this.refused.has(identity)) return
    const handle = this.after(() => {
      this.refused.delete(identity)
      // Nothing was delivered during the window, so the records may have changed.
      if (!this.disposed) this.restartNow(artifact.typename)
    }, ms)
    this.refused.set(identity, { typename: artifact.typename, handle, until: this.now() + ms })
  }

  /**
   * A type's stream ended. Subscribe again first, then read what shows the type, so no change falls
   * between the two. The first restart is below `resyncJitterMs`, which spreads clients that lost
   * their streams together; each further end in a row waits longer, up to `restart.maxMs`.
   */
  private scheduleRestart(typename: string): void {
    const state = this.restartState(typename)
    if (this.disposed || state.handle !== null) return
    const config = typeof this.options.restart === "object" ? this.options.restart : {}
    const maxMs = this.restartMaxMs()
    // A stream that stayed open for the longest delay had recovered.
    if (this.now() - state.startedAt >= maxMs) state.attempts = 0
    const attempts = state.attempts
    state.attempts += 1
    // `restart: false` keeps the fixed delay it always had for lost events.
    const delay =
      attempts === 0 || this.options.restart === false
        ? Math.random() * (this.options.resyncJitterMs ?? 1000)
        : Math.min(maxMs, (config.minMs ?? DEFAULT_RESTART_MIN_MS) * 2 ** (attempts - 1)) * (0.5 + Math.random() * 0.5)
    state.retryAt = this.now() + delay
    state.handle = this.after(() => {
      state.handle = null
      state.retryAt = null
      state.startedAt = this.now()
      if (!this.disposed) this.restartNow(typename)
    }, delay)
  }

  /** Start the type's missing streams, then read what shows the type. */
  private restartNow(typename: string): void {
    this.reconcile()
    const holders = new Set<string>()
    for (const [holder, targets] of this.holders) if (targets.get(typename)?.size) holders.add(holder)
    if (holders.size) this.resync(holders)
    else this.restarts.delete(typename)
  }

  /** A timer that must not keep a Node process (SSR, tests) alive. */
  private after(callback: () => void, ms: number): unknown {
    if (this.options.setTimeout) return this.options.setTimeout(callback, ms)
    const timer = setTimeout(callback, ms)
    ;(timer as { unref?: () => void }).unref?.()
    return timer
  }

  /** An event arrived. Say so at once if it confirms the stream, and at most once a second otherwise. */
  private noteEvent(typename: string): void {
    const state = this.restartState(typename)
    const now = this.now()
    const confirming = state.lastEventAt === null || state.lastEventAt < state.startedAt
    state.lastEventAt = now
    if (!confirming && now - this.lastEventNotice < 1000) return
    this.lastEventNotice = now
    this.onChange(true)
  }

  private receive(artifact: LiveArtifact, response: GraphQLResponse, variables: Record<string, unknown>): void {
    if (this.disposed || this.store.isDisposed) return
    const payload = response.data?.[artifact.field] as Record<string, unknown> | null | undefined
    const entity = payload?.[artifact.entityField] as Record<string, unknown> | null | undefined
    if (!payload || !entity) return
    const id = identify(entity, artifact.operation.keys)
    if (id === null) return
    // A stream without keys carries every record of the type; only held records are written.
    if (!this.held().get(artifact.typename)?.has(id)) return
    this.noteEvent(artifact.typename)
    if (payload[artifact.actionField] === "DELETED") {
      this.store.delete(id)
    } else {
      const root = `client:subscription:${++this.subscriptionCount}`
      // The event payload has no key and nothing reads it afterwards, so it isn't kept. Objects
      // embedded in the changed entity stay with it.
      const embedded = new Set<string>()
      normalize(this.store, artifact.operation.normalization, response.data!, { ...contextOf(artifact.operation, variables), embedded }, root, "Subscription")
      this.store.delete(root)
      for (const embeddedId of embedded) if (embeddedId.startsWith(`${root}.`)) this.store.delete(embeddedId)
    }
    this.store.publish()
  }
}

/**
 * What "a stream" is for remembering a refusal: the type's generated `Changed` subscription, and in
 * `key` mode the record it is for. The chunk of keys in `keys` mode is left out on purpose: it
 * changes whenever a list refresh changes the held records, which would make every refresh a new
 * stream. The manager belongs to one client, and so to one identity, so identity is not part of it.
 */
function refusalIdentity(artifact: LiveArtifact, key: string): string {
  return artifact.mode === "key" && key !== "all" ? `${artifact.typename}\u0000${key}` : artifact.typename
}

/** The `Key` value for a record: its single key, or an object of its composite key fields. */
function keyValue(artifact: LiveArtifact, id: string): unknown {
  const decoded = decodeNodeId(id)
  if (!decoded) throw new Error(`Not a NodeId: ${id}`)
  if (artifact.keyFields.length === 1) return decoded.keyParts[0]
  return Object.fromEntries(artifact.keyFields.map((field, index) => [field, decoded.keyParts[index]]))
}
