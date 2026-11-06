# Changelog

## 0.1.0-alpha.6 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.6/graphql-orm-client-0.1.0-alpha.6.tgz`.
No artifact or generated-module change.

- One-time secrets can stay out of the store (#11). `client.mutate(Mutation, variables, { policy:
  "no-store" })`, and `commit(variables, { policy: "no-store" })` in `useMutation`, return the full
  typed result and write none of the response into the store: not its unkeyed objects, and not keyed
  records in the same payload either, so no other view updates from it. Fragment references in the
  result still open. It is refused together with `optimisticResponse`, and an unknown `policy` throws.
  Default behaviour (`policy: "store"`) is unchanged. New type `MutationPolicy`.
- Back-off for refused streams (#13). `live: { refusalBackoff }`, off by default, remembers a stream
  the server refused (GraphQL errors answering the subscribe, or an error-only frame and then
  `complete`, before any event): no request for it for a window (`true` is five minutes), however
  often the held records change, then it subscribes again by itself. `{ ms, types: { Type: ms | true
  | false } }` sets a window per type and keeps a type on immediate retry with `false`. A stream is
  a type's `Changed` subscription, per record in `key` mode. `SUBSCRIPTION_CONTINUITY_LOST` and
  `SUBSCRIPTION_SOURCE_CLOSED` still restart at once, transport failures are never remembered, and
  disposing the client clears the memory. `client.live.status()` gains `backedOff`. New exports:
  `DEFAULT_REFUSAL_BACKOFF_MS`, `RefusalBackoff`. Default behaviour is unchanged.

## 0.1.0-alpha.5 (2026-11-04)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.5/graphql-orm-client-0.1.0-alpha.5.tgz`.
Regenerate the typed module (`graphql-orm-client generate`): artifacts gain `paged` and
`connection.offset`.

- Page-number navigation for offset connections. Mark a list field that takes graphql-orm's
  `PageInput` `@paged` and read it with `usePagedQuery(Query, variables, { pageIndex, pageSize,
  scope })`, or `client.watchPagedQuery` outside React. The client sets `Limit` and `Offset`,
  stores each page under its own variables, keeps records normalised across pages, and reports
  `totalCount`, `pageCount`, `hasNextPage`, `hasPreviousPage` and `placeholder`. The previous page
  stays on screen (`refreshing`) while another loads. Live events and polling update the visible
  page. `pageVariables` and `pagedState` are exported.
- `@connection` on an offset `PageInput` continues at the number of rows loaded.
- `client.query(Query, variables, { policy, signal })` reads a query outside React; complete stored
  data answers `store-or-network` without a request.
- Plain subscriptions: `client.subscribe` and `useSubscription` run an application's own
  subscription documents through `live.subscribe`, writing each event into the store.
  `live.artifacts` is now optional. An event without data reports an `OperationError` with its codes.
- `client.refetchQueries([...] | "active")`, and `mutate(..., { refetchQueries, signal })`.
- `useQuery`: `skip`, `refetch(variables)` (merged, and the query switches to them), and a new
  `idle` status for skipped queries (previously `loading`).
- Poll intervals belong to the handle that asked for them: a new `pollMs`, or none, replaces the
  old interval, and closing the handle stops it. Previously the shortest interval ever requested
  stayed for the query's lifetime.
- `useMutation` and `useRefetchableFragment` report GraphQL errors as `OperationError`, so
  `extensions.code` is available.
- Each `watchQuery` handle opens and closes at most once at a time.
- A request whose signal is already aborted is not sent.
- A live event's payload object is no longer left in the store until garbage collection.
- Documentation: a "Coming from Apollo" mapping in the design, and the effective-page-size gap in
  the graphql-orm contract.

## 0.1.0-alpha.4 (2026-11-03)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.4/graphql-orm-client-0.1.0-alpha.4.tgz`.
No artifact or API change.

- A query closed and reopened in the same tick fetches again. `close()` aborted the request but
  kept it as in flight, so the reopen waited on it and the query stayed `loading` with no error.
  React's StrictMode closes and reopens every effect on mount, so `useQuery` hung in development.
  A late result of an aborted request also no longer clears a newer request.

## 0.1.0-alpha.3 (2026-11-01)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.3/graphql-orm-client-0.1.0-alpha.3.tgz`.
Regenerate artifacts to use the new stream; older artifacts keep the previous behaviour.

- In `key` mode, a type holding more records than `maxKeyedSubscriptions` uses one stream of the
  type when the field's `Key` is optional, as graphql-orm generates it, instead of polling the
  rest. `maxKeyedSubscriptions: 0` always uses that stream.

## 0.1.0-alpha.2 (2026-11-01)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.2/graphql-orm-client-0.1.0-alpha.2.tgz`.
`RecordVersion` detection needs graphql-orm 0.87.0, and continuity recovery needs graphql-orm 0.88.0
(`workspace-2026.10.31.2`). With an earlier server both are inactive and everything else works.

- The live layer recovers from lost events. When graphql-orm (0.88.0) ends a `Changed` stream with
  `SUBSCRIPTION_CONTINUITY_LOST` or `SUBSCRIPTION_SOURCE_CLOSED`, it subscribes again after a
  random delay below `live.resyncJitterMs` (default 1 s), then refetches the queries that show
  that type. A stream that ends any other way is released and starts again on the next change to
  the held records; it used to stay counted as open.

- The compiler selects graphql-orm's `RecordVersion: Int!` (graphql-orm 0.87.0) on every type
  that has it, and the store orders writes by it, so managed versions need no `versions`
  configuration. `versions` still names another field for a type, and `null` turns it off.

## 0.1.0-alpha.1 (2026-10-31)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.1/graphql-orm-client-0.1.0-alpha.1.tgz`.
`@refetchable` needs graphql-orm 0.86.0 and graphql-orm-router 0.8.0 (workspace release
`workspace-2026.10.30.4`); everything else works with earlier versions.

- Built-in transport: `createHttpNetwork({ url, headers, fetch, credentials })` sends GraphQL
  over HTTP and throws `HttpError` for a response without a GraphQL body.
  `graphqlWsSubscribe(ws)` adapts a graphql-ws client for `live.subscribe`. graphql-ws stays
  the application's dependency; the adapter is checked against its types.
- `useMutation(Mutation)` in `graphql-orm-client/react`: `commit`, `inFlight` and `error`.
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
