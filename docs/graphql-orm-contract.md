# graphql-orm contract

What the client needs from graphql-orm and its router, and where each item stands. Every
addition to graphql-orm is opt-in and ships through graphql-orm's normal release process. The
client never works around a missing item by guessing.

Status as of 2026-10-30, against graphql-orm `main`.

| Need | Why the client needs it | Status |
| --- | --- | --- |
| Complete key on every entity | The store's `NodeId` is built from it | Exists. Every generated entity has a primary key, possibly composite |
| `federation_key` on every routed entity | Records can be looked up by key across subgraphs; basis for `node` | Exists, opt-in per entity |
| Global `NodeId` and a router `node(NodeId)` lookup | Refetch one fragment; one identity across subgraphs | Proposed in graphql-orm #260: a generated `NodeId` field and `@key(fields: "NodeId")` per entity, plus a built-in router `Node` subgraph with `node`/`nodes`. Encoding: opaque base64url of `[typename, ...keyParts]`; no hand-written `NodeId` fields in services |
| Record version | Drop an older poll result that arrives after a newer event | Bare `#[graphql_orm(version)]` is compare-and-swap only, so ordinary writes don't advance it. Managed versions (`version = "managed"`, advanced by every generated write) and an optional `ExpectedVersion` are in progress (graphql-orm #259). Planned: expose the version to clients under one name |
| `<Entity>Changed` subscriptions carrying the entity | Write changes into the store without a refetch | Exists for write-capable entities. Filters: `Actions` and one exact key |
| `Changed` for a list of keys | One subscription per type, not one per record | Proposed in graphql-orm #261: a bounded `Keys` argument, default maximum 500. Continuity after resubscribing is #225 |
| Upward change propagation | Parent views update when a child changes | Exists, opt-in per relation: `propagate_change = "up"`. Cross-crate propagation is in progress (#249) |
| Sequence numbers and replay | Recover missed events after a reconnect without refetching everything | Planned |
| One connection shape | Generic pagination | Planned. Offset connections and keyset lists both exist today; the client supports both until they are unified |
| Persisted operations | Smaller requests; an allow-list of compiled operations at the router | Planned. The operation catalogue exists |
| Shareable shared objects | Two subgraphs must compose | `PageInfo` is shareable. The aggregate result objects are fixed in 0.81.2 |
| Lifetime metadata in the schema | The compiler can configure expiry without hand-written policy | Planned |
| Volatile entity sources | In-memory server state (connection, heartbeat) through the generated entity, policy and `Changed` surface | Planned; tracked in graphql-orm #223 |

## Rules for services

These go in each service, not in graphql-orm or the client:

- Write live state only through the ORM's write paths. Writes made around the ORM emit no
  `Changed`, and the client must keep polling that state.
- Compose roots with `schema_roots!`, so no generated root is left out.
- Keep `Id` values stable. The `NodeId` is built on them.
- Add `#[graphql_orm(version)]` to rows that are rewritten in place while users watch them.
- Set `propagate_change = "up"` on relations whose parent views show child state.
- Do not add hand-written `NodeId` fields, `node` resolvers or replacement subscriptions.
  Report the gap to graphql-orm instead.
