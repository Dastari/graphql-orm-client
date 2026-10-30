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

export interface LiveOptions {
  /** Compiled live artifacts per type (`compile(...).live`). */
  readonly artifacts: Readonly<Record<string, LiveArtifact>>
  /** Start a subscription (for example through graphql-ws); returns its disposer. */
  readonly subscribe: (request: OperationRequest, sink: SubscriptionSink) => () => void
  /** Per-record subscriptions allowed per type in `key` mode before the rest overflow. Default 50. */
  readonly maxKeyedSubscriptions?: number
  /** Largest `Keys` list per subscription in `keys` mode. Default 500. */
  readonly maxKeys?: number
  /** Delay before changes to the held records reach the server. Default 50 ms. */
  readonly debounceMs?: number
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
}

export interface LiveTypeStatus {
  readonly mode: LiveMode
  readonly held: number
  readonly subscriptions: number
  /** Records held but not covered by a subscription; their holders must poll. */
  readonly overflow: number
}

type Targets = ReadonlyMap<string, ReadonlySet<string>>

interface ActiveType {
  /** Subscription key → disposer. Keys are record ids (`key` mode) or chunk signatures. */
  readonly subscriptions: Map<string, () => void>
  overflow: number
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

  constructor(
    private readonly store: Store,
    private readonly options: LiveOptions
  ) {}

  /** Whether a type has a usable live subscription. */
  covers(typename: string): boolean {
    return typename in this.options.artifacts
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
      Object.values(this.options.artifacts).map((artifact) => {
        const active = this.active.get(artifact.typename)
        return [
          artifact.typename,
          {
            mode: artifact.mode,
            held: held.get(artifact.typename)?.size ?? 0,
            subscriptions: active?.subscriptions.size ?? 0,
            overflow: active?.overflow ?? 0,
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
    for (const artifact of Object.values(this.options.artifacts)) {
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
          for (const id of ids.slice(0, max)) wanted.set(id, { [artifact.keyArgument!]: keyValue(artifact, id) })
          active.overflow = Math.max(0, ids.length - max)
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
        active.subscriptions.set(key, this.start(artifact, variables))
      }
    }
  }

  private start(artifact: LiveArtifact, variables: Record<string, unknown>): () => void {
    const { operation } = artifact
    return this.options.subscribe(
      { kind: "subscription", name: operation.name, text: operation.text, hash: operation.hash, variables },
      {
        next: (response) => this.receive(artifact, response, variables),
        error: () => {},
        complete: () => {},
      }
    )
  }

  private receive(artifact: LiveArtifact, response: GraphQLResponse, variables: Record<string, unknown>): void {
    if (this.disposed || this.store.isDisposed) return
    const payload = response.data?.[artifact.field] as Record<string, unknown> | null | undefined
    const entity = payload?.[artifact.entityField] as Record<string, unknown> | null | undefined
    if (!payload || !entity) return
    const id = identify(entity, artifact.operation.keys)
    if (id === null) return
    // An unkeyed stream carries every record of the type; only held records are written.
    if (artifact.mode === "unkeyed" && !this.held().get(artifact.typename)?.has(id)) return
    if (payload[artifact.actionField] === "DELETED") {
      this.store.delete(id)
    } else {
      const root = `client:subscription:${++this.subscriptionCount}`
      normalize(this.store, artifact.operation.normalization, response.data!, contextOf(artifact.operation, variables), root, "Subscription")
      this.store.delete(root)
    }
    this.store.publish()
  }
}

/** The `Key` value for a record: its single key, or an object of its composite key fields. */
function keyValue(artifact: LiveArtifact, id: string): unknown {
  const decoded = decodeNodeId(id)
  if (!decoded) throw new Error(`Not a NodeId: ${id}`)
  if (artifact.keyFields.length === 1) return decoded.keyParts[0]
  return Object.fromEntries(artifact.keyFields.map((field, index) => [field, decoded.keyParts[index]]))
}
