---
name: graphql-orm-client-adopt
description: Install graphql-orm-client in an application, configure network read/write bounds, partial-result policy and one client per signed-in identity, pull and check schema snapshots, run the generator, wire route loaders and move an Apollo application across route by route.
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

### Network bounds

`createHttpNetwork({ url, reads, writes })` takes `{ deadlineMs, maxResponseBytes }` for each. Both are off unless set, and a write past
its deadline is `unconfirmed`, not retried. See the data skill for `@sensitive`, write outcomes and partial results.


## Build policies and the live setting

Generator settings `strict`, `queryOwners`, `subscriptionPaths` and `live`: see the live skill.
