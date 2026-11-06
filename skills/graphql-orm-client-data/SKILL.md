---
name: graphql-orm-client-data
description: Use bounded readAll with exact totals; keep regenerated lists and counts current with list streams and bounded loaded-page refresh; use full/thin stream projections and bounded holder re-reads (minRereadMs); Write components with graphql-orm-client fragments and route roots, page through tables by number (@paged, usePagedQuery), load more (@connection), refetch, run mutations (including one-time secrets with `no-store`) and plain subscriptions, and port Apollo queries without request waterfalls or over-fetching, and test components against a mock network, scripted streams and a controllable clock (graphql-orm-client/test).
---

# Fragments, roots, pagination and mutations

Status: early alpha. Check the installed `docs/design.md` for the current API.

Composite keys are inferred from `<Type>KeyInput`, and need no `keys` setting. Queries
can include relation/computed fields in `@live` fragments: omitted stream fields refresh through
bounded holder re-reads. `liveSelection: "as-written"` preserves legacy stream text.

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
- Start the root in the route loader (`client.preload`) so the request begins before render.

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
- `pollInterval` → `pollMs`. `refetch(vars)` merges and switches, as in Apollo.
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

## Regenerated lists

Regenerate to emit operation `lists`: root and nested lists and count-only connections use one
un-narrowed stream per type, opened before the read even when empty. Every event re-reads lists
through `live.minRereadMs`; unheld rows are not stored. Server cost: one row-policy check per event
per subscriber. `live.listStreams: false` makes lists poll; required-key schemas also poll. Old
artifacts retain keyed behavior. Health names the operation for disabled/required-key list streams;
a quiet list is unconfirmed, never live. Confirming reads after settleMs narrow, but cannot close,
the subscribe gap without a server acknowledgement.

`@paged` keeps the shown page. `@connection` refreshes the loaded range: offset in one request up
to `live.maxRereadRows` (100, match the service maximum); keyset through returned cursors up to
`live.maxRereadPages` (10). Load-more serializes with refresh. Beyond the bound, a retained tail
may be stale: draw `QueryState.listRefreshTruncated` and health `list-refresh-truncated` honestly.
No server snapshot across keyset pages is promised. Without a delete preimage grant, the server
sends no DELETED event; only the next event or poll repairs the list. Do not promise immediate
delete visibility when polling is disabled. See docs/design.md, List streams (R3), for validation.

## Bounded read-all (R14)

`client.readAll(Query, variables, { limit, pageSize?, signal? })` returns `{ rows, total, truncated }`.
Use exactly one root `@connection`, a variable page input and select `Edges { Node { ...Row } }`
and `PageInfo { TotalCount }`. The positive integer limit is required; optional positive `pageSize` caps each request. Missing metadata or
an absent/null total throws; totals are never inferred. Rows are normalised and deduplicated
by opaque identity. Offset traversal advances by returned edge count; keyset traversal follows
`PageInfo.EndCursor` while `HasNextPage` is true. Empty continuing pages or repeated cursors
fail rather than loop. Pages have no shared snapshot: concurrent movement may omit rows.
`total` is the exact total returned by the last page, not a snapshot-wide guarantee.
Abort and identity disposal cancel traversal. This is a one-time read; watch a root for freshness.
