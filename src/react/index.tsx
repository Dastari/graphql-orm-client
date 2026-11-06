import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { FragmentArtifact, FragmentRefFor, OperationArtifact } from "../artifact.js"
import {
  OperationError,
  fragmentSelector,
  pageSizeOf,
  pageVariables,
  pagedState,
  type Client,
  type FetchPolicy,
  type GraphQLErrorLike,
  type PagedState,
  type QueryState,
} from "../client.js"
import { stableStringify, type Variables } from "../store/arguments.js"
import { recycle, type Snapshot } from "../store/store.js"

const ClientContext = createContext<Client | null>(null)

/** Provide one client per signed-in identity; pass a new client when the identity changes. */
export function ClientProvider({ client, children }: { client: Client; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}

export function useClient(): Client {
  const client = useContext(ClientContext)
  if (!client) throw new Error("useClient needs a ClientProvider")
  return client
}

const IDLE: QueryState<never> = {
  status: "idle",
  data: undefined,
  error: null,
  errors: [],
  hasMore: false,
  loadingMore: false,
}

export interface QueryOptions {
  readonly policy?: FetchPolicy
  /** Refetch on this interval while mounted; another value (or none) replaces it. */
  readonly pollMs?: number
  /** Send nothing and report `idle`, as `variables: null` does. */
  readonly skip?: boolean
}

/**
 * Read a route's root query. Returns the root's own fields; child fragments arrive as masked
 * references to pass to the components that declared them. `variables: null` or `skip` skips
 * the query (status `idle`).
 *
 * `refetch(variables)` merges `variables` into the current ones, switches the query to them and
 * fetches; a later change to the `variables` argument replaces them again.
 */
export function useQuery<T = unknown, V extends Variables = Variables>(
  artifact: OperationArtifact<T, V>,
  variables: V | null,
  options: QueryOptions = {}
): QueryState<T> & { refetch: (variables?: Partial<V>) => Promise<void>; loadMore: () => Promise<void> } {
  const client = useClient()
  const baseKey = variables === null || options.skip ? null : stableStringify(variables)
  const [override, setOverride] = useState<{ base: string; variables: V } | null>(null)
  const effective = baseKey === null ? null : override?.base === baseKey ? override.variables : variables
  const variablesKey = effective === null ? null : stableStringify(effective)
  const watchOptions = useMemo(
    () => ({
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    }),
    [options.policy, options.pollMs]
  )
  const watched = useMemo(
    () => (effective === null ? null : client.watchQuery<T, V>(artifact, effective, watchOptions)),
    // variablesKey stands in for variables: equal variables share one query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, artifact, variablesKey, watchOptions]
  )
  useEffect(() => {
    if (!watched) return
    watched.open()
    return () => watched.close()
  }, [watched])
  const state = useSyncExternalStore(
    watched?.subscribe ?? noopSubscribe,
    watched?.getState ?? idleState,
    watched?.getState ?? idleState
  ) as QueryState<T>
  const refetch = useCallback(
    async (next?: Partial<V>) => {
      if (!watched || effective === null || baseKey === null) return
      if (!next) return watched.refetch()
      const merged = { ...effective, ...next } as V
      // Hold the merged query open while it fetches, so the switch below finds it in flight.
      const pending = client.watchQuery<T, V>(artifact, merged, watchOptions)
      pending.open()
      setOverride({ base: baseKey, variables: merged })
      try {
        await pending.refetch()
      } finally {
        pending.close()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, artifact, watched, variablesKey, baseKey, watchOptions]
  )
  return { ...state, refetch, loadMore: watched?.loadMore ?? resolved }
}

export interface PagedQueryOptions extends QueryOptions {
  /** The page to show, from 0 (a zero-based page index, as tables use). Default 0. */
  readonly pageIndex?: number
  /** Rows per page. Default: the page variable's limit, else 50 (graphql-orm's default). */
  readonly pageSize?: number
  /**
   * Keep the previous page on screen while new `variables` load, as long as this value is
   * unchanged (for example the organisation shown). Without it, only a change of page or page
   * size keeps the previous page; `null` never keeps it.
   */
  readonly scope?: string | null
}

/**
 * Show a `@paged` query one page at a time. Pass the page as `pageIndex` and `pageSize`; the hook
 * sets the page variable's limit and offset. Each page is stored under its own variables, so a
 * page seen before shows at once, and records stay normalised across pages. While another page
 * loads, the previous one stays in `data` with `placeholder: true` and status `refreshing`.
 */
export function usePagedQuery<T = unknown, V extends Variables = Variables>(
  artifact: OperationArtifact<T, V>,
  variables: V | null,
  options: PagedQueryOptions = {}
): PagedState<T> & { refetch: () => Promise<void> } {
  const { pageIndex = 0, pageSize = pageSizeOf(artifact, variables), scope, ...queryOptions } = options
  const skipped = variables === null || options.skip === true
  const query = useQuery(artifact, skipped ? null : pageVariables(artifact, variables, pageIndex, pageSize), queryOptions)
  const scopeKey = skipped || scope === null ? null : scope !== undefined ? `scope:${scope}` : `variables:${stableStringify(variables)}`
  // The last page that arrived, for its scope; shown while another page of that scope loads.
  const held = useRef<{ scope: string; state: QueryState<T> } | null>(null)
  if (scopeKey !== null && query.data !== undefined && (query.status === "ready" || query.status === "refreshing"))
    held.current = { scope: scopeKey, state: query }
  const placeholder = query.status === "loading" && scopeKey !== null && held.current?.scope === scopeKey
  const base: QueryState<T> = placeholder ? held.current!.state : query
  const state = pagedState(artifact, base, pageIndex, pageSize, placeholder)
  const { refetch } = query
  const refetchPage = useCallback(() => refetch(), [refetch])
  return { ...state, refetch: refetchPage }
}

export interface SubscriptionState<T> {
  /** The latest event, with masked fragment references; undefined before the first. */
  readonly data: T | undefined
  /** Errors that arrived with the latest event's data. */
  readonly errors: readonly GraphQLErrorLike[]
  /** Why the stream ended, if it failed. */
  readonly error: Error | null
}

/**
 * Run a plain subscription (not a `@live` fragment's) while mounted, as `client.subscribe` does.
 * `variables: null` or `skip` stops it. `onData` is called for each event.
 */
export function useSubscription<T = unknown, V extends Variables = Variables>(
  artifact: OperationArtifact<T, V>,
  variables: V | null,
  options: {
    readonly skip?: boolean
    readonly onData?: (result: { data: T; errors: readonly GraphQLErrorLike[] }) => void
    readonly onError?: (error: Error) => void
  } = {}
): SubscriptionState<T> {
  const client = useClient()
  const [state, setState] = useState<SubscriptionState<T>>({ data: undefined, errors: [], error: null })
  const callbacks = useRef(options)
  useEffect(() => {
    callbacks.current = options
  })
  const variablesKey = variables === null || options.skip ? null : stableStringify(variables)
  useEffect(() => {
    if (variablesKey === null) return
    return client.subscribe<T, V>(artifact, JSON.parse(variablesKey) as V, {
      next: (result) => {
        setState({ data: result.data, errors: result.errors, error: null })
        callbacks.current.onData?.(result)
      },
      error: (error) => {
        setState((previous) => ({ ...previous, error }))
        callbacks.current.onError?.(error)
      },
    })
  }, [client, artifact, variablesKey])
  return state
}

const noopSubscribe = () => () => {}
const idleState = () => IDLE
const resolved = () => Promise.resolve()

function useFragmentSnapshot(fragment: FragmentArtifact<any, any>, ref: unknown): Snapshot | null {
  const cache = useRef<{ ref: unknown; fragment: FragmentArtifact<any, any>; snapshot: Snapshot | null } | null>(null)
  const getSnapshot = useCallback((): Snapshot | null => {
    if (ref === null || ref === undefined) return null
    const current = cache.current
    if (current && current.ref === ref && current.fragment === fragment) return current.snapshot
    const { store, selector } = fragmentSelector(fragment, ref)
    const snapshot = store.lookup(selector)
    const data = current?.snapshot ? recycle(current.snapshot.data, snapshot.data) : snapshot.data
    const next = { ...snapshot, data }
    cache.current = { ref, fragment, snapshot: next }
    return next
  }, [fragment, ref])
  const subscribe = useCallback(
    (notify: () => void) => {
      const snapshot = getSnapshot()
      if (!snapshot || ref === null || ref === undefined) return () => {}
      const { store } = fragmentSelector(fragment, ref)
      return store.subscribe(snapshot, (next) => {
        cache.current = { ref, fragment, snapshot: next }
        notify()
      })
    },
    [fragment, ref, getSnapshot]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** A component's own fragment fields, re-rendered only when they change. */
export function useFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N>
): D
export function useFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N> | null | undefined
): D | null
export function useFragment(fragment: FragmentArtifact<any, any>, ref: unknown): unknown {
  const snapshot = useFragmentSnapshot(fragment, ref)
  return snapshot?.data ?? null
}

export interface RefetchState {
  /** True while a refetch is in flight. */
  readonly refetching: boolean
  /** The last refetch's failure: a thrown error, or the GraphQL errors it returned. */
  readonly error: Error | null
  /** False once a refetch found the record missing or denied (it is then removed). */
  readonly found: boolean
}

/**
 * `useFragment` for a `@refetchable` fragment, plus `refetch()`, which reads this record again
 * through `node(NodeId)` without refetching the query that produced it.
 */
export function useRefetchableFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N>
): RefetchState & { data: D; refetch: () => Promise<void> }
export function useRefetchableFragment<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  ref: FragmentRefFor<N> | null | undefined
): RefetchState & { data: D | null; refetch: () => Promise<void> }
export function useRefetchableFragment(
  fragment: FragmentArtifact<any, string>,
  ref: unknown
): RefetchState & { data: unknown; refetch: () => Promise<void> } {
  const client = useClient()
  const snapshot = useFragmentSnapshot(fragment, ref)
  const [state, setState] = useState<RefetchState>({ refetching: false, error: null, found: true })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const refetch = useCallback(async () => {
    if (ref === null || ref === undefined) return
    setState((previous) => ({ ...previous, refetching: true }))
    let next: RefetchState
    try {
      const { found, errors } = await client.refetchFragment(fragment, ref)
      next = { refetching: false, error: errors.length ? graphQLError(fragment.name, errors) : null, found }
    } catch (error) {
      next = { refetching: false, error: error instanceof Error ? error : new Error(String(error)), found: true }
    }
    if (mounted.current) setState(next)
  }, [client, fragment, ref])
  return { ...state, data: snapshot?.data ?? null, refetch }
}

/** The options of `client.mutate`. */
export type MutationOptions = NonNullable<Parameters<Client["mutate"]>[2]>

export interface MutationState {
  /** True while any commit from this hook is in flight. */
  readonly inFlight: boolean
  /** The last commit's failure: a thrown error, or the GraphQL errors returned with its data. */
  readonly error: Error | null
}

/**
 * Commit a mutation from a component. `commit` resolves with the result, as `client.mutate`
 * does, and rejects when the mutation fails, so await or catch it. The response is written into
 * the store, so every view of the changed records updates, unless `options.policy` is `no-store`
 * (for one-time secrets: nothing from the response is stored).
 */
export function useMutation<T = unknown, V extends Variables = Variables>(
  mutation: OperationArtifact<T, V>
): MutationState & {
  commit: (variables: V, options?: MutationOptions) => Promise<{ data: T; errors: readonly GraphQLErrorLike[] }>
} {
  const client = useClient()
  const [state, setState] = useState<MutationState>({ inFlight: false, error: null })
  const pending = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const commit = useCallback(
    async (variables: V, options: MutationOptions = {}) => {
      pending.current += 1
      setState((previous) => ({ ...previous, inFlight: true }))
      let error: Error | null = null
      try {
        const result = await client.mutate(mutation, variables, options)
        if (result.errors.length) error = graphQLError(mutation.name, result.errors)
        return result
      } catch (thrown) {
        error = thrown instanceof Error ? thrown : new Error(String(thrown))
        throw thrown
      } finally {
        pending.current -= 1
        if (mounted.current) setState({ inFlight: pending.current > 0, error })
      }
    },
    [client, mutation]
  )
  return { ...state, commit }
}

/** Errors returned with data, as an `OperationError` that keeps each error's `extensions.code`. */
function graphQLError(name: string, errors: readonly GraphQLErrorLike[]): Error {
  return new OperationError(name, errors)
}

/**
 * View models for a list of references, for tables and adapters that need whole rows. The array
 * keeps its identity until a row changes; unchanged rows keep theirs.
 */
export function useFragmentList<D = Record<string, unknown>, N extends string = string>(
  fragment: FragmentArtifact<D, N>,
  refs: readonly FragmentRefFor<N>[] | null | undefined
): readonly D[]
export function useFragmentList<T>(
  fragment: FragmentArtifact<any, any>,
  refs: readonly unknown[] | null | undefined
): readonly T[] {
  const cache = useRef<{ refs: readonly unknown[] | null | undefined; rows: readonly T[] } | null>(null)
  const getSnapshot = useCallback((): readonly T[] => {
    if (cache.current && cache.current.refs === refs) return cache.current.rows
    const rows = (refs ?? []).map((ref) => {
      const { store, selector } = fragmentSelector(fragment, ref)
      return store.lookup<T>(selector).data
    })
    const recycled = cache.current ? recycle(cache.current.rows as T[], rows) : rows
    cache.current = { refs, rows: recycled }
    return recycled
  }, [fragment, refs])
  const subscribe = useCallback(
    (notify: () => void) => {
      const disposers = (refs ?? []).map((ref) => {
        const { store, selector } = fragmentSelector(fragment, ref)
        return store.subscribe(store.lookup(selector), () => {
          // Force a re-read on the next getSnapshot.
          if (cache.current) cache.current = { refs: null, rows: cache.current.rows }
          notify()
        })
      })
      return () => disposers.forEach((dispose) => dispose())
    },
    [fragment, refs]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
