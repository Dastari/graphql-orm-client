---
name: graphql-orm-client-live
description: Keep data current on screen with graphql-orm-client, using @live fragments and generated Changed streams; draw live status (useLiveHealth); and diagnose stale data, refused streams and polling with the doctor. Use when data must update by itself or looks stale.
---

# Live data

Status: early alpha. Check the installed `docs/design.md` and `docs/graphql-orm-contract.md`.

## The default path

1. **Mark a fragment `@live` if it shows a record that can change while it's on screen.** If you aren't sure, mark it. Fields can include
   relations and computed fields. The compiler builds a stream that can carry them, and re-reads what it can't.
2. **Pass `live` to `createClient`:** `live: { artifacts: live, ...graphqlWsTransport(ws) }`, with `live` from the generated module and
   `ws` from graphql-ws. Don't write subscription operations, reconnect handling, restarts or refetches around a stream.
3. **Regenerate.** `@live` on a type with no usable `Changed` stream fails the build, naming the fragment. Remove `@live`, or declare
   `@poll(reason: "...")` if polling is the honest answer. A fragment on a type that has a stream and isn't live gets a warning, because it won't update: mark it `@live`, or
   `@live(enabled: false)` if that's meant. Don't leave the warning.
4. **Draw what it says.** `useLiveHealth(typename?)` tells you whether the data is being kept current, so a page can show "live updates
   unavailable". Unknown is never drawn as healthy: `unconfirmed` means no update yet, not that all is well.
5. **Run the doctor before a deploy** (below). What a router admits for an identity can't be known at build time.

With that, a record's fields update from events. A list of a live type also picks up new rows, removed rows, re-sorting and totals, in the
same order and with loaded pages kept. A count or generated aggregate of a live type does too.

## What keeps data current

- **Records:** an event writes what it carries, and the queries holding the record re-read what a stream can't carry, which also catches a
  changed relation link. Order is by record version. Without a version the last write to arrive wins: for a row rewritten while users watch
  it, ask the backend for a managed version (`#[graphql_orm(version = "managed")]`). The client then needs no configuration.
- **Lists:** a list of a live type opens one stream for the type before its first read, even when empty. It needs a regenerated module, and it
  costs the server a row-policy check per event per subscriber. `live.listStreams: false` makes lists poll instead.
  - `@paged` keeps its page. `@connection` reads what's loaded, `live.maxRereadRows` (100) rows per request: offset in one request, keyset
    in up to `live.maxRereadPages` (10). Set `maxRereadRows` to the service's maximum page size. Past the bound it keeps the loaded tail
    and sets `QueryState.listRefreshTruncated`: show that on screen, because those rows may be stale.
- **Rate limit:** automatic reads are limited per query by `live.minRereadMs` (2000): one at the start of a burst and one at the end, a read
  already running is followed by one more, and they wait while the page is hidden.
- **After a burst:** the router can drop frames under a burst with no signal (graphql-orm#359), so after at least 32 events on a type settle,
  the queries holding it read once more. That's one extra read per burst per query, coalesced across types. `live.burstRead` adjusts or turns it off.
- **First load:** a query reads once more after its records first gain a stream (`live.settleMs`, 250 ms), because nothing acknowledges a
  subscribe. This narrows the gap between read and subscribe, and can't close it. `settleMs: false` removes the extra read.
- **Ended streams** restart by themselves and re-read, whatever ended them, backing off to about once a minute. A reconnected socket
  re-reads as well.
- **Refused streams** wait about five minutes and poll meanwhile (`polling.liveFallbackMs`, 30 s), then work with no reload once the server
  accepts them. `live.refusalBackoff` changes this.

## Limits to design around

- **Deletes:** a direct delete reaches subscribers only if the host grants `RowPolicy::can_read_deleted_preimage`. Without it the server sends
  nothing, so a list corrects on its next event or poll. Don't promise instant deletes where nothing polls.
- `DELETED` removes the record, except with change kind `PROPAGATED`: a child went, the record stays, and its queries read again.
- A record can disappear under a mounted component: see "Deleted rows" in the data skill.
- A write made around the ORM (in-memory state, raw SQL) sends no event. Record the gap instead of adding a hand-written subscription.
- `Changed` fires on writes, not on clock expiry. For a lifetime field, see the data skill.
- For data that isn't an entity (progress, AI text, terminal output), use the [streams skill](../graphql-orm-client-streams/SKILL.md).

## Drawing status

`useLiveHealth(typename?)` or `client.liveHealth()`. Each type has a `state`:

| State | Meaning |
| --- | --- |
| `live` | An event has arrived on an open stream |
| `unconfirmed` | Open, with no event yet. A quiet stream looks the same as an unanswered one |
| `connecting` | Starting, or restarting |
| `polling` | No stream right now, and a poll keeps it fresh. `pollMs` says how often |
| `refused`, `unavailable` | Nothing keeps it fresh. `reason` and `code` say why |
| `idle` | Nothing held |

Each type also has `reason`, `code`, `lastEventAt`, `lastReadAt`, `retryAt`, `burstReads`, `lastBurstReadAt` and the `fragments` held. A null
time means it hasn't happened, not zero. The socket is `unknown` without `graphqlWsTransport`.

To measure, sample `liveHealth().reads` (sent requests by cause), `streams` (open managed subscriptions, not your own `client.subscribe` ones)
and `refusedStreams`. These are absent with no live layer.

A `@live` fragment that can't stay live warns once in development, naming it. `live: { onDiagnostic }` sends these elsewhere.

## Diagnosing stale data

Start with the doctor, which needs no code. Put the credential in an environment variable, then:

```sh
pnpm exec graphql-orm-client doctor --url https://router.example/graphql --token-env ROUTER_TOKEN
```

It checks every document against the served schema and opens each live stream for up to `--stream-ms` (3000), for that token's identity. It runs
introspection and subscriptions only. `--json` prints the report as JSON.

| Verdict | Meaning | Exit |
| --- | --- | --- |
| `admitted` | An event arrived | 0 |
| `not-refused` | No error and no event | 0; 1 with `--strict` |
| `fallback-admitted`, `fallback-not-refused` | The full selection was refused, and keys only works. Every event then means a re-read | 0; the second is 1 with `--strict` |
| `refused <code>` | The server said no | 1 |
| `missing` | The type has live fragments and no `Changed` subscription | 1 |
| `invalid` | The document no longer validates against the served schema | 1 |
| `unknown` | It couldn't be tested | 1 |

Then, in the running application:

1. Is the fragment live, and is the record on screen? Check `client.liveHealth()`: `state` and `reason` say what's wrong, and `fragments` what it affects.
2. Does the server send `Changed` for that write? It has to go through the ORM, and a change on a child needs `propagate_change = "up"`.
3. Is an older poll result overwriting a newer event? That needs a record version.
4. Reasons worth knowing:
   - `selection-refused`: the server refused the full selection, so this client uses keys only and re-reads on every event.
   - `over-cap`: too many streams. The router allows 32 operations per connection by default, and open streams stay while the rest poll.
   - `identity-mismatch`: a server `NodeId` doesn't match the key fields in any order, so no stream opens and the query polls.
   - `list-key-required`, `list-streams-disabled`: this list polls. `list-refresh-truncated`: its loaded tail may be stale.
5. `client.live.status()` has more per type: `held`, `subscriptions`, `restartAttempts`, and `lastEnd` for why a stream ended. A climbing
   `restartAttempts` usually means a custom `live.subscribe` isn't getting a fresh connection after a schema reload: use `graphqlWsTransport`.
6. Frequent `SUBSCRIPTION_CONTINUITY_LOST` means a bulk writer is outrunning the server's `event_channel_capacity`.

Test what happens when streams fail with `graphql-orm-client/test`: see Testing in the data skill.

## Settings

Each of these changes a default on purpose. Reach for them when you have a reason.

| Setting | Effect |
| --- | --- |
| `live: "default"` (generator) | Fragments on keyed object types are live with no directive. `@live(enabled: false)` opts one out. Opt-in, and `{ default: ["src/area/**"] }` limits it to fragments written in files matching those globs, not the files that spread them. The generator warns about a pattern that matches no fragment's file. Each newly live type costs one operation on a connection |
| `liveSelection: "as-written"` (generator) | Keeps the older stream text. On graphql-orm before 0.92.0 the server refuses it on an entity with `NodeId` |
| `strict` (generator) | `liveWithoutStream`, `pollWithoutReason`, `rawSubscriptions`, `queryOwnership` and `fragmentNotLive`, each `"error"`, `"warn"` or `"off"`. All default to `"error"` except `fragmentNotLive`, which warns |
| `queryOwners`, `subscriptionPaths` (generator) | Globs for where queries and raw subscriptions may be written. Off unless set |
| `live.maxKeyedSubscriptions` | Per-record streams in `key` mode (50). `0` means one stream per type in `key` and `keys` mode when the argument is optional, at a row-policy check per event per subscriber |
| `versions: { Type: null }` (generator) | Stops selecting a version field some users can't read |
| `live.restart: false`, `live.refusalBackoff: false` | Older behaviour, for migration. `restart: false` can leave data stale |

`pollMs` needs `query Name @poll(reason: "...") { ... }`. On a regenerated module an undeclared one throws where `process.env.NODE_ENV`
is set and isn't `production`, as in development and tests. Elsewhere, including a bundle that doesn't define it, it warns and still
polls. `polling.undeclared: "error"` throws everywhere, and `"warn"` or `"off"` relax it. Fallback polling needs no declaration.
