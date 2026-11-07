---
name: graphql-orm-client-data
description: Write components and data flows with graphql-orm-client. Use whenever a component shows or changes server data: fragments and route roots (loadQuery), pagination (@paged, @connection), mutations and write outcomes, secrets (@sensitive), batched relations (@batch), readAll, deleted rows, persistence, porting from Apollo, and testing with graphql-orm-client/test.
---

# Fragments, roots, pagination and mutations

Status: early alpha. Check the installed `docs/design.md` for the current API.

## The default path

1. Give each component that shows server data its own fragment, in the same file. Mark it `@live` if the record can change while it's on
   screen (see the live skill).
2. Spread that fragment up to one query owned by the route. Start it in the route loader.
3. Run `graphql-orm-client generate`. Import `graphql` from the generated module, so a wrong field fails the build.
4. Change data with `useMutation`. Spread the affected fragments into the mutation so the response updates the store.

```tsx
import { useFragment, useLoadedQuery } from "graphql-orm-client/react"
import { graphql } from "./graphql/generated"

const TicketRow = graphql(`fragment TicketRow on Ticket @live { Title State }`)
function Row({ ticket }) {
  const { Title, State } = useFragment(TicketRow, ticket)
  return <li>{Title}: {State}</li>
}

const TicketsPage = graphql(`
  query TicketsPage($Where: TicketWhereInput) {
    Tickets(Where: $Where) { Edges { Node { Id ...TicketRow } } }
  }
`)
// In the route's loader: return client.loadQuery(TicketsPage, { Where: where }, { signal })
function Page({ loaded }) {
  const { data } = useLoadedQuery(loaded)
  return <ul>{data?.Tickets.Edges.map(({ Node }) => <Row key={Node.Id} ticket={Node} />)}</ul>
}
```

## Components declare their own data

- Give every component that renders server data its own fragment, in the same file, on the
  type it renders. Name it after the component (`WidgetRow` → `fragment WidgetRow on Widget`).
- Read it with `useFragment(Fragment, ref)`. The component receives a fragment reference,
  never a raw result object.
- Select only the fields the component renders. To render a child component, spread the
  child's fragment (`...WidgetHealth`) and pass the reference down. Do not select the child's
  fields in the parent.
- You don't need to select `NodeId` or the key fields; the compiler adds them. A type without a
  `NodeId` or a complete key is stored inside its parent, not as its own record.

## Roots own the request

- Only route-level components write queries. A root spreads its children's fragments and
  supplies variables (`Where`, order, page size).
- Never fetch inside a child component to fill in missing data. Add the field to the child's
  fragment instead, so the root's query includes it.
- Start the root in the browser route loader (`client.loadQuery`) and consume its handle with
  `useLoadedQuery`; forward the router abort signal and dispose abandoned handles. It does not suspend.
- `@skip`/`@include` selections and fragment arguments (`@argumentDefinitions`/`@arguments`) are
  unsupported build errors. Use separate roots and operation variables. For existing conditional
  documents, `conditionalDirectives: "legacy"` temporarily keeps unsafe old behaviour while migrating;
  remove it after splitting roots. Whole-query hook `skip` is still supported.

## Filters and lists

- Map every filter and search onto graphql-orm `Where` inputs. Filtering a downloaded page
  does not filter the dataset.
- Use offset connections for sortable tables and keyset lists for a fixed order.
- For a table with page numbers, mark the offset list field `@paged` and pass `Page: $Page`
  (graphql-orm's `PageInput`). Read it with `usePagedQuery(Query, variables, { pageIndex,
  pageSize, scope })`; `pageIndex` counts from 0. Feed `totalCount`, `pageCount`,
  `hasNextPage`/`hasPreviousPage` to the pager and dim the rows while `placeholder` is true (the
  previous page is shown while the next loads). Pass `scope` (the vendor, say) to keep rows
  on screen across a filter change; without it, only page changes keep them. Order by a unique last
  key (`{ Id: ASC }`) so pages don't overlap, and keep `pageSize` within the server's maximum (100).
  Don't build `Limit`/`Offset` by hand, and don't put the page in component state twice.
- For an infinite list, mark the list field `@connection(key: "...")` and pass its paging
  argument as a variable (`Page: $Page`). Call `loadMore()` from `useQuery`, and show
  `loadingMore`/`hasMore`. Pages merge into one list per filter; a refresh keeps the scrolled
  pages. It works on keyset inputs (continues after `EndCursor`) and offset `PageInput`
  (continues at the rows loaded).

## Refetching one record

- Mark a fragment `@refetchable` to refresh its record alone (a detail panel's refresh
  button, after an action whose effects the response doesn't carry). Use
  `useRefetchableFragment` or `client.refetchFragment`; don't refetch the whole root.
- It needs the router's `node(NodeId)` lookup and a type that implements `Node`, and the
  fragment can't use operation variables. The compiler says which is missing.
- `found: false` means the record is gone or no longer readable; it has been removed from the
  store. Show that, rather than the stale record.

## Porting from Apollo

- `skip: true` → `{ skip: true }` (or `variables: null`); the status is `idle`.
- `fetchPolicy` → `policy`: `cache-first` is `store-or-network`, `cache-and-network` is
  `store-and-network` (the default), `network-only` is the same. There is no `no-cache` for queries;
  for a mutation use `policy: "no-store"` (see Mutations).
- `pollInterval` → `pollMs`, after declaring `@poll(reason: "...")` on the query. `refetch(vars)` merges and switches, as in Apollo.
- `errorPolicy: "none"` → treat `query.errors.length` as an error; codes are on
  `errors[i].extensions.code`. `useMutation`'s `error` is an `OperationError` with the same codes.
- `client.query` → `client.query(Query, variables, { policy, signal })`, resolving `{ data, errors }`.
- `refetchQueries` → `client.refetchQueries([Query, "Name"])` or `mutate(..., { refetchQueries })`.
- `useSubscription`/`client.subscribe` for a plain subscription document → the same names; they
  use `live.subscribe`. For records that should stay current on screen, use `@live` instead.
- Offset `fetchMore` → `@connection` + `loadMore()`; offset tables with `previousData` → `@paged`.
- `cache.writeQuery`/`modify`/`evict` have no equivalent. Spread the affected fragments into the
  mutation, refetch the list, or rely on live events.

## Mutations

- In components, use `useMutation(Mutation)`: `commit(variables, { optimisticResponse, signal,
  refetchQueries, policy })`, `inFlight` and `error`. `commit` rejects on failure, so await it or catch it.
- A result without a key (a hand-written result object, rows, a scalar) is fine: it is stored
  inside the mutation's root, and the keyed records in it are normalised.
- A mutation that returns a one-time secret (credential, ticket, download link) must be committed
  with `policy: "no-store"`: `commit(variables, { policy: "no-store" })` or
  `client.mutate(Mutation, variables, { policy: "no-store" })`. The caller gets the full typed result,
  and nothing from the response is written to the store, not even keyed records in the same payload,
  so no view updates from it; add `refetchQueries` if views must change. It can't be combined with
  `optimisticResponse`. Without it, the response is stored and unkeyed objects stay until garbage
  collection. Don't copy the secret into long-lived state, and don't select it in a query.
- Spread the fragments of the views the mutation affects into its selection, so the response
  updates the store.
- Use an optimistic update only when the result is predictable. Lists aren't edited for you and
  there is no updater: pass `refetchQueries` for lists a mutation adds to or removes from.
- Use the generated mutations (`Create…`, `Update…`, `Delete…`). Do not ask the backend for
  hand-written resolvers.

## Testing

`graphql-orm-client/test` has what a test needs, with no test runner dependency. Don't write your own mock
transport: scripted frames only prove something if they match what the router sends.

```tsx
import { createMockNetwork, createMockStreams, createTestClock } from "graphql-orm-client/test"

const clock = createTestClock()
// With `schema`, a document or variables that no longer fit fail the request.
const network = createMockNetwork({ schema, operations: { TicketPage: { data: { Ticket: ticket } } } })
const streams = createMockStreams({ schema })
const client = createClient({
  network,
  store: clock.store,
  polling: clock.polling,
  live: { artifacts: live, subscribe: streams.subscribe, ...clock.live },
})

// Then render with ClientProvider and drive it, inside act() when React renders it.
await clock.tick(100)                                // pass time, let requests settle
streams.one("LiveTicket").emit({ ...ticket, Title: "new" })
streams.reload()                                     // the router retired its graph
await clock.tick(1000)                               // the stream restarts and the query reads again
expect(client.live.status().Ticket.subscriptions).toBe(1)
```

- An operation with no answer fails, and so does a request that doesn't fit `schema`. A query keeps a
  rejection in its state, so check `network.failures` where a test could miss it.
- On one stream: `emit`, `next`, `refuse(code, { frame })`, `loseContinuity`, `reload`, `unavailable`,
  `fail`, `end`. `streams.reload()` and `streams.fail()` act on all of them. `streams.reconnect()` is a
  socket drop the transport recovers from by itself, where nothing ends: use it with `onReconnect`.
- `clock.advance(ms)` fires timers without letting promises settle; use `clock.tick(ms)` when a request is
  involved.

## Secrets, write outcomes and partial results

- Put `@sensitive` on a query or mutation whose result must stay out of the store: tokens, one-time secrets. Results are plain
  values with fragments expanded, not fragment references. Use `client.query` for a sensitive query: watching one is an error,
  because a watch retains results. A sensitive document spreading a `@live` fragment fails the build.
- Use `client.mutateOutcome`, or `commitOutcome` from `useMutation`, when the UI must tell the user whether a write happened. Status is
  `confirmed`, `refused`, `failed` or `unconfirmed`. `mutate` and `commit` are unchanged. A write is never retried: pass `reconcile` to
  read the record again after an `unconfirmed` one, and call again yourself after step-up authentication.
- Use `errorsAtPath(errors, ["alias"])` to show one refused root or alias beside the rest of the response. Set
  `partialResults: "preserve-errors"` on the client so a refused field doesn't overwrite a good stored value with null.


## Polling and query owners

A query passed `pollMs` declares why: `query Name @poll(reason: "...") { ... }`. `queryOwners` globs say where queries may be written. See the live skill.

## Reading everything, counts and deleted rows

- `readAll(client, Query, variables, { limit, pageSize?, signal? })`, from `graphql-orm-client/read-all`, returns `{ rows, total, truncated }`, for one root `@connection` selecting
  `PageInfo { TotalCount }`. The limit is required, and a missing total throws. It's a one-time read: watch a root for freshness.
- Aliased counts, several counts in one document, and generated aggregates stay current like lists, on types the project made live. An aggregate whose
  source entity the schema can't establish isn't covered: poll it.
- A record can disappear under a mounted component. `useFragment(Fragment, ref, { deleted: "null" })` types that as `D | null`, so handle null before
  reading fields. `store: { deletedRecords: "omit" }` drops missing rows from lists while the query re-reads. Both are opt-in.


## Lifetime

Declare generator `lifetimes` only when the service guarantees the field's meaning and format.
Regenerate to adopt. Handle `QueryState.lifetime` (`expired` or `unknown`); unknown time values
are not proved valid. Formats and diagnostics are in the installed design.

## Persistence

Use `persistClient` from `graphql-orm-client/persistence` only with an explicit identity key, generated
`schemaHash` (enable generator `persistence: true`) and a deployment revision in `serverRelease`. Await `ready` before starting reads; show
`QueryState.stale` until a network write confirms restored data. Dispose the client before an identity
change. Sensitive operations and no-store mutation results are excluded automatically.
Adapter, budget and failure behaviour are in the installed design. Disposing a client deletes its saved data, so dispose on an identity change, not on window close.

## Batched relation names

For repeated singular relations, use
`Vendor @batch(foreignKey: "VendorId", root: "Vendors", key: "Id") { ...VendorBadge }`.
Install `installRelationBatching(client)` from `graphql-orm-client/relations` before opening
queries and regenerate. With no `document`, as when rendering on a server, nothing is sent and the relation stays
`pending`. Supply the schema's actual mapping and list root. Keep the limit
within the service's page maximum (default 100). Render `pending`, `missing`, `error` and
`ready` separately. In `ready`, pass `.data` to the related fragment reader. Mark related
fragments `@live` when live delivery is wanted. See the installed design's section on batched relation reads.
