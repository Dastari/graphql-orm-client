---
name: graphql-orm-client-server
description: Model a graphql-orm service so graphql-orm-client can normalise, page and live-update its data. For backend agents changing entities, relations, roots or write paths.
---

# Serving graphql-orm-client

graphql-orm-client relies on server guarantees instead of client configuration. A backend
change that breaks one of these leaves the client with stale or duplicated data.

## Do

- Model data as graphql-orm entities and relations, and compose every root with
  `schema_roots!`. Hand-composed roots silently drop generated roots.
- Keep `Id` (the complete primary key) stable in format and meaning. The client's `NodeId` is
  the type name plus this key. Ids need only be unique within their type.
- Declare `federation_key` on every entity the router serves.
- Add a managed version (`#[graphql_orm(version = "managed")]`, i64, from graphql-orm 0.84.0)
  to rows that are rewritten in place while users watch them: sessions, outcomes, snapshots,
  tickets, state rows. A bare `#[graphql_orm(version)]` is compare-and-swap only.
- Add `node_id` (`#[graphql_entity(node_id)]`, graphql-orm 0.86.0) to entities whose fragments
  should be refetchable on their own.
- Set `propagate_change = "up"` on relations whose parent views show child state.
- Write live state through the ORM's write paths (generated mutations, repository writes,
  transaction writes). Only those emit `Changed`.
- Treat lifetime fields (`expires_at`, `valid_until`) as data. Expiry emits no event.

## Do not

- Add hand-written `NodeId` fields, `node` resolvers, signal subscriptions (`…Updated: Event!`)
  or multi-key subscriptions. graphql-orm generates these; report a gap there.
- Persist every heartbeat to produce events. Persist the state *transitions* a heartbeat
  sweep already decides (connected, delayed, offline) when they happen; steady state then
  writes nothing, and the generated `Changed` carries every transition.
- Reuse an entity's `Id` for a different record, or change its encoding without coordinating
  with the client's consumers.

Read the installed `docs/graphql-orm-contract.md` for the status of each guarantee.
