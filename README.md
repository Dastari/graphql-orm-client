# graphql-orm-client

A GraphQL client for APIs served by [graphql-orm](https://github.com/Dastari/graphql-orm) and
its federation router. Each component declares the fields it needs as a fragment. A build
step combines those fragments into one query per route, and a normalised store keeps each
record once. Generated `Changed` subscriptions update the store while the records are on
screen.

> **Status: early alpha.** The compiler, the normalised store, the React bindings and the live
> layer, cursor pagination, optimistic mutations, polling and the generator with TypeScript types
> all work and are tested. It has not yet run in a production application, and APIs may still
> change. See the [roadmap](docs/roadmap.md).

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

## Generate

Write documents with `graphql(...)` in your source files, one operation or fragment per call,
then generate a typed module:

`graphql-orm-client.config.json`:

```json
{
  "schema": "schema/router.graphql",
  "documents": ["src"],
  "out": "src/graphql/generated.ts",
  "scalars": { "DateTime": "string", "UUID": "string", "JSON": "unknown" },
  "keys": { "Slot": ["Site", "Name"] },
  "versions": { "Ticket": "RowVersion" }
}
```

```sh
pnpm exec graphql-orm-client generate          # write the module
pnpm exec graphql-orm-client generate --check  # fail when it is out of date (CI)
```

Import `graphql` from the generated module. Each call returns a typed artifact:

- for an operation, typed data and variables;
- for a fragment, the fragment's own data.

A query's data shows child fragments as references. `readFragment`, `useFragment` and
`useFragmentList` open those references, and only for the fragment that produced them. The
module also exports `live`, to pass to `createClient({ live: { artifacts: live, subscribe } })`,
and `liveUnavailable`, which lists the types that have no usable `Changed` subscription.

Connect the client to the router with the built-in transport. Pass `live` only when the
router serves subscriptions:

```ts
import { createClient as createWsClient } from "graphql-ws"
import { createClient, createHttpNetwork, graphqlWsSubscribe, type Client } from "graphql-orm-client"
import { live } from "./generated/graphql-orm"

let client: Client
const ws = createWsClient({
  url: "wss://graph.example.com/graphql",
  // Missed events aren't replayed yet, so read open queries again after a reconnect.
  on: { connected: (_socket, _payload, wasRetry) => void (wasRetry && client.refetchActive()) },
})
client = createClient({
  network: createHttpNetwork({ url: "/api/graphql" }),
  live: { artifacts: live, subscribe: graphqlWsSubscribe(ws) },
})
```

`createHttpNetwork` takes `headers` (an object or a function called per request), `fetch` and
`credentials`. A response with GraphQL errors is returned whatever its HTTP status; one without
a GraphQL body throws `HttpError`. Commit mutations with `client.mutate`, or `useMutation` in
React.

A fragment marked `@refetchable` can read its record again on its own, through the router's
`node(NodeId)` lookup: `useRefetchableFragment(Fragment, ref)` or
`client.refetchFragment(Fragment, ref)`. Its type must implement `Node`.

The schema may be router or subgraph SDL; federation directives are accepted.

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
