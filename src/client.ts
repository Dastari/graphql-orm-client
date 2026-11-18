import type { ReadCause } from "./health.js"
import { RESPONSE_FIELD_MISSING, missingFieldMessage, missingFields } from "./missing.js"
import { withoutErrorNulls } from "./partial.js"
import { hadNoResponse, markNoResponse, rootKeys, wasNotSent, writeStatus, type WriteOutcome } from "./outcome.js"
import type { ConnectionSpec, FragmentArtifact, FragmentRefFor, LinkSelection, OperationArtifact, PagedSpec, Selection } from "./artifact.js"
import { fieldStorageKey, included, stableStringify, type Variables } from "./store/arguments.js"
import { contextOf, identify, normalize } from "./store/normalize.js"
import { IDLE_TYPE_HEALTH, diagnosticMessage, typeHealth, worstOf, type LiveDiagnostic, type LiveHealth, type LiveHolding, type LiveTypeHealth } from "./health.js"
import { LiveManager, type LiveOptions, type SubscriptionSink } from "./live.js"
import { FRAGMENT_REF, readSelections, type FragmentRefData } from "./store/read.js"
import { ROOT_ID, Store, type OptimisticLayer, type Selector, type Snapshot, type StoreOptions, intersects, recycle } from "./store/store.js"
import { classifyErrors } from "./errors.js"

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
 * `cache-and-network` is `store-and-network`, and `network-only` is the same. Query results are normalised unless the document declares `@sensitive`.
 * There is no call-site `no-cache` policy for queries. A mutation can skip
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
  /** Restored data has not yet been confirmed by a network read. */
  readonly stale?: boolean
  /** Configured lifetime cannot be proved valid, or has expired. */
  readonly lifetime?: "expired" | "unknown"
  readonly status: QueryStatus
  /** The root's own fields, with child fragments as masked references. */
  readonly data: T | undefined
  readonly error: Error | null
  /** Errors returned alongside data (a denied field, for example). */
  readonly errors: readonly GraphQLErrorLike[]
  /** The query's first stored `@connection` list has another page. `connections` has each one. */
  readonly hasMore: boolean
  /** A next page of one of the query's `@connection` lists is being fetched; the loaded rows stay in `data`. */
  readonly loadingMore: boolean
  /**
   * Each `@connection` list the query reads, by its `key`. Absent when the query has none. Load more of one with
   * `loadMore({ connection: key })`.
   */
  readonly connections?: Readonly<Record<string, ConnectionState>>
  /**
   * The last refresh stopped at its bound (`live.maxRereadRows`, and `live.maxRereadPages` for keyset), so the rows past it are kept
   * as they were and may be stale or out of order. Show it, for example as a notice at the end of the list, and offer a way back to
   * fewer rows. Health reports `list-refresh-truncated` too.
   */
  readonly listRefreshTruncated?: boolean
}

/** One `@connection` list of a query, in `QueryState.connections`. */
export interface ConnectionState {
  /** The list has another page. */
  readonly hasMore: boolean
  /** Its next page is being fetched. */
  readonly loadingMore: boolean
  /** Its last refresh stopped at the bound: see `QueryState.listRefreshTruncated`. */
  readonly listRefreshTruncated: boolean
  /**
   * How often the server refused one of its cursors (`CURSOR_INVALID`) and the list started again from its first page, keeping
   * its records and reading the loaded rows again. See `ClientOptions.connections`.
   */
  readonly restarts: number
}

/** Selects one `@connection` list of a query by its `key`; left out, the query's first. */
export interface ConnectionOptions {
  readonly connection?: string
}

/** Internal: one connection's part in a loaded-range refresh. */
interface ConnectionRefresh {
  /** Rows to read again from its first page. */
  readonly loaded: number
  readonly pages: number
  readonly rows: number
  /** Another connection in the query shares its paging variable, so the refresh can't follow its cursor by itself. */
  readonly shared?: boolean
  /** Replace the whole stored list with what is read: rows past it, and the stored end cursor, are dropped. */
  readonly restart?: boolean
  onTruncated(value: boolean): void
  /** The server refused a cursor the refresh followed, and the refresh started again from the first page and succeeded. */
  onRestart?(code: string): void
}

/** Options for `Client.execute`. */
export interface ExecuteOptions {
  /** Cause counted when a query request is sent. Defaults to manual. */
  readCause?: ReadCause
  signal?: AbortSignal
  beforeWrite?: () => void
  /** Internal loaded-range refresh, by `@connection` key; driven by the compiled connection and returned PageInfo. */
  refreshConnections?: Readonly<Record<string, ConnectionRefresh>>
  /** Internal: false keeps a refused cursor in a refresh from starting it again. */
  cursorRestart?: boolean
  /**
   * Read the response into a store of its own instead of the client's. Nothing reaches the
   * client's store, its subscribers or its retention. The returned snapshot, and the fragment
   * references in its data, read from that private store, which only the caller's result keeps
   * alive. Mutations only (see `mutate`'s `policy: "no-store"`).
   */
  isolated?: boolean
  observeResponse?: (response: GraphQLResponse) => void
  beforeSend?: () => void
  /**
   * Internal: called as soon as the response is in the store, before `execute` resolves, with the errors it will resolve with. A
   * watched query sets its data and errors here in one state change.
   */
  afterPublish?: (snapshot: Snapshot<any>, errors: readonly GraphQLErrorLike[]) => void
  /**
   * @internal Also read these selections from the operation's root, at the same moment as the snapshot, so nothing written
   * after the response (another read of the same query, a live event) comes between the two. Returned as `alsoRead`.
   */
  alsoRead?: readonly Selection[]
}

/** Options for `Client.mutate` and `Client.mutateOutcome`, and React `useMutation`'s `commit` and `commitOutcome`. */
export interface MutateOptions<T = unknown> {
  /**
   * The response you expect, shaped like the mutation's result (with __typename and keys).
   * It shows at once and is rolled back when the real response or an error arrives. Fields
   * changed since (by a live event, say) are not rolled back.
   */
  optimisticResponse?: Record<string, unknown>
  /** Cancels the request; the optimistic layer is rolled back. */
  signal?: AbortSignal
  /**
   * Open queries to read again once the mutation succeeds: artifacts, operation names or
   * `{ query, variables }` entries, as for `client.refetchQueries`. The mutation resolves after
   * they have been read.
   */
  refetchQueries?: readonly RefetchQuery[]
  /** `store` (default) or `no-store`: return the response without writing any of it into the store. */
  policy?: MutationPolicy
  /** Observe certainty without changing this method's returned/thrown behaviour. */
  onOutcome?: (outcome: WriteOutcome) => void
  /** Explicit read for known affected records after an unconfirmed write; never a write replay. */
  reconcile?: () => Promise<unknown>
  /**
   * What confirms this write when its result has no `Success` field, in place of the rule that every selected root has
   * `Success: true`. Called only for a response with data and no errors; a response with any error stays unconfirmed.
   * It receives the response's data as the server sent it, before the store reads it, so fields of spread fragments are
   * there although `T` doesn't name them. Return `true` only for evidence your schema gives, such as a non-null root of a
   * result with no `Success` or `Error` field (one with them is non-null when the write failed too); `false` or a throw
   * leaves the write `unconfirmed`. Affects only the outcome, never what `mutate` returns or throws.
   */
  confirm?: (data: T) => boolean
  /**
   * Error codes this server sends only for a write that didn't happen, such as `NOT_FOUND` or `CONFLICT` from a command
   * that sets no `extensions.outcome`. With data (or `data: null`), the write is `refused`, and `reconcile` isn't called,
   * only when no error has an `extensions.outcome`, every error has one of these codes and a path of exactly one root
   * field, and every root field the operation selects is null with its own such error. Anything else stays `unconfirmed`:
   * null propagation can erase a root that committed before a nested field failed, and roots run in order, so an earlier
   * root may have committed before a later one was refused. On a response with no `data` key the codes add to the known
   * pre-execution codes.
   */
  refusedCodes?: readonly string[]
}

export interface ClientOptions {
  readonly network: Network
  /** Opt-in: error-associated nulls do not erase previous good fields. Default is legacy overwrite. */
  readonly partialResults?: "legacy" | "preserve-errors"
  /**
   * How `mutateOutcome` and `commitOutcome` classify a write response with no `data` key. `by-code` (default): `refused`
   * only when every error's `extensions.code` is a known pre-execution failure (parse, validation, variables, authentication,
   * authorization, persisted document, request limits) or one of the call's `refusedCodes`; otherwise `unconfirmed`, because a
   * router can answer an execution failure that followed a commit without `data`. A body with no `data` and no errors (`{}`)
   * is `unconfirmed` too. `refused`: every such response, `{}` included, is
   * `refused`, as 0.1.0-alpha.12 and earlier did. Neither changes what `mutate` or `commit` return or throw.
   */
  readonly writeWithoutData?: "by-code" | "refused"
  readonly store?: StoreOptions
  /** Keep records read through `@live` fragments current with generated Changed subscriptions. */
  readonly live?: LiveOptions
  readonly polling?: PollingOptions
  readonly connections?: ConnectionClientOptions
  /**
   * `refetchFragment` calls for one fragment made in the same tick go out as one `nodes(NodeIds)` request, in chunks of
   * `maxNodes` ids. The default, 100, is graphql-orm-router's bound; set it to the router's `NodeLookupConfig::with_max_nodes`.
   * It needs a module generated against a schema with `nodes`; otherwise each call reads its record through `node(NodeId)`.
   * `false` sends one `node(NodeId)` request per call, as earlier versions did.
   */
  readonly refetchBatch?: false | { readonly maxNodes?: number }
  /**
   * What to do when a response leaves out a field the operation selects (a non-conformant server, a gateway that drops a field, a
   * schema that changed under the client). The data is incomplete either way. `warn` logs once per operation and path, naming the
   * operation, type, record and response key. `error` adds an error at that path to the result's `errors`, with
   * `extensions.code` `RESPONSE_FIELD_MISSING`, as a GraphQL error there would be. `off` says nothing. Left unset, it warns unless
   * `process.env.NODE_ENV` is `production`. A null is a value, so a null at a nullable field is never reported, nor is a field under
   * a legacy `@skip` or `@include`, or one at or below a path an error names.
   */
  readonly missingFields?: "warn" | "error" | "off"
  /** How watched queries read. */
  readonly reads?: ReadOptions
}

/** How `@connection` lists recover. */
export interface ConnectionClientOptions {
  /**
   * Codes on which a refused cursor starts a keyset list again from its first page, under the same stored list: when
   * `loadMore` sends the stored end cursor, or a refresh follows a cursor past its first request. The records keep their
   * identities and the rows loaded so far are read again, as a refresh does; `loadMore`'s rows come with them. It happens at
   * most once per cursor, so a server that refuses every cursor fails with its error instead of looping, and never when an
   * error in the response is about access (`UNAUTHENTICATED`, `FORBIDDEN`, `ACCESS_DENIED`, `STEP_UP_REQUIRED`). It is
   * counted in `ConnectionState.restarts` and reported once per list through `live.onDiagnostic` as `cursor-restarted`.
   *
   * Default `["CURSOR_INVALID"]`, the code graphql-orm sends from 0.94.0. Add `"INVALID_INPUT"` for roots that send that
   * instead. `[]` turns it off: the refusal is the query's `error`, as before.
   */
  readonly restartOn?: readonly ("CURSOR_INVALID" | "INVALID_INPUT")[]
}

/** How watched queries (`watchQuery`, `useQuery`, `loadQuery`, `usePagedQuery`) read. */
export interface ReadOptions {
  /**
   * Opt-in: send a watched query's read again when it failed before any response arrived (a failed connection or a passed deadline,
   * as `createHttpNetwork` marks them, or `markNoResponse` in a custom network). `true` uses the defaults. A read that got a response,
   * GraphQL errors or an HTTP error included, isn't retried, and a write never is. Closing the query, disposing the client or a newer
   * read of the query (a `refetch`, say) ends the wait. The query keeps its status (`loading` or `refreshing`) while it waits.
   * Waits use `live.setTimeout`, else `store.setTimeout`, else the global timer.
   */
  readonly retry?: boolean | ReadRetryOptions
  /**
   * Read open queries in `error` again when the browser says it's back online (the window's `online` event), and send a waiting
   * retry at once. Default true; `false` restores the earlier behaviour of waiting for a refetch.
   */
  readonly refetchOnOnline?: boolean
}

/** Bounded back-off for `reads.retry`. */
export interface ReadRetryOptions {
  /** Attempts after the first. Default 3. */
  readonly retries?: number
  /**
   * The wait before the first retry. Each later wait doubles, up to `maxMs`, and each is jittered to between half and all of
   * that. Default 1000.
   */
  readonly baseMs?: number
  /** Default 30000. */
  readonly maxMs?: number
  /** A number from 0 to 1 for the jitter. Default `Math.random`; pass one for repeatable tests. */
  readonly random?: () => number
}

export interface PollingOptions {
  /**
   * `pollMs` on a query with no `@poll(reason)`. Left unset, it throws on a regenerated module where `process.env.NODE_ENV` is set to
   * something other than `production`, as in development and tests. Elsewhere, including a bundle that doesn't define
   * `process.env.NODE_ENV`, it warns and still polls. `error` always throws on a regenerated module, `warn` always warns, and `off`
   * says nothing. A module generated before `@poll` only warns.
   */
  readonly undeclared?: "error" | "warn" | "off"
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

/**
 * Which open queries `refetchQueries` reads again: every open instance of an operation (its artifact
 * or name), or `{ query, variables }` for the instances whose variables match. `variables` is a
 * predicate given each instance's variables, or an object whose every field must equal the
 * instance's variable of that name (compared as values, so `{ Id: "a" }` matches
 * `{ Id: "a", Page: { limit: 20 } }`). Without `variables` it selects every instance.
 */
export type RefetchQuery<V extends Variables = any> =
  | OperationArtifact<any, any>
  | string
  | {
      readonly query: OperationArtifact<any, V> | string
      readonly variables?: ((variables: V) => boolean) | Partial<V>
    }

/** A shared, retained view of one query and its variables. */
export interface WatchedQuery<T> {
  getState(): QueryState<T>
  subscribe(listener: () => void): () => void
  refetch(): Promise<void>
  /**
   * Fetch the next page of the query's first stored `@connection` list (the one `hasMore` describes), or of the one whose `key`
   * is `connection`, and append it. Rejects for a key the query doesn't have, and for a keyset list whose paging variable
   * another list shares. Errors that arrive with the page's data go to `errors`.
   */
  loadMore(options?: ConnectionOptions): Promise<void>
  /**
   * Read a `@connection` list again from its first page (the first list, or the one whose `key` is `connection`), under the
   * same stored list: the records keep their identities, the rows loaded so far are read again, and rows past what's read and
   * the stored end cursor are dropped. For an application that knows the list's cursors no longer hold. A refused cursor
   * starts again by itself: see `ClientOptions.connections`. Resolves at once for a query with no `@connection`.
   */
  restart(options?: ConnectionOptions): Promise<void>
}

/** A route read started before mount. Dispose on abandoned navigation; mount with useLoadedQuery. */
export interface LoadedQuery<T> extends WatchedQuery<T> {
  /** Resolves after the first read; inspect getState().error for a read failure. Cancellation resolves quietly. */
  readonly ready: Promise<void>
  /** Identity owner, checked by the React binding. */
  readonly client: Client
  /** Retain while mounted, opening again if the load expired or its last user unmounted. The cleanup tolerates StrictMode effect replay. */
  mount(): () => void
  /**
   * For a suspending read (`useSuspenseLoadedQuery`) before it mounts: a promise, the same one while it is pending, that resolves
   * when the read leaves `loading` (data or an error), when the load is disposed with its client alive, or when the load closes.
   * It never resolves once the client is disposed. Opens an expired load again, as `mount` does, which sends a request. While it
   * is pending the load stays open for up to twice `timeoutMs`; then it closes, so a render that never commits releases it, and a
   * render still waiting opens it again. When it settles the usual deadline starts again. Throws once the load or its client is
   * disposed.
   */
  suspend(): Promise<void>
  /** The promise `suspend()` last returned, kept after it settles (then with `status: "fulfilled"`, which React's `use` reads). */
  readonly waiting: Promise<void> | null
  /** End this loader; it can't be mounted again. Idempotent. Without this, an unused loader only pauses. */
  dispose(): void
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

/** A `@connection` list of a query, with its stored page info. */
interface ConnectionInfo {
  spec: ConnectionSpec
  /** The operation variable holding its paging argument; null when the argument is written inline. */
  variable: string | null
  endCursor: string | null
  hasMore: boolean
  /** Rows in the stored list. */
  loaded: number
}

const declaredConnections = new WeakMap<OperationArtifact<any, any>, readonly { key: string; variable: string | null }[]>()

/** The `@connection` fields a query's own selections reach through single links, in order, with their paging variables. */
function connectionsOf(artifact: OperationArtifact<any, any>): readonly { key: string; variable: string | null }[] {
  let found = declaredConnections.get(artifact)
  if (found) return found
  const list: { key: string; variable: string | null }[] = []
  const walk = (selections: readonly Selection[]): void => {
    for (const selection of selections) {
      if (selection.kind === "inline") walk(selection.selections)
      if (selection.kind !== "link" || selection.plural) continue
      if (!selection.connection) {
        walk(selection.selections)
        continue
      }
      const arg = selection.args.find((entry) => entry.name === selection.connection!.paging[0])
      list.push({ key: selection.connection.key, variable: arg?.kind === "variable" ? arg.variable : null })
    }
  }
  walk(artifact.selections)
  found = list
  declaredConnections.set(artifact, found)
  return found
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
    client.store.configureLifetimes(artifact.lifetimes)
    const snapshot = client.store.lookup<T>(selectorOf(artifact, variables))
    const complete = !snapshot.missing && policy !== "network-only"
    this.state = this.withConnections({
      stale: snapshot.stale,
      lifetime: snapshot.lifetime,
      status: complete ? "ready" : "loading",
      data: complete ? snapshot.data : undefined,
      error: null,
      errors: [],
      hasMore: complete ? this.connection()?.hasMore ?? false : false,
      loadingMore: false,
    })
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
    if (this.state.status === "ready") this.watch(this.client.store.lookup<T>(selectorOf(this.artifact, this.variables)))
    this.release = this.client.store.retain(this.key, selectorOf(this.artifact, this.variables))
    if (this.artifact.lists) this.client.live?.holdLists(this.key, this.artifact.lists)
    if (this.state.stale || this.state.status !== "ready" || this.policy !== "store-or-network") void this.fetch("first")
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
      if (this.users > 0 && active() && !this.inflight) {
        this.client.store.refreshRelations?.(selectorOf(this.artifact, this.variables))
        void this.fetch("poll")
      }
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
    if (this.artifact.lists) this.client.live?.holdLists(this.key, [])
    this.client.live?.hold(this.key, new Map())
    this.client.healthChanged()
    this.release?.()
    this.release = null
  }

  refetch = (): Promise<void> => {
    this.client.store.refreshRelations?.(selectorOf(this.artifact, this.variables))
    return this.fetch()
  }

  private loadingMore: Promise<void> | null = null
  /** The connection `loadingMore` is reading, by key. */
  private loadingKey: string | null = null
  /** Rows each connection has asked for, by key, so a refresh also reads a page that is still arriving. */
  private readonly loadedRanges = new Map<string, number>()
  private readonly truncated = new Map<string, boolean>()
  private readonly restarts = new Map<string, number>()
  /** The cursor each connection last started again from: a second refusal of it fails instead. */
  private readonly restartedFrom = new Map<string, string>()

  /**
   * The key `options` selects, or an error for one the query doesn't have. Without a key, the first stored list, as `hasMore`
   * reports; undefined when none is stored.
   */
  private connectionKey(options: ConnectionOptions): string | Error | undefined {
    const declared = connectionsOf(this.artifact)
    if (options.connection === undefined) return this.connection()?.spec.key
    const matching = declared.filter((entry) => entry.key === options.connection)
    if (matching.length === 0) return new Error(`${this.artifact.name} has no @connection with key "${options.connection}"`)
    if (matching.length > 1) return new Error(`${this.artifact.name} has ${matching.length} @connection fields with key "${options.connection}"; give each its own key`)
    return options.connection
  }

  loadMore = (options: ConnectionOptions = {}): Promise<void> => {
    if (this.inflight) return this.inflight.then(() => (this.users > 0 ? this.loadMore(options) : undefined))
    const key = this.connectionKey(options)
    if (key instanceof Error) return Promise.reject(key)
    if (key === undefined) return Promise.resolve()
    if (this.loadingMore) return this.loadingKey === key ? this.loadingMore : this.loadingMore.then(() => (this.users > 0 ? this.loadMore(options) : undefined))
    const connection = this.connection(key)
    if (!connection?.hasMore || (connection.endCursor === null && !connection.spec.offset)) return Promise.resolve()
    const { spec, variable } = connection
    if (variable === null)
      return Promise.reject(new Error(`Pass ${this.artifact.name}'s ${spec.paging[0]} argument as a variable to load more`))
    // A cursor in a shared variable would reach the other list too, which would refuse it or append the wrong rows. An offset
    // reaches both as well, and lists of one page size advance together, as they always have.
    const sharing = spec.offset ? [] : connectionsOf(this.artifact).filter((entry) => entry.variable === variable && entry.key !== key)
    if (sharing.length)
      return Promise.reject(new Error(`${this.artifact.name}: @connection "${key}" shares its paging variable $${variable} with ${sharing.map((entry) => `"${entry.key}"`).join(", ")}; give each list its own paging variable to load more of it`))
    const pageValue = (this.variables[variable] as Record<string, unknown> | null | undefined) ?? {}
    const next = {
      ...this.variables,
      [variable]: spec.offset
        ? { ...pageValue, [spec.offset]: connection.loaded }
        : { ...pageValue, [spec.after]: connection.endCursor },
    }
    const size = spec.limit ? pageValue[spec.limit] : undefined
    if (typeof size === "number") this.loadedRanges.set(key, Math.max(this.loadedRanges.get(key) ?? 0, connection.loaded + size))
    this.loadingKey = key
    this.set({ ...this.state, loadingMore: true })
    const cursor = spec.offset ? null : connection.endCursor
    let errors: readonly GraphQLErrorLike[] = []
    this.loadingMore = this.client
      .execute<T>(this.artifact, next, { readCause: "pagination", ...(cursor === null ? {} : { observeResponse: this.refusal }) })
      .then((result) => { errors = result.errors }, (error: unknown) => this.restartAfterRefusal(key, cursor, error))
      .then(
        () => {
          this.loadingKey = null
          this.set({ ...this.state, loadingMore: false, hasMore: this.connection()?.hasMore ?? false, ...(errors.length ? { errors } : {}) })
        },
        (error: unknown) => {
          this.loadingKey = null
          this.set({ ...this.state, loadingMore: false, error: asError(error) })
        }
      )
      .finally(() => {
        this.loadingMore = null
      })
    return this.loadingMore
  }

  restart = (options: ConnectionOptions = {}): Promise<void> => {
    const key = this.connectionKey(options) ?? connectionsOf(this.artifact)[0]?.key
    if (key instanceof Error) return Promise.reject(key)
    if (key === undefined) return Promise.resolve()
    // Wait for every read in flight, and any started when it ends: `fetch` would join one and drop the restart.
    const busy = this.inflight ?? this.loadingMore
    if (busy) return busy.then(() => (this.users > 0 ? this.restart(options) : undefined))
    this.restartedFrom.delete(key)
    this.client.store.refreshRelations?.(selectorOf(this.artifact, this.variables))
    return this.fetch("manual", undefined, key)
  }

  /**
   * A response whose errors refuse a cursor (`connections.restartOn`), as one under a nullable parent arrives with data: fail it
   * before it is written, so the list isn't replaced by the parent's null and the refusal can restart it.
   */
  private readonly refusal = (response: GraphQLResponse): void => {
    if (!response.data || !response.errors?.length) return
    const error = new OperationError(this.artifact.name, response.errors)
    if (this.client.cursorRefused(error) !== null) throw error
  }

  /**
   * `loadMore` failed. When the server refused the cursor it sent, and hasn't refused this cursor before, read the list again
   * from its first page; otherwise, or when that read is refused too, fail with `error`.
   */
  private async restartAfterRefusal(key: string, cursor: string | null, error: unknown): Promise<void> {
    const code = cursor === null ? null : this.client.cursorRefused(error)
    if (code === null || cursor === null || this.users === 0 || this.client.store.isDisposed || this.restartedFrom.get(key) === cursor) throw error
    this.restartedFrom.set(key, cursor)
    try {
      await this.client.execute<T>(this.artifact, this.variables, { readCause: "pagination", cursorRestart: false, observeResponse: this.refusal, ...this.refreshOptions(key) })
    } catch (again) {
      throw this.client.cursorRefused(again) === null ? again : error
    }
    this.restarted(key, code)
  }

  private restarted(key: string, code: string): void {
    this.restarts.set(key, (this.restarts.get(key) ?? 0) + 1)
    this.client.cursorRestarted(this.artifact, key, code)
  }

  /**
   * What a refresh reads again of each connection: its loaded range, for regenerated artifacts. `restart` also starts that
   * connection again from its first page, dropping what isn't read.
   */
  private refreshOptions(restart?: string): Pick<ExecuteOptions, "refreshConnections"> {
    if (!this.artifact.lists && restart === undefined) return {}
    const declared = connectionsOf(this.artifact)
    const refreshes: Record<string, ConnectionRefresh> = {}
    const entry = (key: string, loaded: number, shared: boolean): ConnectionRefresh => ({
      loaded,
      ...this.client.connectionRereadLimits,
      ...(shared ? { shared } : {}),
      ...(key === restart ? { restart: true } : {}),
      onTruncated: (value: boolean) => {
        // A restart's list is what it read: a later refresh asks for that, not the range before it.
        if (key === restart) this.loadedRanges.delete(key)
        this.truncated.set(key, value)
        this.set({ ...this.state, listRefreshTruncated: [...this.truncated.values()].some(Boolean) })
      },
      onRestart: (code: string) => this.restarted(key, code),
    })
    for (const connection of this.connections()) {
      const { spec, variable } = connection
      if (spec.key in refreshes || variable === null || (spec.key !== restart && (!this.artifact.lists || !spec.limit))) continue
      const shared = declared.some((other) => other.variable === variable && other.key !== spec.key)
      refreshes[spec.key] = entry(spec.key, Math.max(connection.loaded, this.loadedRanges.get(spec.key) ?? 0), shared)
    }
    if (restart !== undefined && !(restart in refreshes)) refreshes[restart] = entry(restart, 0, false)
    return Object.keys(refreshes).length ? { refreshConnections: refreshes } : {}
  }

  /** The query's first `@connection` list, or the first with `key`, with its stored page info. */
  private connection(key?: string): ConnectionInfo | null {
    for (const found of findConnections(this.client.store, this.artifact.selections, this.variables, ROOT_ID)) {
      if (key === undefined || found.spec.key === key) return this.describe(found)
    }
    return null
  }

  /** Every `@connection` list the query reads that is stored, in order. */
  private connections(): ConnectionInfo[] {
    return findConnections(this.client.store, this.artifact.selections, this.variables, ROOT_ID).map((found) => this.describe(found))
  }

  private describe({ spec, selection, id }: { spec: ConnectionSpec; selection: LinkSelection; id: string }): ConnectionInfo {
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

  /** `state` with each connection's state, when the query has any. */
  private withConnections(state: QueryState<T>): QueryState<T> {
    const declared = connectionsOf(this.artifact)
    if (declared.length === 0) return state
    const stored = new Map<string, ConnectionInfo>()
    if (state.data !== undefined) for (const connection of this.connections()) if (!stored.has(connection.spec.key)) stored.set(connection.spec.key, connection)
    const connections: Record<string, ConnectionState> = {}
    for (const { key } of declared) {
      connections[key] ??= {
        hasMore: stored.get(key)?.hasMore ?? false,
        loadingMore: this.loadingKey === key,
        listRefreshTruncated: this.truncated.get(key) ?? false,
        restarts: this.restarts.get(key) ?? 0,
      }
    }
    return { ...state, connections }
  }

  /** Read the query again; `restart` also starts that `@connection` again from its first page. */
  fetch(cause: ReadCause = "manual", beforeSend?: () => void, restart?: string): Promise<void> {
    // A newer read replaces a retry that is waiting: it is sent now, with its own attempts.
    if (this.retryWait) {
      this.retryWait(cause)
      return this.inflight!
    }
    if (this.inflight) return this.inflight
    if (this.loadingMore) return this.loadingMore.then(() => (this.users > 0 ? this.fetch(cause, beforeSend, restart) : undefined))
    if (this.state.data !== undefined) this.set({ ...this.state, status: "refreshing" })
    const controller = new AbortController()
    this.controller = controller
    this.inflight = this.read(controller, cause, beforeSend, restart).finally(() => {
      if (this.controller !== controller) return
      this.controller = null
      this.inflight = null
    })
    return this.inflight
  }

  /** Our own response is being written: the store watch leaves the state to `afterPublish`, which sets data and errors together. */
  private writing = false
  private retryWait: ((cause: ReadCause) => void) | null = null

  private async read(controller: AbortController, cause: ReadCause, beforeSend?: () => void, restart?: string): Promise<void> {
    // Once per read, however many attempts it takes: burst repair counts reads, not requests.
    let sent = false
    const once = beforeSend && (() => {
      if (sent) return
      sent = true
      beforeSend()
    })
    for (let attempt = 0; ; attempt++) {
      let applied = false
      const apply = (snapshot: Snapshot<T>, errors: readonly GraphQLErrorLike[]) => {
        this.writing = false
        if (controller.signal.aborted || this.client.store.isDisposed) return
        applied = true
        this.lastReadAt = this.client.now()
        this.watch(snapshot)
        this.set({
          ...this.state,
          status: "ready",
          data: snapshot.data,
          stale: snapshot.stale,
          lifetime: snapshot.lifetime,
          error: null,
          errors,
          hasMore: this.connection()?.hasMore ?? false,
        })
      }
      try {
        const { snapshot, errors } = await this.client.execute<T>(this.artifact, this.variables, {
          readCause: attempt > 0 ? "retry" : cause,
          beforeSend: once,
          signal: controller.signal,
          beforeWrite: () => { this.writing = true },
          afterPublish: apply,
          ...this.refreshOptions(restart),
        })
        if (!applied) apply(snapshot, errors)
        return
      } catch (error) {
        this.writing = false
        if (controller.signal.aborted) return
        // Only a query is read again: `watchQuery` also takes a mutation's artifact, and a write is never sent twice.
        const delay = this.artifact.kind === "query" && this.users > 0 && !this.client.store.isDisposed && hadNoResponse(error) ? this.client.retryDelay(attempt) : null
        if (delay === null) {
          this.set({ ...this.state, status: "error", error: asError(error) })
          return
        }
        const woken = await this.waitRetry(delay, controller.signal)
        if (controller.signal.aborted || this.client.store.isDisposed) return
        if (woken) {
          // The newer read starts its own count, under its own cause.
          attempt = -1
          cause = woken
        }
      }
    }
  }

  /** Wait `ms` before a retry. Resolves early with a newer read's cause, or with null when the time is up or the read is cancelled. */
  private waitRetry(ms: number, signal: AbortSignal): Promise<ReadCause | null> {
    return new Promise((resolve) => {
      const wake = (cause: ReadCause | null) => {
        if (this.retryWait !== wake) return
        this.retryWait = null
        cancel()
        signal.removeEventListener("abort", aborted)
        resolve(cause)
      }
      const aborted = () => wake(null)
      this.retryWait = wake
      const cancel = this.client.afterRetry(aborted, ms)
      signal.addEventListener("abort", aborted, { once: true })
    })
  }

  /** Whether a read failed and nothing is retrying it, or a retry is waiting: what the browser's `online` event reads again. */
  get awaitingNetwork(): boolean {
    return this.artifact.kind === "query" && this.users > 0 && (this.retryWait !== null || (this.state.status === "error" && !this.inflight))
  }

  /** End a waiting retry, with no state change; the client is being disposed. A request in flight is cancelled by the client. */
  stop(): void {
    if (this.retryWait) this.controller?.abort()
  }

  private rereadCause: ReadCause = "stale"
  private readonly rereadSent = new Set<(request: object) => void>()
  private rereadWaiting = false
  private rereadPending = false
  private rereadTimer: unknown = null
  private rereadAt = -Infinity

  /** Drop a re-read that hasn't started. */
  cancelRereads(): void {
    if (this.rereadTimer !== null) this.client.cancelReread(this.rereadTimer)
    this.rereadTimer = null
    this.rereadPending = false
    this.rereadSent.clear()
  }

  /** Mark stale, coalescing bursts and following an in-flight read with one more. */
  readAgain(cause: ReadCause = "stale", sent?: (request: object) => void, since?: number): void {
    // A pending automatic read still coalesces. One already sent after the last burst event
    // absorbs this mark, including timers due together; a read predating that event follows up.
    if (cause === "burst" && since !== undefined && !this.rereadPending && this.rereadAt > since) return
    if (!this.rereadPending) this.rereadCause = cause
    if (sent) this.rereadSent.add(sent)
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
    if (this.inflight || this.loadingMore) {
      this.rereadWaiting = true
      const finish = () => {
        this.rereadWaiting = false
        this.drainReread()
      }
      void (this.inflight ?? this.loadingMore)!.then(finish, finish)
      return
    }
    this.rereadPending = false
    this.rereadAt = this.client.now()
    const callbacks = [...this.rereadSent]
    this.rereadSent.clear()
    void this.fetch(this.rereadCause, () => { const request = {}; for (const sent of callbacks) sent(request) })
  }

  /** Whether a projection omits something selected by this query's held fragments. */
  needsEventReread(typename: string, stale: boolean, fragments: readonly string[]): boolean {
    const holding = this.liveHoldings.get(typename)
    return this.artifact.lists?.includes(typename) === true || !!holding && (stale || this.artifact.liveReread?.includes(typename) === true || fragments.some((name) => this.artifact.fragments[name] !== undefined))
  }

  private watch(snapshot: Snapshot<T>): void {
    this.unsubscribeStore?.()
    this.holdLive()
    this.unsubscribeStore = this.client.store.subscribe(snapshot, (next, { structural }) => {
      // This query's own response: `afterPublish` sets its data with its errors, in one change, once the write is done.
      if (this.writing) return
      this.set({ ...this.state, data: next.data as T, stale: next.stale, lifetime: next.lifetime, hasMore: this.connection()?.hasMore ?? false })
      // Which records the query reaches through `@live` fragments changes only with a link, a new record or a removed one among the
      // records it reaches. A changed scalar leaves what it holds as it was, and reading the whole query again for each one costs as
      // much as the query is long.
      if (!this.reach || intersects(this.reach, structural)) this.holdLive()
      // A record this query shows was deleted or collected: read it again from the server.
      if (next.missing && this.users > 0) {
        if (this.artifact.lists) this.readAgain()
        else void this.fetch("stale")
      }
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
    for (const typename of this.artifact.lists ?? []) {
      const existing = result.get(typename)
      result.set(typename, { held: existing?.held ?? [], fragments: [...(existing?.fragments ?? []), this.artifact.name], pollMs: this.pollMs, lastReadAt: this.lastReadAt, list: true, listReason: this.state.listRefreshTruncated ? "list-refresh-truncated" : this.client.live?.listReason(typename) ?? null })
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
    this.reach = readSelections(this.client.store, selectorOf(this.artifact, this.variables), {
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
    }).seen
    live?.hold(this.key, targets)
    this.refreshFallbackPoll()
    this.client.healthChanged()
  }

  private uncovered = false
  /** Every record the last `holdLive` read, through fragments too. */
  private reach: ReadonlySet<string> | null = null

  /** Poll when this query holds `@live` records that nothing else keeps fresh. */
  refreshFallbackPoll(): void {
    if (this.users === 0) return
    const live = this.client.live
    const types = [...this.liveHoldings.keys()]
    const exposed = live ? types.some((typename) => live.covers(typename) && (live.overflows(typename) || live.refusedNow(typename))) : false
    this.fallbackPoll = this.uncovered || exposed || (this.artifact.lists ?? []).some(type => !live?.covers(type) || live.listReason(type) !== null || live.refusedNow(type))
    this.schedulePoll()
  }

  private set(state: QueryState<T>): void {
    this.state = this.withConnections(state)
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
  /** Queries someone has open. */
  private readonly resources = new Map<string, QueryResource<unknown>>()
  /**
   * Queries nobody has open, held only by their handles. React calls `watchQuery` during render and can throw that render away
   * without running its effects, so a handle may never be opened or closed; a strong map would keep each such query for good.
   * Handles for one key still share one query while any of them is reachable.
   */
  private readonly unopened = new Map<string, WeakRef<QueryResource<unknown>>>()
  private readonly forget = new FinalizationRegistry<{ key: string; ref: WeakRef<QueryResource<unknown>> }>(({ key, ref }) => {
    if (this.unopened.get(key) === ref) this.unopened.delete(key)
  })

  private keepUnopened(key: string, resource: QueryResource<unknown>): void {
    const ref = new WeakRef(resource)
    this.unopened.set(key, ref)
    this.forget.register(resource, { key, ref }, ref)
  }
  private readonly controllers = new Set<AbortController>()
  private readonly subscriptions = new Set<() => void>()
  private readonly subscribeTransport: LiveOptions["subscribe"] | null
  private mutationCount = 0
  private readCounts: Readonly<Record<ReadCause, number>> = { first: 0, manual: 0, poll: 0, stale: 0, confirm: 0, restart: 0, reconnect: 0, burst: 0, pagination: 0, relation: 0, retry: 0, online: 0 }

  private countRead(cause: ReadCause): void {
    if (this.live) this.readCounts = { ...this.readCounts, [cause]: this.readCounts[cause] + 1 }
  }


  readonly polling: PollingOptions

  /** How error-associated null writes affect previously cached values. */
  readonly partialResults: "legacy" | "preserve-errors"

  private readonly writeWithoutData: "by-code" | "refused"

  constructor(options: ClientOptions) {
    this.partialResults = options.partialResults ?? "legacy"
    this.writeWithoutData = options.writeWithoutData === "refused" ? "refused" : "by-code"
    this.network = options.network
    this.polling = options.polling ?? {}
    this.subscribeTransport = options.live?.subscribe ?? null
    this.store = new Store(options.store)
    this.live = options.live
      ? new LiveManager(
          this.store,
          options.live,
          (holders, cause, sent, since) => {
            for (const resource of this.resources.values()) {
              if (resource.users > 0 && holders.has(resource.key)) {
                this.store.refreshRelations?.(selectorOf(resource.artifact, resource.variables))
                void resource.readAgain(cause, sent ? request => sent(resource.key, request) : undefined, since)
              }
            }
          },
          (timing) => this.healthChanged(timing),
          () => {
            for (const resource of this.resources.values()) resource.refreshFallbackPoll()
          },
          (holders, typename, stale, fragments) => {
            for (const resource of this.resources.values()) {
              if (holders.has(resource.key) && resource.needsEventReread(typename, stale, fragments)) resource.readAgain()
            }
          }
        )
      : null
    this.rereadOptions = options.live
    this.minRereadMs = Math.max(1, options.live?.minRereadMs ?? 2000)
    this.clock = options.live?.now ?? Date.now
    const fallback = options.live?.onDiagnostic === undefined ? defaultDiagnostic : options.live.onDiagnostic
    this.onDiagnostic = fallback
    this.restartOn = new Set(options.connections?.restartOn ?? ["CURSOR_INVALID"])
    this.maxNodes = options.refetchBatch === false ? 1 : Math.max(1, Math.floor(options.refetchBatch?.maxNodes ?? 100))
    this.missingFields = options.missingFields ?? (isProduction() ? "off" : "warn")
    const retry = options.reads?.retry
    this.retry = retry ? { retries: 3, baseMs: 1000, maxMs: 30_000, random: Math.random, ...(retry === true ? {} : retry) } : null
    this.retryTimers = options.live?.setTimeout ? options.live : options.store?.setTimeout ? options.store : null
    if (options.reads?.refetchOnOnline !== false && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const online = () => {
        if (this.store.isDisposed) return
        for (const resource of [...this.resources.values()]) {
          if (!resource.awaitingNetwork) continue
          this.store.refreshRelations?.(selectorOf(resource.artifact, resource.variables))
          void resource.fetch("online")
        }
      }
      window.addEventListener("online", online)
      this.subscriptions.add(() => window.removeEventListener("online", online))
    }
  }

  private readonly restartOn: ReadonlySet<string>
  /** Most `NodeIds` in one `nodes` request; 1 turns batching off. */
  private readonly maxNodes: number

  /**
   * The code a restart from the first page answers, when `error` is a refused cursor (`connections.restartOn`) with no error
   * about access; otherwise null.
   */
  cursorRefused(error: unknown): string | null {
    if (this.restartOn.size === 0 || !(error instanceof OperationError)) return null
    const classified = classifyErrors(error)
    if (classified.some((entry) => entry.kind === "unauthenticated" || entry.kind === "forbidden" || ACCESS_CODES.has(entry.code ?? ""))) return null
    return classified.find((entry) => entry.code !== null && this.restartOn.has(entry.code))?.code ?? null
  }

  /** Report, once per list, that `artifact`'s connection `key` started again from its first page. */
  cursorRestarted(artifact: OperationArtifact<any, any>, key: string, code: string): void {
    const diagnosed = `${artifact.name}\u0000${key}\u0000cursor-restarted`
    if (!this.onDiagnostic || this.diagnosed.has(diagnosed)) return
    this.diagnosed.add(diagnosed)
    const typename = connectionNodeType(artifact.normalization, key)
    this.onDiagnostic({
      fragment: artifact.name,
      typename,
      state: this.liveTypeHealth(typename).state,
      reason: "cursor-restarted",
      code,
      message: `graphql-orm-client: ${artifact.name}'s @connection "${key}" started again from its first page: the server refused its cursor (${code}). Its loaded rows were read again.`,
    })
  }

  /** What a response that leaves out a selected field does. */
  private readonly missingFields: "warn" | "error" | "off"
  /** Operation and path of each left-out field already warned about. */
  private readonly warnedMissing = new Set<string>()
  private readonly retry: Required<ReadRetryOptions> | null
  private readonly retryTimers: { setTimeout?: (callback: () => void, ms: number) => unknown; clearTimeout?: (handle: unknown) => void } | null

  /** How long a watched query waits before retry `attempt` (from 0) of a read that got no response, or null for no retry. */
  retryDelay(attempt: number): number | null {
    const retry = this.retry
    if (!retry || attempt >= retry.retries) return null
    const cap = Math.min(retry.maxMs, retry.baseMs * 2 ** attempt)
    return cap / 2 + (cap / 2) * Math.min(1, Math.max(0, retry.random()))
  }
  /** Schedule a retry on the live or store timer seam, else the global timer; returns its cancel. */
  afterRetry(callback: () => void, ms: number): () => void {
    const timers = this.retryTimers
    if (timers?.setTimeout) {
      const handle = timers.setTimeout(callback, ms)
      return () => (timers.clearTimeout ?? clearTimeout)(handle as ReturnType<typeof setTimeout>)
    }
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  }

  /** Interval for automatic stale and confirming reads. */
  readonly minRereadMs: number
  /** Bound automatic loaded-connection refresh work. */
  get connectionRereadLimits(): { pages: number; rows: number } { return { pages: Math.max(1, this.rereadOptions?.maxRereadPages ?? 10), rows: Math.max(1, this.rereadOptions?.maxRereadRows ?? 100) } }
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
    const next: LiveHealth = { hasLiveLayer: this.live !== null, ...(this.live ? { reads: this.readCounts, streams: Object.values(statuses).reduce((sum, type) => sum + type.subscriptions, 0), refusedStreams: this.live.refusedStreams } : {}), socket, worst: worstOf(Object.values(types).map((entry) => entry.state)), types }
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
      const key = JSON.stringify(health, (name, value) => (["lastEventAt", "lastReadAt", "burstReads", "lastBurstReadAt", "reads", "refusedStreams"].includes(name) ? undefined : value))
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

  /**
   * Start live delivery again after the server closed the socket for authentication (`liveHealth()` reason
   * `unauthenticated`). Call it once the transport has new credentials in place, for graphql-ws once `connectionParams`
   * returns them: the held types subscribe again, and the queries holding them read, since nothing was delivered
   * meanwhile. If the credentials still aren't accepted, it stops again with no retry on a timer. Does nothing when live
   * delivery hasn't stopped for authentication, or without a live layer.
   */
  reconnectLive(): void {
    this.live?.reconnect()
  }

  /** Refetch every open query; call after a subscription reconnect may have missed events. */
  async refetchActive(): Promise<void> {
    await this.refetchQueries("active")
  }

  /**
   * Refetch the open queries of these operations, or every open query for `"active"`. An entry is an
   * artifact or an operation name, which selects every open instance of it, or
   * `{ query, variables }`, which selects only the instances whose variables match: a predicate, or
   * an object whose every field equals the instance's variable of that name. Resolves when they
   * have been read again; failures go to each query's state, not here. Queries nobody has open are
   * not fetched.
   */
  async refetchQueries(include: "active" | readonly RefetchQuery[]): Promise<void> {
    const same = (artifact: OperationArtifact<any, any>, query: OperationArtifact<any, any> | string) =>
      typeof query === "string" ? artifact.name === query : artifact === query || artifact.hash === query.hash
    const matches = (resource: QueryResource<unknown>) =>
      include === "active" ||
      include.some((entry) => {
        if (typeof entry === "string" || !("query" in entry)) return same(resource.artifact, entry)
        if (!same(resource.artifact, entry.query)) return false
        const { variables } = entry
        if (variables === undefined) return true
        if (typeof variables === "function") return variables(resource.variables) === true
        return Object.entries(variables).every(([name, value]) => stableStringify(resource.variables[name]) === stableStringify(value))
      })
    await Promise.all(
      [...this.resources.values()].filter((resource) => resource.users > 0 && matches(resource)).map((resource) => resource.refetch())
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
    if (artifact.sensitive) {
      const { snapshot, errors } = await this.execute(artifact, variables, options)
      return { data: snapshot.data, errors }
    }
    const selector = selectorOf(artifact, variables)
    if ((options.policy ?? "store-or-network") === "store-or-network") {
      this.store.configureLifetimes(artifact.lifetimes)
      const stored = this.store.lookup<T>(selector)
      if (!stored.missing && !stored.stale) return { data: stored.data, errors: [] }
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

  /**
   * For optional entry points built on the client: its live options, and a place to register something to end with its identity.
   * Returns a function to remove that registration.
   */
  liveExtension(end: () => void): { readonly live: LiveOptions; remove(): void } {
    if (this.store.isDisposed) throw new Error("This client was disposed with its identity")
    if (!this.rereadOptions) throw new Error("This needs live.subscribe")
    this.subscriptions.add(end)
    return { live: this.rereadOptions, remove: () => void this.subscriptions.delete(end) }
  }

  /**
   * Read the rest of connection `key`'s loaded keyset range after its first page, up to the limits, and merge it into `data`.
   * Returns where the store's kept tail starts: `Infinity` when the whole range was read again, or for a restart.
   */
  private async readLoadedRange(
    artifact: OperationArtifact<any, any>,
    variables: Variables,
    data: Record<string, unknown>,
    key: string,
    refresh: ConnectionRefresh,
    signal: AbortSignal,
    cause: ReadCause
  ): Promise<number | undefined> {
    let found = locateConnection(artifact.normalization, data, key)
    if (!found) return undefined
    const spec = found.selection.connection!
    const arg = found.selection.args.find(arg => arg.name === spec.paging[0])
    if (arg?.kind !== "variable" || !spec.limit) return refresh.restart ? Infinity : undefined
    const page = (variables[arg.variable] ?? {}) as Record<string, unknown>
    const target = refresh.loaded
    const edgesKey = found.selection.selections.find((s): s is LinkSelection => s.kind === "link" && s.fieldName === spec.edges)?.responseKey ?? spec.edges
    const infoKey = found.selection.selections.find((s): s is LinkSelection => s.kind === "link" && s.fieldName === spec.pageInfo)?.responseKey ?? spec.pageInfo
    // A cursor in a shared paging variable would reach the other list too, so a shared list is read in its one request.
    if (!spec.offset && !refresh.shared) {
      let count = 1
      while (found && (found.data[edgesKey] as unknown[]).length < target && count < refresh.pages) {
        const info = found.data[infoKey] as Record<string, unknown>
        if (info[spec.hasNextPage] !== true || typeof info[spec.endCursor] !== "string") break
        // Only the rows still missing, so the last request doesn't read a whole page past what's loaded.
        const size = Math.min(target - (found.data[edgesKey] as unknown[]).length, Math.max(refresh.rows, Number(page[spec.limit]) || 0))
        const next = { ...variables, [arg.variable]: { ...page, [spec.after]: info[spec.endCursor], [spec.limit]: size } }
        this.countRead(cause)
        const extra = await this.network.execute({ kind: artifact.kind, name: artifact.name, text: artifact.text, hash: artifact.hash, variables: next }, { signal })
        if (extra.errors?.length || !extra.data) throw new ContinuationError(artifact.name, extra.errors ?? [], key)
        const part = locateConnection(artifact.normalization, extra.data, key)
        if (!part || !(part.data[edgesKey] as unknown[]).length) break
        // A row that moved between reads comes back on the next page too. Count it once, so the range still fills.
        const nodeId = (edge: unknown) => {
          const node = (edge as Record<string, unknown> | null)?.[spec.node] as Record<string, unknown> | null | undefined
          return node ? identify(node, artifact.keys) : null
        }
        const seen = new Set((found.data[edgesKey] as unknown[]).map(nodeId))
        const fresh = (part.data[edgesKey] as unknown[]).filter((edge) => !seen.has(nodeId(edge)))
        found.data[edgesKey] = [...(found.data[edgesKey] as unknown[]), ...fresh]
        found.data[infoKey] = part.data[infoKey]
        count++
      }
    }
    const length = (found.data[edgesKey] as unknown[]).length
    const more = (found.data[infoKey] as Record<string, unknown> | null | undefined)?.[spec.hasNextPage] === true
    // A restart keeps nothing past what it read: the rest would continue from the refused cursor.
    const truncated = length < target && more && !refresh.restart
    refresh.onTruncated(truncated)
    return truncated ? length : Infinity
  }

  /** Report fields the response leaves out, per `missingFields`; returns the errors to resolve with. */
  private checkFields(artifact: OperationArtifact<any, any>, data: Record<string, unknown>, errors: readonly GraphQLErrorLike[], variables: Variables): readonly GraphQLErrorLike[] {
    const missing = missingFields(artifact, data, errors, variables)
    if (!missing.length) return errors
    if (this.missingFields === "error")
      return [...errors, ...missing.map((field) => ({ message: missingFieldMessage(artifact.name, field), path: field.path, extensions: { code: RESPONSE_FIELD_MISSING } }))]
    for (const field of missing) {
      const key = `${artifact.name}\u0000${field.path.map((part) => (typeof part === "number" ? "[]" : part)).join(".")}`
      if (this.warnedMissing.has(key)) continue
      this.warnedMissing.add(key)
      console.warn(missingFieldMessage(artifact.name, field))
    }
    return errors
  }

  /** Send an operation and write its response into the store. */
  async execute<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: ExecuteOptions = {}
  ): Promise<{ snapshot: Snapshot<T>; errors: readonly GraphQLErrorLike[] }> {
    const { snapshot, errors } = await this.executeResponse(artifact, variables, options)
    return { snapshot, errors }
  }

  /** `execute`, also returning the response's data as the server sent it. For optional entry points built on the client. */
  async executeResponse<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: ExecuteOptions = {}
  ): Promise<{ snapshot: Snapshot<T>; errors: readonly GraphQLErrorLike[]; response: Record<string, unknown>; alsoRead?: unknown }> {
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
      const refreshes = options.refreshConnections
      const networkVariables = refreshes ? refreshVariables(artifact, variables, refreshes) : variables as Variables
      options.beforeSend?.()
      const cause = options.readCause ?? "manual"
      const send = async () => {
        if (artifact.kind === "query") this.countRead(cause)
        const response = await this.network.execute(
          { kind: artifact.kind, name: artifact.name, text: artifact.text, hash: artifact.hash, variables: networkVariables },
          { signal: controller.signal }
        )
        if (this.store.isDisposed || controller.signal.aborted)
          throw new DOMException("The request was cancelled", "AbortError")
        options.observeResponse?.(response)
        const tails: Record<string, number> = {}
        for (const [key, refresh] of refreshes && response.data ? Object.entries(refreshes) : []) {
          const tail = await this.readLoadedRange(artifact, variables as Variables, response.data!, key, refresh, controller.signal, cause)
          if (tail !== undefined) tails[key] = tail
        }
        if (this.store.isDisposed || controller.signal.aborted) throw new DOMException("The request was cancelled", "AbortError")
        return { response, tails }
      }
      let sent: Awaited<ReturnType<typeof send>>
      try {
        sent = await send()
      } catch (error) {
        // A cursor the refresh followed was refused: read the range again from its first page, once.
        const code = error instanceof ContinuationError && options.cursorRestart !== false ? this.cursorRefused(error) : null
        if (code === null) throw error
        try {
          sent = await send()
        } catch (again) {
          throw again instanceof ContinuationError && this.cursorRefused(again) !== null ? error : again
        }
        refreshes![(error as ContinuationError).connection]?.onRestart?.(code)
      }
      const { response, tails } = sent
      const connectionTails = Object.keys(tails).length ? tails : undefined
      let errors = response.errors ?? []
      options.beforeWrite?.()
      if (!response.data) throw new OperationError(artifact.name, errors)
      if (this.missingFields !== "off") errors = this.checkFields(artifact, response.data, errors, variables as Variables)
      if (artifact.sensitive) return {
        snapshot: { data: response.data as T, missing: false, seen: new Set(), selector: selectorOf(artifact, variables) },
        errors,
        response: response.data,
      }
      const rootId = artifact.kind === "query" ? ROOT_ID : `client:${artifact.kind}:${++this.mutationCount}`
      const target = options.isolated ? new Store() : this.store
      normalize(target, artifact.normalization, this.partialResults === "preserve-errors" ? withoutErrorNulls(response.data, errors) : response.data, { ...contextOf(artifact, variables), ...(connectionTails ? { connectionTails } : {}) }, rootId, artifact.rootType)
      target.publish()
      const snapshot = target.lookup<T>(selectorOf(artifact, variables, rootId))
      const alsoRead = options.alsoRead ? target.lookup({ ...snapshot.selector, selections: options.alsoRead }).data : undefined
      if (rootId !== ROOT_ID) target.delete(rootId)
      options.afterPublish?.(snapshot, errors)
      return { snapshot, errors, response: response.data, ...(options.alsoRead ? { alsoRead } : {}) }
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
    if (artifact.sensitive) throw new Error(`${artifact.name}: @sensitive queries use client.query; watched results retain values`)
    const { policy = "store-and-network", pollMs } = typeof options === "string" ? { policy: options } : options
    if (pollMs !== undefined && !artifact.pollReason?.trim()) {
      const message = `Operation ${artifact.name}: pollMs needs @poll(reason: "why polling is needed") on the query. Add it and regenerate, or set polling.undeclared.`
      const setting = this.polling.undeclared
      // A build can't see a runtime option, so this is what finds it. Left unset, it throws only where the environment says it's
      // development or tests. Never on a module generated before the rule existed (no `lists`): a working page mustn't crash on upgrade.
      if ((setting === "error" || (setting === undefined && isDevelopment())) && artifact.lists !== undefined) throw new Error(message)
      if (setting !== "off") console.warn(message)
    }
    const key = `${queryKey(artifact, variables)}:${policy}`
    let resource = (this.resources.get(key) ?? this.unopened.get(key)?.deref()) as QueryResource<T> | undefined
    if (!resource) {
      resource = new QueryResource<T>(this, artifact, variables, queryKey(artifact, variables), policy)
      if (!this.store.isDisposed) this.keepUnopened(key, resource as QueryResource<unknown>)
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
      restart: shared.restart,
      open: () => {
        if (opened || this.store.isDisposed) return
        opened = true
        if (!this.resources.has(key)) {
          this.resources.set(key, shared as QueryResource<unknown>)
          if (this.unopened.get(key)?.deref() === shared) {
            const ref = this.unopened.get(key)!
            this.unopened.delete(key)
            this.forget.unregister(ref)
          }
        }
        if (pollMs !== undefined) shared.addPoll(token, pollMs)
        shared.open()
      },
      close: () => {
        if (!opened) return
        opened = false
        shared.removePoll(token)
        shared.close()
        if (shared.users === 0 && this.resources.get(key) === shared) {
          this.resources.delete(key)
          // Handles still held, as by a mounted loader, keep sharing it.
          if (!this.store.isDisposed && !this.unopened.get(key)?.deref()) this.keepUnopened(key, shared as QueryResource<unknown>)
        }
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

  /**
   * Start a route read before mount. Shares a store-or-network read for equal artifacts/variables.
   * Lists open their stream before this read (R3), even before mount; an unused loader closes after timeoutMs (default 30 seconds)
   * and reopens if it's mounted later. Pass the router's abort signal and dispose on abandonment; a disposed loader can't be mounted.
   * Mount through useLoadedQuery; do not pass this result to useQuery.
   */
  loadQuery<T, V extends Variables>(
    artifact: OperationArtifact<T, V>, variables: V,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): LoadedQuery<T> {
    const timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("loadQuery timeoutMs must be positive and finite")
    const watched = this.watchQuery(artifact, variables, "store-or-network")
    let disposed = false
    let open = false
    let finishCancellation!: () => void
    const cancelled = new Promise<void>(resolve => { finishCancellation = resolve })
    let mounts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // Nobody is using it for now: an expired load, or the last unmount. A later mount opens it again, because a handle can
    // outlive this, as when a slow route chunk takes longer than timeoutMs or a parent remounts.
    // The wait of a render suspended on this load (`suspend`), while it is pending.
    let wake: (() => void) | null = null
    const idle = () => {
      if (!open) return
      open = false
      clearTimeout(timer)
      this.subscriptions.delete(dispose)
      watched.close()
      // After the caller's turn: a client being disposed has disposed its store by then, and that wait never resolves.
      const pending = wake
      if (pending) queueMicrotask(pending)
    }
    const dispose = () => {
      if (disposed) return
      disposed = true
      finishCancellation()
      options.signal?.removeEventListener("abort", dispose)
      idle()
    }
    const start = () => {
      open = true
      this.subscriptions.add(dispose)
      watched.open()
    }
    const live = () => {
      if (disposed || this.store.isDisposed) throw new Error(`${artifact.name}: route load was disposed; start a new loadQuery`)
      clearTimeout(timer)
      if (!open) start()
    }
    const unused = (ms = timeoutMs) => {
      clearTimeout(timer)
      timer = setTimeout(idle, ms)
      timer.unref?.()
    }
    let waiting: (Promise<void> & { status?: "fulfilled"; value?: undefined }) | null = null
    const loaded: LoadedQuery<T> = {
      ...watched, client: this,
      ready: Promise.resolve(),
      dispose,
      get waiting() { return waiting },
      suspend: () => {
        if (wake) return waiting!
        live()
        // A waiting render holds the load for up to two deadlines; then it closes, and a render still waiting opens it again.
        unused(2 * timeoutMs)
        let off = () => {}, resolve!: () => void
        const promise: NonNullable<typeof waiting> = new Promise<void>(done => { resolve = done })
        const settle = wake = () => {
          if (wake !== settle) return
          wake = null
          off()
          if (open && mounts === 0) unused()
          if (this.store.isDisposed) return
          // As React's `use` reads it, so a render after this one doesn't suspend on a settled wait.
          promise.status = "fulfilled"
          resolve()
        }
        off = watched.subscribe(() => { if (watched.getState().status !== "loading") settle() })
        if (watched.getState().status !== "loading") queueMicrotask(settle)
        return waiting = promise
      },
      mount: () => {
        live()
        mounts += 1
        let released = false
        return () => {
          if (released) return
          released = true
          mounts -= 1
          // React replays effects synchronously. Keep the read and stream across that replay.
          queueMicrotask(() => { if (mounts === 0) idle() })
        }
      },
    }
    if (options.signal?.aborted || this.store.isDisposed) { dispose(); return loaded }
    options.signal?.addEventListener("abort", dispose, { once: true })
    unused()
    start()
    // open starts the request; refetch joins it, except for an already complete cached read.
    if (!disposed) Object.assign(loaded, { ready: watched.getState().status === "ready" ? Promise.resolve() : Promise.race([watched.refetch(), cancelled]) })
    return loaded
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
    options: MutateOptions<T> = {}
  ): Promise<{ data: T; errors: readonly GraphQLErrorLike[] }> {
    if (artifact.kind !== "mutation") throw new Error(`${artifact.name} is not a mutation`)
    // A misspelt policy must not quietly store a secret.
    if (options.policy !== undefined && options.policy !== "store" && options.policy !== "no-store")
      throw new Error(`${artifact.name}: unknown mutation policy ${JSON.stringify(options.policy)}`)
    const isolated = artifact.sensitive || options.policy === "no-store"
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
    let sent = false
    let response: GraphQLResponse | undefined
    let failure: unknown
    try {
      const { snapshot, errors } = await this.execute<T>(artifact, variables, {
        observeResponse: value => { response = value },
        beforeSend: () => { sent = true },
        beforeWrite: rollback,
        ...(isolated ? { isolated } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      result = { data: snapshot.data, errors }
    } catch (error) {
      failure = error
      throw error
    } finally {
      rollback()
      const status = response ? writeStatus(response, {
        withoutData: this.writeWithoutData,
        refusedCodes: options.refusedCodes,
        roots: options.refusedCodes && rootKeys(artifact.normalization),
        confirm: options.confirm as ((data: Record<string, unknown>) => boolean) | undefined,
      }) : wasNotSent(failure) || !sent ? "failed" : "unconfirmed"
      let reconciliation: WriteOutcome["reconciliation"] = status === "unconfirmed" ? "unavailable" : "not-needed"
      if (status === "unconfirmed" && options.reconcile && !this.store.isDisposed) {
        try { await options.reconcile(); reconciliation = "reread" }
        catch { reconciliation = "failed" }
      }
      options.onOutcome?.({ status, reconciliation })
    }
    if (options.refetchQueries?.length) await this.refetchQueries(options.refetchQueries)
    return result
  }

  /**
   * Opt into explicit write certainty. Never retries; call again with fresh variables after
   * authentication. Supply a reconciliation read for known records, such as refetchFragment.
   */
  async mutateOutcome<T, V extends Variables>(
    artifact: OperationArtifact<T, V>, variables: V,
    options: MutateOptions<T> = {}
  ): Promise<{ data?: T; errors: readonly GraphQLErrorLike[]; error?: unknown; outcome: WriteOutcome }> {
    let outcome: WriteOutcome = { status: "failed", reconciliation: "not-needed" }
    try {
      const result = await this.mutate(artifact, variables, { ...options, onOutcome: value => {
        outcome = value
        options.onOutcome?.(value)
      } })
      return { ...result, outcome }
    } catch (error) {
      return { error, errors: error instanceof OperationError ? error.errors : [], outcome }
    }
  }

  /**
   * Read a `@refetchable` fragment's record again through the router's `node(NodeId)` lookup and
   * write it into the store; every view of the record updates. A null result without errors
   * means the record is now missing or denied, so it is removed, as on a DELETED event. A
   * failure (errors, a network error) leaves the stored record as it was.
   *
   * Calls for the same fragment made in one tick share one `nodes(NodeIds)` request, in chunks of
   * `refetchBatch.maxNodes`, when the module was generated against a schema with `nodes`. Each call
   * still gets its own result: `found`, and the errors at its entry or with no entry. A missing
   * entry removes only its record; a failed request rejects every call in it and changes nothing.
   * A call whose signal aborts rejects at once; the request is cancelled when every call in it has.
   */
  async refetchFragment<N extends string>(
    fragment: FragmentArtifact<any, N>,
    ref: FragmentRefFor<N>,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ found: boolean; errors: readonly GraphQLErrorLike[] }> {
    if (!fragment.refetch) throw new Error(`${fragment.name} is not @refetchable`)
    const { selector } = fragmentSelector(fragment, ref)
    const batch = fragment.refetchNodes
    if (!batch || this.maxNodes <= 1) return this.refetchNode(fragment.refetch, selector.id, options.signal)
    if (this.store.isDisposed) throw new Error("This client was disposed with its identity")
    if (options.signal?.aborted) throw cancelled()
    return new Promise((resolve, reject) => {
      let queue = this.refetchQueues.get(batch.hash)
      if (!queue) {
        queue = { batch, single: fragment.refetch!, calls: [] }
        this.refetchQueues.set(batch.hash, queue)
        queueMicrotask(() => this.flushRefetches(batch.hash))
      }
      const call: RefetchCall = { id: selector.id, settled: false, resolve, reject, release: () => {} }
      const signal = options.signal
      if (signal) {
        const abort = () => settle(call, { error: cancelled() })
        signal.addEventListener("abort", abort, { once: true })
        call.signal = signal
        call.release = () => signal.removeEventListener("abort", abort)
      }
      queue.calls.push(call)
    })
  }

  /** `refetchFragment` calls waiting for this tick's request, by batched query. */
  private readonly refetchQueues = new Map<string, { batch: OperationArtifact; single: OperationArtifact; calls: RefetchCall[] }>()

  private flushRefetches(hash: string): void {
    const queue = this.refetchQueues.get(hash)
    this.refetchQueues.delete(hash)
    if (!queue) return
    const calls = queue.calls.filter((call) => !call.settled)
    if (this.store.isDisposed) {
      for (const call of calls) settle(call, { error: cancelled() })
      return
    }
    const ids = [...new Set(calls.map((call) => call.id))]
    // One record needs no list: send the lookup a single call sends.
    if (ids.length === 1) {
      const shared = sharedSignal(calls)
      this.refetchNode(queue.single, ids[0]!, shared.signal)
        .then(
          (result) => calls.forEach((call) => settle(call, { result })),
          (error: unknown) => calls.forEach((call) => settle(call, { error }))
        )
        .finally(shared.release)
      return
    }
    for (let start = 0; start < ids.length; start += this.maxNodes) {
      const chunk = ids.slice(start, start + this.maxNodes)
      const members = new Set(chunk)
      void this.refetchNodes(queue.batch, chunk, calls.filter((call) => members.has(call.id)))
    }
  }

  /** Read one record through `node(NodeId)`. */
  private async refetchNode(
    query: OperationArtifact,
    id: string,
    signal: AbortSignal | undefined
  ): Promise<{ found: boolean; errors: readonly GraphQLErrorLike[] }> {
    const { snapshot, errors } = await this.execute(query as OperationArtifact<{ node: unknown }>, { NodeId: id }, signal ? { signal } : {})
    const found = snapshot.data.node !== null && snapshot.data.node !== undefined
    if (!found && errors.length === 0) {
      this.store.delete(id)
      this.store.publish()
    }
    return { found, errors }
  }

  /** Read several records through `nodes(NodeIds)`, which answers in the order asked, with null for each it can't give. */
  private async refetchNodes(query: OperationArtifact, ids: readonly string[], calls: readonly RefetchCall[]): Promise<void> {
    let results: Map<string, { found: boolean; errors: readonly GraphQLErrorLike[] }>
    const { signal, release } = sharedSignal(calls)
    try {
      const { snapshot, errors } = await this.execute(query as OperationArtifact<{ nodes: readonly unknown[] | null }>, { NodeIds: ids }, signal ? { signal } : {})
      const nodes = snapshot.data.nodes
      const at = (error: GraphQLErrorLike) => (error.path?.[0] === "nodes" && typeof error.path[1] === "number" ? error.path[1] : null)
      const general = errors.filter((error) => at(error) === null)
      results = new Map()
      let removed = false
      ids.forEach((id, index) => {
        const own = [...general, ...errors.filter((error) => at(error) === index)]
        const found = Array.isArray(nodes) && nodes[index] !== null && nodes[index] !== undefined
        if (!found && own.length === 0 && Array.isArray(nodes)) {
          this.store.delete(id)
          removed = true
        }
        results.set(id, { found, errors: own })
      })
      if (removed) this.store.publish()
    } catch (error) {
      for (const call of calls) settle(call, { error })
      return
    } finally {
      release()
    }
    for (const call of calls) settle(call, { result: results.get(call.id)! })
  }

  dispose(): void {
    for (const queue of this.refetchQueues.values()) for (const call of queue.calls) settle(call, { error: cancelled() })
    this.refetchQueues.clear()
    for (const stop of [...this.subscriptions]) stop()
    for (const resource of this.resources.values()) {
      resource.cancelRereads()
      resource.stop()
    }
    this.live?.dispose()
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.resources.clear()
    this.unopened.clear()
    this.healthListeners.clear()
    this.store.dispose()
  }
}

/**
 * The bundle's `process.env.NODE_ENV`, or undefined where nothing defines it, as in a browser bundle that doesn't replace it.
 * Written out in full, with no guard or optional chaining, because bundlers replace only that exact expression.
 */
function nodeEnv(): string | undefined {
  try {
    const value = process.env.NODE_ENV
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

function isProduction(): boolean {
  return nodeEnv() === "production"
}

/** Development or tests, said so by the bundle or runtime. An unknown environment isn't, so it never throws in a built page. */
function isDevelopment(): boolean {
  const value = nodeEnv()
  return value !== undefined && value !== "production"
}

function defaultDiagnostic(diagnostic: LiveDiagnostic): void {
  if (isProduction()) return
  console.warn(diagnostic.message)
}

export function createClient(options: ClientOptions): Client {
  return new Client(options)
}

/** The masked-reference data behind a fragment reference, or null. */
export function refData(ref: unknown): FragmentRefData | null {
  if (typeof ref !== "object" || ref === null) return null
  return ((ref as Record<symbol, unknown>)[FRAGMENT_REF] as FragmentRefData | undefined) ?? null
}

/**
 * Whether `ref` carries a spread of `fragment`. A spread under `@skip` or `@include` is typed as possibly absent, and is absent
 * when its condition leaves it out; check with this before `readFragment` or `useFragment`.
 *
 * @example
 * ```ts
 * if (hasFragment(WidgetDetail, data.Widget)) return <Detail widget={data.Widget} />
 * ```
 */
export function hasFragment<N extends string, R>(fragment: FragmentArtifact<any, N>, ref: R): ref is R & FragmentRefFor<N> {
  return refData(ref)?.fragments.has(fragment.name) === true
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
 * can call it; components that should re-render use `useFragment` instead. `{ deleted: "null" }` types a
 * deleted or missing record as null; a live record's data is unchanged.
 */
export function readFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>, ref: FragmentRefFor<N> | null | undefined,
  options: { deleted: "null" }
): D | null
export function readFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N>
): D
export function readFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N> | null | undefined
): D | null
export function readFragment(fragment: FragmentArtifact<any, any>, ref: unknown, options?: { deleted: "null" }): unknown {
  if (ref === null || ref === undefined) return null
  const { store, selector } = fragmentSelector(fragment, ref)
  const data = store.lookup(selector).data
  return options?.deleted === "null" ? data ?? null : data
}

const defaultActive = () => typeof document === "undefined" || document.visibilityState !== "hidden"

/** A failure as an `Error`. One that isn't (a `DOMException` from another realm, say) is wrapped, keeping its name and whether a response arrived. */
function asError(error: unknown): Error {
  if (error instanceof Error) return error
  const message = (error as { message?: unknown } | null)?.message
  const wrapped = new Error(typeof message === "string" ? message : String(error))
  const name = (error as { name?: unknown } | null)?.name
  if (typeof name === "string") wrapped.name = name
  return hadNoResponse(error) ? markNoResponse(wrapped) : wrapped
}

/** Follow stored links from a record to each `@connection` field the selections read, in order. */
function findConnections(
  store: Store,
  selections: readonly Selection[],
  variables: Variables,
  id: string,
  found: { spec: ConnectionSpec; selection: LinkSelection; id: string }[] = []
): { spec: ConnectionSpec; selection: LinkSelection; id: string }[] {
  const record = store.get(id)
  if (!record) return found
  for (const selection of selections) {
    if (!included(selection.conditions, variables)) continue
    if (selection.kind === "inline") {
      findConnections(store, selection.selections, variables, id, found)
      continue
    }
    if (selection.kind !== "link" || selection.plural) continue
    const ref = (record.fields.get(fieldStorageKey(selection, variables)) as { __ref?: string } | null | undefined)?.__ref
    if (!ref) continue
    if (selection.connection) found.push({ spec: selection.connection, selection, id: ref })
    else findConnections(store, selection.selections, variables, ref, found)
  }
  return found
}

/** Codes that say a request was refused for access, which a restart from the first page can't cure. */
const ACCESS_CODES: ReadonlySet<string> = new Set(["UNAUTHENTICATED", "FORBIDDEN", "ACCESS_DENIED", "STEP_UP_REQUIRED"])

/** A refresh's request for a page after its first failed. */
class ContinuationError extends OperationError {
  constructor(
    operation: string,
    errors: readonly GraphQLErrorLike[],
    /** The `@connection` key the request continued. */
    readonly connection: string
  ) {
    super(operation, errors)
  }
}

/** The response data of connection `key`, through single links from `data`. */
function locateConnection(
  selections: readonly Selection[],
  data: Record<string, unknown>,
  key: string
): { selection: LinkSelection; data: Record<string, unknown> } | null {
  for (const selection of selections) {
    if (selection.kind === "inline") {
      const found = locateConnection(selection.selections, data, key)
      if (found) return found
    }
    if (selection.kind !== "link") continue
    const child = data[selection.responseKey]
    if (!child || typeof child !== "object" || Array.isArray(child)) continue
    if (selection.connection) {
      if (selection.connection.key === key) return { selection, data: child as Record<string, unknown> }
      continue
    }
    const found = locateConnection(selection.selections, child as Record<string, unknown>, key)
    if (found) return found
  }
  return null
}

/** The type of connection `key`'s nodes, or of the connection when that can't be found. */
function connectionNodeType(selections: readonly Selection[], key: string): string {
  for (const selection of selections) {
    if (selection.kind !== "link" && selection.kind !== "inline") continue
    if (selection.kind === "link" && selection.connection?.key === key) {
      const spec = selection.connection
      const edges = selection.selections.find((entry): entry is LinkSelection => entry.kind === "link" && entry.fieldName === spec.edges)
      const node = edges?.selections.find((entry): entry is LinkSelection => entry.kind === "link" && entry.fieldName === spec.node)
      return node?.types[0] ?? selection.types[0] ?? spec.key
    }
    if (selection.kind === "link" && selection.connection) continue
    const found = connectionNodeType(selection.selections, key)
    if (found) return found
  }
  return ""
}

/**
 * The variables a loaded-range refresh sends: each refreshed connection's paging variable asks for its loaded rows, within the
 * bound, and at least the page the query asks for, since asking only for what's loaded would let a new row push one out of a
 * page with room. Connections sharing a variable get the largest.
 */
function refreshVariables(artifact: OperationArtifact<any, any>, variables: Variables, refreshes: Readonly<Record<string, ConnectionRefresh>>): Variables {
  const limits = new Map<string, { spec: ConnectionSpec; limit: number }>()
  const visit = (selections: readonly Selection[]): void => {
    for (const selection of selections) {
      if (selection.kind === "inline") visit(selection.selections)
      if (selection.kind !== "link") continue
      const spec = selection.connection
      if (!spec) {
        visit(selection.selections)
        continue
      }
      const refresh = refreshes[spec.key]
      const arg = selection.args.find((entry) => entry.name === spec.paging[0])
      if (!refresh || !spec.limit || arg?.kind !== "variable" || refresh.loaded <= 0) continue
      const page = (variables[arg.variable] as Record<string, unknown> | undefined) ?? {}
      const limit = Math.max(Math.min(refresh.loaded, refresh.rows), Number(page[spec.limit]) || 0)
      if ((limits.get(arg.variable)?.limit ?? -1) < limit) limits.set(arg.variable, { spec, limit })
    }
  }
  visit(artifact.normalization)
  let result = variables
  for (const [variable, { spec, limit }] of limits) {
    const page = (variables[variable] as Record<string, unknown> | undefined) ?? {}
    result = { ...result, [variable]: { ...page, ...(spec.offset ? { [spec.offset]: page[spec.offset] ?? 0 } : {}), [spec.limit!]: limit } }
  }
  return result
}

/** One `refetchFragment` call waiting for a batched request. */
interface RefetchCall {
  readonly id: string
  signal?: AbortSignal
  settled: boolean
  resolve(result: { found: boolean; errors: readonly GraphQLErrorLike[] }): void
  reject(error: unknown): void
  /** Stop listening to the call's signal. */
  release(): void
}

function settle(call: RefetchCall, outcome: { result: { found: boolean; errors: readonly GraphQLErrorLike[] } } | { error: unknown }): void {
  if (call.settled) return
  call.settled = true
  call.release()
  if ("result" in outcome) call.resolve(outcome.result)
  else call.reject(outcome.error)
}

/**
 * A signal that aborts once every call's signal has; none when a call has no signal. `release` stops listening to the calls'
 * signals, once the request has settled.
 */
function sharedSignal(calls: readonly RefetchCall[]): { signal?: AbortSignal; release(): void } {
  if (calls.some((call) => !call.signal)) return { release() {} }
  const controller = new AbortController()
  let open = calls.length
  const abort = () => { if (--open === 0) controller.abort() }
  for (const call of calls) {
    if (call.signal!.aborted) open--
    else call.signal!.addEventListener("abort", abort, { once: true })
  }
  if (open === 0) controller.abort()
  return { signal: controller.signal, release: () => { for (const call of calls) call.signal!.removeEventListener("abort", abort) } }
}

function cancelled(): DOMException {
  return new DOMException("The request was cancelled", "AbortError")
}
