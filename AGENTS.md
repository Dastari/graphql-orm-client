# graphql-orm-client contributor guidance

Read README.md, docs/design.md and docs/graphql-orm-contract.md before changing anything.
The project is at the design stage: keep the documents, skills and code consistent with
each other, and label anything not yet built as proposed.

## Ownership

- This package is the browser client for graphql-orm APIs. It is not a general GraphQL client.
  Rely on graphql-orm's guarantees (stable keys, uniform connections, typed `Changed` events,
  the operation catalogue) instead of adding per-type configuration to work around their
  absence.
- When the client needs something from the server, the fix belongs in
  [graphql-orm](https://github.com/Dastari/graphql-orm), opt-in and released through its normal
  process. Record the dependency in docs/graphql-orm-contract.md. Never add a client-side
  workaround that guesses identity, ordering or pagination.
- Keep the core store and network framework-agnostic. React bindings live under the `react`
  subpath; the compiler lives under the `codegen` subpath. Application code (routes, domain
  types, branding) never belongs here.

## Design rules

- Root queries are composed at build time from fragments. Never build a query at runtime
  from the components that happen to mount: that creates request waterfalls.
- A component reads only its own fragment. Do not expose the store or raw query results to
  components.
- Records are identified by `NodeId`: an opaque base64url encoding of the GraphQL type name
  plus the complete key parts. Clients never parse it.
- A write with an older record version never replaces a newer one. Without a version, the
  last write to arrive wins; document that limit wherever it applies.
- `Changed` fires on writes, not on clock expiry. Honour lifetime fields (`expires_at`,
  `valid_until`) in the store.
- Identity changes dispose the whole store synchronously. A result from one identity or
  scope must never be shown under another.
- Live delivery is an optimisation, never the only path to correct data. Every live record
  has a refetch path for reconnects and gaps.

## Documentation

- Document public APIs with TSDoc. Keep README.md short; detail goes in docs/.
- Skills in skills/ are shipped to consumers. Update the matching skill whenever behaviour or
  an API changes, and keep each skill's description line accurate: agents choose skills by it.
- Write factual, plain documentation. No promotional copy.

## Verification

Once code exists: run `pnpm check` (types, lint, tests) and `pnpm build`. Store and live-layer
changes need tests for ordering, version conflicts, identity disposal, garbage collection and
reconnect replay. Do not commit node_modules, build output, test output, credentials or
.handoff notes.
