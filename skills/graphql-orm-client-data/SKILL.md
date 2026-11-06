---
name: graphql-orm-client-data
description: Write fragments, route queries, pagination and mutations with graphql-orm-client; declare sensitive operations, handle write certainty and partial path errors, configure full/thin live projections and bounded holder re-reads, and test with the mock network and scripted streams.
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

### Sensitive operations (R9)

Declare `@sensitive` on a query or mutation. Generation records `sensitive: true` and strips
the directive from the wire document. Results are plain values with fragment selections expanded;
they carry no fragment references and cannot be opened by `readFragment`. No store (including
a private store), retention or inspector receives the result. Existing matching entities remain
unchanged, just as with mutation `policy: "no-store"`. That older option still supports private
fragment reads. Sensitive queries use imperative `client.query`; watched queries and preload
reject them because those retain results. Sensitive mutations reject optimistic responses.
Live fragments anywhere in a sensitive operation, and operation-level `@live`, fail the build.
Persistence is proposed (R17); it must exclude these results. Callers own the returned values
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
Transport evidence of no send (`WriteNotSentError`) or cancellation before sending is failed.
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
