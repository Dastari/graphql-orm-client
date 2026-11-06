---
name: graphql-orm-client-live
description: Use full/thin stream projections and bounded holder re-reads (minRereadMs); Keep graphql-orm-client data live with @live fragments and generated Changed subscriptions, overlap replacements and confirm first reads (settleMs), back off from refused streams, order writes by record version, use polling fallbacks, draw live status (useLiveHealth, liveHealth), check streams against a real router (doctor) and diagnose stale data.
---

# Live data and cache policy

Status: early alpha. Check the installed `docs/design.md` and `docs/graphql-orm-contract.md`.

## Making data live

- Mark a fragment `@live` when its fields should update while on screen. The live layer
  subscribes to the type's generated `<Entity>Changed` events for the records that are
  retained. Do not write subscription operations by hand for this.
- A `@live` fragment can include relations and computed fields. New generation flattens keys,
  version and scalars without arguments; it omits relations/composites, argument scalars and NodeId.
  Full refused with INVALID_INPUT switches to keys-only thin for this client. Health retains
  `selection-refused`; thin refusal uses normal back-off. Every thin event, and full events for
  holders selecting omitted fields, schedule re-reads, which catch changed relation links too.
- Automatic stale, reconnect and confirming reads share `live.minRereadMs` (default 2000): leading
  and trailing reads, following an in-flight read and paused while `polling.isActive()` is false.
  Missing versions remain last-arrival-wins. `liveSelection: "as-written"` preserves legacy stream
  text; old artifacts have no thin fallback. Doctor reports fallback separately; quiet thin is
  still uncertain and fails `--strict`.
- `@live` updates records already held. A new row, a removed row or a changed total needs a refetch
  (`refetchQueries`) or a poll.
- Live delivery needs the server to write that state through the ORM. If a type's state is
  written around the ORM (in-memory registries, raw SQL), no events arrive. Types with no usable
  `Changed` subscription are in the generated `liveUnavailable`. Queries showing them poll every
  `polling.liveFallbackMs` (default 30 s), and so do records beyond the per-record cap. Record
  the gap rather than adding a hand-written subscription.
- Without a record version, the last write to arrive wins. For a row that is rewritten while
  users watch it, ask the backend for a managed version (`#[graphql_orm(version = "managed")]`).
  The client then selects and orders by the generated `RecordVersion` with no configuration.
  When the version field has a read policy some users fail, or isn't available to
  subscriptions, set `versions: { Type: null }` so selecting it doesn't fail their reads.

- The first load reads, subscribes, then confirms with one more read after `live.settleMs` (default
  250 ms). Newly streamed records use the same confirming read; queries already covered do not.
  This adds a request per query on first load. Set `live: { settleMs: false }` to restore the previous
  request cost. There is no subscribe acknowledgement: the delay narrows the gap, it cannot close
  it against a real server. R3's list streams before reads are still proposed.
- Stream replacements overlap for the settle delay (250 ms with confirming reads disabled), keeping
  baseline coverage if the candidate fails. Keys keep stable chunks. Router capacity errors use
  ordinary restart back-off, never a five-minute refusal window. At full capacity replacements
  wait for room while old coverage stays and newly uncovered records use the polling fallback.

- A subscription document of the application's own (not a `@live` fragment's) runs through
  `client.subscribe` or `useSubscription`, on the same `live.subscribe` transport. Its events are
  written into the store, but the client doesn't resubscribe for it: on
  `SUBSCRIPTION_CONTINUITY_LOST`, subscribe again and refetch.
- A `@live` stream that ends without the client asking restarts by itself, for any reason: a schema
  reload, lost events, a failed socket, a plain `complete`, a refusal. The queries that show the type
  then read again. Repeated ends back off to about once a minute (`live: { restart: { minMs, maxMs } }`).
  Use `graphqlWsTransport(ws)`, spread into `live`: after a schema reload it closes the retired socket,
  which a stream needs to come back, and it reads open queries again after a socket recovers by itself. A
  custom `live.subscribe` must get a fresh connection after `SUBSCRIPTION_SCHEMA_RELOAD`. Don't write your own restart, reconnect or
  refetch around a stream. `live: { restart: false }` is the old behaviour, where an ended stream stays
  down until the held records change; it exists for migration and can leave data stale.
- To draw status, use `useLiveHealth(typename?)` or `client.liveHealth()`. Each type has a `state`: `live`,
  `unconfirmed`, `connecting`, `polling`, `refused`, `unavailable` or `idle`; plus `reason`, `code`, `pollMs`,
  `lastEventAt`, `lastReadAt`, `retryAt` and the `fragments` held. Draw `unconfirmed` as "no update yet", not
  as healthy: a stream with no event can't be told from one nobody answered. A null time means it hasn't
  happened. The socket is `unknown` without `graphqlWsTransport`.
- A `@live` fragment that can't stay live warns once in development, naming the fragment. Send these
  somewhere else with `live: { onDiagnostic }`; `null` turns them off.
- Lower down, `client.live.status()` shows `restarting`, `restartAttempts` and `lastEnd` (`reason`, `code`,
  `at`) per type.
- A stream the server refuses (GraphQL errors answering the subscribe, or an error-only frame then
  `complete`, before any event) waits five minutes before trying again, varying by 20%, with no setup. Queries
  holding it poll meanwhile (`polling.liveFallbackMs`, 30 s) and read when the window ends, and it starts
  working by itself once the server accepts it. `live: { refusalBackoff: { ms, types: { Type: ms | false } } }`
  changes the window, and `false` means the ordinary back-off instead, for a type or for all. A schema reload,
  lost events, `SERVICE_UNAVAILABLE`, `SUBGRAPH_UNAVAILABLE`, `SUBSCRIPTION_LIMIT_EXCEEDED` and a transport failure are never refusals. Don't
  wrap `live.subscribe` to build this.
- Paged tables (`usePagedQuery`) keep only the visible page live; changing page moves the
  subscription to the new page's rows.

- Test what happens when streams fail with `graphql-orm-client/test`: see the Testing section of the
  graphql-orm-client-data skill.

## Cache policy

- `store.retainMs` is the only store option: how long released records stay.
- Per-type policy, `store.scope` and persistence are proposed, not built. Don't pass them.
- `Changed` fires on writes, not on clock expiry, and the store doesn't read lifetime fields yet.
  A record with a lifetime stays on screen after it lapses unless the component compares the field
  with the clock itself.

## Diagnosing stale data

Start with the doctor, which needs no code. Put the credential in an environment variable, then:

```sh
pnpm exec graphql-orm-client doctor --url https://router.example/graphql --token-env ROUTER_TOKEN
```

It checks every document against the served schema and opens each live stream for up to `--stream-ms` (3000), for
that token's identity. It runs introspection and subscriptions only.

| Verdict | Meaning | Exit |
| --- | --- | --- |
| `admitted` | An event arrived | 0 |
| `not-refused` | No error and no event. A quiet stream looks the same as an unanswered one | 0; 1 with `--strict` |
| `refused <code>` | The server said no. Usually a relation or computed field in a `@live` fragment | 1 |
| `missing` | The type has `@live` fragments and no `Changed` subscription | 1 |
| `invalid` | The document no longer validates against the served schema | 1 |
| `unknown` | It couldn't be tested: a required `Key`, an outage, or a socket that failed | 1 |

`--json` prints the report as JSON. Exit 2 means bad usage. Then, in a running application:

1. Is the fragment marked `@live` and is the record retained?
2. Does the server emit `Changed` for that write? (Check that the write path goes through the
   ORM and that the relation propagates `up` if the change is on a child.)
3. Is an older poll result overwriting a newer event? That requires a record version.
4. What does `client.liveHealth()` say? `state` and `reason` say what's wrong, and `fragments` which
   fragments it affects. For detail, `client.live.status()` shows `held` and `subscriptions`, and
   `lastEnd.reason` says why a stream ended. With `restartAttempts` climbing and `reason: "unavailable"`,
   the socket is stuck on a retired graph: use `graphqlWsTransport`, or get a fresh connection in your own
   transport. With
   `restart: false`, an ended stream stays down until the held records change, and nothing refetches.
5. Was the stream refused? Common causes: a relation or computed field in a `@live` fragment, or
   `NodeId` on a graphql-orm older than the release that admits it. `versions: { Type: null }` stops
   the compiler selecting a version field the stream refuses.
6. When graphql-ws reconnects by itself, missed events aren't replayed and the stream doesn't end.
   `graphqlWsTransport` reads again then; with `graphqlWsSubscribe`, the application calls
   `client.refetchActive()` from the `connected` event. After
   `SUBSCRIPTION_CONTINUITY_LOST`, the client resubscribes and refetches by itself; if that happens
   often, a bulk writer is outrunning the server's `event_channel_capacity`.
