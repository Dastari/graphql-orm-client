---
name: graphql-orm-client-adopt
description: Install graphql-orm-client in an application, configure the network, store and identity scope, run the codegen preset and wire route loaders.
---

# Adopt graphql-orm-client

Status: design stage. The APIs below are proposed; check the installed package's
`docs/design.md` and changelog before writing code, and do not invent APIs it does not list.

Install a versioned GitHub release archive (`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v<version>/graphql-orm-client-<version>.tgz`), and keep the lockfile. Then read the installed `README.md`, `docs/design.md` and `docs/graphql-orm-contract.md`.
The client only works against graphql-orm services and their router.

1. **Schema snapshot.** Keep the router's SDL in the repository (for example
   `schema/router.graphql`) and refresh it with the project's schema pull script.
2. **Generate.** Add `graphql-orm-client.config.json` (`schema`, `documents`, `out`,
   `scalars`; `keys` for composite or non-`Id` keys on types without `NodeId`; `versions` for record-version fields).
   Run `graphql-orm-client generate`, and run `generate --check` in CI. Write every document with
   the generated `graphql()`, one operation or fragment per call, so each carries its own types
   and an invalid field fails the build.
3. **Client.** Create one client per signed-in identity with `createClient`. Pass the identity
   key as `store.scope`. When the identity changes, dispose the client; never reuse it.
4. **Network.** Use `createHttpNetwork({ url })` for queries and mutations (a same-origin BFF
   where the project has one; pass `headers` or a wrapped `fetch` for auth). For subscriptions,
   create a graphql-ws client, authenticate it in `connectionParams`, and pass
   `live: { artifacts: live, subscribe: graphqlWsSubscribe(ws) }`. In its `connected` event,
   call `client.refetchActive()` when `wasRetry` is true: missed events aren't replayed yet.
   Write a custom `Network` only when the project needs something these don't do.
5. **Provider.** Wrap the application in the React provider from `graphql-orm-client/react`.
6. **Routes.** Each route that shows data owns one root query. Start it in the route loader
   with `client.preload(Query, variables)` and read it in the component with `useQuery`.
7. **Migrate gradually.** An application already on Apollo can move one route at a time.
   Move the fragments next to their components first (see `graphql-orm-client-data`).

Verify: the route makes one request on first load, a second visit within the retention
period makes none, and signing out clears every record.
