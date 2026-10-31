# graphql-orm contract

What the client needs from graphql-orm and its router, and where each item stands. Every
addition to graphql-orm is opt-in and ships through graphql-orm's normal release process. The
client never works around a missing item by guessing.

Status as of 2026-10-31: graphql-orm 0.86.0 and graphql-orm-router 0.8.0 are released
(workspace release `workspace-2026.10.30.4`).

| Need | Why the client needs it | Status |
| --- | --- | --- |
| Complete key on every entity | The store's `NodeId` is built from it | Exists. Every generated entity has a primary key, possibly composite |
| `federation_key` on every routed entity | Records can be looked up by key across subgraphs; basis for `node` | Exists, opt-in per entity |
| Global `NodeId` and a router `node(NodeId)` lookup | Refetch one fragment (`@refetchable`); one identity across subgraphs | Released in graphql-orm 0.86.0 and graphql-orm-router 0.8.0 (#260): `#[graphql_entity(node_id)]` generates `NodeId: ID!` and `@key(fields: "NodeId")`; the router hosts `interface Node`, `node(NodeId)` and `nodes(NodeIds)` (default bound 100). Encoding: base64url of `[typename, ...keyParts]`, checked against graphql-orm's shared vectors. Where `NodeId` exists the client stores records under it, so composite and non-`Id` keys need no `keys` configuration; no hand-written `NodeId` fields in services |
| Record version | Drop an older poll result that arrives after a newer event | Bare `#[graphql_orm(version)]` is compare-and-swap only, so ordinary writes don't advance it. Managed versions (`version = "managed"`, advanced by every generated write) and an optional `ExpectedVersion` are released in graphql-orm 0.84.0 (#259). graphql-orm 0.87.0 (#264) also serves a managed version as `RecordVersion: Int!`, with the declared field's read policy; the client selects it and orders by it with no configuration |
| `<Entity>Changed` subscriptions carrying the entity | Write changes into the store without a refetch | Exists for write-capable entities. Filters: `Actions` and one exact key |
| `Changed` for a list of keys | One subscription per type, not one per record | Released in graphql-orm 0.85.0 (#261): a bounded `Keys` argument, default maximum 500. The client uses it automatically. Continuity after resubscribing is #225 |
| Upward change propagation | Parent views update when a child changes | Exists, opt-in per relation: `propagate_change = "up"`. Cross-crate propagation is in progress (#249) |
| Sequence numbers and replay | Recover missed events after a reconnect without refetching everything | Planned |
| One connection shape | Generic pagination | Planned. Offset connections and keyset lists both exist today; the client supports both until they are unified |
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
- Add `#[graphql_orm(version)]` to rows that are rewritten in place while users watch them.
- Set `propagate_change = "up"` on relations whose parent views show child state.
- Do not add hand-written `NodeId` fields, `node` resolvers or replacement subscriptions.
  Report the gap to graphql-orm instead.
