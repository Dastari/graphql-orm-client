import type { LinkSelection, Selection } from "./artifact.js"
import type { Client } from "./client.js"
import { fieldStorageKey, storageKey, type Variables } from "./store/arguments.js"
import { HEAD_LENGTH } from "./store/normalize.js"
import { readSelections } from "./store/read.js"
import { ROOT_ID } from "./store/store.js"

/** Per-type freshness for `store-or-network` reads. */
export interface FreshnessOptions {
  /**
   * How long, in milliseconds, a record of each named type counts as fresh after a server response or a live event last wrote
   * every field it holds. `0` makes every `store-or-network` read of the type go to the network. `Infinity` keeps a record fresh
   * once a response in this client has written all of it. Types left out read as they do without freshness.
   */
  readonly staleMs: Readonly<Record<string, number>>
}

/** What a query's selections can reach, worked out once per selection set. */
interface Reach {
  /** It reaches a type with a setting, so a read has to be checked. */
  readonly checked: boolean
  /** Types of records without a key, below it, that hold a list able to reach a type with a setting. */
  readonly lists: ReadonlySet<string>
  /** Query fields with their own age: those returning a type with a setting, or a list that can reach one. */
  readonly roots: readonly LinkSelection[]
}

/**
 * Give record types a freshness period. A `store-or-network` read (`client.query`, `loadQuery`, or a watched query when it opens)
 * answers from the store only while every record it reaches whose type has a setting is fresh, and reads again otherwise,
 * showing the stored data meanwhile. Install once, right after `createClient` and before any read: a record written before
 * then has no age and counts as stale. It ends with the client's identity.
 *
 * - A response (a query, a refetch, a mutation's response) or a live event restarts a record's age only when it wrote every
 *   field the store holds for it (each argument-keyed field counts on its own). A write that carries fewer fields keeps the
 *   earlier deadline, so a summary polled every few seconds doesn't keep a detail's other fields fresh. An optimistic write
 *   doesn't restart it, and neither does a write the store refused because it carried an older version.
 * - A list that can hold a type with a setting (a connection, or another record without a key that holds a list) is fresh for
 *   the smallest such setting, from when a response last replaced all of its rows. So a list read a while ago is read again
 *   even when events have kept each of its rows fresh, because rows created since aren't in it, and an empty list ages too. A
 *   `loadMore` page, or a first page that keeps the pages loaded after it, doesn't restart it.
 * - A query field that returns a type with a setting, or a list that can hold one, has an age of its own, from when a response
 *   last wrote it: a `Ticket(Id:)` that answered null is asked again after the period.
 * - A stream covering a record doesn't keep it fresh; only what the stream delivers does. An event that carries only keys, a
 *   child deletion (`PROPAGATED`), an event of a type whose stream leaves out fields some fragment reads, and an event for a
 *   record no open query holds make the record stale.
 * - A record restored from persistence has no age until the network writes all of it.
 * - Lifetime fields still decide expiry: an expired record reads as missing however fresh it is.
 * - An open query doesn't read again when its records go stale; give it `pollMs` or `@live` for that.
 *
 * Ages use the store's clock (`store.now`, which `createTestClock().store` drives).
 */
export function installFreshness(client: Client, options: FreshnessOptions): void {
  const store = client.store
  if (store.freshness) throw new Error("Freshness is already installed")
  const staleMs = new Map<string, number>()
  for (const [type, ms] of Object.entries(options.staleMs)) {
    if (typeof ms !== "number" || !(ms >= 0)) throw new RangeError(`installFreshness: staleMs for ${type} must be 0 or more milliseconds`)
    staleMs.set(type, ms)
  }
  // When each record, or query field, stops being fresh, less `epoch`. That keeps a value a small integer for the first twelve
  // days or so, which V8 holds in the map entry instead of allocating a number for it.
  const epoch = store.now()
  const now = () => store.now() - epoch
  const freshUntil = new Map<string, number>()
  const rootUntil = new Map<string, number>()

  const least = (a: number, b: number | undefined) => (b === undefined || b < 0 ? a : a < 0 || b < a ? b : a)
  // The smallest setting a selection set can reach (following fragment spreads when `fragments` are given), or -1 for none.
  const reachable = new WeakMap<readonly Selection[], number>()
  const reach = (selections: readonly Selection[], fragments?: FragmentMap): number => {
    let ms = reachable.get(selections)
    if (ms !== undefined) return ms
    ms = -1
    for (const selection of selections) {
      if (selection.kind === "inline") ms = least(ms, reach(selection.selections, fragments))
      else if (selection.kind === "spread") {
        const fragment = fragments?.[selection.name]
        if (fragment) ms = least(ms, reach(fragment.selections, fragments))
      } else if (selection.kind === "link") ms = least(least(ms, own(selection)), reach(selection.selections, fragments))
    }
    reachable.set(selections, ms)
    return ms
  }
  const own = (selection: LinkSelection) => selection.types.reduce((ms, type) => least(ms, staleMs.get(type)), -1)
  const listMs = (selection: LinkSelection, fragments?: FragmentMap) => (selection.plural ? least(own(selection), reach(selection.selections, fragments)) : -1)
  // The smallest setting reachable through a list these selections hold directly, or -1.
  const listed = new WeakMap<readonly Selection[], number>()
  const holds = (selections: readonly Selection[], fragments?: FragmentMap): number => {
    let ms = listed.get(selections)
    if (ms !== undefined) return ms
    ms = -1
    for (const selection of selections) {
      if (selection.kind === "inline") ms = least(ms, holds(selection.selections, fragments))
      else if (selection.kind === "spread") {
        const fragment = fragments?.[selection.name]
        if (fragment) ms = least(ms, holds(fragment.selections, fragments))
      } else if (selection.kind === "link") ms = least(ms, listMs(selection, fragments))
    }
    listed.set(selections, ms)
    return ms
  }
  // A query field's own setting: its type's, or for a list, the smallest it can reach.
  const rootMs = (selection: LinkSelection, fragments?: FragmentMap) => least(own(selection), listMs(selection, fragments))

  // What a query reads, worked out once per root selection set.
  const reaches = new WeakMap<readonly Selection[], Reach>()
  const reachOf = (selections: readonly Selection[], fragments: FragmentMap): Reach => {
    let found = reaches.get(selections)
    if (found) return found
    const lists = new Set<string>()
    const roots: LinkSelection[] = []
    const seen = new Set<readonly Selection[]>()
    const walk = (set: readonly Selection[], root: boolean) => {
      if (seen.has(set)) return
      seen.add(set)
      for (const selection of set) {
        if (selection.kind === "inline") walk(selection.selections, root)
        else if (selection.kind === "spread") {
          const fragment = fragments[selection.name]
          if (fragment) walk(fragment.selections, root)
        } else if (selection.kind === "link") {
          if (root && rootMs(selection, fragments) >= 0) roots.push(selection)
          if (holds(selection.selections, fragments) >= 0) for (const type of selection.types) lists.add(type)
          walk(selection.selections, false)
        }
      }
    }
    walk(selections, true)
    found = { checked: reach(selections, fragments) >= 0, lists, roots }
    reaches.set(selections, found)
    return found
  }

  // The storage keys a write of `value` through `selections` set on a record of `typename`, as normalisation writes them.
  const written = (selections: readonly Selection[], value: Record<string, unknown>, typename: string, variables: Variables, keys: Set<string>) => {
    for (const selection of selections) {
      if (selection.kind === "inline") {
        if (selection.possibleTypes === null || selection.possibleTypes.includes(typename)) written(selection.selections, value, typename, variables, keys)
      } else if (selection.kind === "scalar") {
        if (selection.fieldName !== "__typename" && selection.responseKey in value) keys.add(storageKey(selection.fieldName, selection.args, variables))
      } else if (selection.kind === "link" && !selection.batch && selection.responseKey in value) keys.add(fieldStorageKey(selection, variables))
    }
    return keys
  }

  // A deleted or collected record forgets its age, and a collected query field its own; disposal forgets every age.
  store.observeWrites(
    (changed) => {
      for (const id of changed) if (!store.get(id)) freshUntil.delete(id)
      if (rootUntil.size && changed.has(ROOT_ID)) {
        const root = store.get(ROOT_ID)
        for (const key of rootUntil.keys()) if (!root?.fields.has(key)) rootUntil.delete(key)
      }
    },
    () => {
      freshUntil.clear()
      rootUntil.clear()
    }
  )

  store.freshness = {
    wrote(record, selections, value, variables, unkeyed) {
      if (record.__id === ROOT_ID) {
        // Each query field ages on its own, from the response that wrote it.
        const visit = (set: readonly Selection[]) => {
          for (const selection of set) {
            if (selection.kind === "inline") visit(selection.selections)
            else if (selection.kind === "link" && !selection.batch && selection.responseKey in value) {
              const ms = rootMs(selection)
              if (ms >= 0) rootUntil.set(fieldStorageKey(selection, variables), now() + ms)
            }
          }
        }
        visit(selections)
        return
      }
      // A record without a key is aged only when it holds a list: its other links are fields of the record above it.
      const ms = staleMs.get(record.__typename) ?? (unkeyed ? holds(selections) : -1)
      if (ms < 0) return
      // Only a write of every field the record holds restarts its age; a partial one leaves the earlier deadline.
      const keys = written(selections, value, record.__typename, variables, new Set())
      for (const key of record.fields.keys()) if (key !== HEAD_LENGTH && !keys.has(key)) return
      freshUntil.set(record.__id, now() + ms)
    },
    outdate(id) {
      freshUntil.delete(id)
    },
    fresh(selector) {
      const found = reachOf(selector.selections, selector.fragments)
      if (!found.checked) return true
      const time = now()
      if (selector.id === ROOT_ID) {
        const root = store.get(ROOT_ID)
        for (const selection of found.roots) {
          const key = fieldStorageKey(selection, selector.variables)
          const value = root?.fields.get(key)
          // A field that found a record is as fresh as that record, so an event on it keeps a lookup by key fresh. One that
          // answered null, or a list, has nothing else to age it.
          if (!selection.plural && typeof value === "object" && value !== null && "__ref" in value) continue
          const until = rootUntil.get(key)
          if (until === undefined || until <= time) return false
        }
      }
      // Fragments are read too: a record a child fragment reaches is as much on screen as the root's own. Reading for this
      // mustn't start a `@batch` relation request.
      let reached: ReadonlySet<string>
      const collecting = store.collecting
      store.collecting = true
      try {
        reached = readSelections(store, selector, { inlineSpreads: true }).seen
      } finally {
        store.collecting = collecting
      }
      for (const id of reached) {
        const until = freshUntil.get(id)
        if (until !== undefined) {
          if (until <= time) return false
          continue
        }
        const typename = store.get(id)?.__typename
        if (typename === undefined) continue
        // With no age: a record of a type with a setting, or a list that should have one (stored under a path, which a
        // NodeId never contains a dot of).
        if (staleMs.has(typename) || (id.includes(".") && found.lists.has(typename))) return false
      }
      return true
    },
  }
}

type FragmentMap = Readonly<Record<string, { readonly selections: readonly Selection[] }>>
