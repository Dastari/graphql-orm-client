# Changelog

## 0.1.0-alpha.10 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.10/graphql-orm-client-0.1.0-alpha.10.tgz`.

**Regenerate before adopting graphql-orm 0.93.0.** The fix below needs the stream to select the change kind, and a module
generated earlier doesn't. `generate --check` fails on such a module, because the generated streams changed.

### Fixed: a child delete removed its parent

Since graphql-orm 0.93.0 (#290), deleting a child under a relation with `propagate_change = "up"` sends subscribers of the
parent an event with action `DELETED` and change kind `PROPAGATED`. The parent still exists, but the client removed it from the
store, so it disappeared from every open view until a read restored it.

- Generated streams now select the change kind where the type serves it, in the service's casing. This includes
  `liveSelection: "as-written"`, whose stream text otherwise stays as it was.
- `DELETED` with `PROPAGATED` keeps the record and reads the queries holding it again. Deleting N children sends N events, and
  they coalesce through `live.minRereadMs`.
- `DELETED` with `DIRECT` still removes the record.
- A service that doesn't serve the change kind, and a module generated before this release, keep the old behaviour: every
  `DELETED` removes the record.
- This was the only place an event's action removes a record. `client.subscribe` leaves a `DELETED` action to the application,
  so a hand-written subscription handler must check the change kind itself.

### Changed: streams compile from what they can carry (R2)

After regenerating, a stream selects key fields, the version and scalars with no arguments. It never selects `NodeId`, a
relation or a scalar with arguments. Queries re-read what the stream can't carry, which also catches a changed relation link. If
the server refuses that selection with `INVALID_INPUT`, the client uses keys only for its lifetime, and health keeps reason
`selection-refused`. `doctor` adds the verdicts `fallback-admitted` and `fallback-not-refused`.

- Composite keys need no `keys` setting. Their names come from `<Type>KeyInput` and their order from a held record's `NodeId`, by
  exact match, because introspection through the router doesn't give the order (graphql-orm#356). If no order matches, health shows
  `identity-mismatch`: that type opens no stream and polls.
- `key` mode reads key fields from the stored record, and no longer decodes `NodeId`.

### Changed: no lost events (R4)

- Replacing a stream starts the new one first and keeps the old one for `live.settleMs` (default 250 ms). An old stream closes only
  once a wanted stream covers every held record it covers.
- In `keys` mode a key keeps its chunk until released, so adding a key replaces one stream.
- **More requests:** a live query reads once more when its records first gain a stream. This narrows the first-read gap and
  doesn't close it, because nothing acknowledges a subscribe (graphql-orm#341).
- `SUBSCRIPTION_LIMIT_EXCEEDED` is now an outage on the ordinary back-off, not a five-minute refusal. Open streams stay, and
  uncovered records poll.
- Automatic re-reads share `live.minRereadMs` (default 2000 ms) per query, and pause while `polling.isActive()` is false. This also
  applies to the re-read after a restart or reconnect, which can now wait up to that long.

### Added

- `graphql-orm-client schema pull --url <router>`, and `--check` to detect drift without writing (R23). It writes sorted SDL and
  `<schema>.sha256`. Once that file exists, `generate --check` also fails on a hand-edited snapshot. Projects without it behave as
  before.
- `pnpm budgets` and its CI workflow (R22), in this repository only.

### Migration from alpha.9

1. Regenerate, then read the generator's warnings. Each names a fragment and field the stream now excludes, which that fragment's
   queries will re-read on an event.
2. To regenerate without the new stream selection, set `liveSelection: "as-written"` in the generator config. The change-kind
   fix still applies.
3. To keep the old read count, set `live: { settleMs: false }`. Overlap stays on either way, at 250 ms.
4. If a re-read's timing matters, set `live.minRereadMs`.
5. Run `doctor` against the deployed identity to see which types fall back to keys only.
6. Check any hand-written subscription handler that removes a record on `DELETED`: it needs the change kind too.

## 0.1.0-alpha.9 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.9/graphql-orm-client-0.1.0-alpha.9.tgz`.
No artifact or generated-module change: no need to regenerate.

- **Behaviour change: refused streams back off by default (R6).** `live.refusalBackoff` is now on with no
  configuration. A refused stream waits five minutes, sends nothing for it meanwhile, and subscribes again and
  reads when the window ends. Every window now varies by 20% either way, including one you set. The queries holding it poll
  during the window (`polling.liveFallbackMs`, 30 s), so their records still refresh. `SUBGRAPH_UNAVAILABLE` joins
  the codes that are never refusals.

  To keep the behaviour you had: `live: { refusalBackoff: false }` for alpha.7 and alpha.8's ordinary back-off, or
  `live: { restart: false, refusalBackoff: false }` for alpha.5 and alpha.6's. To keep the window with no poll, set
  `polling: { liveFallbackMs: null }`, but that also turns off the poll for types with no stream. An application
  with its own back-off around `live.subscribe` should remove it.
- `graphql-orm-client doctor --url <router>` (R8) checks every document against the schema the router serves and
  opens each live stream briefly, for the identity whose credential you name. It prints `admitted`, `not-refused`,
  `refused <code>`, `missing`, `invalid` or `unknown` per type, and exits non-zero for all but the first two.
  `--strict` fails `not-refused` too. Credentials come only from named environment variables (`--token-env`,
  `--header-env`). It runs introspection and subscriptions only, never a query for data or a mutation.

What it ran against: unit tests with mocks, and a real `graphql-orm-router` 0.8.1 built from the
`graphql-orm-v0.90.1` tag, with real sockets and a test-owned subgraph that refuses like graphql-orm's source does.
Not run against a generated graphql-orm service. The refusal runs were on Node only.

Migration from alpha.8 (from an earlier version, follow its steps as well):

1. Decide about refused streams: the default now waits five minutes between attempts and polls meanwhile, where
   alpha.8 retried about once a minute with no poll. Set `live: { refusalBackoff: false }` to keep alpha.8's.
2. Expect polling reads for a refused type, every `polling.liveFallbackMs` (30 s) per query holding it, paused when
   the page is hidden. Past the router's 32 operations per connection, the extra streams count as refused too.
3. To see what your router refuses before you deploy, run `graphql-orm-client doctor`.

## 0.1.0-alpha.8 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.8/graphql-orm-client-0.1.0-alpha.8.tgz`.
No artifact or generated-module change: no need to regenerate.

- **Fix: a stream could stay down after a schema reload on Node (0.1.0-alpha.7).** The socket was closed while
  graphql-ws was still releasing the operation, which started its reconnect loop. On Node, where `ws` delivers
  the router's `error` and `complete` in one tick, 1 run in 8 then ended every restart as soon as it started.
  `graphqlWsSubscribe` now waits a task before closing. Not seen in headless Chromium, where alpha.7 recovered
  in 5 of 5 runs; if your client runs on Node, see [the design](docs/design.md#ended-streams).
- Live health (R7). `client.liveHealth()`, `client.subscribeLiveHealth(listener)` and, in the React bindings,
  `useLiveHealth(typename?)` report `live`, `unconfirmed`, `connecting`, `polling`, `refused`, `unavailable` or
  `idle` per type, with the reason, code, poll, times and fragments, and the socket's state. It works with no
  live layer.
- `graphqlWsTransport(ws)` gives `subscribe` and `connection`: spread it into `live`. It reports the socket, and
  a socket that recovers by itself reads the queries holding live records again, so you can remove a
  `refetchActive` call from graphql-ws's `connected` event. `graphqlWsSubscribe` is unchanged and still needs that
  call.
- **New console output:** a `@live` fragment that settles into `refused`, `unavailable` or `polling` warns once,
  naming the fragment, except where `process.env.NODE_ENV` is `production`. Pass `live: { onDiagnostic }` to send
  these elsewhere, or `null` to turn them off. A client with no `live` option uses the default.
- `client.live.status()` gains `lastEventAt`, `retryAt` and `confirmed`. Existing fields are unchanged. No
  regeneration needed.

- A test kit, `graphql-orm-client/test` (R20). `createMockNetwork({ schema, operations })` answers by
  operation name and fails anything unanswered or not valid for the schema. `createMockStreams({ schema })`
  is a `live.subscribe` with the router's frames: `emit`, `refuse`, `loseContinuity`, `reload`, `unavailable`,
  `fail`, `end`, and `reconnect` for a recovery the transport makes by itself. `createTestClock()` fills the
  `live`, `store` and `polling` timer seams. It needs `graphql`, which is already a peer dependency, and no
  test runner. Nothing else changes.

What it ran against: unit tests with mocks, and a real `graphql-orm-router` 0.8.1 built from the
`graphql-orm-v0.90.1` tag, with real sockets and a test-owned subgraph, on Node and in headless Chromium.
Not run against a generated graphql-orm service, or in Firefox or Safari. The test kit and the status API
were tested with mocks; the status states were also read during the router runs.

Migration from alpha.7 (from alpha.5 or alpha.6, follow alpha.7's steps as well):

1. Nothing is required. Update the archive URL.
2. Expect one console warning per fragment and reason for a `@live` fragment that can't stay live, outside
   production. Pass `live: { onDiagnostic }` to send them elsewhere, or `null` to turn them off. A test that fails
   on console output needs one of these.
3. Optional: replace `subscribe: graphqlWsSubscribe(ws)` with `...graphqlWsTransport(ws)`, and remove any
   `refetchActive` call from graphql-ws's `connected` event.

## 0.1.0-alpha.7 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.7/graphql-orm-client-0.1.0-alpha.7.tgz`.
No artifact or generated-module change: no need to regenerate.

- **Fix: a `@live` stream that ended stayed down, and data went stale with no sign of it.** A router
  schema reload, a socket out of retries or a plain `complete` left the stream closed, with nothing read,
  until the held records next changed, which they couldn't without a stream. Any end the client didn't ask
  for now restarts the type's streams and reads the queries that show the type. The first restart is within
  `live.resyncJitterMs`; repeated ends back off to about once a minute with jitter (`live.restart: { minMs,
  maxMs }`), and no change to the held records shortens the wait.
- **Fix: a schema reload no longer counts as a refusal** under `refusalBackoff`, on either channel, and
  neither does `SERVICE_UNAVAILABLE`, which is what a retired connection answers. In alpha.6 a reload of a
  quiet stream started a five-minute window.
- **Fix: a stream can come back after a schema reload.** The router pins a connection to its graph, and
  answers every new subscribe on a retired one with `SERVICE_UNAVAILABLE`. `graphqlWsSubscribe` now closes
  that socket through `ws.terminate()` once its last operation has ended, so the next subscribe gets a fresh
  connection. `GraphQLWsClientLike` gains an optional `terminate`.
- `client.live.status()` gains `restarting`, `restartAttempts` and `lastEnd` (`{ reason, code, at }`) per
  type. Existing fields are unchanged. New exports: `LiveEnd`, `LiveEndReason`, `StreamRestart`. `live` gains
  `restart` and a `now` test seam.
- A window under `refusalBackoff` now ends with a read of the queries that show the type.

**Known issue, found after publishing:** on Node, where `ws` delivers the router's `error` and `complete` in one
tick, 1 run in 8 stayed down after a schema reload. In headless Chromium it recovered in 5 of 5 runs. The fix is in
the next release.

What it ran against: unit tests with mocks, and a real `graphql-orm-router` 0.8.1 built from the
`graphql-orm-v0.90.1` tag, with real `graphql-ws` 6.4.1 sockets and a test-owned Node subgraph that speaks
graphql-transport-ws. Not run against a generated graphql-orm service; the frames the router forwards are
what was tested.

Migration from alpha.5 or alpha.6:

1. Nothing is required. Update the archive URL.
2. Expect more requests when streams fail: a type whose stream keeps ending now costs about one subscribe,
   and one read per query that shows it, a minute. A refused stream with no `refusalBackoff` is included;
   set `refusalBackoff: true` for one attempt in five minutes. Past the router's 32 operations per connection
   (its default; the client's `key` mode allows 50), the extra streams are refused with
   `SUBSCRIPTION_LIMIT_EXCEEDED` and count here too.
3. A retry that started on the next change to the held records now waits for its back-off. That includes
   `refusalBackoff: { types: { Type: false } }`, which now means the ordinary back-off and not retry on change.
4. Remove any retry, back-off or refetch you wrapped around `live.subscribe`. Keep calling
   `client.refetchActive()` from graphql-ws's `connected` event when `wasRetry` is true: a reconnect graphql-ws
   handles itself doesn't end the stream.
5. A custom `live.subscribe` that doesn't use `graphqlWsSubscribe` must open a fresh connection after
   `SUBSCRIPTION_SCHEMA_RELOAD`, or its restarts keep answering `SERVICE_UNAVAILABLE`.
6. To keep the old behaviour while you migrate, set `live: { restart: false }`. Ended streams then stay down
   until the held records change, and data can stay stale indefinitely. The reload and refusal fix still applies.

Documentation published with this release corrects 0.1.0-alpha.6: **the skills shipped in alpha.6 tell agents
to pass `store.scope` and `store.types` and to use a list updater, none of which exist,** and alpha.6's README,
design, contract and roadmap describe options that aren't built. Reinstall skills with
`graphql-orm-client skills install --target <target> --update`. Examples now use a neutral domain.

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
- Design, graphql-orm contract, roadmap, agent guidance and four bundled skills.
