# Changelog

## Unreleased

- Compiler: validates documents against the schema; adds `__typename` and key fields; emits operation text, a sha256 hash, masked reader selections, inlined normalisation selections, per-type keys and versions, and `@live` flags.
- Store: one record per NodeId, with storage keys per argument set and keyless objects kept under their parent. An older record version never replaces a newer one. Reads give masked fragment references with structural sharing. Subscriptions notify only affected readers. Retention and garbage collection, and synchronous disposal.
- Client: `execute`, shared `watchQuery`, `preload`, `mutate` and `readFragment`. Request cancellation on disposal.
- React: `ClientProvider`, `useQuery`, `useFragment` and `useFragmentList`.
- Optimistic mutations: `mutate(..., { optimisticResponse })` writes a layer that is rolled back field by field, never over a newer write.
- Polling: `pollMs` on `watchQuery` and `useQuery`. A live fallback polls queries showing `@live` records that no subscription covers. Polls pause while inactive.
- Pagination:
  - `@connection(key, paging)` merges pages into one stored list per filter. A cursor appends; a first-page refresh keeps the later pages.
  - `loadMore`, `hasMore` and `loadingMore` on `watchQuery` and `useQuery`.
  - The compiler adds the cursor and page-info fields, and strips client directives from the operation text.
- Generator:
  - `graphql-orm-client generate [--config] [--check]`, with `extractDocuments` and `generate` from `graphql-orm-client/compiler`.
  - Typed artifacts. Masked `FragmentRefs` types. Enum and input types. Union variants keyed by `__typename`.
  - `live` and `liveUnavailable` exports. A `graphql()` overload per exact document.
  - Router or subgraph SDL is accepted.
  - Typed `readFragment`, `useFragment` and `useFragmentList` refuse a reference from a different fragment.
- Live layer:
  - The compiler emits one subscription per type with `@live` fragments, and picks `keys`, `key` or `unkeyed` mode from the schema.
  - `LiveManager` keeps subscriptions open for exactly the held records and writes events into the store.
  - DELETED removes the record and refetches the queries that showed it.
  - Status reports overflow. `client.refetchActive()` is available for use after a reconnect.
- Design, graphql-orm contract, roadmap, agent guidance and four bundled skills. No runtime
  code yet.
