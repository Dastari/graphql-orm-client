import type { Selection } from "../artifact.js"
import { fieldStorageKey, storageKey } from "./arguments.js"
import { ROOT_ID, type Selector, type Store, type StoredLink, type StoredLinks } from "./store.js"

/** Hidden on every object that carries masked fragment references. */
export const FRAGMENT_REF = Symbol.for("graphql-orm-client.fragmentRef")

export interface FragmentRefData {
  readonly id: string
  readonly fragments: ReadonlySet<string>
  readonly store: Store
  readonly variables: Readonly<Record<string, unknown>>
}

export interface ReadResult<T = unknown> {
  /** Contains restored records not yet read from the network. */
  readonly stale?: boolean
  readonly lifetime?: "expired" | "unknown"
  readonly data: T
  /** True when a selected field is absent from the store and must be fetched. */
  readonly missing: boolean
  /**
   * Every record id read, so the store knows which writes affect this snapshot. After an incremental read it can also hold
   * ids an earlier read reached and this one didn't, which costs an extra read and never a missed one.
   */
  readonly seen: ReadonlySet<string>
  /** @internal The memo an incremental read continues from. Absent when the read can't be memoised. */
  readonly cache?: ReadCache
}

/** @internal */
export interface CachedNode {
  readonly selections: readonly Selection[]
  data: Record<string | symbol, unknown> | null | undefined
  /** Whether anything below this record was missing or restored. */
  readonly missing: boolean
  readonly stale: boolean
  /** Records read below this one, itself included. */
  readonly count: number
  /** The same record read through other selections, or an earlier read through these. */
  readonly next?: CachedNode
}

/**
 * @internal What one subscription's last read produced for each record, and which records it reached each one from. A later read
 * given the ids written since reads those records and the ones above them again, and takes everything else from here. One cache
 * belongs to one subscription: each read changes it in place.
 */
export interface ReadCache {
  readonly nodes: Map<string, CachedNode>
  readonly parents: Map<string, string | string[]>
  readonly seen: Set<string>
  /** The results the last read produced itself, for the store to swap for the objects its snapshot kept. */
  fresh: CachedNode[]
}

interface ReadOptions {
  /** Read fragment spreads as if inlined (used for garbage-collection marking). */
  readonly inlineSpreads?: boolean
  /** Collects the root-record keys read (used for garbage collection). */
  readonly rootKeys?: Set<string>
  /** Called for every fragment spread that applies to a record. */
  readonly onSpread?: (fragment: string, id: string, typename: string) => void
  /** `true` builds a memo of this read. A memo from the selector's last read, with `changed`, reads only what changed. */
  readonly cache?: ReadCache | true
  /** Every record id written since the read that produced `cache`. */
  readonly changed?: ReadonlySet<string>
}

/** Past this many ids a memo holds more than twice what its read reaches, and is built again. */
const CACHE_SLACK = 256

function isLink(value: unknown): value is StoredLink {
  return typeof value === "object" && value !== null && "__ref" in value
}

function isLinks(value: unknown): value is StoredLinks {
  return typeof value === "object" && value !== null && "__refs" in value
}

export function readSelections<T>(store: Store, selector: Selector, options: ReadOptions = {}): ReadResult<T> {
  const previous = typeof options.cache === "object" && options.changed ? options.cache : null
  const cache: ReadCache | null = previous ?? (options.cache ? { nodes: new Map(), parents: new Map(), seen: new Set(), fresh: [] } : null)
  const seen = cache?.seen ?? new Set<string>()
  let missing = false
  let stale = false
  let lifetime: "expired" | "unknown" | undefined
  let count = 0
  // A lifetime changes with the clock and a relation with its request, not only with a write, so neither is memoised.
  let cacheable = true

  // What was written, and every record a previous read reached one of those from.
  let dirty: Set<string> | null = null
  if (cache) cache.fresh = []
  if (previous) {
    dirty = new Set()
    const pending = [...options.changed!]
    while (pending.length) {
      const id = pending.pop()!
      if (dirty.has(id)) continue
      dirty.add(id)
      // A record that isn't reached this time mustn't leave a result behind for a later read to take.
      previous.nodes.delete(id)
      const parents = previous.parents.get(id)
      if (typeof parents === "string") pending.push(parents)
      else if (parents) pending.push(...parents)
    }
  }

  const readRecord = (id: string, selections: readonly Selection[], parent: string | null): Record<string | symbol, unknown> | null | undefined => {
    if (!cache) {
      seen.add(id)
      return readFresh(id, selections)
    }
    if (parent !== null) {
      const known = cache.parents.get(id)
      if (known === undefined) cache.parents.set(id, parent)
      else if (typeof known === "string") { if (known !== parent) cache.parents.set(id, [known, parent]) }
      else if (!known.includes(parent)) known.push(parent)
    }
    let node = cache.nodes.get(id)
    while (node && node.selections !== selections) node = node.next
    if (node && dirty && !dirty.has(id)) {
      if (node.missing) missing = true
      if (node.stale) stale = true
      count += node.count
      return node.data
    }
    seen.add(id)
    const outerMissing = missing
    const outerStale = stale
    const outerCount = count
    missing = false
    stale = false
    count = 0
    const data = readFresh(id, selections)
    count += 1
    // Put first, so it's found before an older result for the same selections.
    const chain = cache.nodes.get(id)
    node = chain ? { selections, data, missing, stale, count, next: chain } : { selections, data, missing, stale, count }
    cache.nodes.set(id, node)
    cache.fresh.push(node)
    missing ||= outerMissing
    stale ||= outerStale
    count += outerCount
    return data
  }

  const readFresh = (id: string, selections: readonly Selection[]): Record<string | symbol, unknown> | null | undefined => {
    if (store.isRestored(id)) stale = true
    const record = store.get(id)
    if (!record) {
      missing = true
      return undefined
    }
    if (!options.inlineSpreads) {
      const state = store.lifetime(id)
      if (state !== undefined) cacheable = false
      if (state === "expired" || state === "unknown") {
        if (lifetime !== "expired") lifetime = state
        if (state === "expired") { missing = true; return undefined }
      }
    }
    const data: Record<string | symbol, unknown> = {}
    readInto(data, record.__id, record.__typename, selections)
    return data
  }

  const readInto = (
    data: Record<string | symbol, unknown>,
    id: string,
    typename: string,
    selections: readonly Selection[]
  ): void => {
    const record = store.get(id)!
    for (const selection of selections) {
      switch (selection.kind) {
        case "scalar": {
          if (selection.fieldName === "__typename") {
            data[selection.responseKey] = typename
            break
          }
          const key = storageKey(selection.fieldName, selection.args, selector.variables)
          if (id === ROOT_ID) options.rootKeys?.add(key)
          if (!record.fields.has(key)) {
            missing = true
            break
          }
          data[selection.responseKey] = record.fields.get(key)
          break
        }
        case "link": {
          if (selection.batch) {
            if (!store.relation) throw new Error("@batch requires installRelationBatching(client) from graphql-orm-client/relations")
            cacheable = false
            const state = store.relation(selection, id, selector.variables)
            if (state.stateId) seen.add(state.stateId)
            data[selection.responseKey] = state.status === "ready" && state.id
              ? { status: "ready", data: readRecord(state.id, selection.selections, id) }
              : state.status === "error" ? { status: "error", error: state.error } : { status: state.status }
            break
          }
          const key = fieldStorageKey(selection, selector.variables)
          if (id === ROOT_ID) options.rootKeys?.add(key)
          if (!record.fields.has(key)) {
            missing = true
            break
          }
          const value = record.fields.get(key)
          if (value === null) {
            data[selection.responseKey] = null
          } else if (isLink(value)) {
            data[selection.responseKey] = readRecord(value.__ref, selection.selections, id)
          } else if (isLinks(value)) {
            const values = value.__refs.map((ref) => ref === null ? null : readRecord(ref, selection.selections, id))
            data[selection.responseKey] = store.deletedRecords === "omit" ? values.filter((item, index) => (item !== undefined || value.__refs[index] === null) && (!selection.listNode || item?.[selection.listNode] != null)) : values
          } else {
            missing = true
          }
          break
        }
        case "inline": {
          if (selection.possibleTypes === null || selection.possibleTypes.includes(typename))
            readInto(data, id, typename, selection.selections)
          break
        }
        case "spread": {
          if (!selection.possibleTypes.includes(typename)) break
          options.onSpread?.(selection.name, id, typename)
          if (options.inlineSpreads) {
            const fragment = selector.fragments[selection.name]
            if (fragment) readInto(data, id, typename, fragment.selections)
            break
          }
          const existing = data[FRAGMENT_REF] as FragmentRefData | undefined
          const fragments = new Set(existing?.fragments ?? [])
          fragments.add(selection.name)
          Object.defineProperty(data, FRAGMENT_REF, {
            value: { id, fragments, store, variables: selector.variables } satisfies FragmentRefData,
            enumerable: false,
            configurable: true,
          })
          break
        }
      }
    }
  }

  const data = readRecord(selector.id, selector.selections, null)
  if (cache && !cacheable) {
    // The memo was changed in place and can't be continued from. A read without one gives this selector its own ids again.
    return readSelections(store, selector, { ...options, cache: undefined, changed: undefined })
  }
  if (previous && seen.size > 2 * count + CACHE_SLACK) return readSelections(store, selector, { ...options, cache: true, changed: undefined })
  return { data: (data ?? null) as T, missing, seen, ...(stale ? { stale: true } : {}), ...(lifetime ? { lifetime } : {}), ...(cache ? { cache } : {}) }
}
