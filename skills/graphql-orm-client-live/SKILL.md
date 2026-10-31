---
name: graphql-orm-client-live
description: Keep graphql-orm-client data live with generated Changed subscriptions, per-type cache policy, record versions, expiry and polling fallbacks.
---

# Live data and cache policy

Status: design stage. Check the installed `docs/design.md` and `docs/graphql-orm-contract.md`.

## Making data live

- Mark a fragment `@live` when its fields should update while on screen. The live layer
  subscribes to the type's generated `<Entity>Changed` events for the records that are
  retained. Do not write subscription operations by hand for this.
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

## Cache policy

- Configure per type in `store.types`: `staleMs` for background refresh, `expiresField` for
  records with a lifetime. `Changed` fires on writes, not on clock expiry, so expiring records
  need `expiresField` or they stay on screen after they lapse.
- Keep `store.scope` set to the signed-in identity. Never persist across scopes.
- Use persistence (IndexedDB) only when offline start is a requirement.

## Diagnosing stale data

1. Is the fragment marked `@live` and is the record retained?
2. Does the server emit `Changed` for that write? (Check that the write path goes through the
   ORM and that the relation propagates `up` if the change is on a child.)
3. Is an older poll result overwriting a newer event? That requires a record version.
4. After a reconnect, did the client replay or refetch? After `SUBSCRIPTION_CONTINUITY_LOST`, the
   client resubscribes and refetches by itself; if that happens often, a bulk writer is
   outrunning the server's `event_channel_capacity`.
