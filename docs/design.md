# Design

Status: partly built. Implemented and tested:
- the compiler (`compile` from `graphql-orm-client/compiler`);
- NodeId;
- the store: normalisation, version ordering, masked reads, subscriptions, retention and garbage collection, disposal;
- `Client`: `execute`, `watchQuery`, `preload` and `mutate`;
- transport: `createHttpNetwork` (GraphQL over HTTP) and `graphqlWsSubscribe` (a graphql-ws
  client for the live layer);
- `readFragment`;
- React: `ClientProvider`, `useQuery`, `useFragment`, `useFragmentList` and `useMutation`;
- the live layer: `compile(...).live`, `LiveManager`, and `createClient({ live })`;
- the generator: `graphql-orm-client generate` with `--check`. It emits typed artifacts, masked
  reference types, the `live` artifacts and an overloaded `graphql()`.

- pagination: `@connection`, `loadMore`, `hasMore` and `loadingMore`;
- optimistic mutations, interval polling, and the live polling fallback;
- `@refetchable` fragments: `client.refetchFragment` and `useRefetchableFragment`.

Proposed, not built: offset (page-number) navigation, automatic list insertion after mutations, persistence, and per-type `staleMs`/`expiresField` policy.

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

A root reports `loading`, `ready`, `refreshing` or `error`. Changing variables within the same
hold scope (a new search term on the same organisation) keeps the previous result as
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
   the next change to the held records starts it again. After a socket reconnect the
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
- **Lists.** Inserting into or removing from a list is not automatic. Refetch the affected query,
  or rely on the live layer.

## Polling

- **Fixed intervals.** `watchQuery(..., { pollMs })` and `useQuery(..., { pollMs })` refetch on
  an interval while the query is open.
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
- **Field names** default to graphql-orm's: `Edges`, `Node`, `Cursor`, `PageInfo`, `EndCursor`,
  `HasNextPage` and `Page.after`. Change them with the `connection` compile option.

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
