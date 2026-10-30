# Changelog

## Unreleased

- `@refetchable` fragments. The compiler adds a `node(NodeId)` query to the fragment artifact
  (`fragment.refetch`, named `<Fragment>Refetch` or `queryName`). `client.refetchFragment` and
  `useRefetchableFragment` read one record again; a null result without errors removes it. The
  compiler refuses a type that doesn't implement `Node`, a schema without `node(NodeId)`,
  fragments that use operation variables, and name clashes. Needs graphql-orm 0.86.0 and
  graphql-orm-router 0.8.0.
- Records of a type with graphql-orm's generated `NodeId: ID!` are stored under the server's
  `NodeId`. The compiler selects it on such types and on `interface Node`, so composite and
  non-`Id` keys need no `keys` configuration. The encoding is tested against graphql-orm's
  shared vectors.

## 0.1.0-alpha.0 (2026-10-30)

First alpha. Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.0/graphql-orm-client-0.1.0-alpha.0.tgz`.

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
