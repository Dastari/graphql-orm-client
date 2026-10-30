import type { FragmentArtifact, FragmentRefFor, OperationArtifact } from "./artifact.js"
import { stableStringify, type Variables } from "./store/arguments.js"
import { contextOf, normalize } from "./store/normalize.js"
import { LiveManager, type LiveOptions } from "./live.js"
import { FRAGMENT_REF, readSelections, type FragmentRefData } from "./store/read.js"
import { ROOT_ID, Store, type Selector, type Snapshot, type StoreOptions } from "./store/store.js"

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

/** Thrown when the server returns no data. */
export class OperationError extends Error {
  constructor(
    readonly operation: string,
    readonly errors: readonly GraphQLErrorLike[]
  ) {
    super(errors[0]?.message ?? `${operation} returned no data`)
    this.name = "OperationError"
  }
}

export type FetchPolicy =
  /** Serve complete stored data; fetch only what is missing. */
  | "store-or-network"
  /** Serve stored data while fetching. */
  | "store-and-network"
  /** Always fetch; serve nothing from the store first. */
  | "network-only"

export type QueryStatus = "loading" | "ready" | "refreshing" | "error"

export interface QueryState<T> {
  readonly status: QueryStatus
  /** The root's own fields, with child fragments as masked references. */
  readonly data: T | undefined
  readonly error: Error | null
  /** Errors returned alongside data (a denied field, for example). */
  readonly errors: readonly GraphQLErrorLike[]
}

export interface ClientOptions {
  readonly network: Network
  readonly store?: StoreOptions
  /** Keep records read through `@live` fragments current with generated Changed subscriptions. */
  readonly live?: LiveOptions
}

/** A shared, retained view of one query and its variables. */
export interface WatchedQuery<T> {
  getState(): QueryState<T>
  subscribe(listener: () => void): () => void
  refetch(): Promise<void>
}

export function selectorOf(artifact: OperationArtifact<any, any>, variables: Variables, id: string = ROOT_ID): Selector {
  return { id, selections: artifact.selections, variables, fragments: artifact.fragments }
}

function queryKey(artifact: OperationArtifact<any, any>, variables: Variables): string {
  return `${artifact.hash}:${stableStringify(variables)}`
}

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
  }

  close(): void {
    this.users -= 1
    if (this.users > 0) return
    this.controller?.abort()
    this.unsubscribeStore?.()
    this.unsubscribeStore = null
    this.client.live?.hold(this.key, new Map())
    this.release?.()
    this.release = null
  }

  refetch = (): Promise<void> => this.fetch()

  fetch(): Promise<void> {
    if (this.inflight) return this.inflight
    if (this.state.data !== undefined) this.set({ ...this.state, status: "refreshing" })
    const controller = new AbortController()
    this.controller = controller
    this.inflight = this.client
      .execute<T>(this.artifact, this.variables, { signal: controller.signal })
      .then(({ snapshot, errors }) => {
        if (controller.signal.aborted) return
        this.watch(snapshot)
        this.set({ status: "ready", data: snapshot.data, error: null, errors })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        this.set({ ...this.state, status: "error", error: error instanceof Error ? error : new Error(String(error)) })
      })
      .finally(() => {
        this.inflight = null
        if (this.controller === controller) this.controller = null
      })
    return this.inflight
  }

  private watch(snapshot: Snapshot<T>): void {
    this.unsubscribeStore?.()
    this.holdLive()
    this.unsubscribeStore = this.client.store.subscribe(snapshot, (next) => {
      this.set({ ...this.state, data: next.data as T })
      this.holdLive()
      // A record this query shows was deleted or collected: read it again from the server.
      if (next.missing && this.users > 0) void this.fetch()
    })
  }

  /** Tell the live layer which records this query shows through `@live` fragments. */
  private holdLive(): void {
    const live = this.client.live
    if (!live) return
    const targets = new Map<string, Set<string>>()
    readSelections(this.client.store, selectorOf(this.artifact, this.variables), {
      inlineSpreads: true,
      onSpread: (fragment, id, typename) => {
        if (!this.artifact.fragments[fragment]?.live || !live.covers(typename)) return
        const ids = targets.get(typename) ?? new Set<string>()
        ids.add(id)
        targets.set(typename, ids)
      },
    })
    live.hold(this.key, targets)
  }

  private set(state: QueryState<T>): void {
    this.state = state
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
  private mutationCount = 0

  constructor(options: ClientOptions) {
    this.network = options.network
    this.store = new Store(options.store)
    this.live = options.live ? new LiveManager(this.store, options.live) : null
  }

  /** Refetch every open query; call after a subscription reconnect may have missed events. */
  async refetchActive(): Promise<void> {
    await Promise.all([...this.resources.values()].filter((resource) => resource.users > 0).map((resource) => resource.fetch()))
  }

  /** Send an operation and write its response into the store. */
  async execute<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ snapshot: Snapshot<T>; errors: readonly GraphQLErrorLike[] }> {
    if (this.store.isDisposed) throw new Error("This client was disposed with its identity")
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
    this.controllers.add(controller)
    try {
      const response = await this.network.execute(
        { kind: artifact.kind, name: artifact.name, text: artifact.text, hash: artifact.hash, variables },
        { signal: controller.signal }
      )
      if (this.store.isDisposed || controller.signal.aborted)
        throw new DOMException("The request was cancelled", "AbortError")
      const errors = response.errors ?? []
      if (!response.data) throw new OperationError(artifact.name, errors)
      const rootId = artifact.kind === "query" ? ROOT_ID : `client:${artifact.kind}:${++this.mutationCount}`
      normalize(this.store, artifact.normalization, response.data, contextOf(artifact, variables), rootId, artifact.rootType)
      this.store.publish()
      const snapshot = this.store.lookup<T>(selectorOf(artifact, variables, rootId))
      if (rootId !== ROOT_ID) this.store.delete(rootId)
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
    policy: FetchPolicy = "store-and-network"
  ): WatchedQuery<T> & { open(): void; close(): void } {
    const key = `${queryKey(artifact, variables)}:${policy}`
    let resource = this.resources.get(key) as QueryResource<T> | undefined
    if (!resource) {
      resource = new QueryResource<T>(this, artifact, variables, queryKey(artifact, variables), policy)
      this.resources.set(key, resource as QueryResource<unknown>)
    }
    const shared = resource
    return {
      getState: shared.getState,
      subscribe: shared.subscribe,
      refetch: shared.refetch,
      open: () => shared.open(),
      close: () => {
        shared.close()
        if (shared.users === 0) this.resources.delete(key)
      },
    }
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

  /** Run a mutation; its response updates every stored record it contains. */
  async mutate<T = unknown, V extends Variables = Variables>(
    artifact: OperationArtifact<T, V>,
    variables: V
  ): Promise<{ data: T; errors: readonly GraphQLErrorLike[] }> {
    if (artifact.kind !== "mutation") throw new Error(`${artifact.name} is not a mutation`)
    const { snapshot, errors } = await this.execute<T>(artifact, variables)
    return { data: snapshot.data, errors }
  }

  dispose(): void {
    this.live?.dispose()
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.resources.clear()
    this.store.dispose()
  }
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
