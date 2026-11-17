import type { Selection } from "./artifact.js"
import type { Client } from "./client.js"
import { readSelections } from "./store/read.js"

/** Per-type freshness for `store-or-network` reads. */
export interface FreshnessOptions {
  /**
   * How long, in milliseconds, a record of each named type counts as fresh after a server response or a live event last wrote
   * it. `0` makes every `store-or-network` read of the type go to the network. `Infinity` keeps a record fresh once a response
   * in this client has written it. Types left out read as they do without freshness.
   */
  readonly staleMs: Readonly<Record<string, number>>
}

/**
 * Give record types a freshness period. A `store-or-network` read (`client.query`, `loadQuery`, or a watched query when it opens)
 * answers from the store only while every record it reaches whose type has a setting is fresh, and reads again otherwise,
 * showing the stored data meanwhile. Install once, right after `createClient` and before any read: a record written before
 * then has no age and counts as stale. It ends with the client's identity.
 *
 * - A response (a query, a refetch, a mutation's response) or a live event that writes a record restarts its age, even when it
 *   carries only some of the fields a query reads. An optimistic write doesn't, and neither does a write the store refused
 *   because it carried an older version.
 * - A list that can hold a type with a setting (a connection, or another record without a key that holds a list) is fresh for
 *   the smallest such setting, from when a response last replaced all of its rows. So a list read a while ago is read again
 *   even when events have kept each of its rows fresh, because rows created since aren't in it, and an empty list ages too. A
 *   `loadMore` page, or a first page that keeps the pages loaded after it, doesn't restart it. A list held directly by a record
 *   with a key, or by the query root, isn't aged apart from its rows; graphql-orm serves lists as connections.
 * - A stream covering a record doesn't keep it fresh; only what the stream delivers does. An event that carries only keys, a
 *   child deletion (`PROPAGATED`), or an event of a type whose stream leaves out fields some fragment reads makes the record
 *   stale.
 * - A record restored from persistence has no age until the network writes it.
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
  // When each record stops being fresh, less `epoch`. That keeps a value a small integer for the first twelve days or so,
  // which V8 holds in the map entry instead of allocating a number for it.
  const epoch = store.now()
  const freshUntil = new Map<string, number>()
  // The smallest setting a selection set can reach, or -1 for none; and the smallest one reachable through a list it holds.
  const reachable = new WeakMap<readonly Selection[], number>()
  const listed = new WeakMap<readonly Selection[], number>()
  const smallest = (cache: WeakMap<readonly Selection[], number>, selections: readonly Selection[], lists: boolean): number => {
    let ms = cache.get(selections)
    if (ms !== undefined) return ms
    let least = -1
    const take = (own: number | undefined) => {
      if (own !== undefined && own >= 0 && (least < 0 || own < least)) least = own
    }
    for (const selection of selections) {
      if (selection.kind === "inline") take(smallest(cache, selection.selections, lists))
      if (selection.kind !== "link" || (lists && !selection.plural)) continue
      for (const type of selection.types) take(staleMs.get(type))
      take(smallest(reachable, selection.selections, false))
    }
    cache.set(selections, least)
    return least
  }
  // A deleted or collected record forgets its age; disposal forgets every age.
  store.observeWrites(
    (changed) => {
      for (const id of changed) if (!store.get(id)) freshUntil.delete(id)
    },
    () => freshUntil.clear()
  )
  store.freshness = {
    wrote(id, typename, selections) {
      // A record without a key is aged only when it holds a list: its other links are fields of the record above it.
      const ms = staleMs.get(typename) ?? (selections ? smallest(listed, selections, true) : -1)
      if (ms >= 0) freshUntil.set(id, store.now() - epoch + ms)
    },
    outdate(id) {
      freshUntil.delete(id)
    },
    fresh(selector) {
      const now = store.now() - epoch
      // Fragments are read too: a record a child fragment reaches is as much on screen as the root's own. Reading for this
      // mustn't start a `@batch` relation request.
      let reached: ReadonlySet<string>
      store.collecting = true
      try {
        reached = readSelections(store, selector, { inlineSpreads: true }).seen
      } finally {
        store.collecting = false
      }
      for (const id of reached) {
        const until = freshUntil.get(id)
        if (until === undefined ? staleMs.has(store.get(id)?.__typename ?? "") : until <= now) return false
      }
      return true
    },
  }
}
