# graphql-orm-client

A GraphQL client for APIs served by [graphql-orm](https://github.com/Dastari/graphql-orm) and
its federation router. Each component declares the fields it needs as a fragment. A build
step combines those fragments into one query per route, and a normalised store keeps each
record once. Generated `Changed` subscriptions update the store while the records are on
screen.

> **Status: early alpha.** The compiler, the normalised store and the React bindings work and
> are tested. The live layer, pagination helpers, optimistic updates and the codegen preset are
> not built yet, and APIs may still change. See the [roadmap](docs/roadmap.md).

## Why not Apollo or Relay

- **Apollo** guesses identity and pagination per type (`dataIdFromObject`, `typePolicies`),
  treats subscriptions as separate operations, and lets any component read any cached field.
- **Relay** has the right model: colocated fragments, compiled root queries, data masking and
  a normalised store. But it expects its own schema conventions (`id`, `edges`, `node`,
  `pageInfo`) and has no notion of graphql-orm's change events, keyset lists or `Where`
  filters.

graphql-orm generates the schema, so the client can rely on server guarantees instead of
configuration: stable keys, uniform connections, typed change events and an operation
catalogue. This client is built on those guarantees.

## How it works

| Stage | What happens |
| --- | --- |
| Component | Declares a fragment on the type it renders and reads it with `useFragment`. It only sees the fields it asked for (data masking). |
| Route root | Owns one query that spreads its children's fragments. A route loader can prefetch it before rendering, so there is no request waterfall. |
| Compiler | A graphql-codegen preset turns every root into a flattened query, a persisted-operation hash, a normalisation map, per-fragment readers and, for fragments marked `@live`, a subscription document. |
| Store | Keeps records by `NodeId` (type name plus complete key), orders writes by record version, retains by reference count and applies per-type cache policy. |
| Live layer | Subscribes to the generated `Changed` events for the records the store currently holds and writes each event's entity into the store. Polling is a fallback after a reconnect gap or for state that emits no events. |

Read [the design](docs/design.md) for the full model and [the graphql-orm
contract](docs/graphql-orm-contract.md) for what the server must provide.

## For agents

Start with [`AGENTS.md`](AGENTS.md) and [`llms.txt`](llms.txt). Install the bundled skills into a
consuming project with:

```sh
pnpm exec graphql-orm-client skills list
pnpm exec graphql-orm-client skills install --target claude   # or agents / codex
```

| Skill | Task |
| --- | --- |
| `graphql-orm-client-adopt` | Install the client, configure the network, store and identity scope, and wire a router |
| `graphql-orm-client-data` | Write fragments, route roots, pagination, refetching and mutations |
| `graphql-orm-client-live` | Live updates, cache policy, expiry and polling fallbacks |
| `graphql-orm-client-server` | What a graphql-orm service must declare so the client works (for backend agents) |

## Licence

MIT
