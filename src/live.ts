import type { LiveArtifact, LiveMode } from "./artifact.js"
import type { GraphQLResponse, OperationRequest } from "./client.js"
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
   * immediate retry.
   */
  readonly ms?: number
  /**
   * Per type (the generated `<Type>Changed` subscription is the operation). A number sets that
   * type's window, `true` uses `DEFAULT_REFUSAL_BACKOFF_MS` and `false` keeps immediate retry: the
   * stream starts again on the next change to the records it holds, as without the option. Use
   * `false` for a stream with no poll behind it.
   */
  readonly types?: Readonly<Record<string, number | boolean>>
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
   * Off by default. When a stream ends because the server refused it (see `docs/design.md`), the
   * live layer remembers that for a window, starts no request for it however often the held
   * records change, and subscribes again when the window ends. `true` is five minutes for every
   * type; see `RefusalBackoff` for a window per type and opting a type out. A close that reports
   * lost events (`SUBSCRIPTION_CONTINUITY_LOST`, `SUBSCRIPTION_SOURCE_CLOSED`) and a transport
   * failure are never remembered. The memory belongs to the client and goes with it when the
   * identity changes. Uses `setTimeout` and `clearTimeout` below, so tests can drive the window.
   */
  readonly refusalBackoff?: boolean | RefusalBackoff
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
}

export interface LiveTypeStatus {
  readonly mode: LiveMode
  readonly held: number
  readonly subscriptions: number
  /** Records held but not covered by a subscription; their holders must poll. */
  readonly overflow: number
  /** At least one of the type's streams is waiting out a refusal window (`refusalBackoff`). */
  readonly backedOff: boolean
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

const hasContinuityCode = (errors: GraphQLErrors) => errors.some((error) => CONTINUITY_CODES.has(String(error.extensions?.code)))

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
  private readonly resyncs = new Map<string, unknown>()
  /** Streams waiting out a refusal window, by identity, with the timer that ends the wait. */
  private readonly refused = new Map<string, { readonly typename: string; readonly handle: unknown }>()
  private readonly artifacts: Readonly<Record<string, LiveArtifact>>

  /**
   * `resync` receives the holders that show records of a type whose events were lost, after the
   * type's subscriptions have been started again; the client refetches them.
   */
  constructor(
    private readonly store: Store,
    private readonly options: LiveOptions,
    private readonly resync: (holders: ReadonlySet<string>) => void = () => {}
  ) {
    this.artifacts = options.artifacts ?? {}
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
  }

  status(): Readonly<Record<string, LiveTypeStatus>> {
    const held = this.held()
    return Object.fromEntries(
      Object.values(this.artifacts).map((artifact) => {
        const active = this.active.get(artifact.typename)
        return [
          artifact.typename,
          {
            mode: artifact.mode,
            held: held.get(artifact.typename)?.size ?? 0,
            subscriptions: active?.subscriptions.size ?? 0,
            overflow: active?.overflow ?? 0,
            backedOff: [...this.refused.values()].some((entry) => entry.typename === artifact.typename),
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
    if (this.timer !== null) (this.options.clearTimeout ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    for (const handle of this.resyncs.values()) (this.options.clearTimeout ?? clearTimeout)(handle as ReturnType<typeof setTimeout>)
    this.resyncs.clear()
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
      for (const [key, variables] of wanted) {
        if (active.subscriptions.has(key)) continue
        this.start(artifact, active, key, variables)
      }
    }
  }

  private start(artifact: LiveArtifact, active: ActiveType, key: string, variables: Record<string, unknown>): void {
    const { operation } = artifact
    const identity = refusalIdentity(artifact, key)
    // A refused stream is not asked for again until its window ends; the end of the window
    // reconciles, so it starts again by itself if the records are still held.
    if (this.refused.has(identity)) return
    let ended = false
    let stopped = false
    let delivered = false
    let answeredWithErrors = false
    let dispose: (() => void) | null = null
    const stop = () => {
      stopped = true
      dispose?.()
    }
    // The stream ended from the server's side. It is started again only when events were lost;
    // after any other end, the next change to the held records starts it. An end that is a refusal
    // is also remembered, when the option is on.
    const end = (lost: boolean, refusal = false) => {
      if (ended) return
      ended = true
      const requested = !stopped
      if (active.subscriptions.get(key) === stop) active.subscriptions.delete(key)
      stop()
      if (lost) this.scheduleResync(artifact.typename)
      else if (refusal && requested) this.remember(artifact, identity)
    }
    active.subscriptions.set(key, stop)
    dispose = this.options.subscribe(
      { kind: "subscription", name: operation.name, text: operation.text, hash: operation.hash, variables },
      {
        next: (response) => {
          if (lostContinuity(response)) return end(true)
          if (response.data) delivered = true
          else if (response.errors?.length) answeredWithErrors = true
          this.receive(artifact, response, variables)
        },
        error: (failure) => {
          const errors = graphQLErrorsOf(failure)
          // The server answered the subscribe with errors, and no event ever arrived: a refusal.
          // Lost events (a continuity code) and failures of the transport are neither.
          end(false, errors !== null && !delivered && !hasContinuityCode(errors))
        },
        complete: () => end(false, answeredWithErrors && !delivered),
      }
    )
    if (ended) dispose()
  }

  /** The window for a type's refused streams, in ms; 0 for immediate retry. */
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
    const set =
      this.options.setTimeout ??
      ((callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay)
        // A window must not keep a Node process (SSR, tests) alive.
        ;(timer as { unref?: () => void }).unref?.()
        return timer
      })
    const handle = set(() => {
      this.refused.delete(identity)
      if (!this.disposed) this.reconcile()
    }, ms)
    this.refused.set(identity, { typename: artifact.typename, handle })
  }

  /**
   * Events of a type were lost. Subscribe again first, then refetch what shows the type, so no
   * change falls between the two. A random delay spreads clients that lost events together.
   */
  private scheduleResync(typename: string): void {
    if (this.disposed || this.resyncs.has(typename)) return
    const set = this.options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
    const handle = set(() => {
      this.resyncs.delete(typename)
      if (this.disposed) return
      this.reconcile()
      const holders = new Set<string>()
      for (const [holder, targets] of this.holders) if (targets.get(typename)?.size) holders.add(holder)
      if (holders.size) this.resync(holders)
    }, Math.random() * (this.options.resyncJitterMs ?? 1000))
    this.resyncs.set(typename, handle)
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
