# graphql-orm-client contributor guidance

Read README.md, docs/design.md, docs/requirements.md and docs/graphql-orm-contract.md before
changing anything. The package is in alpha and used by real applications: keep the documents,
skills and code consistent with each other, and label anything not yet built as proposed.

Keep this repository free of any consuming project's names and domain, in examples, tests, docs and
changelogs. Check for them before each commit. Requests from consumers go in docs/requirements.md in
general terms.

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
  subpath; the compiler lives under the `compiler` subpath; the test kit under `test`. Application code (routes, domain
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
  `valid_until`) in the store. Lifetime is opt-in through explicit generated per-type field and time-format policies (R17).
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

Run `pnpm check` (types, tests and the skills listing; there is no lint step) and `pnpm build`. Store and live-layer
changes need tests for ordering, version conflicts, identity disposal, garbage collection and
reconnect replay. Do not commit node_modules, build output, test output, credentials or
.handoff notes.

## Releases

Consumers pin exact versions, so while the package is pre-1.0 a release can change behaviour, but only like this:

- Every breaking change has migration steps in `CHANGELOG.md`, and a generator error or warning where one is possible.
- A behaviour change that alters what a working application does has a setting that restores it.
- Anything not yet released can still move, for example to its own entry point, with no migration.
- `test/release.test.ts` checks the version, changelog and shipped skills agree. CI, a clean-clone install and the changelog's steps come before publishing.

## Conformance

From a source checkout, `pnpm conformance` runs the built client against the SQLite service and real router
in `conformance/`, separately from `pnpm check`. Install Chromium with
`pnpm exec playwright-core install --with-deps chromium`. Set `CONFORMANCE_SCRATCH`
outside the worktree to cache builds; check disk space first (allow 10 GB). Use only
ports 42000–42099. A missing local browser is reported as `NOT RUN`; CI requires it.
See `conformance/README.md` for pinned versions, fixture accommodations and coverage.
