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
import { fragmentSelector, type Client, type FetchPolicy, type GraphQLErrorLike, type QueryState } from "../client.js"
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
  status: "loading",
  data: undefined,
  error: null,
  errors: [],
  hasMore: false,
  loadingMore: false,
}

/**
 * Read a route's root query. Returns the root's own fields; child fragments arrive as masked
 * references to pass to the components that declared them. `variables: null` skips the query.
 */
export function useQuery<T = unknown, V extends Variables = Variables>(
  artifact: OperationArtifact<T, V>,
  variables: V | null,
  options: { policy?: FetchPolicy; pollMs?: number } = {}
): QueryState<T> & { refetch: () => Promise<void>; loadMore: () => Promise<void> } {
  const client = useClient()
  const variablesKey = variables === null ? null : stableStringify(variables)
  const watched = useMemo(
    () =>
      variables === null
        ? null
        : client.watchQuery<T, V>(artifact, variables, {
            ...(options.policy ? { policy: options.policy } : {}),
            ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
          }),
    // variablesKey stands in for variables: equal variables share one query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, artifact, variablesKey, options.policy, options.pollMs]
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
  return { ...state, refetch: watched?.refetch ?? resolved, loadMore: watched?.loadMore ?? resolved }
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

export interface MutationState {
  /** True while any commit from this hook is in flight. */
  readonly inFlight: boolean
  /** The last commit's failure: a thrown error, or the GraphQL errors returned with its data. */
  readonly error: Error | null
}

/**
 * Commit a mutation from a component. `commit` resolves with the result, as `client.mutate`
 * does, and rejects when the mutation fails, so await or catch it. The response is written into
 * the store, so every view of the changed records updates.
 */
export function useMutation<T = unknown, V extends Variables = Variables>(
  mutation: OperationArtifact<T, V>
): MutationState & {
  commit: (
    variables: V,
    options?: { optimisticResponse?: Record<string, unknown> }
  ) => Promise<{ data: T; errors: readonly GraphQLErrorLike[] }>
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
    async (variables: V, options: { optimisticResponse?: Record<string, unknown> } = {}) => {
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

function graphQLError(name: string, errors: readonly GraphQLErrorLike[]): Error {
  return new Error(`${name}: ${errors.map((error) => error.message).join("; ")}`)
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
