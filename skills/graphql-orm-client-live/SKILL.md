---
name: graphql-orm-client-live
description: Keep graphql-orm-client data live with @live fragments and generated Changed subscriptions, back off from refused streams, order writes by record version, use polling fallbacks and diagnose stale data.
---

# Live data and cache policy

Status: early alpha. Check the installed `docs/design.md` and `docs/graphql-orm-contract.md`.

## Making data live

- Mark a fragment `@live` when its fields should update while on screen. The live layer
  subscribes to the type's generated `<Entity>Changed` events for the records that are
  retained. Do not write subscription operations by hand for this.
- A `@live` fragment may select only persisted scalars of its type. A relation or computed field
  in any `@live` fragment makes the server refuse the type's whole stream, and the build doesn't
  catch it. Move those fields to a fragment without `@live`, and refresh them with a poll or a refetch.
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

- A subscription document of the application's own (not a `@live` fragment's) runs through
  `client.subscribe` or `useSubscription`, on the same `live.subscribe` transport. Its events are
  written into the store, but the client doesn't resubscribe for it: on
  `SUBSCRIPTION_CONTINUITY_LOST`, subscribe again and refetch.
- By default, a stream that ends (other than by lost events) starts again on the next change to the
  records it holds, so a router that refuses it sees a doomed subscribe on every list refresh. Turn
  on `live: { refusalBackoff: true }` (five minutes) or `{ ms, types: { Type: ms | false } }`: a stream
  the server refused (GraphQL errors answering the subscribe, or an error-only frame then `complete`,
  before any event) sends no request for the window and then subscribes again by itself.
  `SUBSCRIPTION_CONTINUITY_LOST` and `SUBSCRIPTION_SOURCE_CLOSED` still restart at once, and a
  transport failure is never remembered. The client doesn't refetch when the window ends, so keep a
  poll behind each backed-off type; give a type with no poll `false`. `client.live.status()` shows
  `backedOff`. Don't wrap `live.subscribe` to build this yourself.
- Paged tables (`usePagedQuery`) keep only the visible page live; changing page moves the
  subscription to the new page's rows.

## Cache policy

- `store.retainMs` is the only store option: how long released records stay.
- Per-type policy, `store.scope` and persistence are proposed, not built. Don't pass them.
- `Changed` fires on writes, not on clock expiry, and the store doesn't read lifetime fields yet.
  A record with a lifetime stays on screen after it lapses unless the component compares the field
  with the clock itself.

## Diagnosing stale data

1. Is the fragment marked `@live` and is the record retained?
2. Does the server emit `Changed` for that write? (Check that the write path goes through the
   ORM and that the relation propagates `up` if the change is on a child.)
3. Is an older poll result overwriting a newer event? That requires a record version.
4. Is the stream open? `client.live.status()` shows `held` and `subscriptions` per type. Records
   held with no subscription mean the stream was refused or ended. A stream that ended, other than by
   lost events, stays ended until the held records change, and nothing refetches.
5. Was the stream refused? Common causes: a relation or computed field in a `@live` fragment, or
   `NodeId` on a graphql-orm older than the release that admits it. `versions: { Type: null }` stops
   the compiler selecting a version field the stream refuses.
6. After a reconnect, did the application call `client.refetchActive()`? Missed events aren't
   replayed. After `SUBSCRIPTION_CONTINUITY_LOST`, the client resubscribes and refetches by itself; if
   that happens often, a bulk writer is outrunning the server's `event_channel_capacity`.
