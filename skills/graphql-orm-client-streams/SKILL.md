---
name: graphql-orm-client-streams
description: Build ephemeral streams for progress, AI text deltas, terminal output and search results with createStream from graphql-orm-client/streams, cursor replay, bounded buffers and React useEphemeralStream.
---

# Ephemeral streams

- Use `createStream(client, Subscription, variables, { select, bufferSize, sequence? })` for non-entity
  data. This is R11's sanctioned subscription path outside record freshness. No value enters the
  store or persistence. `client.subscribe` still writes to the store.
- Create the handle in its owner, call `open()`, and dispose it when the owner closes. Components
  call `useEphemeralStream(handle)` from the React entry point; it uses coalesced external-store
  snapshots. The owner must dispose and replace the client on identity changes.
- Select the service's sequence and cursor in the document. Declare `sequence.value(item)`, optional
  `after` (last sequence before the range), and paired `cursor(item)` / `resume(variables, cursor)`.
  Only declare contiguous, ordered safe-integer sequences. Never guess from timestamps or identity.
- Replay is a service contract, absent from graphql-orm's generic custom-subscription transport.
  Omit cursor/resume if unavailable. Without sequence, no deduplication or gap detection is possible.
- Draw status plus continuity, gap and dropped count. `open` only means an item arrived; `observed`
  covers observed sequence continuity, never unseen tails. `unprovable` is not healthy. Gaps are
  sticky; overflow evicts oldest items and increments `dropped`.
- Use `graphqlWsTransport(ws)` through `live`. Reconnect uses its connection signal and resumes with
  the last cursor. Retries use `live.restart` delays, at most `maxRetries` in a row (default eight); an item arriving starts the count again.
  Refusals fail immediately and normal completion ends. Dispose the failed handle before explicitly
  creating another, to avoid unbounded retry loops.
- Declare a sequence for any source that bursts. The router can drop frames under a burst with no error (graphql-orm#359), and only a
  sequence makes that visible, as `state.gap`.
- Test bursts with `createMockStreams` and `createTestClock`: send raw `next` frames, then fail or
  signal socket reconnect, replay overlap, and assert gaps, buffer drops and empty state on disposal.
  Read the design's R11 section for full state semantics.
