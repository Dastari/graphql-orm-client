---
name: graphql-orm-client-adopt
description: Install graphql-orm-client in an application, configure the network and one client per signed-in identity, pull and check schema snapshots, run the generator, wire route loaders and move an Apollo application across route by route.
---

# Adopt graphql-orm-client

Status: early alpha. Check the installed package's `docs/design.md` and changelog before
writing code, and do not invent APIs it does not list.

Install a versioned GitHub release archive (`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v<version>/graphql-orm-client-<version>.tgz`), and keep the lockfile. Then read the installed `README.md`, `docs/design.md` and `docs/graphql-orm-contract.md`.
The client only works against graphql-orm services and their router.

1. **Schema snapshot.** Keep the router's SDL in the repository (for example
   `schema/router.graphql`) and refresh it with `graphql-orm-client schema pull --url <router> --token-env TOKEN`.
   Set `schema` in the project config first. Commit the SDL and its `.sha256` sidecar.
   Use `schema pull --check` in CI for server drift; it never writes and an unreachable server fails.
   Credentials come from `--token-env NAME` or `--header-env name=NAME`, never literal flags.
   Once the hash exists, `generate --check` also verifies snapshot integrity and provenance.
   After pulling a changed schema, run `generate`. Existing projects without a sidecar keep working.
2. **Generate.** Add `graphql-orm-client.config.json` (`schema`, `documents`, `out`,
   `scalars`; `keys` for composite or non-`Id` keys on types without `NodeId`; `versions` only for a version field other than graphql-orm's `RecordVersion`, or `null` to stop selecting it).
   Run `graphql-orm-client generate`, and run `generate --check` in CI. Write every document with
   the generated `graphql()`, one operation or fragment per call, so each carries its own types
   and an invalid field fails the build.
3. **Client.** Create one client per signed-in identity with `createClient`. When the identity
   changes, call `client.dispose()` and pass a new client to the provider; never reuse one. There
   is no `store.scope` option yet.
4. **Network.** Use `createHttpNetwork({ url })` for queries and mutations (a same-origin BFF
   where the project has one; pass `headers` or a wrapped `fetch` for auth). For subscriptions,
   create a graphql-ws client, authenticate it in `connectionParams`, and pass
   `live: { artifacts: live, ...graphqlWsTransport(ws) }`. It reads open queries again after a
   reconnect, because missed events aren't replayed yet.
   Write a custom `Network` only when the project needs something these don't do.
5. **Provider.** Wrap the application in the React provider from `graphql-orm-client/react`.
6. **Routes.** Each route that shows data owns one root query. Start it in the route loader
   with `client.preload(Query, variables)` and read it in the component with `useQuery`.
7. **Migrate gradually.** An application already on Apollo can move one route at a time.
   Move the fragments next to their components first (see `graphql-orm-client-data`, which maps
   Apollo's options). The installed `docs/design.md` has a table under "Coming from Apollo".
   Offset tables become `@paged` queries with `usePagedQuery`; plain subscriptions need
   `live: { subscribe }` even without `@live` fragments.

Verify: the route makes one request on first load, a second visit within the retention
period makes none, and signing out clears every record.

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

### Write certainty (R10)

`client.mutateOutcome` and React `useMutation(...).commitOutcome` return an outcome even
when legacy `mutate` / `commit` would throw; those existing APIs still return or throw as before.
Statuses are `confirmed`, `refused`, `failed`, `unconfirmed`. No write is retried.
After step-up authentication call `commitOutcome` again explicitly with fresh variables;
the hook queues no replay and holds no credential. Supply `reconcile: () => client.refetchFragment(F, ref)`
(or an explicit network-only query) for known affected records. Unconfirmed writes await that read
and report `reread`, `failed`, or `unavailable` when no record/read is known.
A re-read observes current state; it does not prove this write committed.

The classifier requires evidence: all selected root results with `Success: true` and no errors
confirm a write. Explicit server `extensions.outcome: "refused"` / `"failed"` distinguish those
outcomes; these two signals are proposed server contract additions and tested with mocks.
Transport evidence of no send (`WriteNotSentError`) or cancellation before sending is failed.
Connection loss, cancellation after send, HTTP errors, partial errors and GraphQL `data: null`
are unconfirmed. Neither HTTP status nor error message text proves a refusal. Missing Success,
`Success: false`, and mixed multi-root outcomes are conservatively unconfirmed.

Source checked: graphql-orm tag `graphql-orm-v0.90.1`, router 0.8.1:
runtime/mutation.rs marks post-commit payload denial/failure/timeout with
`extensions.outcome: "committed", retryable: false`; outcome unknown also forbids automatic retry.
Generated operations.rs uses boolean Success and free-form Error; these are insufficient for
uniform refusal classification. No client inference from error text is used.

HTTP limits are opt-in to preserve existing applications: configure
`createHttpNetwork({ url, writes: { deadlineMs: 15000, maxResponseBytes: 1048576 } })`.
`reads` has independent bounds; omitted bounds retain unlimited behaviour.
Limits cover response streaming and are not mutation retries. Custom networks must implement
their own bounds and must not automatically retry mutations.
