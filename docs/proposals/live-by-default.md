# Live by default: design for requirement groups 1 and 2

Status: **proposed; the owner approved the direction on 2026-11-06. Built so far: the restart of ended
streams (fact 4), in 0.1.0-alpha.7; R20 and R7, in 0.1.0-alpha.8; R8 and R6, in 0.1.0-alpha.9. Group 1 is built.** Requirement numbers refer to [requirements.md](../requirements.md).
Unless noted, server facts were read from graphql-orm `main` at `9d1a482` and not run against a live
router; R21 is what will prove them. The large application's backend is on graphql-orm 0.90.1.

## Four facts that shape the design

1. **A stream is admitted or refused whole.** `validate_subscription_selection` refuses a `Changed`
   subscription if any selected entity field isn't a persisted, subscribable column, with the generic
   `INVALID_INPUT`. Today the compiler spreads `@live` fragments unchanged, so one relation or computed
   field in one fragment stops every fragment of that type. `NodeId` is refused too on 0.91.1.
2. **Nothing confirms a subscribe.** graphql-transport-ws has no per-operation acknowledgement, and
   `Changed` sends nothing until an event. A quiet admitted stream looks the same as an unanswered
   one, and a client can't know when it is safe to read after subscribing.
3. **Narrowed streams can't see list changes.** A stream with `Keys` drops events for other keys, so
   it can't report a new row or one moving into a filter. `DELETED` needs a preimage grant, which
   is off by default.
4. **Streams used to die quietly, up to 0.1.0-alpha.6.** After a schema reload, an exhausted socket or a
   plain `complete`, nothing resubscribed or read until the held records changed. Fixed in 0.1.0-alpha.7,
   and reproduced and tested against a real router 0.8.1 (built from the `graphql-orm-v0.90.1` tag). The
   router's default of 32 operations per connection is still below the client's default of 50 per-record
   streams in `key` mode.

## The model

An event does two things: it writes what it carries, and it marks stale what it can't carry.

```
event (type T, key, action)
  write the carried fields into the store, ordered by version
  mark an open query stale if
    it shows a list of T (membership, order and totals may have changed), or
    it holds this record and a fragment selects something the stream can't carry
  each stale query re-reads, coalesced and rate limited
```

So a stream is an optimisation over re-reading, as `AGENTS.md` requires, and correctness never
depends on knowing exactly which fields a stream carries. Knowing only saves reads. That means **R2
does not block on graphql-orm**, although it gets better with its help.

## Group 1: failures become visible and testable

Order: R20, R7, R8, R6. The test kit comes first because every later test uses it. The silent stream
death (fact 4) shipped first, in 0.1.0-alpha.7, ahead of the rest of R4, because it affects applications on
released versions.

### R20. Test kit (`graphql-orm-client/test`)

A new subpath, not in the main bundle and with no test-runner dependency:

- `createMockNetwork({ schema?, operations })`, keyed by operation name, validating each request when
  given a schema;
- `createMockStreams()`, with `emit`, `refuse(code)`, `loseContinuity()`, `end()`, `reload()` and
  `reconnect()` on the real frame shapes, including an error delivered as `next` then `complete`;
- `createTestClock()`, which fills the existing timer seams.

The client's own tests run on it, so it can't drift from what they exercise. **Built in 0.1.0-alpha.8.**

### R7. Live status

**Built in 0.1.0-alpha.8;** [design.md](../design.md#live-health) describes what shipped.
`client.live.status()` keeps its shape, so nothing breaks. Added alongside it:

```ts
type LiveState = "live" | "unconfirmed" | "connecting" | "polling" | "refused" | "unavailable" | "idle"

interface LiveTypeHealth {
  state: LiveState
  reason: LiveReason | null  // no-stream, no-live-layer, selection-refused, refused, over-cap,
                             // socket-down, stream-ended, schema-reload
  code: string | null        // the server's extensions.code, when it gave one
  held: number
  pollMs: number | null      // the poll behind it now; null means nothing refreshes these records
  lastEventAt: number | null // null is "never", not zero
  lastReadAt: number | null
  retryAt: number | null
  fragments: readonly string[]
}

client.liveHealth(): { socket: "connected" | "connecting" | "closed" | "unknown"; worst: LiveState; types: ... }
client.subscribeLiveHealth(listener)
useLiveHealth(typename?)     // graphql-orm-client/react
```

- **Two states more than R7 lists.** `unconfirmed` means sent, not refused, no event yet, which is all
  fact 2 lets us say; drawing it as `live` would draw unknown as healthy. It becomes `live` on the first
  event, or at once if the server gains a started signal. `idle` means nothing is held.
- **`socket` is `unknown`** unless the transport reports it. A new `graphqlWsTransport(ws)` returns
  `{ subscribe, connection }`. `graphqlWsSubscribe` stays.
- **It works with no live layer.** `client.live` is null then, so these live on `Client`, and report
  `unavailable` with reason `no-live-layer`.
- **Types with no stream are learned at run time.** `liveUnavailable` is a generated export the client
  never receives. The query knows when it holds a `@live` record no stream covers, so no regeneration
  is needed.
- **Development warning.** `live.onDiagnostic`, by default `console.warn` outside production, once per
  fragment and reason, naming the fragment.

### R8. `graphql-orm-client doctor --url <router>`

**Built in 0.1.0-alpha.9.** Also added: `--json`, and `unknown` fails the run, because a stream that couldn't be
tested mustn't pass.

Credentials come from named environment variables, never arguments. It uses only introspection and
subscriptions, and one code path refuses any other operation, with a test.

1. Introspect the served schema and validate every compiled document against it.
2. Open each live operation with `Keys: []` where possible, which admission checks and which matches no
   rows, for `--stream-ms` (default 3000).
3. Print `admitted`, `not-refused`, `refused <code>`, `missing` or `invalid`, for the identity used.

`not-refused` is a separate word because of fact 2. Exit is non-zero for refused, missing or invalid.
`--strict` adds `not-refused`. A type that can't be tested reports `unknown`, never `ok`. It speaks
graphql-transport-ws itself, so it needs no new dependency.

### R6. Back-off on by default

**Built in 0.1.0-alpha.9.** `refusalBackoff` defaults to on, and `false` restores the behaviour before it. What changes:

- A refusal excludes `SUBSCRIPTION_SCHEMA_RELOAD`, `SERVICE_UNAVAILABLE` and `SUBGRAPH_UNAVAILABLE`,
  which are outages and take the restart path in R4. Code lists stay this short: anything else that
  answers a subscribe with errors is a refusal, as now.
- Windows get ±20% jitter.
- A refused type's holders poll (`polling.liveFallbackMs`, 30 s). Today the fallback only looks at
  coverage and overflow, so the layer needs to tell queries when this changes. With the fallback off,
  health shows `refused` and `pollMs: null`.
- When a window ends and the subscribe isn't refused, holders re-read, because events were missed.

## Group 2: what makes the default safe

Order: R4, R2, R3, R1.

### R4. No lost events

- **Replacing a stream.** Start the new one, then stop the old, as graphql-orm documents. Duplicates
  are dropped by version; without a version the same snapshot is written twice, which is harmless.
- **Chunks stop shifting.** Keys are sliced after sorting today, so one new key restarts every later
  chunk. Keys get a stable chunk until it is released.
- **Newly covered keys are re-read,** since events before the subscribe aren't replayed.
- **First read.** A type shown in a list has its stream (R3) opened before the read. Other roots can't
  know their keys first, so the order is read, subscribe, then one confirming re-read after
  `live.settleMs` (250 ms). Because of fact 2 this narrows the gap and doesn't close it against a real
  server. Tests can prove the ordering; only a started signal can prove no gap.
- **Any end we didn't ask for restarts,** with jittered exponential delay (1 s to 60 s), then re-reads.
  A reload also asks the transport for a fresh connection, because a retired connection answers
  `SERVICE_UNAVAILABLE` to new subscribes.
- **Reconnect** re-reads through the transport's `connection`, so applications stop wiring
  `client.refetchActive()`. One that still does causes no extra request, since `fetch` joins a read in
  flight.
- **A read in flight can't absorb a stale mark.** Today `fetch` returns the one in flight, which may
  predate the event. The mark must trigger another read afterwards.

### R2. What goes in a stream

The compiler stops spreading fragments and builds the selection:

| Selected in a fragment | In the stream | Keeps it current |
| --- | --- | --- |
| Key fields | Always, flattened | |
| `NodeId` | Never. The store's id is encoded from the key fields, checked against shared vectors | |
| `RecordVersion` | When carried | |
| Relation or other composite field | Never: the rule is visible in the schema's shape | Re-read, which also catches a changed link. Its own type's stream keeps the related record current |
| Scalar with arguments | Never | Re-read |
| Other scalar | See below | |

Without a server marker a scalar can't be classified, so each type compiles to two selections:
**full** (keys, version and scalars) and **thin** (keys only). The client tries full. If the server
refuses it with `INVALID_INPUT`, or a future dedicated code, it uses thin for the life of the client, and
health shows `selection-refused`. Every event then means a re-read. This costs one doomed subscribe per
type per client and never guesses: the server decides. `doctor` reports which types fall back, so a team
can see and fix them. A marker removes the fallback and tells the compiler up front.

Also fixed here: composite keys come from `<Type>KeyInput`, so a composite type needs no `keys`
configuration, and `key` mode reads key fields from the stored record, not by decoding the `NodeId`.

### R3. Lists stay correct

- `OperationArtifact` gains `lists: string[]`, the types the operation shows in a list.
- **At most one stream per type.** A type with a list open uses one stream not narrowed by key, and
  drops events for rows nobody holds. Otherwise it uses `Keys`. Two per type would run into the
  router's 32 operations per connection. An un-narrowed stream costs the server a row-policy check per
  event per subscriber, so `live.listStreams: false` opts out and lists then poll.
- **Re-reads** run once at the start of a burst and once at the end, at most every
  `live.minRereadMs` (default 2000) per query. 100 events in a second is two reads. They pause while
  `polling.isActive()` is false, and run once on return.
- **`@paged`** re-reads the shown page. **`@connection`** re-reads what is loaded: offset in one request
  up to the server's maximum, keyset page by page up to a limit. Past the limit it keeps the loaded tail
  and says so in `QueryState`, because silently shortening or reordering would be worse.
- Records keep their identity, so selection and virtualised scroll position survive.
- **Deletes.** With a preimage grant, `DELETED` removes the record. Without one, the list corrects on the
  next event or poll, and that limit is documented. Fixing it needs the server.

### R1. Live by default

A generator setting: `"live": "explicit" | "default" | { "default": ["src/area/**"] }`, the last for moving
one area at a time. With `default`, a fragment on an object type with a usable stream is live unless it
says `@live(enabled: false)`. A type with no stream is reported and polls, and health says so. Under
`default`, `@live` on such a type becomes an error once R5 lands. The setting goes away at 1.0.

## Settings and migration

Everything is controlled by a setting or by regenerating, and the large application stays on its pinned
alpha.5 archive until it chooses to move.

| Change | Setting | Restores the old behaviour | Comes with |
| --- | --- | --- | --- |
| Ended streams restart and re-read (built) | `live.restart` | `false` | Client upgrade |
| Back-off by default (built) | `live.refusalBackoff` | `false` | Client upgrade |
| Refused types poll (built) | `polling.liveFallbackMs` | `null` | Client upgrade |
| Compiled stream selection | `liveSelection` in the generator | `"as-written"` | Regeneration |
| List re-reads | `live.listStreams` | `false` until `live` is `default` | Regeneration: older artifacts have no `lists` |
| Live by default | `live` in the generator | `"explicit"` | Regeneration |

Each gets changelog steps. The generator warns about a stream selection the new rules would have
excluded, so a team sees what will change first.

## Tests

Every store or live-layer change gets tests for ordering, version conflicts, identity disposal, garbage
collection and reconnect. Added scenarios: writes during a key-set change and a first read; a burst of 100
events; a read in flight when an event arrives; reload, reconnect and exhausted-socket recovery; a refused
full selection falling back to thin; and the R1 acceptance test end to end through the test kit.

## What this needs from graphql-orm

In order. All opt-in, through its normal process.

1. **Say what a stream can carry, in the schema.** Today nothing does: the SDL shows `Widget` the same either way, and the semantic catalogue has `selectable` and
   `relationship` but nothing for streams. Only the macro's `subscription_field_policy` knows.
   - **Recommended: a typed snapshot on the event.** `WidgetChangedEvent { Snapshot: WidgetSnapshot }`,
     where `WidgetSnapshot` has exactly the fields the payload admits. It is ordinary schema, so it survives
     introspection, router composition and every schema pull, and GraphQL validation checks the compiler's
     selection at build time. Computed, federated, `subscribe = false` and private fields are absent by
     construction. Cost: one more type per entity in the SDL, so opt-in per `schema_roots!`.
   - **Rejected: a field directive.** Applied directives aren't in introspection, so a pulled schema loses
     them, and each needs `@composeDirective` to survive composition.
   - **Fallback: a `subscribable` flag on `GraphqlSemanticFieldMetadata`.** Cheap, but separate from the
     SDL, per subgraph and not served by the router, so every team has another file to keep in step.
   - **Unknown:** whether the router admits a federated field on a stream by planning an entity fetch per
     event. R21 should settle it. The snapshot makes it moot.
2. **Merge PR #312** (`NodeId` and `RecordVersion` on relation-bearing entities). In flight. Without it
   those entities have neither, whatever the client does.
3. **A stream-started signal.** An opt-in first frame after authorization, as `CacheSync::changes` sends.
   It is the only thing that closes the first-read gap and makes `live` provable for a quiet stream.
4. **A dedicated code for an unsupported selection,** so `INVALID_INPUT` needn't stand for it.
5. **A key-only delete signal** that needs no preimage (see #217), and #290 for child deletes.
6. Already listed in the contract: effective page size, and one time format.

## Decisions from the owner (2026-11-06)

- **R1:** accepted: live by default with an opt-out, behind `live`, once R2, R3, R4 and R6 hold. Check with
  the owner before turning it on.
- **R5:** accepted: build errors by default for `@live` on a type with no stream and for polls with no
  reason, with query ownership as per-project globs.
- **R19:** one socket and store per window for now. R22 measures the cost, including pop-out tool windows.
- **R7:** `unconfirmed` and `idle` are added.
- **`Snapshot`** is a request to graphql-orm and blocks nothing here.
- **graphql-orm PR #312** is the owner's decision; the client doesn't wait for it.
