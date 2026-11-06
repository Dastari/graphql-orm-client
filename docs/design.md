# Design

Status: partly built. Implemented and tested:
- the compiler (`compile` from `graphql-orm-client/compiler`);
- NodeId;
- the store: normalisation, version ordering, masked reads, subscriptions, retention and garbage collection, disposal;
- `Client`: `execute`, `watchQuery`, `watchPagedQuery`, `preload`, `query`, `mutate`, `subscribe`
  and `refetchQueries`;
- transport: `createHttpNetwork` (GraphQL over HTTP) and `graphqlWsSubscribe` (a graphql-ws
  client for the live layer);
- `readFragment`;
- React: `ClientProvider`, `useQuery`, `usePagedQuery`, `useFragment`, `useFragmentList`,
  `useMutation` and `useSubscription`;
- the live layer: `compile(...).live`, `LiveManager`, `createClient({ live })`, and opt-in back-off for refused streams;
- the generator: `graphql-orm-client generate` with `--check`. It emits typed artifacts, masked
  reference types, the `live` artifacts and an overloaded `graphql()`.

- pagination: `@connection` (keyset or offset), `loadMore`, `hasMore` and `loadingMore`;
- page-number navigation: `@paged`, `watchPagedQuery` and `usePagedQuery`;
- optimistic mutations, `no-store` mutations, interval polling, and the live polling fallback;
- `@refetchable` fragments: `client.refetchFragment` and `useRefetchableFragment`.

Proposed, not built: automatic list insertion after mutations, persistence, and per-type `staleMs`/`expiresField` policy.

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
const DeviceRowFragment = graphql(`
  fragment DeviceRow on Device @live {
    Id
    Hostname
    LastSeen
    ...DeviceHealth
  }
`)

function DeviceRow({ device }: { device: FragmentRef<typeof DeviceRowFragment> }) {
  const data = useFragment(DeviceRowFragment, device)
  return <Row name={data.Hostname} seen={data.LastSeen} health={data} />
}

const FleetPageQuery = graphql(`
  query FleetPage($Where: DeviceWhereInput) {
    Devices(Where: $Where, First: 50) {
      Edges { Node { ...DeviceRow } }
      PageInfo { HasNextPage EndCursor }
    }
  }
`)

// Route loader: start the request before rendering.
loader: ({ context, deps }) => context.client.preload(FleetPageQuery, { Where: deps.where })

function FleetPage() {
  const { data } = useQuery(FleetPageQuery, useLoaderDeps())
  return data.Devices.Edges.map((edge) => <DeviceRow key={edge.Node.__id} device={edge.Node} />)
}
```

`useFragment` returns only the fragment's own fields. A child's fields are hidden behind its
fragment reference (data masking), so a parent cannot come to depend on them by accident.

### View-model fragments

Some screens don't render records one component at a time. A data table needs complete row
objects for sorting, filtering and column rendering, and an application may map server data into
domain models before rendering. A device fleet table is one example: one `FleetDeviceFacts`
fragment feeds the table columns, device identity, navigation and usage views.

In that case the fragment belongs to the adapter that builds the view model, not to a component:

- The adapter declares one fragment per view model and is the only code that reads it, through
  `readFragment(Fragment, ref)`. That is a plain function, not a hook, so it works in mappers.
- `useFragmentList(Fragment, refs)` subscribes to a list of records and returns view models that
  update when any of their fields change. Tables use it instead of one `useFragment` per row.
- Components below the adapter receive domain objects and never see GraphQL.

Masking still applies at the adapter boundary: a query that spreads the fragment can't read its
fields without `readFragment`. Per-component fragments remain the default for screens that
render records one component at a time.

## Compiler

`graphql-orm-client generate` reads every `graphql(...)` document in the application. It uses
`compile` and `generate` from `graphql-orm-client/compiler`, and emits one typed module with an
artifact per root:

- **Query text.** The flattened operation, sent as is or by persisted hash.
- **Persisted hash.** Registered with the router's operation allow-list when it is enabled.
- **Normalisation map.** Where each record sits in the response, its type and its key fields,
  so the store can split the response into records without guessing.
- **Fragment readers.** One per fragment: the fields to read from the store and the child
  fragment references to hand down.
- **Live subscription document.** For roots that contain `@live` fragments, a subscription
  whose selection is the union of those fragments for each type.
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
- A `Changed` event with action `DELETED` removes the record and every list entry that points
  to it.
- Writes are batched per tick. Subscribers are notified once per batch, and only those whose
  fields changed.

### Retention and garbage collection

A mounted root retains the records it reaches. When it unmounts, its records stay for a
configurable period (default: five minutes) and are collected once nothing retains them.
A small buffer of recently released roots stays warm for back navigation.

### Cache policy

```ts
const client = createClient({
  network: createHttpNetwork({ url: "/api/graphql" }),
  store: {
    retainMs: 5 * 60_000,
    // Planned from here: scope, per-type policy and persistence.
    scope: identityKey,            // a change disposes the store synchronously
    types: {
      Device: { staleMs: 30_000 },
      ReleaseCatalog: { staleMs: 5 * 60_000 },
      EnrollmentRequest: { expiresField: "ExpiresAtEpoch" },
    },
    persistence: null,             // or indexedDbPersistence({ name, maxBytes })
  },
  live: { artifacts: live, subscribe: graphqlWsSubscribe(ws) },
  polling: { liveFallbackMs: 30_000 },
})
```

- **`staleMs`.** How long a record counts as fresh. Reading a stale record serves it from the
  cache and refetches it in the background.
- **`expiresField`.** A lifetime field. The store drops the record when it expires, because
  `Changed` fires on writes, not on clock expiry. Once graphql-orm publishes lifetime metadata
  in the schema, the compiler will fill this in.
- **`persistence`.** Optional IndexedDB storage for offline start. Persisted data is keyed by
  identity scope and cleared when the scope changes.

### Query states

A root reports `idle` (skipped), `loading`, `ready`, `refreshing` or `error`. `usePagedQuery` and
`watchPagedQuery` keep the previous page while another page loads, and keep it across new
variables within the same hold scope (a new search term on the same organisation), as
`refreshing` instead of blanking. A different scope never shows another scope's records.

## Live layer

1. **Collect.** After a root's query resolves, the live layer collects the `NodeId`s of
   records read by `@live` fragments that are still retained.
2. **Subscribe.** It subscribes to each type's generated `<Entity>Changed` subscription for
   those keys, with the union selection from the compiler. One subscription covers a list of
   keys once graphql-orm supports it; until then, one per key, with an upper limit and polling
   above it.
3. **Write.** It writes each event's entity into the store, ordered by version. An
   upward-propagated event (`ChangeKind: PROPAGATED`) updates the parent record and refetches
   any of the parent's fields that are computed from its children.
4. **Recover.** graphql-orm (0.88) ends a `Changed` stream that lost events with one error,
   `SUBSCRIPTION_CONTINUITY_LOST` (the subscriber fell behind the event channel) or
   `SUBSCRIPTION_SOURCE_CLOSED`. After a random delay below `live.resyncJitterMs` (default
   1 s), the live layer subscribes again, then refetches the roots that show that type. Any
   other end of a stream (a transport error, a plain `complete`) releases it without a retry;
   the next change to the held records starts it again. A stream the server refuses can be held
   back for a window instead (see [Refused streams](#refused-streams)). After a socket reconnect the
   application calls `client.refetchActive()`, until the server supports replay from a sequence
   number.
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

The payload's entity field is found by type (`Device` in `DeviceChangedEvent`), and its action
by name. Types with `@live` fragments but no usable subscription are listed in
`compile(...).liveUnavailable`, and their holders must poll. `client.live.status()` reports
per-type counts, including overflow beyond the `key`-mode limit. A `DELETED` event removes the
record, and any query that showed it reads again.

### Refused streams

By default, a stream that ended for any reason except lost events starts again on the next change to
the records it holds, so a router that refuses a stream sees another doomed subscribe on every list
refresh. `live: { refusalBackoff }` (off by default) remembers the refusal instead:

```ts
createClient({
  network,
  live: {
    artifacts: live,
    subscribe,
    // Five minutes for every type, except Ticket, which has no poll behind it and stays on
    // immediate retry:
    refusalBackoff: { ms: DEFAULT_REFUSAL_BACKOFF_MS, types: { Ticket: false } },
    // or: refusalBackoff: true            every type, five minutes
    //     refusalBackoff: { types: { Device: 60_000 } }   Device only, one minute
  },
})
```

- **What counts as a refusal.** A stream that ends before delivering any event, by either of these: the
  server answers the subscribe with GraphQL errors (graphql-ws delivers an array of errors to the
  sink's `error`, as an `error` message), or it sends frames with errors and no data and then
  completes. Both mean the router said no to this subscribe, whatever the code; the client has no list
  of refusal codes and does not guess one.
- **What does not.** Lost events: a frame carrying `SUBSCRIPTION_CONTINUITY_LOST` or
  `SUBSCRIPTION_SOURCE_CLOSED` still restarts after the jitter and refetches, whatever the option, and
  is never remembered (a continuity code on the `error` channel is also left alone, as before). A
  transport failure (an `Error`, a socket close event) says nothing about the stream: graphql-ws owns
  reconnection, and the stream starts again on the next change. A `complete` with no frames is a
  clean end, because a healthy stream with nothing to report can end that way. A stream that
  delivered an event and then fails is not a refusal.
- **Identity of a stream.** The type's `<Type>Changed` operation; in `key` mode, that operation for one
  record (a refusal of one record's stream doesn't hold back another's, as when the router caps the
  streams per connection). The chunk of keys in `keys` mode is not part of it: it changes whenever a
  list refresh changes the held records, so one refused stream would look new every time.
- **During the window.** No request is sent for that stream however often the held records change, and
  the stream is not removed from the layer: when the window ends, it subscribes again by itself if its
  records are still held. A refusal then starts another window; an admitted stream stays open. The
  window is a timer (`live.setTimeout`, `live.clearTimeout`), so tests drive it without waiting.
  `client.live.status()` reports `backedOff` per type.
- **What the client does not do.** It doesn't refetch when a window ends: events during the window
  were missed, so keep a poll (`pollMs`, or the live polling fallback) behind every type that backs
  off, and leave a type on immediate retry (`false`) when nothing else refreshes it.
- **Disposal.** The memory and its timers belong to the client's live layer and go with the client when
  the identity changes. A refusal recorded for one identity cannot hold back the next identity's
  client, and one that arrives after disposal is ignored.
- **Not covered.** Plain subscriptions (`client.subscribe`) are never restarted by the client, so they
  have no loop to break.

## Mutations

In React, `useMutation(Mutation)` returns `commit`, `inFlight` and `error`; `commit` takes the
same arguments as `client.mutate` and rejects when the mutation fails.

```ts
await client.mutate(RenameDeviceMutation, { Id: id, Name: name }, {
  optimisticResponse: { UpdateDevice: { __typename: "DeviceResult", Success: true, Entity: { __typename: "Device", Id: id, Name: name } } },
})
```

- **Store updates.** Spread the fragments of the views a mutation affects into its selection, so
  its response updates every view of the record.
- **Optimistic responses.** An `optimisticResponse` is written as a layer and shows at once. When
  the real response or an error arrives, the layer is rolled back field by field, and the real
  response is written. A field that changed since (from a live event or another response) is not
  rolled back.
- **Lists.** Inserting into or removing from a list is not automatic. Refetch the affected query
  (`refetchQueries`), or rely on the live layer.
- **Refetching after.** `mutate(..., { refetchQueries: [TicketsPageQuery, "FleetPage"] })` reads
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
  an interval while that handle is open. Each handle's interval lasts until it closes, and the
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
query FleetScroll($Where: DeviceWhereInput, $Page: KeysetPageInput) {
  Devices(Where: $Where, Page: $Page) @connection(key: "fleet") {
    Edges { Node { ...DeviceRow } }
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
- **Refreshing.** Refetching the first page (a refresh or poll) replaces the head and keeps the
  pages loaded after it. The end cursor stays at the last loaded page.
- **Offset input.** When the paging argument is graphql-orm's offset `PageInput` (`Limit`,
  `Offset`, no `after`), the compiler records it and `loadMore()` asks for `Offset` = the number of
  rows loaded. A first-page refresh keeps the later rows, as for keyset lists; rows that moved
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
  const page = usePagedQuery(TicketsPageQuery, { Where: where }, { pageIndex, pageSize, scope: organisationId })
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
fragment DeviceCard on Device @refetchable {
  Name
  Hostname
}
```

- **Query.** The compiler adds `query DeviceCardRefetch($NodeId: ID!) { node(NodeId: $NodeId) { ...DeviceCard } }`
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
`subscription FileOperations { FameFileOperationChanged(...) { ... } }`, run through the same
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
- Responses are size-bounded and time-bounded.
- Persisted data is per identity scope and is never read across scopes.
- The client does not authorise anything. A denied field or record arrives as the server
  decides (null or error), and the client stores exactly that.
- A record lookup can fail with "not current" or "unavailable" (a stale row, or a source that
  cannot be verified right now). The store keeps what it has, marks the record stale and
  refetches later. It does not treat the failure as the record being absent. Only a null
  result means the record is denied or missing.
