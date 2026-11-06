import { ephemeral, type EphemeralOptions, type EphemeralStream } from "./ephemeral.js"
import type { ConnectionSpec, FragmentArtifact, FragmentRefFor, LinkSelection, OperationArtifact, PagedSpec, Selection } from "./artifact.js"
import { fieldStorageKey, stableStringify, type Variables } from "./store/arguments.js"
import { contextOf, normalize } from "./store/normalize.js"
import { IDLE_TYPE_HEALTH, diagnosticMessage, typeHealth, worstOf, type LiveDiagnostic, type LiveHealth, type LiveHolding, type LiveTypeHealth } from "./health.js"
import { LiveManager, type LiveOptions, type SubscriptionSink } from "./live.js"
import { FRAGMENT_REF, readSelections, type FragmentRefData } from "./store/read.js"
import { ROOT_ID, Store, type OptimisticLayer, type Selector, type Snapshot, type StoreOptions, recycle } from "./store/store.js"

export interface GraphQLErrorLike {
  readonly message: string
  readonly path?: readonly (string | number)[]
  readonly extensions?: Readonly<Record<string, unknown>>
}

export interface GraphQLResponse {
  readonly data?: Record<string, unknown> | null
  readonly errors?: readonly GraphQLErrorLike[]
}

export interface OperationRequest {
  readonly kind: OperationArtifact["kind"]
  readonly name: string
  readonly text: string
  /** sha256 of `text`, for persisted operations. */
  readonly hash: string
  readonly variables: Variables
}

export interface Network {
  execute(request: OperationRequest, options: { signal?: AbortSignal }): Promise<GraphQLResponse>
}

/**
 * GraphQL errors from one operation, with their `extensions.code`. Thrown when the server returns
 * no data. The React hooks also report errors that arrived with data as one, in `error`.
 */
export class OperationError extends Error {
  constructor(
    readonly operation: string,
    readonly errors: readonly GraphQLErrorLike[]
  ) {
    super(errors[0]?.message ?? `${operation} returned no data`)
    this.name = "OperationError"
  }
}

/**
 * How a query uses stored data. Apollo's names: `cache-first` is `store-or-network`,
 * `cache-and-network` is `store-and-network`, and `network-only` is the same. Every query result
 * is normalised, so there is no `no-cache` for queries; use `network-only`. A mutation can skip
 * the store with `MutationPolicy` `no-store`.
 */
export type FetchPolicy =
  /** Serve complete stored data; fetch only what is missing. */
  | "store-or-network"
  /** Serve stored data while fetching. */
  | "store-and-network"
  /** Always fetch; serve nothing from the store first. */
  | "network-only"

/**
 * What a mutation does with its response. `store` (the default) normalises it into the store, so
 * every view of the records it carries updates. `no-store` returns it to the caller and writes
 * none of it: see `Client.mutate`.
 */
export type MutationPolicy = "store" | "no-store"

/** `idle`: the query is skipped (React `skip`, or `variables: null`) and sends nothing. */
export type QueryStatus = "idle" | "loading" | "ready" | "refreshing" | "error"

export interface QueryState<T> {
  readonly status: QueryStatus
  /** The root's own fields, with child fragments as masked references. */
  readonly data: T | undefined
  readonly error: Error | null
  /** Errors returned alongside data (a denied field, for example). */
  readonly errors: readonly GraphQLErrorLike[]
  /** The query's `@connection` list has another page. */
  readonly hasMore: boolean
  /** A next page is being fetched; the loaded rows stay in `data`. */
  readonly loadingMore: boolean
}

export interface ClientOptions {
  readonly network: Network
  readonly store?: StoreOptions
  /** Keep records read through `@live` fragments current with generated Changed subscriptions. */
  readonly live?: LiveOptions
  readonly polling?: PollingOptions
}

export interface PollingOptions {
  /**
   * How often a query refetches when it shows `@live` records that no subscription covers: types
   * without a usable Changed subscription, records beyond a per-record cap, or a stream waiting out a
   * refusal window. Default 30 s;
   * `null` disables the fallback.
   */
  readonly liveFallbackMs?: number | null
  /** Polls pause while this returns false. Default: the document is visible. */
  readonly isActive?: () => boolean
  readonly setInterval?: (callback: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface WatchOptions {
  readonly policy?: FetchPolicy
  /** Refetch on this interval while the query is open. */
  readonly pollMs?: number
}

/** A shared, retained view of one query and its variables. */
export interface WatchedQuery<T> {
  getState(): QueryState<T>
  subscribe(listener: () => void): () => void
  refetch(): Promise<void>
  /** Fetch the next page of the query's `@connection` list and append it. */
  loadMore(): Promise<void>
}

/** Receives a plain subscription's events (`client.subscribe`). */
export interface SubscriptionObserver<T> {
  /** One event, written into the store first; `errors` are those that arrived with its data. */
  next?(result: { readonly data: T; readonly errors: readonly GraphQLErrorLike[] }): void
  /**
   * The stream failed: a transport error, or an event with errors and no data (an
   * `OperationError` with the codes, such as `SUBSCRIPTION_CONTINUITY_LOST`).
   */
  error?(error: Error): void
  complete?(): void
}

/** One page of a `@paged` query, with the page's position and the list's size. */
export interface PagedState<T> extends QueryState<T> {
  /** The page shown or being loaded, from 0. */
  readonly pageIndex: number
  readonly pageSize: number
  /** The server's `TotalCount`; null when it didn't send one. */
  readonly totalCount: number | null
  /** `ceil(totalCount / pageSize)`; null without a total. */
  readonly pageCount: number | null
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
  /**
   * `data` is the previous page (or the previous variables' page) while this page loads; `status`
   * is then `refreshing`. `hasNextPage` and `hasPreviousPage` are estimated from the previous
   * total until the page arrives.
   */
  readonly placeholder: boolean
}

/** A `@paged` query shown one page at a time (`client.watchPagedQuery`). */
export interface PagedQuery<T, V> {
  getState(): PagedState<T>
  subscribe(listener: () => void): () => void
  open(): void
  close(): void
  /** Fetch the shown page again. */
  refetch(): Promise<void>
  /** Show another page; the current one stays until it arrives. */
  setPage(pageIndex: number): void
  /** Change the page size, keeping the first row of the current page in view. */
  setPageSize(pageSize: number): void
  /**
   * Show other variables (a filter or order), from `pageIndex` (default 0). The current page is
   * dropped at once unless `hold` is true; hold only within one scope, such as one vendor.
   */
  setVariables(variables: V, options?: { hold?: boolean; pageIndex?: number }): void
}

/** graphql-orm's default page size, used when neither the caller nor the variables give one. */
export const DEFAULT_PAGE_SIZE = 50

function pagedSpecOf(artifact: OperationArtifact<any, any>): PagedSpec {
  if (!artifact.paged) throw new Error(`${artifact.name} has no @paged field to page through`)
  return artifact.paged
}

/** The page size a `@paged` query's variables ask for, or the default. */
export function pageSizeOf(artifact: OperationArtifact<any, any>, variables: Variables | null | undefined): number {
  const spec = pagedSpecOf(artifact)
  const limit = (variables?.[spec.variable] as Record<string, unknown> | null | undefined)?.[spec.limit]
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_PAGE_SIZE
}

/**
 * A `@paged` query's variables for one page: the page variable's limit is the page size and its
 * offset `pageIndex * pageSize`. Its other fields are kept.
 */
export function pageVariables<V extends Variables>(
  artifact: OperationArtifact<any, V>,
  variables: V,
  pageIndex: number,
  pageSize: number
): V {
  const spec = pagedSpecOf(artifact)
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new RangeError(`pageIndex must be a whole number from 0, not ${pageIndex}`)
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`pageSize must be a whole number from 1, not ${pageSize}`)
  const page = (variables[spec.variable] as Record<string, unknown> | null | undefined) ?? {}
  return { ...variables, [spec.variable]: { ...page, [spec.limit]: pageSize, [spec.offset]: pageIndex * pageSize } }
}

/** A query state with a `@paged` query's page position and totals. */
export function pagedState<T>(
  artifact: OperationArtifact<T, any>,
  state: QueryState<T>,
  pageIndex: number,
  pageSize: number,
  placeholder = false
): PagedState<T> {
  const spec = pagedSpecOf(artifact)
  let connection: unknown = state.data
  for (const key of spec.path) connection = (connection as Record<string, unknown> | null | undefined)?.[key]
  const pageInfo = (connection as Record<string, unknown> | null | undefined)?.[spec.pageInfo] as Record<string, unknown> | null | undefined
  const total = pageInfo?.[spec.totalCount]
  const totalCount = typeof total === "number" ? total : null
  const nextPage = pageInfo?.[spec.hasNextPage]
  const previousPage = spec.hasPreviousPage ? pageInfo?.[spec.hasPreviousPage] : undefined
  return {
    ...state,
    ...(placeholder ? { status: "refreshing" as const, error: null } : {}),
    pageIndex,
    pageSize,
    totalCount,
    pageCount: totalCount === null ? null : Math.ceil(totalCount / pageSize),
    hasNextPage: placeholder
      ? totalCount !== null && (pageIndex + 1) * pageSize < totalCount
      : nextPage === true,
    hasPreviousPage: !placeholder && typeof previousPage === "boolean" ? previousPage : pageIndex > 0,
    placeholder,
  }
}

export function selectorOf(artifact: OperationArtifact<any, any>, variables: Variables, id: string = ROOT_ID): Selector {
  return { id, selections: artifact.selections, variables, fragments: artifact.fragments }
}

function queryKey(artifact: OperationArtifact<any, any>, variables: Variables): string {
  return `${artifact.hash}:${stableStringify(variables)}`
}

/** How often a query with a re-read waiting checks whether polling has become active again. */
const INACTIVE_REREAD_CHECK_MS = 1000

class QueryResource<T> implements WatchedQuery<T> {
  private state: QueryState<T>
  private readonly listeners = new Set<() => void>()
  private unsubscribeStore: (() => void) | null = null
  private release: (() => void) | null = null
  private inflight: Promise<void> | null = null
  private controller: AbortController | null = null
  users = 0

  constructor(
    private readonly client: Client,
    readonly artifact: OperationArtifact<T, any>,
    readonly variables: Variables,
    readonly key: string,
    private readonly policy: FetchPolicy
  ) {
    const snapshot = client.store.lookup<T>(selectorOf(artifact, variables))
    const complete = !snapshot.missing && policy !== "network-only"
    this.state = {
      status: complete ? "ready" : "loading",
      data: complete ? snapshot.data : undefined,
      error: null,
      errors: [],
      hasMore: complete ? this.connection()?.hasMore ?? false : false,
      loadingMore: false,
    }
    if (complete) this.watch(snapshot)
  }

  getState = (): QueryState<T> => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Start using the resource: retain its records and fetch per the policy. */
  open(): void {
    this.users += 1
    if (this.users > 1) return
    this.release = this.client.store.retain(this.key, selectorOf(this.artifact, this.variables))
    if (this.state.status !== "ready" || this.policy !== "store-or-network") void this.fetch()
    this.holdLive()
    this.schedulePoll()
  }

  /** Poll intervals asked for by each open handle; the shortest wins. */
  private readonly pollRequests = new Map<object, number>()
  private fallbackPoll = false
  private pollTimer: unknown = null
  private pollMs: number | null = null

  /** Poll at this interval for `token` (one open handle) until `removePoll(token)`. */
  addPoll(token: object, ms: number): void {
    this.pollRequests.set(token, ms)
    this.schedulePoll()
  }

  removePoll(token: object): void {
    if (this.pollRequests.delete(token)) this.schedulePoll()
  }

  private schedulePoll(): void {
    const fallback = this.client.polling.liveFallbackMs === undefined ? 30_000 : this.client.polling.liveFallbackMs
    const candidates = [...this.pollRequests.values(), this.fallbackPoll ? fallback : null].filter(
      (value): value is number => typeof value === "number" && value > 0
    )
    const next = this.users > 0 && candidates.length ? Math.min(...candidates) : null
    if (next === this.pollMs) return
    const clear = this.client.polling.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
    if (this.pollTimer !== null) clear(this.pollTimer)
    this.pollTimer = null
    this.pollMs = next
    if (next === null) return
    const set =
      this.client.polling.setInterval ??
      ((callback: () => void, ms: number) => {
        const handle = setInterval(callback, ms)
        // Don't keep a Node process (SSR, tests) alive for a poll.
        ;(handle as { unref?: () => void }).unref?.()
        return handle
      })
    this.pollTimer = set(() => {
      const active = this.client.polling.isActive ?? defaultActive
      if (this.users > 0 && active() && !this.inflight) void this.fetch()
    }, next)
  }

  /** Whether the query polls, and how often; for diagnostics and tests. */
  get polling(): number | null {
    return this.pollMs
  }

  close(): void {
    this.users -= 1
    if (this.users > 0) return
    this.users = 0
    this.cancelRereads()
    this.schedulePoll()
    // Forget the request as well: a reopen in the same tick (React's StrictMode replays effects)
    // must start a new one, not wait on this one, whose result is dropped.
    this.controller?.abort()
    this.controller = null
    this.inflight = null
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    this.client.live?.hold(this.key, new Map())
    this.client.healthChanged()
    this.release?.()
    this.release = null
  }

  refetch = (): Promise<void> => this.fetch()

  private loadingMore: Promise<void> | null = null

  loadMore = (): Promise<void> => {
    if (this.loadingMore) return this.loadingMore
    const connection = this.connection()
    if (!connection?.hasMore || (connection.endCursor === null && !connection.spec.offset)) return Promise.resolve()
    const { spec, variable } = connection
    if (variable === null)
      return Promise.reject(new Error(`Pass ${this.artifact.name}'s ${spec.paging[0]} argument as a variable to load more`))
    const pageValue = (this.variables[variable] as Record<string, unknown> | null | undefined) ?? {}
    const next = {
      ...this.variables,
      [variable]: spec.offset
        ? { ...pageValue, [spec.offset]: connection.loaded }
        : { ...pageValue, [spec.after]: connection.endCursor },
    }
    this.set({ ...this.state, loadingMore: true })
    this.loadingMore = this.client
      .execute<T>(this.artifact, next)
      .then(() => this.set({ ...this.state, loadingMore: false, hasMore: this.connection()?.hasMore ?? false }))
      .catch((error: unknown) => {
        this.set({ ...this.state, loadingMore: false, error: error instanceof Error ? error : new Error(String(error)) })
      })
      .finally(() => {
        this.loadingMore = null
      })
    return this.loadingMore
  }

  /** The first `@connection` list this query reads, with its stored page info. */
  private connection(): {
    spec: ConnectionSpec
    variable: string | null
    endCursor: string | null
    hasMore: boolean
    /** Rows in the stored list. */
    loaded: number
  } | null {
    const found = findConnection(this.client.store, this.artifact.selections, this.variables, ROOT_ID)
    if (!found) return null
    const { spec, selection, id } = found
    const record = this.client.store.get(id)
    const pageInfoRef = record
      ? ([...record.fields].find(([key]) => key === spec.pageInfo || key.startsWith(`${spec.pageInfo}(`))?.[1] as { __ref?: string } | undefined)?.__ref
      : undefined
    const pageInfo = pageInfoRef ? this.client.store.get(pageInfoRef) : undefined
    const pagingArg = selection.args.find((arg) => arg.name === spec.paging[0])
    const endCursor = pageInfo?.fields.get(spec.endCursor)
    const edges = record
      ? ([...record.fields].find(([key]) => key === spec.edges || key.startsWith(`${spec.edges}(`))?.[1] as { __refs?: unknown[] } | undefined)
      : undefined
    return {
      loaded: edges?.__refs?.length ?? 0,
      spec,
      variable: pagingArg?.kind === "variable" ? pagingArg.variable : null,
      endCursor: typeof endCursor === "string" ? endCursor : null,
      hasMore: pageInfo?.fields.get(spec.hasNextPage) === true,
    }
  }

  fetch(): Promise<void> {
    if (this.inflight) return this.inflight
    if (this.state.data !== undefined) this.set({ ...this.state, status: "refreshing" })
    const controller = new AbortController()
    this.controller = controller
    this.inflight = this.client
      .execute<T>(this.artifact, this.variables, { signal: controller.signal })
      .then(({ snapshot, errors }) => {
        if (controller.signal.aborted) return
        this.lastReadAt = this.client.now()
        this.watch(snapshot)
        this.set({
          ...this.state,
          status: "ready",
          data: snapshot.data,
          error: null,
          errors,
          hasMore: this.connection()?.hasMore ?? false,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        this.set({ ...this.state, status: "error", error: error instanceof Error ? error : new Error(String(error)) })
      })
      .finally(() => {
        if (this.controller !== controller) return
        this.controller = null
        this.inflight = null
      })
    return this.inflight
  }

  private rereadWaiting = false
  private rereadPending = false
  private rereadTimer: unknown = null
  private rereadAt = -Infinity

  /** Drop a re-read that hasn't started. */
  cancelRereads(): void {
    if (this.rereadTimer !== null) this.client.cancelReread(this.rereadTimer)
    this.rereadTimer = null
    this.rereadPending = false
  }

  /** Mark stale, coalescing bursts and following an in-flight read with one more. */
  readAgain(): void {
    this.rereadPending = true
    this.drainReread()
  }

  private drainReread(): void {
    if (this.rereadWaiting || !this.rereadPending || this.rereadTimer !== null || this.users === 0 || this.client.store.isDisposed) return
    const delay = Math.max(0, this.rereadAt + this.client.minRereadMs - this.client.now())
    const active = (this.client.polling.isActive ?? defaultActive)()
    if (delay > 0 || !active) {
      this.rereadTimer = this.client.afterReread(() => {
        this.rereadTimer = null
        this.drainReread()
      }, Math.max(delay, active ? 0 : INACTIVE_REREAD_CHECK_MS))
      return
    }
    if (this.inflight) {
      this.rereadWaiting = true
      const finish = () => {
        this.rereadWaiting = false
        this.drainReread()
      }
      void this.inflight.then(finish, finish)
      return
    }
    this.rereadPending = false
    this.rereadAt = this.client.now()
    void this.fetch()
  }

  /** Whether a projection omits something selected by this query's held fragments. */
  needsEventReread(typename: string, thin: boolean, fragments: readonly string[]): boolean {
    const holding = this.liveHoldings.get(typename)
    return !!holding && (thin || this.artifact.liveReread?.includes(typename) === true || fragments.some((name) => this.artifact.fragments[name] !== undefined))
  }

  private watch(snapshot: Snapshot<T>): void {
    this.unsubscribeStore?.()
    this.holdLive()
    this.unsubscribeStore = this.client.store.subscribe(snapshot, (next) => {
      this.set({ ...this.state, data: next.data as T, hasMore: this.connection()?.hasMore ?? false })
      this.holdLive()
      // A record this query shows was deleted or collected: read it again from the server.
      if (next.missing && this.users > 0) void this.fetch()
    })
  }

  private lastReadAt: number | null = null
  /** What this query holds through `@live` fragments, per type. */
  private liveHoldings = new Map<string, { ids: Set<string>; fragments: Set<string> }>()

  /** What this query holds, per type, for `client.liveHealth()`. Nothing when it isn't open. */
  holdings(): ReadonlyMap<string, LiveHolding> {
    const result = new Map<string, LiveHolding>()
    if (this.users === 0) return result
    for (const [typename, { ids, fragments }] of this.liveHoldings) {
      result.set(typename, { held: [...ids], fragments: [...fragments], pollMs: this.pollMs, lastReadAt: this.lastReadAt })
    }
    return result
  }

  /** Tell the live layer which records this query shows through `@live` fragments. */
  private holdLive(): void {
    if (this.users === 0) return
    const live = this.client.live
    const targets = new Map<string, Set<string>>()
    this.uncovered = false
    this.liveHoldings = new Map()
    readSelections(this.client.store, selectorOf(this.artifact, this.variables), {
      inlineSpreads: true,
      onSpread: (fragment, id, typename) => {
        if (!this.artifact.fragments[fragment]?.live) return
        const holding = this.liveHoldings.get(typename) ?? { ids: new Set<string>(), fragments: new Set<string>() }
        holding.ids.add(id)
        holding.fragments.add(fragment)
        this.liveHoldings.set(typename, holding)
        if (!live?.covers(typename)) {
          this.uncovered = true
          return
        }
        const ids = targets.get(typename) ?? new Set<string>()
        ids.add(id)
        targets.set(typename, ids)
      },
    })
    live?.hold(this.key, targets)
    this.refreshFallbackPoll()
    this.client.healthChanged()
  }

  private uncovered = false

  /** Poll when this query holds `@live` records that nothing else keeps fresh. */
  refreshFallbackPoll(): void {
    if (this.users === 0) return
    const live = this.client.live
    const types = [...this.liveHoldings.keys()]
    const exposed = live ? types.some((typename) => live.covers(typename) && (live.overflows(typename) || live.refusedNow(typename))) : false
    this.fallbackPoll = this.uncovered || exposed
    this.schedulePoll()
  }

  private set(state: QueryState<T>): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}

type Watched<T> = WatchedQuery<T> & { open(): void; close(): void }

class PagedQueryResource<T, V extends Variables> implements PagedQuery<T, V> {
  private readonly listeners = new Set<() => void>()
  private current: { watched: Watched<T>; key: string; unsubscribe: () => void }
  /** The page shown while `current` loads. */
  private previous: { watched: Watched<T>; unsubscribe: () => void } | null = null
  private opened = false
  private state: PagedState<T>

  constructor(
    private readonly client: Client,
    private readonly artifact: OperationArtifact<T, V>,
    private variables: V,
    private pageIndex: number,
    private pageSize: number,
    private readonly options: WatchOptions
  ) {
    this.current = this.watch()
    this.state = this.compute()
  }

  getState = (): PagedState<T> => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  open(): void {
    if (this.opened) return
    this.opened = true
    this.current.watched.open()
    this.update()
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    this.dropPrevious()
    this.current.watched.close()
  }

  refetch = (): Promise<void> => this.current.watched.refetch()

  setPage(pageIndex: number): void {
    this.navigate(this.variables, pageIndex, this.pageSize, true)
  }

  setPageSize(pageSize: number): void {
    this.navigate(this.variables, Math.floor((this.pageIndex * this.pageSize) / pageSize), pageSize, true)
  }

  setVariables(variables: V, options: { hold?: boolean; pageIndex?: number } = {}): void {
    this.navigate(variables, options.pageIndex ?? 0, this.pageSize, options.hold ?? false)
  }

  private watch(): { watched: Watched<T>; key: string; unsubscribe: () => void } {
    const variables = pageVariables(this.artifact, this.variables, this.pageIndex, this.pageSize)
    const watched = this.client.watchQuery<T, V>(this.artifact, variables, this.options)
    return { watched, key: stableStringify(variables), unsubscribe: watched.subscribe(this.update) }
  }

  private navigate(variables: V, pageIndex: number, pageSize: number, hold: boolean): void {
    const key = stableStringify(pageVariables(this.artifact, variables, pageIndex, pageSize))
    this.variables = variables
    this.pageIndex = pageIndex
    this.pageSize = pageSize
    if (key === this.current.key) return this.update()
    const outgoing = this.current
    const shown = outgoing.watched.getState().data !== undefined
    // Keep the page on screen: the outgoing page if it arrived, else the one shown while it loaded.
    if (!hold || shown) this.dropPrevious()
    if (hold && shown) {
      this.previous = outgoing
    } else {
      outgoing.unsubscribe()
      outgoing.watched.close()
    }
    this.current = this.watch()
    if (this.opened) this.current.watched.open()
    this.update()
  }

  private dropPrevious(): void {
    if (!this.previous) return
    this.previous.unsubscribe()
    this.previous.watched.close()
    this.previous = null
  }

  private compute(): PagedState<T> {
    const current = this.current.watched.getState()
    const waiting = current.data === undefined && current.status !== "error"
    if (waiting && this.previous) {
      return pagedState(this.artifact, this.previous.watched.getState(), this.pageIndex, this.pageSize, true)
    }
    return pagedState(this.artifact, current, this.pageIndex, this.pageSize)
  }

  private update = (): void => {
    const current = this.current.watched.getState()
    if (this.previous && (current.data !== undefined || current.status === "error")) this.dropPrevious()
    this.state = this.compute()
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * One client per signed-in identity. Dispose it when the identity changes: the store is cleared
 * synchronously and no request completes into it afterwards.
 */
export class Client {
  readonly store: Store
  /** Null when the client was created without live options. */
  readonly live: LiveManager | null
  private readonly network: Network
  private readonly resources = new Map<string, QueryResource<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private readonly subscriptions = new Set<() => void>()
  private readonly subscribeTransport: LiveOptions["subscribe"] | null
  private mutationCount = 0

  readonly polling: PollingOptions

  constructor(options: ClientOptions) {
    this.network = options.network
    this.polling = options.polling ?? {}
    this.subscribeTransport = options.live?.subscribe ?? null
    this.store = new Store(options.store)
    this.live = options.live
      ? new LiveManager(
          this.store,
          options.live,
          (holders) => {
            for (const resource of this.resources.values()) {
              if (resource.users > 0 && holders.has(resource.key)) void resource.readAgain()
            }
          },
          (timing) => this.healthChanged(timing),
          () => {
            for (const resource of this.resources.values()) resource.refreshFallbackPoll()
          },
          (holders, typename, thin, fragments) => {
            for (const resource of this.resources.values()) {
              if (holders.has(resource.key) && resource.needsEventReread(typename, thin, fragments)) resource.readAgain()
            }
          }
        )
      : null
    this.rereadOptions = options.live
    this.minRereadMs = Math.max(1, options.live?.minRereadMs ?? 2000)
    this.clock = options.live?.now ?? Date.now
    const fallback = options.live?.onDiagnostic === undefined ? defaultDiagnostic : options.live.onDiagnostic
    this.onDiagnostic = fallback
  }

  /** Interval for automatic stale and confirming reads. */
  readonly minRereadMs: number
  private readonly rereadOptions: LiveOptions | undefined
  /** Schedule a stale-read check on the live clock. */
  afterReread(callback: () => void, ms: number): unknown {
    if (this.rereadOptions?.setTimeout) return this.rereadOptions.setTimeout(callback, ms)
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  }
  /** Cancel a pending stale-read check. */
  cancelReread(handle: unknown): void {
    (this.rereadOptions?.clearTimeout ?? clearTimeout)(handle as ReturnType<typeof setTimeout>)
  }

  private readonly clock: () => number
  private readonly onDiagnostic: ((diagnostic: LiveDiagnostic) => void) | null
  private readonly healthListeners = new Set<() => void>()
  private readonly diagnosed = new Set<string>()
  private healthSnapshot: LiveHealth | null = null
  private healthQueued = false
  private healthForced = false
  private healthKey: string | null = null

  /** The current time on the client's clock. */
  now(): number {
    return this.clock()
  }

  /**
   * What keeps `@live` data fresh right now, per type and for the socket. It works with no live layer.
   * Unknown is never reported as healthy: a stream with no event yet is `unconfirmed`, and the socket is
   * `unknown` unless the transport reports it (`graphqlWsTransport`). The result keeps its identity
   * while nothing has changed, so it can be used as a snapshot.
   */
  liveHealth(): LiveHealth {
    const holdings = new Map<string, LiveHolding[]>()
    for (const resource of this.resources.values()) {
      for (const [typename, holding] of resource.holdings()) {
        const list = holdings.get(typename) ?? []
        list.push(holding)
        holdings.set(typename, list)
      }
    }
    const statuses = this.live?.status() ?? {}
    const socket = this.live?.socket ?? "unknown"
    const types: Record<string, LiveTypeHealth> = {}
    for (const typename of new Set([...Object.keys(statuses), ...holdings.keys()])) {
      types[typename] = typeHealth(statuses[typename], holdings.get(typename) ?? [], { socket, hasLiveLayer: this.live !== null })
    }
    const next: LiveHealth = { socket, worst: worstOf(Object.values(types).map((entry) => entry.state)), types }
    const snapshot = this.healthSnapshot ? recycle(this.healthSnapshot, next) : next
    this.healthSnapshot = snapshot
    return snapshot
  }

  /** The health of one type; a type nothing holds is `idle`. */
  liveTypeHealth(typename: string): LiveTypeHealth {
    return this.liveHealth().types[typename] ?? IDLE_TYPE_HEALTH
  }

  /** Call `listener` when `liveHealth()` may have changed. Events tell it at most once a second. */
  subscribeLiveHealth = (listener: () => void): (() => void) => {
    this.healthListeners.add(listener)
    return () => {
      this.healthListeners.delete(listener)
    }
  }

  /**
   * Something health depends on may have changed: if so, tell listeners and report diagnostics, once
   * per tick. A new `lastEventAt` alone tells them only with `timing`, which the live layer limits.
   */
  healthChanged(timing = false): void {
    if (timing) this.healthForced = true
    if (this.healthQueued || this.store.isDisposed) return
    this.healthQueued = true
    queueMicrotask(() => {
      this.healthQueued = false
      if (this.store.isDisposed) return
      const health = this.liveHealth()
      const key = JSON.stringify(health, (name, value) => (name === "lastEventAt" ? undefined : value))
      const forced = this.healthForced
      this.healthForced = false
      if (key === this.healthKey && !forced) return
      this.healthKey = key
      this.diagnose(health)
      for (const listener of [...this.healthListeners]) listener()
    })
  }

  private diagnose(health: LiveHealth): void {
    if (!this.onDiagnostic) return
    for (const [typename, entry] of Object.entries(health.types)) {
      const lasting = entry.state === "refused" || entry.state === "unavailable" || entry.state === "polling"
      if (!lasting) continue
      for (const fragment of entry.fragments) {
        const key = `${fragment}\u0000${entry.reason}`
        if (this.diagnosed.has(key)) continue
        this.diagnosed.add(key)
        this.onDiagnostic({ fragment, typename, state: entry.state, reason: entry.reason, code: entry.code, message: diagnosticMessage(fragment, typename, entry) })
      }
    }
  }

  /** Refetch every open query; call after a subscription reconnect may have missed events. */
  async refetchActive(): Promise<void> {
    await this.refetchQueries("active")
  }

  /**
   * Refetch the open queries of these operations (by artifact or operation name), or every open
   * query for `"active"`. Resolves when they have been read again; failures go to each query's
   * state, not here. Queries nobody has open are not fetched.
   */
  async refetchQueries(include: "active" | readonly (OperationArtifact<any, any> | string)[]): Promise<void> {
    const matches = (artifact: OperationArtifact<any, any>) =>
      include === "active" ||
      include.some((entry) => (typeof entry === "string" ? artifact.name === entry : artifact === entry || artifact.hash === entry.hash))
    await Promise.all(
      [...this.resources.values()].filter((resource) => resource.users > 0 && matches(resource.artifact)).map((resource) => resource.fetch())
    )
  }

  /**
   * Read a query outside React. `store-or-network` (the default) answers from complete stored
   * data without a request; the other policies always fetch. The records stay for the retention
   * period, like a preload. Rejects with `OperationError` when the server returns no data;
   * errors that arrive with data are in `errors`.
   */
  async query<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: { policy?: FetchPolicy; signal?: AbortSignal } = {}
  ): Promise<{ data: T; errors: readonly GraphQLErrorLike[] }> {
    if (artifact.kind !== "query") throw new Error(`${artifact.name} is not a query`)
    const selector = selectorOf(artifact, variables)
    if ((options.policy ?? "store-or-network") === "store-or-network") {
      const stored = this.store.lookup<T>(selector)
      if (!stored.missing) return { data: stored.data, errors: [] }
    }
    const release = this.store.retain(`query:${queryKey(artifact, variables)}`, selector)
    try {
      const { snapshot, errors } = await this.execute<T>(artifact, variables, options.signal ? { signal: options.signal } : {})
      return { data: snapshot.data, errors }
    } finally {
      if (!this.store.isDisposed) release()
    }
  }

  /**
   * Run a subscription document that isn't a `@live` fragment's (an operation's own
   * `subscription`), through `live.subscribe`. Each event is written into the store, so keyed
   * records it carries update every view, then passed to `observer.next` with masked fragment
   * references. Objects without a key from one event are kept until the next. Events lost by
   * the server are not replayed: on `SUBSCRIPTION_CONTINUITY_LOST` (reported to `error`),
   * subscribe again and refetch. Returns the function that stops it.
   */
  subscribe<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    observer: SubscriptionObserver<T>
  ): () => void {
    if (artifact.kind !== "subscription") throw new Error(`${artifact.name} is not a subscription`)
    if (this.store.isDisposed) throw new Error("This client was disposed with its identity")
    const transport = this.subscribeTransport
    if (!transport) throw new Error(`Pass live.subscribe to createClient to run ${artifact.name}`)
    let closed = false
    let previous: string[] = []
    const dropPrevious = () => {
      for (const id of previous) this.store.delete(id)
      previous = []
    }
    const sink: SubscriptionSink = {
      next: (response) => {
        if (closed || this.store.isDisposed) return
        const errors = response.errors ?? []
        if (!response.data) {
          observer.error?.(new OperationError(artifact.name, errors))
          return
        }
        const rootId = `client:subscription:${++this.mutationCount}`
        const embedded = new Set<string>()
        normalize(this.store, artifact.normalization, response.data, { ...contextOf(artifact, variables), embedded }, rootId, artifact.rootType)
        const snapshot = this.store.lookup<T>(selectorOf(artifact, variables, rootId))
        this.store.delete(rootId)
        dropPrevious()
        previous = [...embedded].filter((id) => id.startsWith(`${rootId}.`))
        this.store.publish()
        observer.next?.({ data: snapshot.data, errors })
      },
      error: (error) => {
        if (!closed) observer.error?.(error instanceof Error ? error : new Error(String(error)))
      },
      complete: () => {
        if (!closed) observer.complete?.()
      },
    }
    const dispose = transport({ kind: artifact.kind, name: artifact.name, text: artifact.text, hash: artifact.hash, variables }, sink)
    const stop = () => {
      if (closed) return
      closed = true
      this.subscriptions.delete(stop)
      dispose()
      if (!this.store.isDisposed) {
        dropPrevious()
        this.store.publish()
      }
    }
    this.subscriptions.add(stop)
    return stop
  }

  /** Create a bounded, volatile stream. Call open() to subscribe and dispose() to erase it. */
  stream<D, T, V extends Variables, C = unknown>(
    artifact: OperationArtifact<D, V>, variables: V, options: EphemeralOptions<D, T, V, C>
  ): EphemeralStream<T, C> {
    if (this.store.isDisposed) throw new Error("This client was disposed with its identity")
    if (!this.rereadOptions) throw new Error("A stream requires live.subscribe")
    const stream = ephemeral(artifact, variables, options, this.rereadOptions, () => this.subscriptions.delete(stream.dispose))
    this.subscriptions.add(stream.dispose)
    return stream
  }

  /** Send an operation and write its response into the store. */
  async execute<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: {
      signal?: AbortSignal
      beforeWrite?: () => void
      /**
       * Read the response into a store of its own instead of the client's. Nothing reaches the
       * client's store, its subscribers or its retention. The returned snapshot, and the fragment
       * references in its data, read from that private store, which only the caller's result keeps
       * alive. Mutations only (see `mutate`'s `policy: "no-store"`).
       */
      isolated?: boolean
    } = {}
  ): Promise<{ snapshot: Snapshot<T>; errors: readonly GraphQLErrorLike[] }> {
    if (this.store.isDisposed) throw new Error("This client was disposed with its identity")
    if (options.isolated && artifact.kind !== "mutation")
      throw new Error(`${artifact.name} is not a mutation; only mutations can skip the store`)
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
    this.controllers.add(controller)
    try {
      // A request cancelled before it starts is never sent.
      if (controller.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
      const response = await this.network.execute(
        { kind: artifact.kind, name: artifact.name, text: artifact.text, hash: artifact.hash, variables },
        { signal: controller.signal }
      )
      if (this.store.isDisposed || controller.signal.aborted)
        throw new DOMException("The request was cancelled", "AbortError")
      const errors = response.errors ?? []
      options.beforeWrite?.()
      if (!response.data) throw new OperationError(artifact.name, errors)
      const rootId = artifact.kind === "query" ? ROOT_ID : `client:${artifact.kind}:${++this.mutationCount}`
      const target = options.isolated ? new Store() : this.store
      normalize(target, artifact.normalization, response.data, contextOf(artifact, variables), rootId, artifact.rootType)
      target.publish()
      const snapshot = target.lookup<T>(selectorOf(artifact, variables, rootId))
      if (rootId !== ROOT_ID) target.delete(rootId)
      return { snapshot, errors }
    } finally {
      options.signal?.removeEventListener("abort", abort)
      this.controllers.delete(controller)
    }
  }

  /**
   * A shared view of a query. Call `open()` from `watch` users; the resource retains its records
   * while anyone uses it and is dropped when the last user closes it.
   */
  watchQuery<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: FetchPolicy | WatchOptions = "store-and-network"
  ): WatchedQuery<T> & { open(): void; close(): void } {
    const { policy = "store-and-network", pollMs } = typeof options === "string" ? { policy: options } : options
    const key = `${queryKey(artifact, variables)}:${policy}`
    let resource = this.resources.get(key) as QueryResource<T> | undefined
    if (!resource) {
      resource = new QueryResource<T>(this, artifact, variables, queryKey(artifact, variables), policy)
      this.resources.set(key, resource as QueryResource<unknown>)
    }
    const shared = resource
    // Each handle opens and closes once at a time, and polls only while it is open.
    const token = {}
    let opened = false
    return {
      getState: shared.getState,
      subscribe: shared.subscribe,
      refetch: shared.refetch,
      loadMore: shared.loadMore,
      open: () => {
        if (opened || this.store.isDisposed) return
        opened = true
        if (!this.resources.has(key)) this.resources.set(key, shared as QueryResource<unknown>)
        if (pollMs !== undefined) shared.addPoll(token, pollMs)
        shared.open()
      },
      close: () => {
        if (!opened) return
        opened = false
        shared.removePoll(token)
        shared.close()
        if (shared.users === 0 && this.resources.get(key) === shared) this.resources.delete(key)
      },
    }
  }

  /**
   * A `@paged` query shown one page at a time, from `pageIndex` (default 0) with `pageSize`
   * (default: the page variable's limit, else 50). Each page is its own watched query, stored
   * under its own variables, so a page seen before shows at once. While another page loads, the
   * current one stays (`placeholder`, status `refreshing`). Call `open()` to start it.
   */
  watchPagedQuery<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: WatchOptions & { pageIndex?: number; pageSize?: number } = {}
  ): PagedQuery<T, V> {
    const { pageIndex = 0, pageSize = pageSizeOf(artifact, variables), ...watch } = options
    return new PagedQueryResource<T, V>(this, artifact, variables, pageIndex, pageSize, watch)
  }

  /** Start a query before rendering (from a route loader). Resolves when the data is stored. */
  async preload<T, V extends Variables>(artifact: OperationArtifact<T, V>, variables: V): Promise<void> {
    const watched = this.watchQuery(artifact, variables)
    watched.open()
    try {
      await watched.refetch()
    } finally {
      // Keep the records for the retention period; the route's useQuery picks them up.
      watched.close()
    }
  }

  /**
   * Run a mutation; its response updates every stored record it contains.
   *
   * `policy: "no-store"` returns the response to the caller and writes none of it into the store.
   * Use it for one-time secrets (a credential, a ticket, a download link). The result is complete
   * and typed, and its fragment references still open with `readFragment` and `useFragment`; they
   * read from a private store that the result alone keeps alive, so it is collected with the
   * result. Nothing is normalised into the client's store, retained, or shown by anything that
   * prints it. The rule for keyed records is the same: records in the response are not merged
   * either, so other views of them do not update, and a record the store never held is not
   * created. Refetch the affected queries (`refetchQueries`) when views must change. An
   * `optimisticResponse` cannot be combined with it, and the call rejects before sending. The
   * option governs this call's response only: the variables are sent as usual, and a query that
   * later reads the same data from the server stores it as any query does.
   */
  async mutate<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: {
      /**
       * The response you expect, shaped like the mutation's result (with __typename and keys).
       * It shows at once and is rolled back when the real response or an error arrives. Fields
       * changed since (by a live event, say) are not rolled back.
       */
      optimisticResponse?: Record<string, unknown>
      /** Cancels the request; the optimistic layer is rolled back. */
      signal?: AbortSignal
      /**
       * Open queries to read again once the mutation succeeds (by artifact or operation name), as
       * for `client.refetchQueries`. The mutation resolves after they have been read.
       */
      refetchQueries?: readonly (OperationArtifact<any, any> | string)[]
      /** `store` (default) or `no-store`: return the response without writing any of it into the store. */
      policy?: MutationPolicy
    } = {}
  ): Promise<{ data: T; errors: readonly GraphQLErrorLike[] }> {
    if (artifact.kind !== "mutation") throw new Error(`${artifact.name} is not a mutation`)
    // A misspelt policy must not quietly store a secret.
    if (options.policy !== undefined && options.policy !== "store" && options.policy !== "no-store")
      throw new Error(`${artifact.name}: unknown mutation policy ${JSON.stringify(options.policy)}`)
    const isolated = options.policy === "no-store"
    if (isolated && options.optimisticResponse)
      throw new Error(`${artifact.name}: optimisticResponse can't be combined with policy "no-store"`)
    let layer: OptimisticLayer | null = null
    if (options.optimisticResponse) {
      const response = options.optimisticResponse
      const root = `client:optimistic:${++this.mutationCount}`
      layer = this.store.optimistic(() =>
        normalize(this.store, artifact.normalization, response, contextOf(artifact, variables), root, artifact.rootType)
      )
    }
    const rollback = () => {
      if (layer) this.store.rollback(layer)
      layer = null
    }
    let result: { data: T; errors: readonly GraphQLErrorLike[] }
    try {
      const { snapshot, errors } = await this.execute<T>(artifact, variables, {
        beforeWrite: rollback,
        ...(isolated ? { isolated } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      result = { data: snapshot.data, errors }
    } finally {
      rollback()
    }
    if (options.refetchQueries?.length) await this.refetchQueries(options.refetchQueries)
    return result
  }

  /**
   * Read a `@refetchable` fragment's record again through the router's `node(NodeId)` lookup and
   * write it into the store; every view of the record updates. A null result without errors
   * means the record is now missing or denied, so it is removed, as on a DELETED event. A
   * failure (errors, a network error) leaves the stored record as it was.
   */
  async refetchFragment<N extends string>(
    fragment: FragmentArtifact<any, N>,
    ref: FragmentRefFor<N>,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ found: boolean; errors: readonly GraphQLErrorLike[] }> {
    if (!fragment.refetch) throw new Error(`${fragment.name} is not @refetchable`)
    const { selector } = fragmentSelector(fragment, ref)
    const { snapshot, errors } = await this.execute(
      fragment.refetch as OperationArtifact<{ node: unknown }>,
      { NodeId: selector.id },
      options.signal ? { signal: options.signal } : {}
    )
    const found = snapshot.data.node !== null && snapshot.data.node !== undefined
    if (!found && errors.length === 0) {
      this.store.delete(selector.id)
      this.store.publish()
    }
    return { found, errors }
  }

  dispose(): void {
    for (const stop of [...this.subscriptions]) stop()
    for (const resource of this.resources.values()) resource.cancelRereads()
    this.live?.dispose()
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.resources.clear()
    this.healthListeners.clear()
    this.store.dispose()
  }
}

function defaultDiagnostic(diagnostic: LiveDiagnostic): void {
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") return
  console.warn(diagnostic.message)
}

export function createClient(options: ClientOptions): Client {
  return new Client(options)
}

/** The masked-reference data behind a fragment reference, or null. */
function refData(ref: unknown): FragmentRefData | null {
  if (typeof ref !== "object" || ref === null) return null
  return ((ref as Record<symbol, unknown>)[FRAGMENT_REF] as FragmentRefData | undefined) ?? null
}

/** The selector a fragment reads through a reference produced by a spread of that fragment. */
export function fragmentSelector(fragment: FragmentArtifact<any, any>, ref: unknown): { store: Store; selector: Selector } {
  const data = refData(ref)
  if (!data) throw new Error(`readFragment(${fragment.name}) needs a reference from a spread of ${fragment.name}`)
  if (!data.fragments.has(fragment.name))
    throw new Error(`This reference was not produced by a spread of ${fragment.name}`)
  return {
    store: data.store,
    selector: { id: data.id, selections: fragment.selections, variables: data.variables, fragments: {} },
  }
}

/**
 * Read a fragment's own fields through a reference. A plain function, so adapters and mappers
 * can call it; components that should re-render use `useFragment` instead.
 */
export function readFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N>
): D
export function readFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N> | null | undefined
): D | null
export function readFragment(fragment: FragmentArtifact<any, any>, ref: unknown): unknown {
  if (ref === null || ref === undefined) return null
  const { store, selector } = fragmentSelector(fragment, ref)
  return store.lookup(selector).data
}

const defaultActive = () => typeof document === "undefined" || document.visibilityState !== "hidden"

/** Follow stored links from a record to the first `@connection` field the selections read. */
function findConnection(
  store: Store,
  selections: readonly Selection[],
  variables: Variables,
  id: string
): { spec: ConnectionSpec; selection: LinkSelection; id: string } | null {
  const record = store.get(id)
  if (!record) return null
  for (const selection of selections) {
    if (selection.kind === "inline") {
      const found = findConnection(store, selection.selections, variables, id)
      if (found) return found
      continue
    }
    if (selection.kind !== "link" || selection.plural) continue
    const ref = (record.fields.get(fieldStorageKey(selection, variables)) as { __ref?: string } | null | undefined)?.__ref
    if (!ref) continue
    if (selection.connection) return { spec: selection.connection, selection, id: ref }
    const found = findConnection(store, selection.selections, variables, ref)
    if (found) return found
  }
  return null
}
