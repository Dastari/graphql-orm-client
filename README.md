# graphql-orm-client

A GraphQL client for APIs served by [graphql-orm](https://github.com/Dastari/graphql-orm) and its federation router. Each component declares the fields it
needs as a fragment, a build step combines those into one query per route, a normalised store keeps each record once, and generated `Changed` subscriptions
keep the data current while it's on screen. If that can't happen, the build fails or the running application can say so.

> **Status: early alpha.** Real applications use it, and APIs may still change. Pin an exact version and read the [changelog](CHANGELOG.md)'s migration
> steps when you move. Known limits are in [the requirements](docs/requirements.md).

## The default path

Install a [release archive](https://github.com/Dastari/graphql-orm-client/releases), pinned to one version, with `graphql` and, for live updates, `graphql-ws`.

**1. Point it at your router.** `graphql-orm-client.config.json`:

```json
{
  "schema": "schema/router.graphql",
  "documents": ["src"],
  "out": "src/graphql/generated.ts",
  "scalars": { "DateTime": "string", "UUID": "string", "JSON": "unknown" }
}
```

```sh
pnpm exec graphql-orm-client schema pull --url https://router.example/graphql --token-env TOKEN
pnpm exec graphql-orm-client generate          # after any document or schema change
pnpm exec graphql-orm-client generate --check  # in CI: fail when it's out of date
```

**2. Create one client per signed-in identity.** Dispose it when the identity changes.

```ts
import { createClient as createWsClient } from "graphql-ws"
import { createClient, createHttpNetwork, graphqlWsTransport } from "graphql-orm-client"
import { live } from "./graphql/generated"

const ws = createWsClient({ url: "wss://graph.example.com/graphql" })
export const client = createClient({
  network: createHttpNetwork({ url: "/api/graphql" }),
  live: { artifacts: live, ...graphqlWsTransport(ws) },
})
```

**3. Give each component its own fragment.** Mark it `@live` if the record can change while it's on screen. That's all it takes for its fields, and for lists and
counts of that type, to stay current.

```tsx
import type { FragmentRefs, LoadedQuery } from "graphql-orm-client"
import { useFragment, useLoadedQuery } from "graphql-orm-client/react"
import { graphql, type TicketsPageQuery } from "./graphql/generated"

const TicketRow = graphql(`fragment TicketRow on Ticket @live { Title State }`)
function Row({ ticket }: { ticket: FragmentRefs<"TicketRow"> }) {
  const { Title, State } = useFragment(TicketRow, ticket)
  return <li>{Title}: {State}</li>
}
```

**4. Own the request at the route.** One query spreads its children's fragments, and the route's loader starts it before mount.

```tsx
const TicketsPage = graphql(`
  query TicketsPage($Where: TicketWhereInput) {
    Tickets(Where: $Where) { Edges { Node { Id ...TicketRow } } }
  }
`)
// In the loader: return client.loadQuery(TicketsPage, { Where: where }, { signal })
function Page({ loaded }: { loaded: LoadedQuery<TicketsPageQuery> }) {
  const { data } = useLoadedQuery(loaded)
  return <ul>{data?.Tickets.Edges.map(({ Node }) => <Row key={Node.Id} ticket={Node} />)}</ul>
}
```

**5. Say when data can't stay current.** `useLiveHealth()` says, per type, whether a stream is keeping it fresh, so a page can draw "live updates unavailable".

**6. Check it against the real router before a deploy.** What a router admits for an identity can't be known at build time.

```sh
pnpm exec graphql-orm-client doctor --url https://router.example/graphql --token-env TOKEN
```

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
| `graphql-orm-client-streams` | Ephemeral progress, AI text deltas, terminal output and search results |
| `graphql-orm-client-server` | What a graphql-orm service must declare so the client works (for backend agents) |

## How it works

| Stage | What happens |
| --- | --- |
| Component | Declares a fragment on the type it renders and reads it with `useFragment`. It only sees the fields it asked for (data masking). |
| Route root | Owns one query that spreads its children's fragments. A browser route loader starts it with `client.loadQuery`; `useLoadedQuery` consumes the same read. |
| Compiler | `graphql-orm-client generate` turns every root into a flattened query, a sha256 hash of its text, a normalisation map, per-fragment readers and, for fragments marked `@live`, a subscription document. |
| Store | Keeps records by `NodeId` (type name plus complete key), orders writes by record version and retains by reference count. |
| Live layer | Subscribes to the generated `Changed` events for the records held through `@live` fragments and writes each event's entity into the store. Polling is a fallback for records no subscription covers. |

Read [the design](docs/design.md) for the full model and [the graphql-orm
contract](docs/graphql-orm-contract.md) for what the server must provide.

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

## What else is here

| Need | Use | Entry |
| --- | --- | --- |
| A table with page numbers | `@paged`, `usePagedQuery` | `/react` |
| Infinite scroll | `@connection`, `loadMore` | `/react` |
| Changing data | `useMutation`, `client.mutate`; `mutateOutcome` when the UI must say whether a write happened | `/react`, main |
| A secret that must stay out of the store | `@sensitive` | main |
| One refused alias beside the rest of a response | `errorsAtPath`, `partialResults: "preserve-errors"` | main |
| A related name on every row, read in one request | `@batch`, `installRelationBatching` | `/relations` |
| Every row up to a stated limit | `readAll` | `/read-all` |
| Progress, AI text deltas, terminal output, search results | `createStream`, `useEphemeralStream` | `/streams`, `/react` |
| Offline start, and lifetime fields | `persistClient`, generator `lifetimes` | `/persistence` |
| One record's refresh | `@refetchable`, `useRefetchableFragment` | `/react` |
| Testing freshness with no server | `createMockNetwork`, `createMockStreams`, `createTestClock` | `/test` |
| Coming from Apollo | [the option map](docs/design.md#coming-from-apollo) | |

Build settings (`strict`, `queryOwners`, `live`) and runtime settings are in the [live skill](skills/graphql-orm-client-live/SKILL.md) and the [design](docs/design.md).

## Licence

MIT
