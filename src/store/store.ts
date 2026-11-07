import { lifetimeTime, type LifetimePolicy, type LifetimeState } from "./lifetime.js"
import type { Selection } from "../artifact.js"
import { readSelections, type ReadResult } from "./read.js"
import type { Variables } from "./arguments.js"

/** The id of the root record that holds Query fields. */
export const ROOT_ID = "client:root"

/** A link to one record, or a list of links (null entries allowed). */
export type StoredLink = { readonly __ref: string }
export type StoredLinks = { readonly __refs: readonly (string | null)[] }
export type StoredValue = unknown

export interface StoredRecord {
  readonly __id: string
  readonly __typename: string
  readonly fields: Map<string, StoredValue>
}

/** What a reader subscribes to: selections read from one record with fixed variables. */
export interface Selector {
  readonly id: string
  readonly selections: readonly Selection[]
  readonly variables: Variables
  readonly fragments: Readonly<Record<string, { readonly selections: readonly Selection[] }>>
}

export interface Snapshot<T = unknown> extends ReadResult<T> {
  readonly selector: Selector
}

/** What an optimistic write changed, so it can be rolled back. */
export interface OptimisticLayer {
  readonly backups: Map<string, { readonly typename: string; readonly fields: Map<string, StoredValue> } | null>
  readonly written: Map<string, Map<string, StoredValue>>
}

export interface StoreOptions {
  /** Explicit per-type expiry policies; also carried by generated artifacts. */
  readonly lifetimes?: Readonly<Record<string, LifetimePolicy>>
  /** Clock for lifetime evaluation. */
  readonly now?: () => number
  /** Reports values with unknown lifetime. */
  readonly onDiagnostic?: (diagnostic: { code: string; message: string }) => void

  /** Omit absent list nodes while a delete-triggered query refresh is pending. Opt-in migration. */
  readonly deletedRecords?: "omit"
  /** How long an unretained operation's records stay before collection. Default 5 minutes. */
  readonly retainMs?: number
  /** Timer seam for tests. */
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
}

interface Subscription {
  snapshot: Snapshot
  readonly callback: (snapshot: Snapshot) => void
}

interface Retention {
  readonly selector: Selector
  count: number
  timer: unknown
}

/**
 * The normalised record store. Records are keyed by NodeId; anything without a complete key is
 * stored under a path below its parent. Writers call `publish()` after a batch of writes;
 * subscribers whose snapshot read a changed record are re-read and notified once.
 */
export class Store {
  /** Refresh batched dependencies after refetch or reconnect. */
  refreshRelations?: (selector: Selector) => void
  /** Resolve a compiler-declared relation; installed by the optional relations entry point. */
  relation?: (selection: import("../artifact.js").LinkSelection, parent: string, variables: Variables) => { status: string; id?: string; stateId?: string; error?: unknown }

  /** A collection is reading to see what's reachable, so a relation read mustn't start a request. */
  collecting = false

  /** Notify readers after a derived relation changes state. */
  touch(id: string): void {
    if (this.disposed) return
    this.changed.add(id)
    this.touched.add(id)
  }

  private readonly touched = new Set<string>()

  /** Whether readers omit removed nodes from lists. */
  readonly deletedRecords: "omit" | undefined
  private readonly records = new Map<string, StoredRecord>()
  private readonly changed = new Set<string>()
  private readonly subscriptions = new Set<Subscription>()
  private readonly retained = new Map<string, Retention>()
  private disposed = false
  private readonly retainMs: number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.diagnostic = options.onDiagnostic
    this.deletedRecords = options.deletedRecords
    this.retainMs = options.retainMs ?? 5 * 60_000
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.configureLifetimes(options.lifetimes)
  }

  private readonly policies = new Map<string, LifetimePolicy>()
  private readonly lifetimeStates = new Map<string, LifetimeState>()
  private expiryTimer: unknown = null
  private readonly now: () => number
  private readonly diagnostic?: StoreOptions["onDiagnostic"]

  /** Register generator-declared policies before normalisation. */
  configureLifetimes(policies?: Readonly<Record<string, LifetimePolicy>>): void {
    for (const [type, policy] of Object.entries(policies ?? {})) this.policies.set(type, policy)
    if (policies && this.records.size && !this.disposed) this.scheduleExpiry()
  }

  /** Undefined means the type has no lifetime policy. */
  lifetime(id: string): LifetimeState | undefined {
    const record = this.records.get(id)
    const policy = record && this.policies.get(record.__typename)
    if (!record || !policy) return undefined
    const time = lifetimeTime(record.fields.get(policy.field), policy.format)
    return time === null ? "unknown" : time <= this.now() ? "expired" : "valid"
  }

  private nextExpiry = Infinity

  /** Note what these records' lifetimes say now. A publish looks only at what changed, so a large store isn't scanned per event. */
  private checkLifetimes(ids: Iterable<string>): void {
    for (const id of ids) {
      const record = this.records.get(id)
      const policy = record && this.policies.get(record.__typename)
      if (!record || !policy) continue
      const state = this.lifetime(id)!
      if (state !== this.lifetimeStates.get(id)) {
        this.changed.add(id)
        if (state === "unknown") {
          try { this.diagnostic?.({ code: "LIFETIME_UNKNOWN", message: `Cannot determine lifetime of ${record.__typename}.${policy.field}` }) } catch { /* diagnostics must not affect reads */ }
        }
      }
      this.lifetimeStates.set(id, state)
      const time = lifetimeTime(record.fields.get(policy.field), policy.format)
      if (time !== null && time > this.now()) this.nextExpiry = Math.min(this.nextExpiry, time)
    }
  }

  /** One timer per store. It can fire early, after a record's expiry moved; the full scan then finds the real next one. */
  private armExpiry(): void {
    if (this.expiryTimer !== null) this.clearTimer(this.expiryTimer)
    this.expiryTimer = null
    if (this.nextExpiry === Infinity || this.disposed) return
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null
      this.scheduleExpiry()
      this.publish()
    }, Math.min(2147483647, Math.max(1, this.nextExpiry - this.now())))
  }

  private scheduleExpiry(): void {
    this.nextExpiry = Infinity
    this.checkLifetimes([...this.records.keys()])
    this.armExpiry()
  }

  private readonly observers = new Set<() => void>()
  private readonly disposers = new Set<() => void>()
  private readonly restored = new Set<string>()
  private readonly layers = new Set<OptimisticLayer>()

  /** Observe published batches and identity disposal; used by optional persistence. */
  observeWrites(write: () => void, dispose: () => void): () => void {
    this.assertLive()
    this.observers.add(write); this.disposers.add(dispose)
    return () => { this.observers.delete(write); this.disposers.delete(dispose) }
  }

  /** Restored records remain stale until a network write reaches them. */
  isRestored(id: string): boolean { return this.restored.has(id) }

  /** Snapshot confirmed data only. Active optimistic layers postpone persistence. */
  persistenceSnapshot(): readonly { id: string; typename: string; fields: readonly (readonly [string, unknown])[] }[] | null {
    if (this.layers.size || this.journal || this.disposed) return null
    // Relation states are derived, and an error in one isn't data to keep.
    return [...this.records.values()].filter(r => r.__typename !== "BatchState").map(r => ({ id: r.__id, typename: r.__typename, fields: [...r.fields] }))
  }

  private restoreBlocked: Set<string> | null = null

  /** Protect writes and deletions while asynchronous persistence is being loaded. Call the returned
   * function even when loading fails, to release the temporary write journal. */
  beginRestore(): (records: Parameters<Store["restore"]>[0]) => void {
    if (this.restoreBlocked) throw new Error("A restore is already pending")
    const blocked = new Set(this.records.keys())
    this.restoreBlocked = blocked
    return records => {
      if (this.restoreBlocked !== blocked) return
      this.restoreBlocked = null
      this.restore(records.filter(record => !blocked.has(record.id)))
    }
  }

  /** Fill absent records only: any write arriving during restore wins, with or without versions. */
  restore(records: readonly { id: string; typename: string; fields: readonly (readonly [string, unknown])[] }[]): void {
    if (this.disposed) return
    for (const entry of records) {
      if (this.records.has(entry.id)) continue
      this.records.set(entry.id, { __id: entry.id, __typename: entry.typename, fields: new Map(entry.fields) })
      this.restored.add(entry.id)
      this.changed.add(entry.id)
    }
    this.publish()
  }

  get(id: string): StoredRecord | undefined {
    return this.records.get(id)
  }

  /** Create the record if missing. A typename change replaces the record. */
  getOrCreate(id: string, typename: string): StoredRecord {
    this.assertLive()
    const existing = this.records.get(id)
    this.restoreBlocked?.add(id)
    this.backup(id)
    if (existing && existing.__typename === typename) return existing
    const record: StoredRecord = { __id: id, __typename: typename, fields: new Map() }
    this.records.set(id, record)
    this.changed.add(id)
    return record
  }

  setField(record: StoredRecord, key: string, value: StoredValue): void {
    this.restoreBlocked?.add(record.__id)
    if (!this.journal && this.restored.delete(record.__id)) this.changed.add(record.__id)
    const previous = record.fields.get(key)
    if (record.fields.has(key) && sameValue(previous, value)) return
    this.backup(record.__id)
    if (this.journal) {
      const written = this.journal.written.get(record.__id) ?? new Map<string, StoredValue>()
      written.set(key, value)
      this.journal.written.set(record.__id, written)
    }
    record.fields.set(key, value)
    this.changed.add(record.__id)
  }

  private journal: OptimisticLayer | null = null

  private backup(id: string): void {
    const journal = this.journal
    if (!journal || journal.backups.has(id)) return
    const existing = this.records.get(id)
    journal.backups.set(
      id,
      existing ? { typename: existing.__typename, fields: new Map(existing.fields) } : null
    )
  }

  /**
   * Apply writes as an optimistic layer. Rolling it back restores each field the layer wrote,
   * unless something newer (a response or live event) has replaced it since.
   */
  optimistic(write: () => void): OptimisticLayer {
    if (this.journal) throw new Error("Optimistic layers cannot nest")
    const layer: OptimisticLayer = { backups: new Map(), written: new Map() }
    this.layers.add(layer)
    this.journal = layer
    try {
      write()
    } finally {
      this.journal = null
    }
    this.publish()
    return layer
  }

  rollback(layer: OptimisticLayer): void {
    this.layers.delete(layer)
    for (const [id, written] of layer.written) {
      const record = this.records.get(id)
      if (!record) continue
      const backup = layer.backups.get(id)
      let untouched = true
      for (const [key, value] of written) {
        if (!sameValue(record.fields.get(key), value)) {
          untouched = false
          continue
        }
        if (backup && backup.fields.has(key)) record.fields.set(key, backup.fields.get(key))
        else record.fields.delete(key)
        this.changed.add(id)
      }
      // A record the layer created, and nothing else has written to, goes away again.
      if (backup === null && untouched && record.fields.size === 0) this.delete(id)
    }
    for (const [id, backup] of layer.backups) {
      if (backup === null && !layer.written.has(id)) this.delete(id)
    }
    this.publish()
  }

  delete(id: string): void {
    this.restoreBlocked?.add(id)
    this.restored.delete(id)
    this.lifetimeStates.delete(id)
    if (this.records.delete(id)) this.changed.add(id)
  }

  /** Read a selector now, without subscribing. */
  lookup<T = unknown>(selector: Selector): Snapshot<T> {
    return { ...readSelections<T>(this, selector), selector }
  }

  /** Notify subscribers affected by the writes since the last publish. */
  publish(): void {
    if (this.disposed) return
    if (this.policies.size) {
      const before = this.nextExpiry
      this.checkLifetimes([...this.changed])
      if (this.nextExpiry !== before || (this.expiryTimer === null && this.nextExpiry !== Infinity)) this.armExpiry()
    }
    if (this.changed.size === 0) return
    for (const observer of this.observers) observer()
    const changed = new Set(this.changed)
    this.changed.clear()
    const touched = new Set(this.touched)
    this.touched.clear()
    for (const subscription of [...this.subscriptions]) {
      if (!this.subscriptions.has(subscription)) continue
      const previous = subscription.snapshot
      if (![...previous.seen].some((id) => changed.has(id))) continue
      const next = this.lookup(previous.selector)
      const data = recycle(previous.data, next.data)
      // A resolved relation can leave a query's masked data the same while it comes to show more records, and the query has to hear that,
      // to hold them. Any other unchanged read notifies nobody.
      if (data === previous.data && next.missing === previous.missing && next.lifetime === previous.lifetime && next.stale === previous.stale && ![...previous.seen].some((id) => touched.has(id))) {
        subscription.snapshot = { ...next, data: previous.data }
        continue
      }
      subscription.snapshot = { ...next, data }
      subscription.callback(subscription.snapshot)
    }
  }

  subscribe(snapshot: Snapshot, callback: (snapshot: Snapshot) => void): () => void {
    const subscription: Subscription = { snapshot, callback }
    this.subscriptions.add(subscription)
    return () => {
      this.subscriptions.delete(subscription)
    }
  }

  /**
   * Keep the records an operation reaches. Releasing starts the retention period; the records
   * are collected afterwards unless another retention still reaches them.
   */
  retain(key: string, selector: Selector): () => void {
    this.assertLive()
    const existing = this.retained.get(key)
    if (existing) {
      if (existing.timer !== null) this.clearTimer(existing.timer)
      existing.timer = null
      existing.count += 1
    } else {
      this.retained.set(key, { selector, count: 1, timer: null })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const retention = this.retained.get(key)
      if (!retention) return
      retention.count -= 1
      if (retention.count > 0) return
      retention.timer = this.setTimer(() => {
        if (this.retained.get(key) !== retention || retention.count > 0) return
        this.retained.delete(key)
        this.collect()
      }, this.retainMs)
    }
  }

  /** Delete every record no retained operation reaches. */
  collect(): void {
    this.collecting = true
    try {
      this.sweep()
    } finally {
      this.collecting = false
    }
  }

  private sweep(): void {
    if (this.disposed) return
    const reachable = new Set<string>([ROOT_ID])
    const rootKeys = new Set<string>()
    for (const retention of this.retained.values()) {
      const result = readSelections(this, retention.selector, { inlineSpreads: true, rootKeys })
      for (const id of result.seen) reachable.add(id)
    }
    for (const subscription of this.relation ? this.subscriptions : []) {
      const result = readSelections(this, subscription.snapshot.selector, { inlineSpreads: true, rootKeys })
      for (const id of result.seen) reachable.add(id)
    }
    for (const id of [...this.records.keys()]) {
      if (!reachable.has(id)) this.delete(id)
    }
    const root = this.records.get(ROOT_ID)
    if (root) {
      for (const key of [...root.fields.keys()]) {
        if (!rootKeys.has(key)) {
          root.fields.delete(key)
          this.changed.add(ROOT_ID)
        }
      }
    }
    this.publish()
  }

  /** Clear every record and timer. Used when the signed-in identity changes. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers) dispose()
    this.disposers.clear(); this.observers.clear(); this.restored.clear(); this.layers.clear(); this.restoreBlocked = null
    if (this.expiryTimer !== null) this.clearTimer(this.expiryTimer)
    this.expiryTimer = null
    this.lifetimeStates.clear()
    for (const retention of this.retained.values()) {
      if (retention.timer !== null) this.clearTimer(retention.timer)
    }
    this.retained.clear()
    this.subscriptions.clear()
    this.records.clear()
    this.relation = undefined
    this.refreshRelations = undefined
    this.changed.clear()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Number of stored records; for diagnostics and tests. */
  get size(): number {
    return this.records.size
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("This store was disposed with its identity")
  }
}

/** Fragment references are equal when they point at the same record with the same fragments. */
function sameRef(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  const left = a as { id?: unknown; fragments?: ReadonlySet<string>; store?: unknown }
  const right = b as { id?: unknown; fragments?: ReadonlySet<string>; store?: unknown }
  if (left.id !== right.id || left.store !== right.store) return false
  const l = [...(left.fragments ?? [])].sort().join(",")
  const r = [...(right.fragments ?? [])].sort().join(",")
  return l === r
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Structural sharing: return `previous` (or parts of it) wherever `next` is deeply equal, so
 * unchanged subtrees keep their identity and React skips them.
 */
export function recycle<T>(previous: T, next: T): T {
  if (previous === next) return previous
  if (typeof previous !== "object" || typeof next !== "object" || previous === null || next === null)
    return next
  if (Array.isArray(previous) !== Array.isArray(next)) return next
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length
    const items = next.map((item, index) => {
      const recycled = index < previous.length ? recycle(previous[index], item) : item
      if (recycled !== previous[index]) same = false
      return recycled
    })
    return (same ? previous : items) as T
  }
  const prev = previous as Record<string, unknown>
  const nxt = next as Record<string, unknown>
  const keys = Object.keys(nxt)
  let same = keys.length === Object.keys(prev).length
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const recycled = key in prev ? recycle(prev[key], nxt[key]) : nxt[key]
    if (recycled !== prev[key]) same = false
    result[key] = recycled
  }
  const symbols = Object.getOwnPropertySymbols(nxt)
  if (symbols.length !== Object.getOwnPropertySymbols(prev).length) same = false
  for (const symbol of symbols) {
    if (!sameRef((prev as Record<symbol, unknown>)[symbol], (nxt as Record<symbol, unknown>)[symbol])) same = false
  }
  if (same) return previous
  // Masked fragment references carry hidden properties; keep them on the new object.
  for (const symbol of symbols) {
    Object.defineProperty(result, symbol, { value: (nxt as Record<symbol, unknown>)[symbol], enumerable: false })
  }
  return result as T
}
