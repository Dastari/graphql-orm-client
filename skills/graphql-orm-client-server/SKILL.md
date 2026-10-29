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
- Add `#[graphql_orm(version)]` (i64) to rows that are rewritten in place while users watch
  them: sessions, outcomes, snapshots, tickets, state rows.
- Set `propagate_change = "up"` on relations whose parent views show child state.
- Write live state through the ORM's write paths (generated mutations, repository writes,
  transaction writes). Only those emit `Changed`.
- Treat lifetime fields (`expires_at`, `valid_until`) as data. Expiry emits no event.

## Do not

- Add hand-written `NodeId` fields, `node` resolvers, signal subscriptions (`…Updated: Event!`)
  or multi-key subscriptions. These are planned in graphql-orm; report the need there.
- Persist heartbeat or connection state only to produce events. In-memory state waits for
  graphql-orm's volatile source (#223); until then the client polls it.
- Reuse an entity's `Id` for a different record, or change its encoding without coordinating
  with the client's consumers.

Read the installed `docs/graphql-orm-contract.md` for the status of each guarantee.
