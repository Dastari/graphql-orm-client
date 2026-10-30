import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { FragmentArtifact, OperationArtifact } from "../artifact.js"
import { fragmentSelector, type Client, type FetchPolicy, type QueryState } from "../client.js"
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

const IDLE: QueryState<never> = { status: "loading", data: undefined, error: null, errors: [] }

/**
 * Read a route's root query. Returns the root's own fields; child fragments arrive as masked
 * references to pass to the components that declared them. `variables: null` skips the query.
 */
export function useQuery<T>(
  artifact: OperationArtifact,
  variables: Variables | null,
  options: { policy?: FetchPolicy } = {}
): QueryState<T> & { refetch: () => Promise<void> } {
  const client = useClient()
  const variablesKey = variables === null ? null : stableStringify(variables)
  const watched = useMemo(
    () => (variables === null ? null : client.watchQuery<T>(artifact, variables, options.policy)),
    // variablesKey stands in for variables: equal variables share one query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, artifact, variablesKey, options.policy]
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
  return { ...state, refetch: watched?.refetch ?? resolved }
}

const noopSubscribe = () => () => {}
const idleState = () => IDLE
const resolved = () => Promise.resolve()

function useFragmentSnapshot(fragment: FragmentArtifact, ref: unknown): Snapshot | null {
  const cache = useRef<{ ref: unknown; fragment: FragmentArtifact; snapshot: Snapshot | null } | null>(null)
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
export function useFragment<T = Record<string, unknown>>(fragment: FragmentArtifact, ref: unknown): T
export function useFragment<T = Record<string, unknown>>(fragment: FragmentArtifact, ref: null | undefined): null
export function useFragment<T = Record<string, unknown>>(fragment: FragmentArtifact, ref: unknown): T | null {
  const snapshot = useFragmentSnapshot(fragment, ref)
  return (snapshot?.data ?? null) as T | null
}

/**
 * View models for a list of references, for tables and adapters that need whole rows. The array
 * keeps its identity until a row changes; unchanged rows keep theirs.
 */
export function useFragmentList<T = Record<string, unknown>>(
  fragment: FragmentArtifact,
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
