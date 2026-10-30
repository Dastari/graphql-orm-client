# Design

Status: partly built. Implemented and tested:
- the compiler (`compile` from `graphql-orm-client/compiler`);
- NodeId;
- the store: normalisation, version ordering, masked reads, subscriptions, retention and garbage collection, disposal;
- `Client`: `execute`, `watchQuery`, `preload` and `mutate`;
- `readFragment`;
- React: `ClientProvider`, `useQuery`, `useFragment` and `useFragmentList`;
- the live layer: `compile(...).live`, `LiveManager`, and `createClient({ live })`.

Proposed, not built: polling for live overflow and unavailable types, `usePagination`, optimistic updates, persistence, the codegen preset, and per-type `staleMs`/`expiresField` policy.

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

A graphql-codegen preset, exported from `graphql-orm-client/codegen`, reads every document in
the application and emits one artifact per root:

- **Query text.** The flattened operation, sent as is or by persisted hash.
- **Persisted hash.** Registered with the router's operation allow-list when it is enabled.
- **Normalisation map.** Where each record sits in the response, its type and its key fields,
  so the store can split the response into records without guessing.
- **Fragment readers.** One per fragment: the fields to read from the store and the child
  fragment references to hand down.
- **Live subscription document.** For roots that contain `@live` fragments, a subscription
  whose selection is the union of those fragments for each type.
- **Types.** TypeScript result, variable and fragment-reference types.

The compiler validates the documents against the router's schema snapshot. It rejects a
fragment on a type without a complete key, because such records cannot be normalised.

## Store

### Identity

Every record that has a complete key is stored under its `NodeId`, an opaque base64url
encoding of `[typename, ...keyParts]`. Keys are unique only within a type, so the type name is
part of the identity. A record without a key (an embedded object or an aggregate row) is
stored inside its parent.

### Writes and ordering

- A response is split into records using the root's normalisation map. Each field is merged
  into the stored record.
- When the type exposes a version, a write carrying an older version than the stored record
  is dropped. Without a version, the last write to arrive wins.
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
  network: {
    http: { url: "/api/graphql", persisted: "prefer" },
    ws: { url: "wss://graph.example.com/graphql", connectionParams: () => ({ authorization: ... }) },
  },
  store: {
    scope: identityKey,            // a change disposes the store synchronously
    retainMs: 5 * 60_000,
    types: {
      Device: { staleMs: 30_000 },
      ReleaseCatalog: { staleMs: 5 * 60_000 },
      EnrollmentRequest: { expiresField: "ExpiresAtEpoch" },
    },
    persistence: null,             // or indexedDbPersistence({ name, maxBytes })
  },
  live: { fallbackPollMs: 30_000 },
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
4. **Recover.** After a reconnect, it replays from the last sequence number when the server
   supports replay. Otherwise it refetches the active roots.
5. **Release.** When records are released, it narrows or ends the subscriptions.

Polling remains for state that emits no events (in-memory server state) and when the number
of live keys exceeds the subscription limit.

### Live modes

The compiler reads each type's generated `<Type>Changed` subscription from the schema and picks
how to narrow it:

| Mode | When | Subscriptions |
| --- | --- | --- |
| `keys` | the field has a `Keys` argument (graphql-orm #261) | one per type, in chunks of up to 500 keys |
| `key` | the field has a `Key` argument | one per held record, up to `maxKeyedSubscriptions` (50) |
| `unkeyed` | neither | one per type; events for records nobody holds are dropped |

The payload's entity field is found by type (`Device` in `DeviceChangedEvent`), and its action
by name. Types with `@live` fragments but no usable subscription are listed in
`compile(...).liveUnavailable`, and their holders must poll. `client.live.status()` reports
per-type counts, including overflow beyond the `key`-mode limit. A `DELETED` event removes the
record, and any query that showed it reads again.

## Mutations

```ts
const [rename, { pending }] = useMutation(RenameDeviceMutation, {
  optimistic: (vars) => ({ Device: { __id: vars.id, Hostname: vars.hostname } }),
})
```

- The mutation's selection spreads the fragments of the views it affects, so the response
  updates the store directly.
- An optimistic update is applied as a layer and removed when the response or an error arrives.
- Inserting into or removing from a list uses explicit list updaters keyed by connection and
  `Where`. When no updater is given, the affected lists are invalidated and refetched.

## Pagination

graphql-orm generates two list shapes: offset connections for sortable tables and keyset
lists for a fixed order. `usePagination(fragment, ref)` supports both. Each page is merged
into the list stored for that field and its `Where`/order arguments. A refetch of the first
page replaces the head and keeps the later pages.

## Refetching a fragment

A fragment can be refetched on its own through the router's `node(NodeId)` lookup, once that
lookup exists. Until then, a fragment can only be refetched through its root.

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
