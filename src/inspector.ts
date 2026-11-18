import type { Selection } from "./artifact.js"
import type { Client, QueryStatus } from "./client.js"
import type { ReadCause } from "./health.js"
import type { LiveManager } from "./live.js"
import { stableStringify, type Variables } from "./store/arguments.js"
import type { LifetimeState } from "./store/lifetime.js"
import { readSelections } from "./store/read.js"

/**
 * Why a query was read. Every `ReadCause`, and two the client counts as `stale`:
 * - `event`: an event for a record the query holds carried something the query can't use (a keys-only stream, a child deleted
 *   below the record, a field the stream can't carry), so the query was read again. `typename` names the event's type.
 * - `list`: an event for the type of a list the query shows, so the list was read again. `typename` names the type.
 *
 * The others are as in `liveHealth().reads`: `first` (a query opened), `manual` (`refetch`, `client.query`, `client.execute`),
 * `poll` (an interval, or the fallback poll for records no stream covers), `stale` (a record the query shows was deleted or
 * collected), `confirm` (a stream started covering its records), `restart` (a stream ended, or a refusal window ended, and was
 * started again), `reconnect` (the socket reconnected, or `reconnectLive()`), `burst` (burst repair), `pagination` (`loadMore`, or a
 * list starting again after a refused cursor), `relation` (an `@batch` relation), `retry` (a read that got no response, sent
 * again) and `online` (the browser came back online).
 */
export type InspectedReadCause = ReadCause | "event" | "list"

/** One read of a query, in the order the client started them. */
export interface InspectedRead {
  /** When the client started it, on the client's clock (`live.now`, else `Date.now`). */
  readonly at: number
  readonly operation: string
  /** The variables it was sent with. A `loadMore` read has the next page's. */
  readonly variables: Variables
  /**
   * The `InspectedQuery.key` of the query keeping records under these variables: a watched query's, else a `client.query` read's.
   * Null when none does, as for a `loadMore` page, a `readAll` page or a `client.execute` call.
   */
  readonly query: string | null
  readonly cause: InspectedReadCause
  /** The type of the event behind an `event` or `list` read. */
  readonly typename?: string
}

/** A record in the client's store. */
export interface InspectedRecord {
  /** The record's `NodeId`, or a path below its parent for an object with no complete key. */
  readonly id: string
  readonly typename: string
  /** A copy of the stored fields, by storage key. A link is `{ __ref: id }` and a list of links `{ __refs: [id, ...] }`. */
  readonly fields: Readonly<Record<string, unknown>>
  /**
   * The `key` of each retained query whose read reaches the record. Empty means no query keeps it: the next collection deletes it,
   * unless it is the root record (`client:root`) or, with `@batch` relation batching installed, a mounted fragment or query reaches it.
   */
  readonly heldBy: readonly string[]
  /** The `id` of each stream whose events are written into the record. */
  readonly coveredBy: readonly string[]
  /** What the type's lifetime field says, for a type with a lifetime policy. */
  readonly lifetime?: LifetimeState
  /** Restored by persistence and not yet confirmed by a read. */
  readonly restored?: true
}

/** A query keeping records in the store. */
export interface InspectedQuery {
  readonly key: string
  /** The operation's name; null when it closed before this inspector saw it. */
  readonly operation: string | null
  readonly variables: Variables
  /**
   * `open`: a view has it open, or a `client.query` read is under way. `released`: nothing uses it, and its records stay until the
   * retention period (`store.retainMs`) ends.
   */
  readonly state: "open" | "released"
  /** A watched query's status; absent for a `client.query` read. */
  readonly status?: QueryStatus
  /** How often it polls; null when it doesn't, or isn't a watched query. */
  readonly pollMs: number | null
  /** The records its read reaches. */
  readonly records: readonly string[]
}

/** A generated `Changed` stream the live layer has open. */
export interface InspectedStream {
  readonly id: string
  readonly typename: string
  /** The generated subscription it runs. */
  readonly operation: string
  /** `all`: every record of the type (a list, or a type with no key argument); `key`: one record; `keys`: a group of records. */
  readonly scope: "all" | "key" | "keys"
  /** The server refused the full selection, so it carries keys only and each event means a read. */
  readonly thin: boolean
  /** The held records whose events it writes into the store. */
  readonly records: readonly string[]
}

/** What `subscribe` listeners hear. */
export type InspectorEvent =
  | { readonly type: "read"; readonly read: InspectedRead }
  /** The store published a batch of writes to these records. Read `records()` again. */
  | { readonly type: "write"; readonly ids: readonly string[] }
  /** The client was disposed, or `dispose()` was called. The inspector holds nothing and has no listeners after this. */
  | { readonly type: "dispose" }

export interface InspectorOptions {
  /**
   * Whether to attach. Left out, it attaches only where the bundle says development or tests (`process.env.NODE_ENV` is set and
   * isn't `"production"`). Where `NODE_ENV` is `"production"` it never attaches, whatever this says.
   */
  readonly enabled?: boolean
  /** Most reads `reads()` keeps, oldest dropped first. Default 200, also for anything but a finite positive number. */
  readonly maxReads?: number
}

/**
 * A development view of one client's store: its records, the queries holding each, the streams covering each, and why each
 * query was read. Everything is read from the client when asked, so it is current, and nothing is kept but the list of reads.
 */
export interface Inspector {
  /** False when it didn't attach (production, `enabled: false`, a disposed client), or after the client or it was disposed. */
  readonly active: boolean
  records(): readonly InspectedRecord[]
  queries(): readonly InspectedQuery[]
  streams(): readonly InspectedStream[]
  /** The most recent reads, oldest first. */
  reads(): readonly InspectedRead[]
  /** Hear each read as it starts, each batch of writes, and disposal. Returns the function that stops it. */
  subscribe(listener: (event: InspectorEvent) => void): () => void
  /** Detach from the client and drop everything, for every caller that was given this inspector. The client is unaffected. */
  dispose(): void
}

const attached = new WeakMap<Client, Inspector>()

/**
 * Inspect `client` in development.
 *
 * There is one inspector per client: while one is attached, `inspect(client, options)` returns it and ignores `options`, and
 * `dispose()` from any caller ends it for all of them.
 *
 * It never receives an `@sensitive` result or a `no-store` mutation's result: neither enters the store, and it sees only that a
 * query read started, never a response. Mutations, and `@sensitive` queries, aren't recorded at all. When the client is disposed it
 * drops what it holds and its listeners, at once.
 *
 * Imported from `graphql-orm-client/inspector`, so an application that doesn't import it doesn't bundle it. Import it behind a
 * development check, so a production bundle doesn't carry it, and say where it's development:
 *
 * ```ts
 * if (import.meta.env.DEV) void import("graphql-orm-client/inspector").then(({ inspect }) => inspect(client, { enabled: import.meta.env.DEV }))
 * ```
 */
export function inspect(client: Client, options: InspectorOptions = {}): Inspector {
  const existing = attached.get(client)
  if (existing?.active) return existing
  const environment = nodeEnv()
  if (environment === "production" || !(options.enabled ?? environment !== undefined) || client.store.isDisposed) return INERT
  const max = options.maxReads
  const maxReads = typeof max === "number" && Number.isFinite(max) && max >= 1 ? Math.floor(max) : 200
  const inspector = new StoreInspector(client, maxReads, () => attached.delete(client))
  attached.set(client, inspector)
  return inspector
}

type OnEvent = LiveManager["onEvent"]
type ExecuteResponse = Client["executeResponse"]

/** Kept as fields of one object, so a test can search everything it holds. */
class StoreInspector implements Inspector {
  private client: Client | null
  private log: InspectedRead[] = []
  private listeners = new Set<(event: InspectorEvent) => void>()
  /**
   * Queries an event marked to read again, by key, with what marked them. The re-read the event asked for consumes it; another
   * read meanwhile, such as a refetch, doesn't. Closing the query, which cancels that re-read, drops it.
   */
  private marks = new Map<string, { readonly cause: "event" | "list"; readonly typename: string }>()
  /**
   * What the wrappers this inspector puts on the client reach it through. Null once it has detached, so a wrapper it couldn't
   * take off (something else wrapped the member after it) passes calls straight through.
   */
  private link: { inspector: StoreInspector | null } = { inspector: this }
  /** Operation names by selections, for queries no longer open. */
  private names = new WeakMap<readonly Selection[], string>()
  private detach: (() => void)[] = []

  constructor(client: Client, private readonly maxReads: number, private readonly forget: () => void) {
    this.client = client
    const target = client as unknown as { executeResponse: ExecuteResponse }
    const own = Object.prototype.hasOwnProperty.call(client, "executeResponse") ? target.executeResponse : undefined
    const original = target.executeResponse
    const link = this.link
    // Only arguments pass through here; the response goes back to the caller untouched.
    const wrapper = function (this: Client, artifact, variables, options = {}) {
      if (artifact.kind === "query" && !artifact.sensitive) link.inspector?.started(artifact, variables, options.readCause ?? "manual", options.beforeSend !== undefined)
      return original.call(this, artifact, variables, options)
    } as ExecuteResponse
    target.executeResponse = wrapper
    this.detach.push(() => {
      if (target.executeResponse !== wrapper) return
      if (own) target.executeResponse = own
      else delete (target as { executeResponse?: ExecuteResponse }).executeResponse
    })
    const live = client.live as unknown as { onEvent: OnEvent } | null
    if (live) {
      const onEvent = live.onEvent
      const tap: OnEvent = (holders, typename, stale, fragments) => {
        link.inspector?.marked(holders, typename, stale, fragments)
        onEvent(holders, typename, stale, fragments)
      }
      live.onEvent = tap
      this.detach.push(() => {
        if (live.onEvent === tap) live.onEvent = onEvent
      })
    }
    const unobserve = client.store.observeWrites(
      (changed) => {
        if (this.listeners.size) this.emit({ type: "write", ids: [...changed] })
      },
      () => this.stop()
    )
    this.detach.push(unobserve)
  }

  get active(): boolean {
    return this.client !== null
  }

  /** A query read started. `reread`: a re-read a query scheduled itself (it carries `beforeSend`), not a refetch, poll or page. */
  private started(artifact: { readonly name: string; readonly hash: string; readonly selections: readonly Selection[] }, variables: Variables, sent: ReadCause, reread: boolean): void {
    try {
      const client = this.client
      if (!client) return
      this.names.set(artifact.selections, artifact.name)
      const key = `${artifact.hash}:${stableStringify(variables)}`
      const mark = this.marks.get(key)
      // The re-read an event asked for: it can be sent as another cause when one came first, such as a burst repair.
      if (sent === "stale" || reread) this.marks.delete(key)
      const retained = client.store["retained"]
      const query = retained.has(key) ? key : retained.has(`query:${key}`) ? `query:${key}` : null
      const read: InspectedRead = {
        at: client.now(),
        operation: artifact.name,
        variables,
        query,
        ...(sent === "stale" && mark ? { cause: mark.cause, typename: mark.typename } : { cause: sent }),
      }
      this.log.push(read)
      if (this.log.length > this.maxReads) this.log.splice(0, this.log.length - this.maxReads)
      this.emit({ type: "read", read })
    } catch {
      // An inspector must never break a read.
    }
  }

  /** An event reached `holders`: note which of them the client will read again, and why, as its own handler decides. */
  private marked(holders: ReadonlySet<string>, typename: string, stale: boolean, fragments: readonly string[]): void {
    try {
      for (const resource of this.client?.["resources"].values() ?? []) {
        if (resource.users === 0 || !holders.has(resource.key) || !resource.needsEventReread(typename, stale, fragments)) continue
        if (this.marks.has(resource.key)) continue
        this.marks.set(resource.key, { cause: resource.artifact.lists?.includes(typename) ? "list" : "event", typename })
        this.onClose(resource)
      }
    } catch {
      // As above.
    }
  }

  /** Queries whose close this inspector watches. */
  private closing = new WeakSet<object>()

  /** Drop a query's mark when it closes: closing cancels the re-read the mark was for. Once per query; passes through after detach. */
  private onClose(resource: { readonly key: string; cancelRereads(): void }): void {
    if (this.closing.has(resource)) return
    this.closing.add(resource)
    const link = this.link
    const cancel = resource.cancelRereads
    resource.cancelRereads = function (this: unknown) {
      link.inspector?.marks.delete(resource.key)
      return cancel.call(this)
    }
  }

  private emit(event: InspectorEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  records(): readonly InspectedRecord[] {
    const client = this.client
    if (!client) return []
    const heldBy = new Map<string, string[]>()
    for (const query of this.queries()) for (const id of query.records) (heldBy.get(id) ?? heldBy.set(id, []).get(id)!).push(query.key)
    const coveredBy = new Map<string, string[]>()
    for (const stream of this.streams()) for (const id of stream.records) (coveredBy.get(id) ?? coveredBy.set(id, []).get(id)!).push(stream.id)
    const store = client.store
    return [...store["records"].values()].map((record) => {
      const lifetime = store.lifetime(record.__id)
      return {
        id: record.__id,
        typename: record.__typename,
        fields: structuredClone(Object.fromEntries(record.fields)),
        heldBy: heldBy.get(record.__id) ?? [],
        coveredBy: coveredBy.get(record.__id) ?? [],
        ...(lifetime ? { lifetime } : {}),
        ...(store.isRestored(record.__id) ? { restored: true as const } : {}),
      }
    })
  }

  queries(): readonly InspectedQuery[] {
    const client = this.client
    if (!client) return []
    const store = client.store
    const watched = new Map<string, { readonly status: QueryStatus; readonly pollMs: number | null }>()
    const resources = [...client["resources"].values(), ...[...client["unopened"].values()].map((ref) => ref.deref())]
    for (const resource of resources) {
      if (!resource) continue
      this.names.set(resource.artifact.selections, resource.artifact.name)
      if (!watched.has(resource.key) || resource.users > 0) watched.set(resource.key, { status: resource.getState().status, pollMs: resource.polling })
    }
    const result: InspectedQuery[] = []
    const collecting = store.collecting
    // As a collection reads: an `@batch` relation found missing here mustn't start a request.
    store.collecting = true
    try {
      for (const [key, retention] of store["retained"]) {
        const { selector } = retention
        let records: readonly string[] = []
        try {
          records = [...readSelections(store, selector, { inlineSpreads: true }).seen]
        } catch {
          // An `@batch` selection with no relation batching installed: the client reports that where it's read.
        }
        const view = watched.get(key)
        result.push({
          key,
          operation: this.names.get(selector.selections) ?? null,
          variables: selector.variables,
          state: retention.count > 0 ? "open" : "released",
          ...(view ? { status: view.status } : {}),
          pollMs: view?.pollMs ?? null,
          records,
        })
      }
    } finally {
      store.collecting = collecting
    }
    return result
  }

  streams(): readonly InspectedStream[] {
    const live = this.client?.live
    if (!live) return []
    const result: InspectedStream[] = []
    for (const [typename, active] of live["active"]) {
      const artifact = live["artifacts"][typename]
      if (!artifact) continue
      for (const key of active.subscriptions.keys()) {
        const thin = key.startsWith("thin:")
        const raw = thin ? key.slice(5) : key
        result.push({
          id: `${typename}:${key}`,
          typename,
          operation: (thin ? artifact.thinOperation ?? artifact.operation : artifact.operation).name,
          scope: raw === "all" ? "all" : raw.startsWith("keys:") ? "keys" : "key",
          thin,
          records: [...(active.coverage.get(key) ?? [])],
        })
      }
    }
    return result
  }

  reads(): readonly InspectedRead[] {
    return [...this.log]
  }

  subscribe(listener: (event: InspectorEvent) => void): () => void {
    if (!this.client) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.stop()
  }

  /** Drop everything, with the listeners told first. Runs inside the client's disposal, so nothing outlives the identity. */
  private stop(): void {
    if (!this.client) return
    for (const detach of this.detach) detach()
    this.detach = []
    this.link.inspector = null
    this.client = null
    this.forget()
    this.log = []
    this.marks = new Map()
    this.names = new WeakMap()
    this.closing = new WeakSet()
    const listeners = this.listeners
    this.emit({ type: "dispose" })
    listeners.clear()
  }
}

/** An inspector that never attached. */
const INERT: Inspector = Object.freeze({
  active: false,
  records: () => [],
  queries: () => [],
  streams: () => [],
  reads: () => [],
  subscribe: () => () => {},
  dispose: () => {},
})

/** The bundle's `process.env.NODE_ENV`, written out in full because bundlers replace only that exact expression. */
function nodeEnv(): string | undefined {
  try {
    const value = process.env.NODE_ENV
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}
