# Roadmap

Each phase is usable on its own. The first consumer is an existing application that currently
uses Apollo.

1. **Server contract.** In graphql-orm: `NodeId`, a uniform version field name, `Changed` for
   a list of keys, sequence numbers and replay, persisted operations at the router. Useful to
   any client, Apollo included.
2. **Colocation on the existing client.** Consumers give each component, or each adapter that
   builds view models, its own fragment, and make sure every query selects stable keys. Fragment
   masking is optional at this stage. It adds most where several components share one query, and
   least where one adapter maps all rows for a table.
3. **Compiler and store.** (In progress: the compiler, store, client and React hooks are built; the codegen preset and pagination are not.) The codegen preset, the normalised store, `useQuery`,
   `useFragment`, `usePagination` and `useMutation`, behind an API that consumers can adopt one
   route at a time.
4. **Live layer.** Store-driven `Changed` subscriptions, version ordering, reconnect replay,
   and removal of polling where events cover the state.
5. **Persistence and tooling.** IndexedDB persistence, a store inspector and persisted-
   operation enforcement.
