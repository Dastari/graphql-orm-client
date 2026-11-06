# graphql-orm contract

What the client needs from graphql-orm and its router, and where each item stands. Every
addition to graphql-orm is opt-in and ships through graphql-orm's normal release process. The
client never works around a missing item by guessing.

Status checked 2026-11-06 against `main` at `9d1a482` (graphql-orm 0.91.1, graphql-orm-router
0.8.1; latest workspace release `workspace-2026.11.05.1`). The router, the `Changed` stream code and the
entity macro are the same at `graphql-orm-v0.90.1`, so what this table says about streams holds for 0.90.1
too. Findings come from reading source unless a row says it was run. "Proposed" means not yet filed or
agreed with graphql-orm.

| Need | Why the client needs it | Status |
| --- | --- | --- |
| Complete key on every entity | The store's `NodeId` is built from it | Exists. Every generated entity has a primary key, possibly composite |
| `federation_key` on every routed entity | Records can be looked up by key across subgraphs; basis for `node` | Exists, opt-in per entity |
| Global `NodeId` and a router `node(NodeId)` lookup | Refetch one fragment (`@refetchable`); one identity across subgraphs | Released in graphql-orm 0.86.0 and graphql-orm-router 0.8.0 (#260): `#[graphql_entity(node_id)]` generates `NodeId: ID!` and `@key(fields: "NodeId")`; the router hosts `interface Node`, `node(NodeId)` and `nodes(NodeIds)` (default bound 100). Encoding: base64url of `[typename, ...keyParts]`, checked against graphql-orm's shared vectors. Where `NodeId` exists the client stores records under it, so composite and non-`Id` keys need no `keys` configuration; no hand-written `NodeId` fields in services. **Gaps:** an entity with relations can't declare `node_id` (#270), and a `Changed` payload can't select `NodeId`, because it has no column. New stream projections omit it and encode identity from key fields. Legacy `as-written` projections still select it and are refused. PR #312 fixes both and is open |
| Record version | Drop an older poll result that arrives after a newer event | Bare `#[graphql_orm(version)]` is compare-and-swap only, so ordinary writes don't advance it. Managed versions (`version = "managed"`, advanced by every generated write) and an optional `ExpectedVersion` are released in graphql-orm 0.84.0 (#259). graphql-orm 0.87.0 (#264) also serves a managed version as `RecordVersion: Int!`, with the declared field's read policy; the client selects it and orders by it with no configuration. **Gap:** entities with relations don't get it (#288, PR #312). In both 0.90.1 and main `9d1a482`, generated `RecordVersion` maps to the persisted managed column and its subscription policy before validation. A hand-written `RecordVersion` is computed and refused; the SDL does not show the difference |
| `<Entity>Changed` subscriptions carrying the entity | Write changes into the store without a refetch | Exists for write-capable entities. Filters: `Actions`, one exact `Key`, or a bounded `Keys`. A stream narrowed by key sees nothing about other rows, so it can't report a new row. Payloads carry persisted, subscribable scalars only: selecting a relation or computed field refuses the whole stream with `INVALID_INPUT` |
| `Changed` for a list of keys | One subscription per type, not one per record | Released in graphql-orm 0.85.0 (#261): a bounded `Keys` argument, default maximum 500. The client uses it automatically |
| Continuity signal | Know when a subscriber missed events, so it can refetch | Released in graphql-orm 0.88.0 (#225): a stream that falls behind ends with `SUBSCRIPTION_CONTINUITY_LOST`, a closed channel with `SUBSCRIPTION_SOURCE_CLOSED` (a `next` frame with the error, then `complete`). The client subscribes again, then refetches the roots showing that type |
| Upward change propagation | Parent views update when a child changes | Exists, opt-in per relation: `propagate_change = "up"`. Cross-crate propagation is open (#249). Deleting a child doesn't notify its parent (#290) |
| Which fields a stream can carry | The compiler keeps other fields out of the stream (R2) | Missing. Neither the SDL nor the semantic catalogue says which fields a `Changed` payload admits; only the macro's `subscription_field_policy` knows. Proposed: a typed snapshot on the event; see [the live design](proposals/live-by-default.md#what-this-needs-from-graphql-orm). Requested: [#340](https://github.com/Dastari/graphql-orm/issues/340). The client works without it: full refusal switches to keys-only thin, with holder re-reads. A stream event identifies its record by key fields, and the served schema doesn't give their order: introspection through router 0.8.1 at `graphql-orm-v0.90.1` lists `SlotKeyInput` as `Name, Site` while `NodeId` encodes `Site, Name`. The client finds the order by exact match against a record's `NodeId` |
| Connection operation budget during overlap | Replacement needs temporary capacity for both generations | Router 0.8.1 at `graphql-orm-v0.90.1` counts operation ids in its connection's `operations` set before forwarding a subscribe; the default is 32. `SUBSCRIPTION_LIMIT_EXCEEDED` rejects only the new operation. The client retains baseline coverage, uses ordinary restart back-off and polls newly uncovered records until room is available. This is a capacity failure, not a five-minute selection refusal |
| Stream-started signal | A client can't tell a quiet admitted stream from one that hasn't been answered, or know when it is safe to read after subscribing (R4, R7) | Missing. graphql-transport-ws has no per-subscribe acknowledgement and `Changed` sends nothing until an event. `CacheSync::changes` has the pattern: an initial signal after authorization. Proposed. Requested: [#341](https://github.com/Dastari/graphql-orm/issues/341) |
| Stable refusal code for a stream | Tell an unsupported selection from a denial or an outage (R6, R8) | Partly. An unsupported selection is the generic `INVALID_INPUT`. Proposed: a code of its own. Requested: [#342](https://github.com/Dastari/graphql-orm/issues/342) |
| `DELETED` reaches subscribers | Lists and records drop a deleted row (R3, R16) | Off by default: needs `RowPolicy::can_read_deleted_preimage`. Without it a row deleted elsewhere sends subscribers nothing. Proposed: a key-only signal with no preimage (see #217) |
| Graph replacement signal | Streams end when the router replaces its schema | Exists, run against router 0.8.1: an `error` frame with `SUBSCRIPTION_SCHEMA_RELOAD`, then `complete`, and the retired connection answers new subscribes with `SERVICE_UNAVAILABLE`. The client restarts, on a fresh connection, and re-reads (0.1.0-alpha.7). **Asked of the router ([#339](https://github.com/Dastari/graphql-orm/issues/339)):** `complete` after `error` breaks the protocol. In headless Chromium it's harmless. On Node, `ws` delivers both frames in one tick, and graphql-ws then releases the operation twice |
| Sequence numbers and replay | Recover missed events after a reconnect without refetching everything | Not planned by graphql-orm that we can find: generated events are process-local, delivered at most once and never replayed. The client refetches instead |
| One connection shape | Generic pagination | Planned. Offset connections and keyset lists both exist today; the client supports both until they are unified (`@connection` on either, `@paged` on offset connections) |
| Effective page size in `PageInfo` | `@paged` computes `pageCount` from the page size it asked for | Missing. graphql-orm clamps an explicit `Limit` to `PaginationConfig::DEFAULT_MAX_LIMIT` (100) and a missing one to 50, but `PageInfo` reports neither the limit nor the offset it applied. A page size above the maximum gives a short page and a wrong page count, and the client can't tell. Needed: `PageInfo` fields for the applied `Limit` and `Offset`, or an error for a `Limit` above the maximum. Until then, keep page sizes within the server's maximum |
| Persisted operations | Smaller requests; an allow-list of compiled operations at the router | Planned. The operation catalogue exists |
| Shareable shared objects | Two subgraphs must compose | `PageInfo` is shareable. The aggregate result objects are fixed in 0.81.2 |
| Lifetime metadata in the schema | The compiler can configure expiry without hand-written policy | Planned |
| In-memory server state | Connection and liveness changes reach the client as `Changed` | Not needed as an ORM feature for now: a service persists state *transitions* (connected, delayed, offline), not heartbeats, so the generated `Changed` covers them. A field overlay for exact in-memory values may follow if a consumer needs it (#223) |

## Rules for services

These go in each service, not in graphql-orm or the client:

- Write live state only through the ORM's write paths. Writes made around the ORM emit no
  `Changed`, and the client must keep polling that state.
- Compose roots with `schema_roots!`, so no generated root is left out.
- Keep `Id` values stable. The `NodeId` is built on them.
- Add `#[graphql_orm(version = "managed")]` to rows that are rewritten in place while users watch
  them. A bare `version` is compare-and-swap only, and ordinary writes don't advance it.
- Set `propagate_change = "up"` on relations whose parent views show child state.
- Do not add hand-written `NodeId` fields, `node` resolvers or replacement subscriptions.
  Report the gap to graphql-orm instead.

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
