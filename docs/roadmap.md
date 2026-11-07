# Roadmap

Each phase is usable on its own. Phases 1 to 4 are built except where noted. Phase 5 is proposed.

1. **Server contract.** In graphql-orm: `NodeId`, a uniform version field name and `Changed` for
   a list of keys are released. Sequence numbers, replay and persisted operations at the router are
   not; see [the contract](graphql-orm-contract.md).
2. **Colocation on the existing client.** Consumers give each component, or each adapter that
   builds view models, its own fragment, and make sure every query selects stable keys. Fragment
   masking is optional at this stage. It adds most where several components share one query, and
   least where one adapter maps all rows for a table.
3. **Compiler and store.** (Built: the compiler, generator, store, client, React hooks, keyset and
   offset pagination, page-number navigation with `@paged` and `usePagedQuery`, optimistic updates,
   `@refetchable` fragments, `useMutation`, plain subscriptions, `client.query`, `refetchQueries`
   and the HTTP and graphql-ws transport.) The codegen preset, the normalised store, `useQuery`,
   `useFragment`, pagination and `useMutation`, behind an API that consumers can adopt one route at
   a time, with the Apollo options a straight port needs.
4. **Live layer.** Built: store-driven `Changed` subscriptions, version ordering and recovery from
   a continuity error. Not built: reconnect replay, which needs the server. An application calls
   `client.refetchActive()` after a reconnect.
5. **Persistence and tooling (partly built).** Opt-in adapter and IndexedDB persistence are built (R17). A store inspector and persisted-
   operation enforcement remain proposed.

What is still needed for a complete client, with acceptance tests and a suggested order, is in
[requirements.md](requirements.md).
