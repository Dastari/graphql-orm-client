# Design

Status: partly built. Implemented and tested:
- the compiler (`compile` from `graphql-orm-client/compiler`);
- NodeId;
- the store: normalisation, version ordering, masked reads, subscriptions, retention and garbage collection, disposal;
- `Client`: `execute`, `watchQuery`, `watchPagedQuery`, `preload`, `loadQuery`, `query`, `mutate`, `subscribe`
  and `refetchQueries`;
- transport: `createHttpNetwork` (GraphQL over HTTP) and `graphqlWsTransport` (a graphql-ws
  client for the live layer);
- `readFragment`;
- React: `ClientProvider`, `useQuery`, `useLoadedQuery`, `usePagedQuery`, `useFragment`, `useFragmentList`,
  `useMutation` and `useSubscription`;
- the live layer: `compile(...).live`, `LiveManager`, `createClient({ live })`, and opt-in back-off for refused streams;
- the generator: `graphql-orm-client generate` with `--check`. It emits typed artifacts, masked
  reference types, the `live` artifacts and an overloaded `graphql()`.

- pagination: `@connection` (keyset or offset), `loadMore`, `hasMore` and `loadingMore`;
- page-number navigation: `@paged`, `watchPagedQuery` and `usePagedQuery`;
- optimistic mutations, `no-store` mutations, interval polling, and the live polling fallback;
- `@refetchable` fragments: `client.refetchFragment` and `useRefetchableFragment`.

Proposed, not built: per-type
`staleMs` policy, the `scope` store option, sending operations by persisted hash,
batching writes per tick, refetching a parent on a `PROPAGATED` event, response size and time limits,
and marking records stale after a failed lookup. Sections below label these. What the client still
needs is in [requirements.md](requirements.md).

## Goals

- Each component declares the data it needs, next to its code, and reads only that data.
- Each route makes one request, containing only the fields its components use.
- Every record is cached once. A change re-renders only the components whose fields changed.
- Records on screen stay current through generated `Changed` subscriptions, with polling only
  as a fallback.
- Cache retention, expiry and persistence are configurable per type.
- The client is standalone: no Apollo, no Relay runtime.

Non-goals: supporting arbitrary GraphQL servers, building queries at runtime from mounted
components, and server-side rendering in the first release.

## Fragments and roots

A component declares a fragment on the type it renders. Parents spread their children's
fragments, so every route's query is fully known at build time.

```tsx
const WidgetRowFragment = graphql(`
  fragment WidgetRow on Widget @live {
    Id
    Sku
    UpdatedAt
    ...WidgetHealth
  }
`)

function WidgetRow({ widget }: { widget: FragmentRef<typeof WidgetRowFragment> }) {
  const data = useFragment(WidgetRowFragment, widget)
  return <Row name={data.Sku} seen={data.UpdatedAt} health={data} />
}

const CatalogPageQuery = graphql(`
  query CatalogPage($Where: WidgetWhereInput) {
    Widgets(Where: $Where, Page: { limit: 50 }) {
      Edges { Node { ...WidgetRow } }
      PageInfo { HasNextPage EndCursor }
    }
  }
`)

// Browser route loader: return the handle without awaiting ready.
loader: ({ context, deps, signal }) =>
  context.client.loadQuery(CatalogPageQuery, { Where: deps.where }, { signal })

function CatalogPage() {
  const { data } = useLoadedQuery(useLoaderData())
  return data?.Widgets.Edges.map((edge) => <WidgetRow key={edge.Node.Id} widget={edge.Node} />)
}
```

`useFragment` returns only the fragment's own fields. A child's fields are hidden behind its
fragment reference (data masking), so a parent cannot come to depend on them by accident.

### Route loading (R18)

`client.loadQuery(Query, variables, { signal?, timeoutMs? })` starts a retained read immediately,
with no component mounted. Return its handle from the browser router loader and pass it to
`useLoadedQuery(handle)` under the same `ClientProvider`. This hook returns `QueryState` and does
not suspend. `handle.ready` resolves after the first read; inspect the state for errors. Equal query
hashes and variables share a `store-or-network` resource. Mounting a completed or in-flight handle
sends no additional request. The same handle can serve several components. Effect cleanup waits one
microtask, so StrictMode's synchronous cleanup/setup replay neither aborts the read nor churns streams.
A real unmount closes after that microtask. A later mount opens it again, because a handle can outlive that, as when a parent remounts. Only `dispose()` or the abort signal ends it for good; then start a new load.

Pass the router's cancellation signal and call `handle.dispose()` when abandoning a navigation.
Cancellation is quiet, including transports that return after abort; identity disposal clears the store
synchronously and rejects late responses. An unmounted loader closes after 30 seconds by default, and opens again if it's mounted later;
`timeoutMs` must be positive and finite. Adjust it for slow navigation. Mount cancels that deadline.
Disposal releases retention; records then follow the configured store retention/garbage collection.
The handle itself should be dropped by the router when the navigation ends.

R3 list interest opens **before** the loader's first read, even if nobody mounts. Deferring the stream
until mount would create a new read/subscribe gap for the preloaded list. Cancellation or the unused-load
deadline closes this interest automatically. R4 confirming reads, reconnect recovery and live events
may still cause additional requests; "one read" means no duplicate caused by mounting, not disabling
freshness. There is still no server subscribe acknowledgement, and the router can drop frames (#359).
`@sensitive` reads reject before loading because a watch retains results; use `client.query` instead.

Migration is opt-in per route: replace `preload` plus `useQuery` with `loadQuery` plus
`useLoadedQuery`, forward cancellation, and handle `idle`, `loading` and `error` states. The old
`preload` remains an awaitable warm-up that closes on completion. A subsequent default `useQuery`
uses `store-and-network` and may read again. Its legacy StrictMode effect replay can restart a request;
the loader hook avoids that. Suspense is not implemented.

### Conditional selections and fragment arguments

Fragment-local `@argumentDefinitions`/`@arguments` are not implemented and fail compilation with a
specific error. Route operations already own their variables and build-time composition; introducing
local defaults and argument substitution would require distinct fragment reference identities and
reader variable scopes. Use operation variables rather than silently losing those scopes.

`@skip` and `@include` are rejected at build time by default, on fields, spreads and inline fragments,
including live fragments. Previously the wire query preserved the directive, but normalisation and
read selections did not represent its condition: an omitted field read as missing, generated types
required it, and flattened live projections could select it unconditionally. This is unsafe and is
not conditional-selection support. `conditionalDirectives: "legacy"` in generator config (or compile
options) temporarily preserves that previous behaviour for migration. Split conditional selections
into separate route roots, remove the setting and regenerate. Proper variable-aware conditional
readers, optional generated fields and stream projections remain proposed. The hook's `skip` option
skips a whole operation and is unaffected.

### Framework server shells

Server rendering data is a non-goal: no result streaming and no serialised store handoff.
Entry points import in Node without `window` or `document`. A server shell may render
`ClientProvider` and `useQuery`; it returns `idle` and starts no read, retention, stream or timer.
The query server snapshot is also `idle` during hydration, so the browser first hydrates the same
shell, then observes/loads client data. Create the browser client and invoke browser loaders there;
do not invoke `loadQuery` from a server loader (it deliberately starts I/O). Do not share identity
clients between server requests. `useLoadedQuery` also supplies an idle server snapshot, but creating
its handle is an explicit I/O action. Fragment hooks require real fragment references; omit data
subtrees from the server shell. No per-render query resources are registered by default shell rendering. Migration: render an idle
placeholder on server and browser; `useQuery(..., { serverSnapshot: "legacy" })` temporarily restores
the old server snapshot and resource registration. Remove it after adopting the idle shell.

### View-model fragments

Some screens don't render records one component at a time. A data table needs complete row
objects for sorting, filtering and column rendering, and an application may map server data into
domain models before rendering. A widget catalog table is one example: one `CatalogWidgetFacts`
fragment feeds the table columns, widget identity, navigation and usage views.

In that case the fragment belongs to the adapter that builds the view model, not to a component:

- The adapter declares one fragment per view model and is the only code that reads it, through
  `readFragment(Fragment, ref)`. That is a plain function, not a hook, so it works in mappers.
- `useFragmentList(Fragment, refs)` subscribes to a list of records and returns view models that
  update when any of their fields change. Tables use it instead of one `useFragment` per row.
- Components below the adapter receive domain objects and never see GraphQL.

Masking still applies at the adapter boundary: a query that spreads the fragment can't read its
fields without `readFragment`. Per-component fragments remain the default for screens that
render records one component at a time.

## Schema snapshots

`graphql-orm-client schema pull --url <router>` uses only introspection and writes the configured
`schema` path as lexicographically sorted SDL. A SHA-256 of its exact bytes lives beside it in
`<schema>.sha256`; a sidecar keeps the SDL usable by ordinary GraphQL tools. Commit both files.
`schema pull --check` compares both without writing and names differing paths. Unreachable servers
are unknown, never a match. Credentials use `--token-env NAME` or repeated
`--header-env name=NAME`; literal `--token`, `--header` and `--password` are refused.

Exit codes: 0 success, 1 drift or stale output, 2 bad usage (as in doctor), 3 unreachable,
4 authentication refused (HTTP 401/403 or GraphQL 401/403/4401), 5 introspection unavailable or disabled.
Server error text is suppressed by schema pull to avoid echoing credentials.

Once the sidecar exists, generated modules include the snapshot hash. `generate --check` verifies
both snapshot integrity and generated provenance, even for schema changes that leave artifact types
unchanged. Fix snapshot integrity with `schema pull --url <router>`, then run `generate`.
Projects without a sidecar retain the existing generation and check behavior.

## Compiler

`graphql-orm-client generate` reads every `graphql(...)` document in the application. It uses
`compile` and `generate` from `graphql-orm-client/compiler`, and emits one typed module with an
artifact per root:

- **Query text.** The flattened operation, sent as is.
- **Hash.** sha256 of the text. Proposed: registering it with a router allow-list and sending the
  hash instead of the text. `createHttpNetwork` sends the text today.
- **Normalisation map.** Where each record sits in the response, its type and its key fields,
  so the store can split the response into records without guessing.
- **Fragment readers.** One per fragment: the fields to read from the store and the child
  fragment references to hand down.
- **Live subscription document.** For roots that contain `@live` fragments, a subscription
  with full and keys-only projections for each type; legacy generation can retain fragment spreading.
- **Types.** TypeScript result, variable and fragment-reference types.

The compiler validates the documents against the router's schema snapshot. A fragment on a
type without a `NodeId` or a complete key is allowed; its data is stored inside the parent
record, so it can't be refetched or kept live on its own.

## Store

### Identity

Every record that has a complete key is stored under its `NodeId`, an opaque base64url
encoding of `[typename, ...keyParts]`. Keys are unique only within a type, so the type name is
part of the identity. When a type has graphql-orm's generated `NodeId: ID!` field, the compiler
selects it and the store uses the server's value, which is right for any key shape. Otherwise
the store encodes the `NodeId` from the type's key fields (`Id`, or the configured `keys`); both
produce the same value for the same record. A record without a key (an embedded object or an
aggregate row) is stored inside its parent.

### Writes and ordering

- A response is split into records using the root's normalisation map. Each field is merged
  into the stored record.
- When the type exposes a version, a write carrying an older version than the stored record
  is dropped. Without a version, the last write to arrive wins. The compiler selects
  graphql-orm's `RecordVersion: Int!` wherever a type has it and uses it as the version, so
  managed versions need no configuration. `versions` names another field for a type, or
  `null` to turn it off.
- A `Changed` event with action `DELETED` removes the record. A query that showed it finds the
  record missing and reads again; lists aren't edited in place. The exception is `DELETED` with change kind
  `PROPAGATED`: a child was deleted under a record that still exists (graphql-orm 0.93.0), so the record stays and
  the queries holding it read again, coalesced by `live.minRereadMs`. Only a generated stream that selects the
  change kind can tell the two apart: without it, on a service that doesn't serve it or in a module generated
  before 0.1.0-alpha.10, every `DELETED` removes the record.
- Each response or event is one batch: subscribers are notified once per batch, synchronously, and
  only those whose fields changed. Proposed: batching writes per tick.

### Retention and garbage collection

A mounted root retains the records it reaches. When it unmounts, its records stay for a
configurable period (`store.retainMs`, default five minutes) and are collected once nothing retains
them, so going back within that period needs no request.

### Cache policy

`store.retainMs` controls retention. Lifetime and persistence are opt-in; see the R17 sections
below. One client belongs to one identity: dispose it before exposing a new identity's client.
Per-type `staleMs` and automatic `store.scope` switching remain proposed.

### Query states

A root reports `idle` (skipped), `loading`, `ready`, `refreshing` or `error`. `usePagedQuery` and
`watchPagedQuery` keep the previous page while another page loads, and keep it across new
variables within the same hold scope (a new search term on the same vendor), as
`refreshing` instead of blanking. A different scope never shows another scope's records.

## Live layer

Streams in `keys` mode keep each key in its chunk until released. Replacing a stream starts
its successor first and retains the baseline for a bounded overlap (`live.settleMs`, default
250 ms; 250 ms when confirming reads are disabled). Only one candidate generation per type
is open at a time. A failed candidate leaves the baseline open; genuine refusals still back off.
`SUBSCRIPTION_LIMIT_EXCEEDED` uses ordinary restart back-off, never the five-minute refusal window.
The router counts both old and new operations against its connection limit (default 32 in router
0.8.1 at graphql-orm-v0.90.1). At a full connection the old coverage stays, newly uncovered records
use the polling fallback, and replacement retries until capacity becomes available. Disable that
fallback only if the application accepts stale uncovered records.

For keyed record streams the first load is **read, subscribe, confirming read**, because keys
are unknown before the read. Regenerated lists subscribe before the first read (R3 below). Queries whose records gained a stream read once more after
`live.settleMs` (default 250 ms). These reads also cover newly subscribed keys during replacement,
coalesce across types, and use `readAgain`: a read in flight is followed by one more. Queries whose
records already have streams do not receive a confirming read. This adds a request per query on
first load. Set `live: { settleMs: false }` to disable these reads and restore the previous request
cost; overlap and reconnect recovery remain enabled.

**This narrows the gap; it does not close it against a real server.** There is no per-subscribe
acknowledgement, and waiting a bounded time proves nothing about admission. A server started signal
is still needed (see the contract). Versioned writes reject older snapshots delivered by overlapping
streams or reads. An identical unversioned snapshot is harmless, but without versions the last write
to arrive wins, so a stale confirming read can overwrite an event. Disposal cancels overlap and
confirming timers, closes both generations, and prevents late event writes.

1. **Collect.** After a root's query resolves, the live layer collects the `NodeId`s of
   records read by `@live` fragments that are still retained.
2. **Subscribe.** It subscribes to each type's generated `<Entity>Changed` subscription for
   those keys, with a flattened full projection: keys, version and scalars without arguments.
   Relations, composite fields and `NodeId` are excluded. An `INVALID_INPUT` refusal switches the
   type to its keys-only thin projection for the lifetime of this client; thin refusal uses the
   normal refusal window. Health retains reason `selection-refused` while using thin.
3. **Write and mark stale.** An event writes what it carries, ordered by version. A holder whose
   fragments select omitted fields re-reads, including when a relation link changes. Every thin
   event re-reads holders. Without a carried version, writes remain last-arrival-wins.

4. **Recover.** graphql-orm (0.88) ends a `Changed` stream that lost events with one error,
   `SUBSCRIPTION_CONTINUITY_LOST` (the subscriber fell behind the event channel) or
   `SUBSCRIPTION_SOURCE_CLOSED`. After a random delay below `live.resyncJitterMs` (default
   1 s), the live layer subscribes again, then refetches the roots that show that type. See
   [Ended streams](#ended-streams): every other end the client didn't ask for takes the same path. A
   stream the server refuses can be held back for a window instead (see
   [Refused streams](#refused-streams)). When graphql-ws reconnects by itself, without ending the
   stream, `graphqlWsTransport` reads the open queries that hold live records again; with plain
   `graphqlWsSubscribe` the application calls `client.refetchActive()` from its `connected` event, until the
   server supports replay from a sequence number.
5. **Release.** When records are released, it narrows or ends the subscriptions.

Polling remains for state that emits no events (in-memory server state) and when the number
of live keys exceeds the subscription limit.

### Live modes

The compiler reads each type's generated `<Type>Changed` subscription from the schema and picks
how to narrow it:

| Mode | When | Subscriptions |
| --- | --- | --- |
| `keys` | the field has a `Keys` argument (graphql-orm #261) | one per type, in chunks of up to 500 keys |
| `key` | the field has a `Key` argument | one per held record, up to `maxKeyedSubscriptions` (50). Past that, one per type if `Key` is optional; otherwise the rest overflow and their holders poll |
| `unkeyed` | neither | one per type; events for records nobody holds are dropped |

The payload's entity field is found by type (`Widget` in `WidgetChangedEvent`), and its action
by name. Types with `@live` fragments but no usable subscription are listed in
`compile(...).liveUnavailable` when compilation succeeds (R5 requires an explicit polling reason or lowered strictness); their holders poll. `client.live.status()` reports
per-type counts, including overflow beyond the `key`-mode limit. A `DELETED` event removes the
record, and any query that showed it reads again, unless its change kind is `PROPAGATED` (see above).

### Stream projections and re-read scheduling

New generation emits `LiveArtifact.operation` (full), `thinOperation` (keys only), and
`rereadFragments` (fragments selecting fields the full stream omits). Operations also carry
`liveReread` for omitted fields selected directly in the query. Streams never select
`NodeId`; the store encodes identity from complete key fields, using shared NodeId vectors.
Composite keys take their field names from `<Type>KeyInput`, when all of its fields are on the type. The
order can't come from there: introspection through router 0.8.1 at `graphql-orm-v0.90.1` lists `SlotKeyInput` as
`Name, Site`, while the service's SDL and its `NodeId` use `Site, Name`. So the client finds the order by exact
match against a held record's server `NodeId`, without decoding it, before opening a stream.

`liveSelection: "as-written"` in generator config preserves previous subscription text. Generation
warns, naming each fragment and field the new projection would exclude. Old artifacts without
`thinOperation` retain their subscription and refusal behavior; no artifact version bump is needed.

Automatic stale, reconnect and R4 confirming reads share one per-query scheduler. It runs a leading
read and one trailing read when more marks arrive, no faster than `live.minRereadMs` (default 2000).
A mark during a read follows it with one more, respecting the interval. While `polling.isActive()`
is false it waits, checking every 1000 ms, then runs once on return. Closing the query cancels pending
work. Manual refetch and interval polls retain their own behavior. List invalidation shares this limiter (R3 below).

In graphql-orm 0.90.1 and main `9d1a482`, `validate_subscription_selection` maps generated
`RecordVersion` to the managed persisted column before validation. Its subscription policy still
applies. A hand-written computed `RecordVersion` is refused. It is incorrect to say all versions
are refused: full does not degrade every managed entity to thin. `NodeId` has no such mapping.

### Ended streams

A stream the client didn't stop can end for many reasons. Each one restarts the type's streams and then
reads the queries that show the type, because events were missed. `client.live.status()` reports it per
type: `restarting`, `restartAttempts`, and `lastEnd` with its `reason`, `code` and time.

| `lastEnd.reason` | What ended it |
| --- | --- |
| `reload` | `SUBSCRIPTION_SCHEMA_RELOAD`: the router retired the graph the connection selected |
| `lost` | `SUBSCRIPTION_CONTINUITY_LOST` or `SUBSCRIPTION_SOURCE_CLOSED` |
| `unavailable` | `SERVICE_UNAVAILABLE`, which a connection on a retired graph answers to every subscribe |
| `refused` | GraphQL errors answered the subscribe and no event ever arrived |
| `errored` | GraphQL errors ended a stream that had delivered events |
| `transport` | The socket failed or ran out of reconnect attempts: not GraphQL errors |
| `completed` | The server ended the stream with no error |

- **Back-off.** The first restart waits a random delay below `live.resyncJitterMs` (1 s), which spreads
  clients that lost their streams together. Each further end in a row waits longer: `live.restart.minMs`
  (1 s) doubling to `maxMs` (60 s), each delay reduced by up to half at random. So a router that keeps
  failing sees about one subscribe and one read per query a minute, however often the held records
  change. A stream that stays open for `maxMs` has recovered, and the next end starts from the shortest
  delay again. Streams of one type restart together, so a reload that ends fifty costs one read.
- **Order.** Subscribe, then read. Nothing confirms a subscribe (see the proposal), so a change that lands
  between the two can still be missed until the next event for that record; R4 closes this. A read
  already under way when the restart fires doesn't count, because it may have been answered before the
  gap ended: one more read follows it.
- **While waiting.** The stream isn't started early, however the held records change, and the page keeps
  what it has. A re-read that fails sets the query's `status` to `error` and keeps its `data`.
- **A retired connection.** The router pins a connection to its graph, so a stream can only come back on a
  fresh connection. `graphqlWsSubscribe` and `graphqlWsTransport` close the socket through `ws.terminate()`,
  a task after the last operation has ended after one of these codes. A custom `live.subscribe` has to get
  a fresh connection too, or its restarts go on answering `unavailable`. In a browser, graphql-ws's default
  `lazy` socket closes by itself once nothing is open, and terminating covers `lazy: false`. On Node, where
  `ws` delivers several frames in one tick by default, the router's `complete` after `error` makes graphql-ws
  release the operation twice, its lock count goes negative, and a later socket failure can leave a stream
  ending as soon as it starts. To run this on Node, pass `{ allowSynchronousEvents: false }` to `ws`, as a
  `webSocketImpl` subclass (router 0.8.1, graphql-ws 6.4.1, ws 8).
- **`live.restart: false`** is the 0.1.0-alpha.6 behaviour, for migration: only lost events restart a
  stream, and any other end waits for the next change to the held records, with nothing read. Data can
  stay stale indefinitely with it. `lastEnd` is still reported.

The original recovery runs used a real router with a hand-written Node subgraph.
R21 adds `pnpm conformance`: a generated SQLite service and router built from
`graphql-orm-v0.90.1` (adfa608d, router 0.8.1), with repeated Node scheduling-mode
and Chromium recovery assertions. Its NodeId admission test reproduces the current
compiler/server mismatch; recovery removes NodeId from the stream document to test
transport recovery independently. See [coverage and limits](../conformance/README.md),
including descriptor catalogue gaps and deterministic ORM continuity channels. A stream started with `client.subscribe` is the application's own and doesn't restart.

### Live health

`client.liveHealth()` says what keeps `@live` data fresh right now, per type and for the socket, and works
with no live layer. `client.subscribeLiveHealth(listener)` and `useLiveHealth(typename?)` follow it.
`client.live.status()` keeps its shape underneath.

| `state` | Meaning |
| --- | --- |
| `live` | A stream is open and has delivered an event since it started |
| `unconfirmed` | Subscribed and not refused, with no event yet. Nothing confirms a subscribe, so a quiet stream can't be told from an unanswered one |
| `connecting` | Starting or restarting, or its socket is reconnecting |
| `polling` | No stream covers the records and a poll does; `reason` says why |
| `refused` | The server refused the stream and nothing refreshes the records |
| `unavailable` | No stream, after three restarts in a row or for good, and nothing refreshes the records |
| `idle` | Nothing is held |

- Each type also has `reason` (`no-live-layer`, `no-stream`, `selection-refused`, `refused`, `identity-mismatch`, `over-cap`,
  `socket-down`, `stream-ended`, `schema-reload`), the server's `code`, `held`, `pollMs`, `lastEventAt`,
  `lastReadAt`, `retryAt` and the `fragments` held. A null time means it hasn't happened, not that it was
  long ago. `pollMs` is null if any query holding the type has no poll. `worst` is the worst state of any type.
- `live` is per type: an event on one record confirms the type until its streams next restart.
- `socket` is `unknown` unless the transport reports it. `graphqlWsTransport(ws)` does, and with it a socket
  that recovers by itself reads the queries holding live records again, which `graphqlWsSubscribe` leaves to
  the application. A stream on a socket that's down is `connecting`.
- `selection-refused` means the code was `INVALID_INPUT`, which the server also uses for other invalid input.
- `identity-mismatch` means a record's server `NodeId` isn't what its key fields encode to in any order. A stream event has only key fields to identify its record, so its events could never reach the record: the type opens no stream and its holders poll. Key order alone doesn't cause it: the served schema doesn't give that order (introspection through router 0.8.1 at `graphql-orm-v0.90.1` lists `SlotKeyInput` as `Name, Site` for a key the server encodes as `Site, Name`), so the client finds it by exact match against a record's `NodeId`, without decoding it.
- Listeners hear about a change once per tick, and a new `lastEventAt` alone at most once a second.
- `live.onDiagnostic` is called once per fragment and reason when a `@live` fragment settles into `refused`,
  `unavailable` or `polling`, naming the fragment. It defaults to `console.warn`, except where
  `process.env.NODE_ENV` is `production`; `null` turns it off. Without `live`, it's the default.
- Types with no stream are learned from what queries hold, so this needs no regeneration.

### The doctor

`graphql-orm-client doctor --url <router>` compiles the project's documents against its schema snapshot, validates
each one against the schema the router serves, and opens each stream on one connection for up to `--stream-ms`.
A `Keys` stream opens with an empty list, which graphql-orm admits and which matches no rows; an optional `Key`
opens with none, so it can receive events it ignores. A required `Key` can't be opened without naming a record, so
it reports `unknown`. Only an event earns `admitted`: a quiet stream is `not-refused`. Full refused with `INVALID_INPUT`
is retried using thin: the verdict is `fallback-admitted` or `fallback-not-refused`. Working fallback
passes normally; `--strict` also fails `fallback-not-refused`, preserving the uncertainty rule. `SUBSCRIPTION_SCHEMA_RELOAD`,
`SERVICE_UNAVAILABLE` and `SUBSCRIPTION_LIMIT_EXCEEDED` report `unknown`, not `refused`. One function (`assertReadOnly`)
guards everything it sends. Credentials come only from named environment variables and aren't in its output.

### Refused streams

By default, a refused stream waits out a window of five minutes, varying by 20% either way. It sends nothing
for that stream however often the held records change, and the queries holding it poll
(`polling.liveFallbackMs`, 30 s) so their records still refresh. When the window ends it subscribes again and they
read, because events were missed. `live: { refusalBackoff }` configures it, and `false` leaves refused streams on
the ordinary back-off above, with no window and no poll:

```ts
createClient({
  network,
  live: {
    artifacts: live,
    subscribe,
    // Five minutes for every type, except Ticket, which has no poll behind it and stays on the
    // ordinary restart back-off:
    refusalBackoff: { ms: DEFAULT_REFUSAL_BACKOFF_MS, types: { Ticket: false } },
    // or: refusalBackoff: true            every type, five minutes
    //     refusalBackoff: { types: { Widget: 60_000 } }   Widget only, one minute
  },
})
```

- **What counts as a refusal.** A stream that ends before delivering any event, by either of these: the
  server answers the subscribe with GraphQL errors (graphql-ws delivers an array of errors to the
  sink's `error`, as an `error` message), or it sends frames with errors and no data and then
  completes. Both mean the router said no to this subscribe, whatever the code; the client has no list
  of refusal codes and does not guess one.
- **What does not.** Lost events, `SUBSCRIPTION_SCHEMA_RELOAD` and `SERVICE_UNAVAILABLE`, on either
  channel: these are about the connection or the moment, not the subscribe. A transport failure (an
  `Error`, a socket close event). A `complete` with no frames. A stream that delivered an event and then
  fails. All of these restart with the back-off above and are never remembered.
- **Identity of a stream.** The type's `<Type>Changed` operation; in `key` mode, that operation for one
  record (a refusal of one record's stream doesn't hold back another's, as when the router caps the
  streams per connection). The chunk of keys in `keys` mode is not part of it: it changes whenever a
  list refresh changes the held records, so one refused stream would look new every time.
- **During the window.** No request is sent for that stream however often the held records change, and
  the stream is not removed from the layer: when the window ends, it subscribes again by itself if its
  records are still held. A refusal then starts another window; an admitted stream stays open. The
  window is a timer (`live.setTimeout`, `live.clearTimeout`), so tests drive it without waiting.
  `client.live.status()` reports `backedOff` per type.
- **With the poll off** (`polling.liveFallbackMs: null`), nothing refreshes the records during a window, and
  `client.liveHealth()` says `refused`. With it on, it says `polling`, with the refusal as the `reason`.
- **Disposal.** The memory and its timers belong to the client's live layer and go with the client when
  the identity changes. A refusal recorded for one identity cannot hold back the next identity's
  client, and one that arrives after disposal is ignored.
- **Not covered.** Plain subscriptions (`client.subscribe`) are never restarted by the client, so they
  have no loop to break.

## Mutations

In React, `useMutation(Mutation)` returns `commit`, `inFlight` and `error`; `commit` takes the
same arguments as `client.mutate` and rejects when the mutation fails.

```ts
await client.mutate(RenameWidgetMutation, { Id: id, Name: name }, {
  optimisticResponse: { UpdateWidget: { __typename: "WidgetResult", Success: true, Widget: { __typename: "Widget", Id: id, Name: name } } },
})
```

- **Store updates.** Spread the fragments of the views a mutation affects into its selection, so
  its response updates every view of the record.
- **Optimistic responses.** An `optimisticResponse` is written as a layer and shows at once. When
  the real response or an error arrives, the layer is rolled back field by field, and the real
  response is written. A field that changed since (from a live event or another response) is not
  rolled back.
- **Lists.** Regenerated list queries re-read on Changed events. For writes with no delivered event,
  use `refetchQueries` or polling; the store does not guess membership or sorting.
- **Refetching after.** `mutate(..., { refetchQueries: [TicketsPageQuery, "CatalogPage"] })` reads
  those open queries again once the mutation succeeds, and resolves after them.
  `client.refetchQueries([...])` does the same at any time, and `"active"` refetches every open query.
- **Cancelling.** `mutate(..., { signal })` cancels the request and rolls back the optimistic layer.
- **Results without a key.** A result type without a key (a hand-written `…Result` object, a list of
  rows, a scalar) is stored inside the mutation's own root, so it never collides with another
  mutation's result; keyed records inside it are normalised as usual. Fragment references in the
  returned `data` keep working until garbage collection.
- **Secrets: `policy: "no-store"`.** A one-time credential, ticket or download link in a mutation's
  response is normalised like any other result, and its unkeyed objects stay in the store until
  garbage collection. `mutate(Mutation, variables, { policy: "no-store" })` (and `commit(variables,
  { policy: "no-store" })` in `useMutation`) returns the same `{ data, errors }` and writes none of the
  response into the store. The rules:
  - *Nothing is written.* The response is read into a private store that only the returned `data` keeps
    alive, so fragment references in it still open with `readFragment` and `useFragment`, and it is
    collected with the result. The client's store, its subscribers, retention, optimistic layers and
    live holders never see it. The client has no logging, devtools hook or request cache of its own,
    and mutations are never de-duplicated, so each call sends its own request.
  - *Keyed records in the same payload are not merged either.* The rule has no exceptions, so a secret
    cannot reach the store through a keyed record that carries it. Other views of that record don't
    update from this response, and a record the store never held isn't created. When views must change,
    pass `refetchQueries`, which works as usual and reads from the server, or keep the updating
    mutation on the default policy and return the secret from a mutation of its own.
  - *`optimisticResponse` is refused*, before anything is sent, because an optimistic layer writes to
    the store. An unknown `policy` value throws instead of storing the result.
  - *Scope.* It governs the mutation's response only. Variables go to the server as usual, and the
    caller owns the returned `data` (don't put it in component state that outlives its use, a logger
    or a persisted store). A query that later reads the same secret from the server stores it like any
    query; plain subscription events are still written to the store.
- **Errors.** When the server returns GraphQL errors, with or without data, `useMutation`'s `error`
  is an `OperationError`, so `error.errors[i].extensions.code` is available. A transport failure
  is the error the network threw.

## Polling

- **Fixed intervals.** `watchQuery(..., { pollMs })` and `useQuery(..., { pollMs })` refetch on
  an interval while that handle is open. The query must declare `@poll(reason: "...")`;
  undeclared intervals fail unless `polling.undeclared` is `"warn"` or `"off"`. Each handle's interval lasts until it closes, and the
  shortest open interval wins; in React, a new `pollMs` (or none) replaces the old one.
- **Live fallback.** A query that shows `@live` records no subscription covers polls every
  `polling.liveFallbackMs` (default 30 s; `null` turns it off). That covers types with no usable
  `Changed` subscription, records beyond the per-record cap in `key` mode, and every `@live`
  record when the client has no live layer.
- **Pausing.** Polls pause while `polling.isActive()` is false (by default, while the document is
  hidden).

## Pagination

Mark a paginated list field `@connection(key: "...")`, and pass its paging argument as a variable:

```graphql
query CatalogScroll($Where: WidgetWhereInput, $Page: KeysetPageInput) {
  Widgets(Where: $Where, Page: $Page) @connection(key: "catalog") {
    Edges { Node { ...WidgetRow } }
    PageInfo { TotalCount }
  }
}
```

- **Merging.** The paging argument (`Page` by default) is left out of the storage key, so every
  page merges into one stored list per filter. The compiler adds `Cursor`, `PageInfo.HasNextPage`
  and `PageInfo.EndCursor` when they're not selected. The directive isn't sent to the server.
- **Loading more.** `loadMore()` (on `watchQuery` and `useQuery`) fetches the next page, with
  the paging variable's `after` set to the stored end cursor, and appends it.
- **State.** `hasMore` and `loadingMore` are in the query state.
- **Refreshing.** Regenerated queries refresh the loaded range as described under R3 below.
  Legacy artifacts replace the head and keep later pages and their end cursor.
- **Offset input.** When the paging argument is graphql-orm's offset `PageInput` (`Limit`,
  `Offset`, no `after`), the compiler records it and `loadMore()` asks for `Offset` = the number of
  rows loaded. With legacy artifacts, a first-page refresh keeps later rows; rows that moved
  between pages can be missed or shown once, so give the root an order with a unique last key
  (`OrderBy: [..., { Id: ASC }]`).
- **Field names** default to graphql-orm's: `Edges`, `Node`, `Cursor`, `PageInfo`, `EndCursor`,
  `HasNextPage`, `Page.after` and `Page.Offset`. Change them with the `connection` compile option.

### Page-number navigation

A table that pages by number marks its list field `@paged` and passes graphql-orm's `PageInput` as
a variable:

```graphql
query TicketsPage($Where: TicketWhereInput, $Page: PageInput) {
  Tickets(Where: $Where, Page: $Page, OrderBy: [{ Opened: DESC }, { Id: ASC }]) @paged {
    Edges { Node { ...TicketRow } }
  }
}
```

```tsx
function TicketTable({ where }: { where: TicketWhereInput }) {
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const page = usePagedQuery(TicketsPageQuery, { Where: where }, { pageIndex, pageSize, scope: vendorId })
  const rows = useFragmentList(TicketRowFragment, page.data?.Tickets.Edges.map((edge) => edge.Node))
  return (
    <Table rows={rows} busy={page.placeholder} pageIndex={pageIndex} pageSize={pageSize}
      total={page.totalCount} onPageChange={setPageIndex} onPageSizeChange={setPageSize} />
  )
}
```

- **Compiler.** `@paged` (optionally `@paged(paging: "Page")`) records where the field sits, its page
  variable, and the `PageInput` and `PageInfo` field names in `artifact.paged`. It adds
  `PageInfo { TotalCount HasNextPage HasPreviousPage }` when not selected and strips the directive.
  It refuses a field that is in a fragment, inside a list, also a `@connection`, or whose page
  argument isn't a variable of an input with `Limit` and `Offset`; one `@paged` field per operation.
- **Pages.** `pageIndex` counts from 0 and `pageSize` defaults to the page variable's `Limit`, else
  50 (graphql-orm's default). The client sets the page variable to
  `{ ...Page, Limit: pageSize, Offset: pageIndex * pageSize }`. Unlike a `@connection`, every page is
  stored under its own arguments, so going back to a page seen before shows it at once (and refreshes
  it per the fetch policy). Records stay normalised: an edit or `Changed` event on one page shows on
  every page and view of that record.
- **State.** `PagedState` is a `QueryState` plus `pageIndex`, `pageSize`, `totalCount`,
  `pageCount` (`ceil(totalCount / pageSize)`, null without a total), `hasNextPage`,
  `hasPreviousPage` and `placeholder`. While a page loads, the previous page stays in `data` with
  `placeholder: true` and status `refreshing`; its next/previous flags are then estimated from the
  previous total. A page that fails shows `error`, not the previous page.
- **Hold scope.** A change of page or page size always keeps the previous page on screen. New
  variables keep it only when `scope` is unchanged (`usePagedQuery`), or with
  `setVariables(variables, { hold: true })`; otherwise the table shows `loading`. `scope: null`
  never holds.
- **Live and polling.** Each page is an ordinary watched query, so `@live` fragments on the visible
  page subscribe for that page's rows, `pollMs` and the live polling fallback apply to the visible
  page only, and a deleted row makes the page read again.
- **Outside React.** `client.watchPagedQuery(Query, variables, { pageIndex, pageSize, policy, pollMs })`
  returns a `PagedQuery` with `getState`, `subscribe`, `open`, `close`, `refetch`, `setPage`,
  `setPageSize` (which keeps the first row of the page in view) and `setVariables`. `pageVariables`
  and `pagedState` are exported for code that pages by hand.
- **Not done by the client.** It doesn't move to the last page when the total shrinks below the
  current page; compare `pageIndex` with `pageCount`. graphql-orm clamps an explicit `Limit` to its
  maximum (100 by default) without saying so in `PageInfo`, so `pageCount` is only right for page
  sizes within that maximum (see the contract).

## Refetching a fragment

Mark a fragment `@refetchable` to read its record again without refetching the root that
produced it:

```graphql
fragment WidgetCard on Widget @refetchable {
  Name
  Sku
}
```

- **Query.** The compiler adds `query WidgetCardRefetch($NodeId: ID!) { node(NodeId: $NodeId) { ...WidgetCard } }`
  to the fragment artifact (`fragment.refetch`). `@refetchable(queryName: "...")` renames it.
  The directive isn't sent to the server.
- **Requirements.** The schema needs the router's `node(NodeId)` lookup, and the fragment's
  type must implement `Node` (graphql-orm's `#[graphql_entity(node_id)]`). The fragment can't
  use operation variables. The compiler refuses each of these with a message.
- **Calling it.** `client.refetchFragment(Fragment, ref)` sends the query with the reference's
  `NodeId` and writes the result, so every view of the record updates.
  `useRefetchableFragment(Fragment, ref)` is `useFragment` plus `refetch`, `refetching`, `error`
  and `found`.
- **Missing or denied.** A null `node` without errors means the record is missing or no longer
  readable: the store removes it, as for a `DELETED` event. A null with errors, or a failed
  request, leaves the stored record as it was.
- **Not yet.** Batching several refetches into one `nodes(NodeIds)` request.

## Imperative reads

`client.query(Query, variables, { policy, signal })` reads a query outside React and resolves with
`{ data, errors }`. `store-or-network` (the default) answers from complete stored data without a
request; `store-and-network` and `network-only` always fetch. What it read stays for the retention
period, like a preload. It rejects with `OperationError` when the server returns no data.
`client.store.lookup(selectorOf(Query, variables))` reads only the store.

## Plain subscriptions

Subscriptions that aren't the live layer's, such as an operation's own
`subscription ExportJobs { ExportJobChanged(...) { ... } }`, run through the same
`live.subscribe` transport. `live.artifacts` can be left out when an application has no `@live`
fragments.

- `client.subscribe(Subscription, variables, { next, error, complete })` returns the function that
  stops it. Each event is written into the store first, so keyed records it carries update every
  view, then passed to `next` as `{ data, errors }` with masked references. An event's objects
  without a key are kept until the next event.
- An event with errors and no data goes to `error` as an `OperationError` with its codes.
  graphql-orm ends a stream that lost events with `SUBSCRIPTION_CONTINUITY_LOST` or
  `SUBSCRIPTION_SOURCE_CLOSED`; subscribe again and refetch what the stream fed.
- `useSubscription(Subscription, variables | null, { skip, onData, onError })` runs it while
  mounted and returns the latest `data`, `errors` and `error`.
- The client interprets nothing in the payload: a `DELETED` action is the consumer's to handle.
  Use `@live` fragments when the aim is to keep records on screen current.

## Coming from Apollo

| Apollo | graphql-orm-client |
| --- | --- |
| `useQuery(Q, { variables, skip })` | `useQuery(Q, variables, { skip })`; `variables: null` also skips. Status `idle` |
| `refetch(newVariables)` | `refetch(newVariables)`: merged into the current variables, and the hook switches to them until the `variables` argument changes |
| `fetchPolicy: "cache-first"` / `"cache-and-network"` / `"network-only"` | `policy: "store-or-network"` / `"store-and-network"` (the default) / `"network-only"` |
| `fetchPolicy: "no-cache"` | Queries: not provided, every result is normalised; use `network-only`. Mutations: `mutate(..., { policy: "no-store" })` returns the result without writing it (see [Mutations](#mutations)) |
| `pollInterval`, `startPolling` | `pollMs`, per hook or handle, alongside the client's live polling fallback |
| `context: { fetchOptions: { signal } }` | `signal` on `client.query`, `client.execute`, `client.mutate` and `client.refetchFragment`. Watched queries cancel their own request when closed |
| `errorPolicy: "all"` | The behaviour: data with `errors`, each with `extensions.code`. For `"none"`, treat `errors.length` as a failure |
| `client.query` | `client.query(Q, variables, { policy, signal })` |
| `client.subscribe`, `useSubscription` | `client.subscribe` and `useSubscription`, through `live.subscribe` |
| `refetchQueries` (client or mutation option) | `client.refetchQueries([...])`, `mutate(..., { refetchQueries })` |
| `fetchMore` with a field policy | `@connection` and `loadMore()`, keyset or offset |
| Offset pages with `previousData` | `@paged` and `usePagedQuery` |
| `useLazyQuery` | `useQuery` with `skip`, or `client.query` |
| `cache.writeQuery`, `cache.modify`, `cache.evict` | Not provided. Spread the views' fragments into the mutation, refetch, or rely on live events; garbage collection drops what no query retains |
| `client.clearStore`, `resetStore` | Dispose the client and create one for the next identity |

## Security

- The store is disposed synchronously when the identity changes. No read runs under the
  outgoing identity.
- Proposed: bounding responses by size and time. `createHttpNetwork` sets no limit; pass a wrapped
  `fetch` for one.
- Opt-in persistence is keyed by an explicit identity and deleted by `clear()`, which an application calls on
  sign-out. Disposing a client doesn't delete it. It does not encrypt storage; use a storage adapter appropriate
  to the data and threat model.
- The client does not authorise anything. A denied field or record arrives as the server
  decides (null or error), and the client stores exactly that.
- A record lookup can fail with "not current" or "unavailable" (a stale row, or a source that
  cannot be verified right now). The store keeps what it has and does not treat the failure as the
  record being absent: only a null result without errors means the record is denied or missing
  (`refetchFragment`). Proposed: marking such a record stale and refetching it later.

## Several windows (R19) and budgets (R22)

R19 keeps one client, store and graphql-ws socket per window. R22 is built as
`pnpm budgets`, separate from `pnpm check`, with a separate CI workflow.
[The budget sources](../budgets/README.md) describe the workloads; every threshold,
baseline and reason for its margin is in [limits.json](../budgets/limits.json).

**Measurement from one machine, 2026-11-06:** AMD Ryzen 9 9955HX, 16 available logical CPUs,
64 GiB RAM, Linux 6.17.13-3-pve, Node 24.13.1, Playwright 1.65.0,
headless Chromium 158.0.8127.18. These are local measurements, not Actions results.
Five complete runs passed, with no observed flakiness. The table gives the median across
those runs; each timing in each run is itself the median of five samples.

| Workload | Measured | Limit |
| --- | ---: | ---: |
| 10,000-row writes (ms) | 23.158 | 500 |
| 10,000 fragment reads (ms) | 7.833 | 300 |
| 10,000-row collection (ms) | 4.14 | 300 |
| Store retained heap (bytes) | 8,196,336 | 24,000,000 |
| Heap after collection (bytes) | 14,960 | 4,000,000 |
| 100-event burst wall time (ms) | 32.552 | 750 |
| 100-event subscriber notifications | 100 | 100 |
| 45,000-line schema + 250 documents (ms) | 694 | 5,000 |
| Main standalone raw bundle (bytes) | 59,388 | 65,000 |
| Main standalone gzip bundle (bytes) | 19,014 | 21,000 |
| React standalone raw bundle (bytes) | 6,969 | 10,000 |
| React standalone gzip bundle (bytes) | 2,836 | 4,000 |

Bundles come from the actual built ESM entries, bundled and minified with esbuild; raw means
uncompressed bundle bytes, gzip uses level 9. React and GraphQL peers are external.
Each standalone entry counts all its reachable package modules once, including shared code;
a module reachable from both entries counts in both totals. These totals should not be added
to estimate an application importing both. The React entry does not pull in the entire client.
The compiler fixture has 125 root queries and 125 live fragments, with 500 neutral entity types.
The live burst uses the shipped schema-validating test kit and a simulated second (100 steps of
10 ms), exercising the real live layer and 100 fragment subscribers; it is not a socket throughput
or React rendering benchmark.

For the window measurement, a page served from loopback opens pop-out tool windows with
`window.open`. Each window holds an independent 10,000-row query/store and graphql-ws client.
A **test-owned ws 8.22.1 server**, not a graphql-orm service or router, acknowledges each socket;
every socket must have started a live subscription before measurement.
CDP forces garbage collection and measures retained JS heap, counting each distinct V8 isolate
once. All windows shared one isolate on this machine; summing per-target heap would overcount it.

| Windows open (main + pop-outs) | Rows per window | Total retained JS heap (bytes) | Open sockets |
| ---: | ---: | ---: | ---: |
| 1 | 10,000 | 9,048,332 | 1 |
| 3 | 10,000 | 23,083,224 | 3 |
| 6 | 10,000 | 43,677,244 | 6 |

The larger marginal cost of the 1→3 and 3→6 steps was **7,017,366 JS bytes
and one socket per additional window**. This supports keeping the R19 decision for now.
It includes page/runtime, query snapshots and store allocations; it excludes native renderer
memory, browser RSS, GPU memory and server cost. It does not establish a bound on a full
application or on other devices.

The compile, main and react rows were measured again on 2026-11-07 after R2, R3 and R4; the rest are from the first run. Those three
changes took the main bundle from 39,582 to 49,423 bytes. The marginal JS heap per window is unchanged, at about 7.1 MB with 10,000 rows per window. It looked like 11.5 MB for a while, because the budget measured with R4's confirming read still in flight; it now waits for that to finish.

A nested compile for each live type used to re-extend the whole schema, which took the compile from 7.6 s to about 24 s while staying under
the then limit of 30 s. The extended schema is now cached per schema, and the 5 s limit is what guards it.
A missing browser fails with "window budget not run"; an explicit `--skip-window` reports
incomplete and never counts as a pass. CI installs Chromium and does not skip.

### List streams (R3)

Regenerated query artifacts include `lists`, the entity types shown in root lists, connections,
nested relation lists and count-only `PageInfo { TotalCount }` connections. Connection identity
comes from the schema's `Edges.Node`, not the connection name. The generator emits a stream for
count-only queries even when no live fragment selects the entity. Old artifacts without `lists`
retain keyed record behavior until regenerated.

Opening a query registers list interest before its first read, even for an empty list. While any
list of a type is open, the type uses one un-narrowed stream; otherwise it returns to keyed streams
and `maxKeyedSubscriptions` still applies. Replacement temporarily overlaps generations using R4.
An un-narrowed stream costs the server a row-policy check per event per subscriber.
`live.listStreams: false` opts out and lists poll. A schema requiring a key also forces lists to
poll. Health reports `list-streams-disabled` or `list-key-required` and names the operation; with
polling disabled it reports unavailable. Empty lists are `unconfirmed` until an event arrives.

Every event of the type marks every open list query of that type stale. Unheld rows are never
written to the store. Queries with neither a list of that type nor the changed record do not read.
Stale, gap-recovery and confirming reads share `live.minRereadMs` (default 2000), including the
inactive-query pause and single catch-up on return. A 100-event one-second burst produces two
reads per query. Newly started list streams schedule a confirming read after `live.settleMs`;
queries opening on an existing stream need none. With no subscribe acknowledgement this narrows
the first-read gap and does not close it. `settleMs: false` disables confirming reads.

`@paged` re-reads the current variables, so page 3 stays page 3. Regenerated `@connection` queries
refresh the loaded range, including explicit refetch and polls. Offset connections request the
loaded row count in one request, bounded by `live.maxRereadRows` (default 100, the generated
service default maximum). Set this to the service's configured maximum: PageInfo does not expose
it. Keyset connections follow returned EndCursor/HasNextPage page by page, bounded by
`live.maxRereadPages` (default 10). Responses are assembled before publishing. Load-more and
refresh serialize; the requested loaded range survives overlapping membership changes. Existing
record identities survive, allowing application selection and scroll state to remain attached.

If the bound prevents a complete refresh, the loaded tail stays and
`QueryState.listRefreshTruncated` is true; health reports `list-refresh-truncated`, never healthy.
That tail may be stale and its order is not guaranteed. Increase the bound or reopen a smaller
range. This is not a snapshot across requests: concurrent server writes between keyset pages
remain a server consistency limit. The existing pagination API manages the first `@connection`
in a query; put independently managed connections in separate query owners.

With a preimage grant, `DELETED` removes the held record and re-reads lists. Without
`can_read_deleted_preimage`, graphql-orm sends no delete event; the next event or poll corrects
the list. With polling disabled and no subsequent event, it may stay stale indefinitely.

Validation against generated graphql-orm 0.90.1 and router 0.8.1: 8/8 runs with default Node `ws`
and 8/8 with `allowSynchronousEvents: false`, using HTTP mutations from a second connection.
Each verified first-row creation, filtered/sorted placement, filter entry/exit, TotalCount, page 3,
and three loaded offset and keyset pages. Preimage deletes passed 16/16; one no-preimage delete
stayed stale and repaired on the next update. With 40 held records and `maxKeys: 1`, a regenerated
list used 1 stream with 0 capacity refusals; a legacy artifact hit 32 streams with 8
SUBSCRIPTION_LIMIT_EXCEEDED refusals. Mocks cover bursts, inactive reads, version conflicts,
identity disposal, collection, overlap, reconnect recovery and a load-more race. No browser or
server-main run was performed for R3.
### Sensitive operations (R9)

Declare `@sensitive` on a query or mutation. Generation records `sensitive: true` and strips
the directive from the wire document. Results are plain values with fragment selections expanded;
they carry no fragment references and cannot be opened by `readFragment`. No store (including
a private store), retention or inspector receives the result. Existing matching entities remain
unchanged, just as with mutation `policy: "no-store"`. That older option still supports private
fragment reads. Sensitive queries use imperative `client.query`; watched queries, preload and loadQuery
reject them because those retain results. Sensitive mutations reject optimistic responses.
Live fragments anywhere in a sensitive operation, and operation-level `@live`, fail the build.
Persistence excludes these results. Callers own the returned values
and must avoid logging or retaining secrets themselves. No server change is required.

### Write certainty (R10)

`client.mutateOutcome` and React `useMutation(...).commitOutcome` return an outcome even
when legacy `mutate` / `commit` would throw; those existing APIs still return or throw as before.
Statuses are `confirmed`, `refused`, `failed`, `unconfirmed`. No write is retried.
After step-up authentication call `commitOutcome` again explicitly with fresh variables;
the hook queues no replay and holds no credential. Supply `reconcile: () => client.refetchFragment(F, ref)`
(or an explicit network-only query) for known affected records. Unconfirmed writes await that read
and report `reread`, `failed`, or `unavailable` when no record/read is known.
A re-read observes current state; it does not prove this write committed.

The classifier requires evidence: all selected root results with `Success: true` and no errors
confirm a write. Explicit server `extensions.outcome: "refused"` / `"failed"` distinguish those
outcomes; these two signals are proposed server contract additions and tested with mocks.
A transport can mark an error as coming before the send with `markNotSent`, as `createHttpNetwork` does for a failed `headers()`; that, or cancellation before sending, is failed. The thrown error is unchanged. A response with no `data` key is refused: per GraphQL over HTTP, execution never started.
Connection loss, cancellation after send, HTTP errors, partial errors and GraphQL `data: null`
are unconfirmed. Neither HTTP status nor error message text proves a refusal. Missing Success,
`Success: false`, and mixed multi-root outcomes are conservatively unconfirmed.

Source checked: graphql-orm tag `graphql-orm-v0.90.1`, router 0.8.1:
runtime/mutation.rs marks post-commit payload denial/failure/timeout with
`extensions.outcome: "committed", retryable: false`; outcome unknown also forbids automatic retry.
Generated operations.rs uses boolean Success and free-form Error; these are insufficient for
uniform refusal classification. No client inference from error text is used.

HTTP limits are opt-in to preserve existing applications: configure
`createHttpNetwork({ url, writes: { deadlineMs: 15000, maxResponseBytes: 1048576 } })`.
`reads` has independent bounds; omitted bounds retain unlimited behaviour.
Limits cover response streaming and are not mutation retries. Custom networks must implement
their own bounds and must not automatically retry mutations.

### Partial responses (R12)

Already supported: an HTTP GraphQL response with both data and errors is returned; successful
aliases normalise and render. `QueryState.errors` and `useQuery().errors` preserve every original
error path (including aliases and list indices). Query state is ready with partial data; React
also exposes an `OperationError` in `error`. No-data responses still throw. `readFragment` and
`useFragment` return only masked data, not operation errors. The query owner must pass error
state to fragment components; use `errorsAtPath(query.errors, ["alias", ...])` to select it.
Pathless errors apply to every path. Do not render missing data as empty or zero.

Previously (and by default), error-associated nulls overwrite good cached fields. Opt into
`createClient({ network, partialResults: "preserve-errors" })` to omit null writes at error paths
or their null-bubbled ancestors. Other aliases still write, and genuine nulls without errors
still clear values. A refused array position preserves the whole list rather than shifting
positions or guessing identity. Pathless errors cannot identify refused fields, so their nulls
retain legacy handling. Missing fields remain missing. Existing values may therefore be stale;
always render the path error alongside retained data. Fragment readers see retained values;
they do not independently know whether a root was refused. Version ordering, identity disposal
and collection still use the existing store rules. Live recovery continues to re-read holders.

Migration: enable `partialResults: "preserve-errors"`, then audit partial views to check
`errorsAtPath` before displaying retained values. The default remains `"legacy"` so existing
applications keep their null-clearing behaviour.

Real run: generated conformance service from graphql-orm 0.90.1, router 0.8.1, with a failing
remote root and a successful entity alias in one document returned
`data: { bad: null, good: { Id: "w1", Name: "First" } }` and
`errors: [{ message: "Unexpected error", path: ["bad"], extensions: {
code: "DOWNSTREAM_SERVICE_ERROR", service: "remote" } }]` (also source locations).
This confirms the router preserves the good alias for this nullable failing root. A non-null
root can still bubble to data:null; the client cannot recover data the server did not return.
The same real run dropped the HTTP socket after a write committed: outcome was unconfirmed,
reconciliation reread, and a network-only read observed the updated name and version 2.
No real refused-write signal or committed read-back denial was produced; those classifier
cases use mocks. The fixture's public mutation succeeded without an authorization header.
## Ephemeral streams (R11)

`createStream(client, subscription, variables, options)`, from `graphql-orm-client/streams` so it stays out of the main bundle, creates a framework-agnostic handle for progress,
AI text deltas, terminal output and search results. It uses `live.subscribe`, as plain subscriptions
do, but bypasses normalization entirely. Nothing enters the store or persistence. Call `open()`
to start and `dispose()` to stop and synchronously erase the buffer and cursor. The client owns
all handles, including unopened ones, and disposes them on `client.dispose()`. Identity changes
must dispose the old client before creating the next one, as with query data.

```ts
const output = createStream(client, OutputSubscription, {}, {
  select: data => data.output,
  bufferSize: 2000,
  sequence: {
    value: item => item.seq,
    after: 0,
    cursor: item => item.cursor,
    resume: (variables, cursor) => ({ ...variables, after: cursor }),
  },
})
output.open()
// React: useEphemeralStream(output), imported from graphql-orm-client/react.
// The owner opens and disposes the handle; the hook only reads it.
```

The application's subscription must select the sequence and cursor fields and declare the resume
variable. `sequence.value` declares contiguous increasing safe integers; values at or below the
last accepted sequence are discarded. This assumes ordered delivery within that declared sequence,
not arbitrary out-of-order events. `after` establishes the initial expected sequence; without it,
observation starts at the first item and says nothing about earlier items. `cursor` and `resume`
are a pair, omitted when the service cannot replay. Cursors remain opaque to the client.

State has `connecting`, `open` (an item arrived), `reconnecting`, `ended` (normal completion or
disposal) and `failed`. `continuity: observed` means only that observed sequences were contiguous;
it does not prove admission of a quiet stream or delivery of an unseen final item. During reconnect
continuity is `unprovable` until replay delivers another contiguous sequence. Without replay it
stays unprovable after an interruption. A forward jump records the first `gap` with `expected` and
`received`; it remains visible. Without `sequence`, continuity is always `unprovable`, duplicates
are kept, and gaps cannot be detected. `status: open` alone is never a continuity guarantee.

`bufferSize` is required. Oldest items are evicted and `dropped` counts them; eviction is separate
from a transport gap. Notifications and immutable snapshots coalesce over 16 ms using the live timer
seam, so `useSyncExternalStore` does not render for every event. `getState()` returns the last
published snapshot. Disposal publishes an empty snapshot synchronously and cancels all timers.
No browser global is accessed at module import time.

Use `graphqlWsTransport(ws)` so socket recovery signals through `live.connection`; the handle cancels
the transport's stale-variable resubscription and subscribes with the last cursor. Transport errors,
continuity errors, schema reload and capacity/unavailability errors retry using `live.restart`'s
minimum and maximum delays, with jitter and a minimum positive delay. `maxRetries` counts retries in a row, since the last item, including socket recoveries, and defaults to eight.
`live.restart: false` disables automatic retries. Refusals and other GraphQL errors fail immediately;
normal completion ends without retry. Create a new handle explicitly after a failure. Plain
`client.subscribe` and `useSubscription` retain their existing store-writing behavior.

The server must implement replay for the application's custom subscription. Neither graphql-orm
0.90.1 nor 0.91.1 with router 0.8.1 supplies a generic custom-subscription replay protocol.

R11 verification: the test kit drives 1,000 items with overlapping replay across reconnect and fewer
than ten React renders, plus gaps, unprovable continuity, overflow, disposal and refusal/retry cases.
A loopback run used the conformance router binary (graphql-orm-router 0.8.1 built from the 0.90.1
source) with a test-owned Node subgraph declaring `output(after: Int)` and explicit integer replay:
1,000 items, socket dropped after 500, resume at 500, no missing/duplicate items, 278 notifications.
The source sent one item every 5 ms. An unpaced burst through the router loses items, and the stream reports the gap. That loss
is the router's, not the client's: a bare socket with no client received 274 of 1000 frames from the same source, with no error frame
(router 0.8.1 at `graphql-orm-v0.90.1`, graphql-orm#359). So for a source that bursts, declare a sequence so the loss shows, and don't
rely on the router delivering every frame.

R11 budget run (`pnpm budgets --skip-window`): main 48,554 raw / 15,767 gzip bytes and React
7,096 / 2,875, within checked-in limits. Comparing minified source closures with the branch's parent
adds 3,613 raw / 1,151 gzip bytes to main and 127 / 37 to React (source and built closures differ
slightly). The command failed the unrelated compiler timing budget: median 41,678.8 ms exceeded
30,000 ms. Window measurements were explicitly skipped, so that portion is incomplete. No limits
were raised and this is not a full budget pass.

## Project build policies (R5)

Built. `strict` in the generator config accepts `liveWithoutStream`, `pollWithoutReason`,
`rawSubscriptions` and `queryOwnership`, each `"error"` (default), `"warn"` or `"off"`.
An explicit `@live` fragment with no usable stream must remove `@live` or declare
`@poll(reason: "why polling is needed")`. Reasons must be non-empty and are recorded on artifacts.
`liveUnavailable` remains available when a policy is downgraded or polling is declared.

Set `queryOwners: ["src/routes/**", "src/dialogs/**", "src/adapters/**"]` to restrict query documents;
windows, pickers and other project owners can have their own paths. `subscriptionPaths` similarly
restricts raw subscription documents. Both checks are disabled when their setting is absent.
Globs use config-relative source document paths with `/`, `*`, `**` and `?`; brace/extglob syntax
is unsupported. All files declaring identical text are checked. Programmatic compilation can pass
`documentPaths` (document text to file paths); without it diagnostics name the GraphQL source or
`<document N>` and configured path policies cannot match unknown paths.

`pollMs` is a runtime option, including through hooks, so a build can't see it. Declare it instead:
`query Name @poll(reason: "...") { ... }`. An undeclared `pollMs` throws from `watchQuery` outside production, on a regenerated module, so
development and tests find it. In production, and on a module generated before this release, it warns and still polls, because a working
page mustn't crash on upgrade. `polling.undeclared: "warn" | "off"` on the client relaxes this. `strict.pollWithoutReason` covers an empty
reason at build time. Fallback polling is reported through health and needs no declaration. The escape for a raw subscription is
`createStream` from `graphql-orm-client/streams` (R11).

## Live generation setting (R1)

Built. The generator and `compile` default to `live: "explicit"`: only `@live` fragments request
streams. `live: "default"` is opt-in, not recommended by default; the owner must decide before
the package default changes. It makes object fragments live without a directive.
`live: { "default": ["src/area/**"] }` enables that behaviour only for matching fragment document
source files, relative to the config directory. It matches the fragment's file, not a spreading query's.
Plain-string `compile(schema, sources)` keeps its explicit behaviour; pass `documentPaths` when
using area mode programmatically. Unknown files do not match area globs.

Under `explicit`, a fragment on a keyed type with a `Changed` stream that isn't marked at all gets a generator warning, `strict.fragmentNotLive` (`"warn"` by default; `"error"` or `"off"`). An acceptance test found the reason: an agent given only the package and an ordinary feature request wrote a clean page with no `@live`, and against a real router a row created or renamed elsewhere never appeared, with health reading `idle`. `@live(enabled: false)` says it's meant and silences it.

`@live(enabled: false)` opts a fragment out in every mode; `@live` and `@live(enabled: true)` opt in.
An implicit live fragment with no usable stream warns, appears in `liveUnavailable`, and uses the
normal fallback interval (30 seconds unless changed); health reports `no-stream` and polling, or
unavailable if fallback is disabled. Explicit `@live` on that type follows R5's error policy.
Only fragments on object types with a key become implicitly live. A keyless value type has no identity and no stream, and its data comes with its parent, so it stays as it is. Abstract fragments need explicit intent.
Lists open streams only for types with a live fragment somewhere in the project. Default mode
widens that set; an opted-out fragment does not disable another live fragment of the same type.

Migration: keep `"explicit"` to retain current stream scope. Opt in per area, regenerate, and inspect
`liveUnavailable` and `client.liveHealth()`. More live types use more operations: the router's default
32-operation connection budget still applies; capacity refusals remain visible and uncovered data polls.
No setting overrides server admission or guarantees every burst event arrives.

R1 validation: the generated default-mode project updates a directive-free Widget fragment from
a real stream and reports PageInfo polling with `no-stream`, against graphql-orm 0.90.1/router
0.8.1. Mock tests cover versions, reconnect refetch, collection, identity disposal, source-area
globs and 40 live types at a simulated 32-operation limit. Router configuration source at both
0.90.1 and 0.93.0 sets that default limit to 32; this change did not run conformance on 0.93.0.

## Bounded read-all (R14)

`readAll(client, Query, variables, { limit, pageSize?, signal? })`, from `graphql-orm-client/read-all` so it stays out of the main bundle, returns `{ rows, total, truncated }`.
Use exactly one root `@connection`, a variable page input and select `Edges { Node { ...Row } }`
and `PageInfo { TotalCount }`. The positive integer limit is required; optional positive `pageSize` caps each request. Missing metadata or
an absent/null total throws; totals are never inferred. Rows are normalised and deduplicated
by opaque identity. Offset traversal advances by returned edge count; keyset traversal follows
`PageInfo.EndCursor` while `HasNextPage` is true. Empty continuing pages or repeated cursors
fail rather than loop. Pages have no shared snapshot: concurrent movement may omit rows.
`total` is the exact total returned by the last page, not a snapshot-wide guarantee.
Abort and identity disposal cancel traversal. This is a one-time read; watch a root for freshness.

## Generated aggregates and counts (R15)

Aliased count-only connections and multiple counts in one document use the same R3 list
refresh path. Generated aggregates return arrays of `GraphqlAggregateResultRow`, with
`Groups` and `Metrics` containing nullable `Field`, `Operator`, `Value` strings and a
non-null `Kind` enum. Values stay exact strings; the generator preserves aliases and nullability.
Read from graphql-orm tags 0.90.1 and 0.93.0: aggregate roots are opt-in (`aggregate = true`),
accept generated Where, GroupBy, Metrics and GroupLimit inputs, and read their declared entity.
The compiler matches the aggregate's input object types to connection-root inputs and derives
the entity from `Edges.Node`. Exactly one candidate is required, and only project-live types
enter `OperationArtifact.lists`. Shared result type or operation naming alone cannot establish
entity ownership. With no matching connection, missing filter inputs, or several candidate
entities, SDL is insufficient: no aggregate stream coverage is claimed. Poll explicitly.
Proposed server contract: publish aggregate source entity metadata in the served schema.

## Deleted records (R16)

A direct `DELETED` removes the held store record and triggers its owning roots to re-read.
Confirmed in React: a still-mounted row's `useFragment` returns null during the reread and
after the response excludes it. `readFragment` also returns null. Legacy non-null signatures
do not describe this state safely. Migrate by passing `{ deleted: "null" }` as the third
argument to both functions: the return type becomes `D | null`; render a placeholder or
return null before reading fields. Live-record fields and fragment masking stay unchanged.
Null means unavailable (deleted, collected, disposed, or a missing record), not proof of a
delete or permission to infer an empty result.

Opt in to `createClient({ ..., store: { deletedRecords: "omit" } })` and regenerate.
Readers omit missing direct list members and compiled connection edges with missing nodes
while the owning root refreshes. The record is removed from storage immediately; stale
connection references are replaced by the next read and collected normally. Totals still
come from the server, so they may lag until the reread. Without this setting legacy list
shape remains unchanged. Components holding old references must still handle null.
`DELETED` with `PROPAGATED` retains the parent and re-reads its roots (graphql-orm 0.93.0).
On both server tags read (0.90.1 and 0.93.0), without a preimage grant direct deletes send
nothing: lists correct on their next delivered event or poll. A stream alone cannot promise
instant delete visibility. Pages have no shared snapshot. Deletes carry no retained version tombstone: a late
response can restore a removed row, even when that response carries a record version,
because the deleted record no longer supplies a version to compare. Re-reading after
reconnect remains necessary. Without a version, ordinary writes use last-arrival-wins.

## Lifetime (R17)

Lifetime is opt-in. Generator `lifetimes: { Widget: { field: "Expires", format: "unix-seconds" } }`
selects that scalar in reads and carries the policy in artifacts. No field name implies expiry.
`StoreOptions.lifetimes` accepts the same declaration for direct store writers. Regenerate to adopt;
projects without a declaration keep their current behaviour. The available representations are
`unix-seconds` (number or decimal text), `rfc3339` (explicit zone required), and `sqlite-utc`
(an explicit service guarantee that SQLite's zone-less datetime text means UTC).

Expired records read as missing, with `Snapshot.lifetime` and `QueryState.lifetime` set to `expired`;
watched holders re-read. A fragment whose own record has expired reads null, like a missing record. Unknown or absent time values remain visible with lifetime `unknown` and
emit `StoreOptions.onDiagnostic` code `LIFETIME_UNKNOWN`. They are neither expired nor proved valid.
A null lifetime is unknown, not an infinite lease. Calendar dates are validated before parsing.
The store uses one expiry timer, rechecking at the nearest deadline, capped at 2,147,483,647 ms.
Expiry does not delete records or synthesize Changed events; normal version ordering and retention
still apply. Disposal clears the timer and records. Browser clock correctness is a consumer dependency.

## Persistence (R17)

Import `persistClient` and optionally `indexedDBAdapter` from `graphql-orm-client/persistence`.
Attach once to a fresh client, before starting reads, and await `ready` to draw restored data:

```ts
import { persistClient, indexedDBAdapter } from "graphql-orm-client/persistence"
import { schemaHash } from "./graphql/generated"

const persistence = persistClient(client, {
  adapter: indexedDBAdapter(),
  identityKey: signedInIdentityKey,
  schemaHash,
  serverRelease: deploymentRevision,
  onDiagnostic: diagnostic => report(diagnostic),
})
await persistence.ready
```

The adapter interface is async `get(key): string | null`, `set(key, string)` and `delete(key)`.
There is no default identity: absent or empty `identityKey` disables all storage access. Include
authorization scope in that key. To change identity, dispose the old client synchronously before
creating a new client; changing an application variable does not change an existing client's identity.
Do not attach two persistence controllers to the same client. The adapter must make writes atomic.

**On sign-out, call `clear()`.** Disposing a client doesn't delete what's saved, because the client can't tell a
window closing from a user leaving, and other windows of the identity may rely on it. Nothing else removes saved
data, so an application that skips `clear()` leaves it on the device:

```ts
void persistence.clear() // deletes, and stops this identity's other windows saving it
client.dispose()
```

Windows of one identity share a key, because each has its own store (R19). The last write wins, which costs only staleness, since restored data is re-read. It can also replace a large snapshot with a window's smaller one. So give a secondary window, such as a pop-out, `readOnly: true`: it restores and never writes or deletes, whatever it reads and however it closes. Its `clear()` still deletes.

`clear()` tells the identity's other windows through a `BroadcastChannel`, where one exists. Each stops saving, and a window that can write deletes once more after any write it had under way. They keep their data in memory until the application disposes them. `deleteOnDispose: true` restores the earlier behaviour of deleting on disposal. Use it only with one window per identity.

Envelopes contain format version, package version, schema hash, server release and identity.
Any mismatch is diagnosed and deleted, with no migration. Generator setting `persistence: true` exports `schemaHash`, a
SHA-256 of printed schema SDL; a consumer can also supply its tracked R23 snapshot hash consistently.
The application must supply `serverRelease` and change it on every deployment affecting the API.
Neither SDL nor operation hashes can detect a release with unchanged schema. The client cannot
detect a misreported release. Connections and their cursors are restored only under an exact
release match; none cross a declared release. Storage remains local to the adapter and identity.

Restored snapshots set `stale: true` in QueryState and Snapshot until network writes reach their
records. Cache-first watched queries fetch on open; imperative queries bypass restored cache hits.
Restore only inserts absent records, so reads and live events arriving during restore always win,
including unversioned writes. Normal version ordering applies after restore; without a version,
arrival order wins. Restoration does not set last-read times or confirm a live stream.

Sensitive and no-store results never enter this store and cannot reach persistence. Active optimistic
layers postpone the entire snapshot until rollback/confirmation, so unconfirmed values never persist.
Writers that put secrets directly into the shared store are responsible for those values.

Writes coalesce for `throttleMs` (250 ms by default). `flush()` awaits restore and a pending snapshot;
call it before navigation when persistence matters. The default `maxBytes` is 1 MiB of UTF-8 JSON,
applied before parse and before writes. Oversized snapshots delete the previous stored payload.
Malformed records, envelope mismatches, storage unavailability and quota failures report
`PERSISTENCE_*` diagnostics and never fail a query. Diagnostic callbacks cannot break persistence.
The budget bounds accepted payloads, not an adapter's allocation before returning a value.

Disposal erases memory immediately and cancels pending writes, and a late restore cannot repopulate
disposed memory. `clear()` also queues deletion after any in-flight write in that window, so a late write
cannot survive it. Adapter failures can prevent physical deletion and are diagnosed; isolation still holds in
memory. Adapter operations must eventually settle. Closing a page or disposing a client preserves a snapshot
for the next load; `clear()` deletes it. Apart from that signal, tabs are independent: there is no cross-tab
synchronization of data, or transaction ordering between different adapter instances.

R17 bundle measurement (minified standalone ESM closure, external peers, gzip level 9):
main 59,593 bytes / 19,175 gzip, versus 55,720 / 17,995 before R17 (+3,873 / +1,180).
The separate persistence entry is 3,354 / 1,562 bytes and imports no runtime code from main.
The main growth is lifetime evaluation plus store hooks for stale restoration and optimistic safety.

## Batched relation reads (R13)

Install `installRelationBatching(client)` from `graphql-orm-client/relations` before
opening queries, annotate singular relations and regenerate:

```graphql
fragment TicketRow on Ticket @live {
  Title
  Vendor @batch(foreignKey: "VendorId", root: "Vendors", key: "Id", limit: 100) {
    ...VendorBadge
  }
}
fragment VendorBadge on Vendor @live { Name }
```

The compiler validates the declared foreign key and complete single target key, their scalar
types, `Where.<key>.InList`, `Page.Limit` and `Edges.Node`. It selects the foreign key and
removes the relation and unused child fragments from the parent request. The SDL does not
attest the mapping; the directive author supplies it. Unsupported mappings fail the build
with the parent field and reason. Composite target keys, plural relations, relation arguments,
conditional relation directives, operation variables in the related projection and nested
batches are unsupported.

The generated relation is a discriminated union. Render each state explicitly:

- `{ status: "pending" }`: queued or in flight; render loading.
- `{ status: "ready", data }`: only the selected fields and masked child references.
  Pass `data` to `useFragment(VendorBadge, data)` to read the badge.
- `{ status: "missing" }`: null foreign key or no readable record returned. The server
  cannot distinguish absent from denied records here.
- `{ status: "error", error }`: a failed chunk, reported per requested record. The parent
  query remains usable. Explicit refetch retries missing and failed lookups.

A five-millisecond window coalesces keys across open queries. Batch sites for the same declared
root and key share a build-time union projection, including different fragments. Requests
contain at most `limit` distinct keys (default and maximum 100), and explicitly request that
many rows. Use a lower limit for services configured below the default page maximum. The
smallest declared limit for a shared root wins. No offset or cursor is guessed.

Related records use normal identity and version ordering. Complete stored records are reused;
lifetime expiry is still proposed under R17. Without a version, the last arrival wins. Related
types get streams only when the project marks their fragments `@live`; otherwise use query
polling or refetch. Parent foreign-key events queue the new target. Polling, refetch and reconnect
invalidate batched dependencies and coalesce reads again. Router burst loss remains a server
gap (graphql-orm#359), so streams alone cannot prove continuity.

Readers track lookup states and related records for notification and collection. Mounted
fragment subscriptions retain their graph even after a query closes. Released subscriptions
and queries no longer retain targets. Identity disposal aborts client requests; queued work
checks disposal before sending or writing. The scheduler is in an optional entry point. On the R13 implementation base, the main
minified browser closure changes from 55,720 to 56,492 bytes; level-9 gzip changes from
17,995 to 18,191 bytes (limits: 60,000 and 20,000).
Documents without the directive keep their existing request behaviour; adoption requires
installation, annotation and regeneration only.

Reading a relation can queue a request, so a read during render can too. That queue only reads, sends each id once however many renders ask, including under StrictMode, and writes to the store only after render, so a render React discards leaves at most a read whose result the next render uses. Tests pin each of these. With no `document`, as when rendering on a server, nothing is sent and the relation stays `pending`, because private reads must never run in server rendering; `withoutDocument: "read"` allows it for a non-browser client that means to.

## Burst repair reads

Router 0.8.1 at graphql-orm 0.90.1 and 0.93.0 can drop frames silently (#359).
`live.burstRead` is enabled by default: `{ events: 32, settleMs: 500, maxWaitMs: 10000 }`.
The threshold matches the router's default broadcast capacity: fewer than 32 events cannot
fill that buffer. Events count while less than 500 ms apart. One manager-wide window waits
until every participating type is quiet, or 10000 ms passes, then reads the union of record
and list holders once per query. Sustained streams start a fresh window after each deadline.
This repairs dropped final frames when enough preceding frames arrive; it cannot detect an
entirely lost or below-threshold burst. Server continuity signalling is still needed.

Reads use `QueryResource.readAgain`: pending R3 or thin invalidations absorb the burst mark;
an automatic read already sent after the last burst event absorbs the mark, including
timers due together. A read predating that event is followed by one more.
The shared `minRereadMs` limiter bounds request frequency; hidden pages wait and read once
on return through `polling.isActive()`. A list burst with a trailing invalidation pending
adds zero requests; other timing can add at most one per window. Disposal cancels all timers.
Restart clears that type's window; reconnect clears the whole window before recovery reads.
Per-type `burstReads` counts actual repair requests (including a shared pending invalidation)
and `lastBurstReadAt` is null until one is sent. Several queries can increment a type's count.

Migration: one extra read per query holding the type per burst of at least 32 events,
coalesced across types and at most one per `minRereadMs`. Set `live: { burstRead: false }`
to restore the old read cost. Modules generated earlier get this without regeneration.

## Read and stream counters

With a live layer, `liveHealth().reads` is an immutable snapshot of monotonic request
counts for this client: `first` (opened query fetch), `manual` (refetch, execute, query and
imperative reads), `poll` (interval including fallback), `stale` (event, missing record or
list invalidation), `confirm` (new coverage), `restart` (ended stream), `reconnect` (socket
recovery), `burst` (burst repair), and `pagination` (load-more). Loaded keyset refresh pages
count individually under the initiating cause. A request which fails still counts; one
cancelled before sending, absorbed by an in-flight read, or coalesced in the limiter does
not. The first pending cause owns a coalesced request; per-type `burstReads` can additionally
identify its participation in burst repair. Counters never double-count a shared request.

`streams` counts open managed subscriptions across types, including overlap candidates;
it excludes plain subscriptions and ephemeral streams. `refusedStreams` counts failed or
refused managed operations, including full selections refused before a thin fallback and
synchronous transport failures. Normal completion, reload and continuity-loss ends do not
count as subscribe failures. `hasLiveLayer` explicitly reports configuration. These fields are absent without a live layer: zero means
measured and none. Take two health samples and divide count differences by elapsed minutes.
Counter and read-time changes alone do not notify health listeners. Event timing follows
the existing at-most-once-per-second notification path; state changes still notify promptly.

## Zero keyed subscription cap

`live.maxKeyedSubscriptions: 0` requests one whole-type stream in `key` and `keys`
modes when the narrowing argument is optional. `unkeyed` already uses one. Changes to
held sets keep the same stream, even if the old and new sets have no rows in common;
events for unheld rows are dropped. List invalidation still sees them. With required
`Keys`, delivery remains narrowed and status and type health expose `keyRequired: true`.
Other cap values are ignored in `keys` mode as before; `maxKeys` still sizes chunks.
Required `Key` retains its existing zero-cap overflow and polling behavior.
This applies equally to explicit and opt-in default live generation, including old artifacts.

Migration for optional `Keys` schemas already setting zero: streams stop narrowing.
The server performs a row-policy check per event per subscriber, including unheld rows.
Remove `maxKeyedSubscriptions: 0` to keep narrowing. No regeneration is needed.
