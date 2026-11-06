# Requirements for a complete client

What the client still needs, written from running it in real applications. A requirement is done
when its acceptance line passes. Requests from consuming projects join this list; keep the entries
free of any project's names and domain.

## The goal

A developer, or an agent, writes a component with a fragment, says nothing about freshness, and the
data stays correct while it is on screen. If something prevents that, the build says so, or the
running application can say so. It never quietly goes stale.

**The acceptance test for the whole project:** give an agent a small new feature in a real
application and say nothing about live updates. If the feature doesn't update live, or stale data
can't be noticed, the design isn't done.

## Verified gaps in the current code

- `@live` is opt-in per fragment, so it can be forgotten.
- The compiler spreads a `@live` fragment into the stream unchanged, relations and computed fields
  included. The build passes and the server can refuse the stream at runtime.
- `@live` only updates records already held. New rows, removed rows and changed totals need a poll.
- `@live` on a type with no stream only adds it to `liveUnavailable`, and falls back to polling.
- Nothing checks where a query is written, and `pollMs` is one option away.
- A refused stream restarts on the next change to the records it holds, so every list refetch can
  send another failing subscribe. Consumers have to write their own back-off.

## 1. Staying live without thinking about it

**R1. Live by default.** A fragment on an entity with a usable `Changed` stream is live, with an
explicit opt-out (`@live(false)` or similar). A `live: "explicit" | "default"` setting lets existing
applications migrate one area at a time, and goes away at 1.0.
*Acceptance:* a new fragment with no directive updates from a stream.

**R2. The compiler decides what goes in a stream.** Only fields the stream can carry are selected:
scalars and relation keys. A related record is kept current by its own stream. Computed and
federated fields are refreshed by a refetch of the record, so they need the server to mark them
(contract table below).
*Acceptance:* the natural row fragment, with a relation and a computed field, compiles to a stream
that the server accepts, and all of its fields stay current.

**R3. Lists stay correct.** When a `Changed` event of the type arrives, or a stream resumes, a list
query re-reads what it has on screen, in the same order. This covers new rows, removed rows,
re-sorting and `TotalCount`. Scroll position, selection and loaded pages are kept. Re-reads are
coalesced and rate limited per query, with a limit the application can set, because a re-read can be
expensive on the server. Count-only reads and aggregates follow the same rule (R15).
*Acceptance:* a row created elsewhere appears, in the right place, in a filtered and sorted list,
with no polling and no consumer code. A burst of 100 events causes a small, bounded number of reads.

**R4. No lost events.** Replacing a stream, as when the key set changes, starts the new stream before
closing the old one and removes duplicates by record version. A first read subscribes first and then
reads, so no change falls between them. After a gap, what the stream fed is refetched.
*Acceptance:* a test that writes during a key-set change and during a first read loses nothing.

**R5. Build failures in place of conventions**, each with a small, named escape:

| Rule | Default | Escape |
| --- | --- | --- |
| `@live` on a type with no usable stream | Error | Opt out, or `@poll(reason: "...")` |
| `pollMs` on a query | Error at build | `@poll(reason: "...")`, recorded in generated output |
| Raw subscriptions outside allowed paths | Error when paths are set | The ephemeral stream (R11) |
| Queries outside query owners | Error when `queryOwners` globs are set | Add the path to the globs |

Query ownership is a project setting, not "routes only". Real applications have legitimate owners
other than routes: windows, dialogs, pickers and data-layer adapters. Keep a required reason on every
poll, because some state has no event and polling is the honest answer there.

## 2. When it can't stay live, say so

Without this section, R1 makes failures quieter, so it comes first.

**R6. A refused stream backs off and recovers.** The server's refusal is a `next` with `data: null`
and errors, then `complete`. Distinguish it from lost events (`SUBSCRIPTION_CONTINUITY_LOST`,
`SUBSCRIPTION_SOURCE_CLOSED`), which restart at once. A refused stream is never removed: it retries
slowly, with jitter, and recovers by itself on the day the server allows it. Its records fall back to
the polling path meanwhile.
*Acceptance:* a refused stream sends a bounded number of subscribes per hour however often its lists
refetch, and starts working with no reload once the server accepts it.

**R7. Live status is visible.** `client.liveStatus(type)` and a hook report `live`, `connecting`,
`refused`, `unavailable` or `polling`, with reason codes and the last update time, per type and for
the socket. An application can draw "updated 5 min ago, live updates unavailable". A development
warning names a fragment whose data can't stay live.
*Acceptance:* the refused and unavailable states can be drawn with no consumer bookkeeping.

**R8. A doctor command.** `graphql-orm-client doctor --url <router>`, with credentials from the
environment, checks every document against the served schema and opens each live operation briefly.
It reports what is admitted, refused and missing, for the identity used. Only subscriptions and reads
run, never a mutation. Admission can't be known at build time, and it is the commonest cause of
silently stale data.
*Acceptance:* it names a refused stream and a document that no longer validates, with a non-zero exit.

**R23. Schema pull with drift detection.** `graphql-orm-client schema pull` writes the snapshot and
its hash. `generate --check` fails when generated output doesn't match. Consumers currently write
their own.

## 3. What real applications need beyond records

**R9. Sensitive results.** An operation or field marked sensitive (one-time credentials, connection
tokens) is never normalised, never persisted, and never shown by an inspector or a log. It goes only
to the caller that asked for it.
*Acceptance:* after such a mutation, the value is nowhere in the store, and a test proves it.

**R10. Honest write outcomes.** A mutation is sent once and never retried automatically. The result
separates **refused** (it didn't happen), **failed**, and **unconfirmed** (the connection was lost
after sending, or the server committed and then refused the read-back, so it may have happened).
Writes have their own deadline and response limit, apart from reads. A hook supports an explicit
retry after step-up authentication, with no queued replay and no credential held.
*Acceptance:* each outcome is distinguishable in a test, and the unconfirmed path re-reads the record.

**R11. Ephemeral streams.** A first-class stream for data that isn't an entity and doesn't belong in
the store: progress, AI text deltas, terminal output, search results. It has a resume cursor, sequence
de-duplication, replay after reconnect, a bounded buffer and render coalescing. This replaces the
consumer-written versions and is the one sanctioned exception in R5.
*Acceptance:* a high-frequency stream reconnects with no duplicate or missing items and without
re-rendering per event.

**R12. Partial results.** One refused root or alias must not blank the rest of a response. Errors are
reported per path, so several aliased counts or dashboard reads can show their own state. Confirm what
happens today, and document it.

**R13. Batched relation reads.** Selecting a relation on every row can cost the server a permission
check per row, so consumers hand-write "collect the distinct ids, read them in one `Id InList`,
chunked". The compiler should offer this, for example a directive on a relation selection, with
chunking, de-duplication, a pending state and shared caching.
*Acceptance:* a 200-row list with a related name makes a bounded number of reads, with no consumer
code.

**R14. Bounded read-all.** For roots that only filter on a key, `readAll` pages to a stated limit and
reports whether it truncated, along with the exact total. Consumers have written this several times.

**R15. Counts and aggregates.** Typed results for generated aggregates, and aliased count reads, stay
current under R3.

**R16. Deleted records.** The live layer removes a deleted record from lists and the store. A
component holding one gets a defined deleted state and doesn't crash. Confirm today's behaviour.

**R17. Lifetime and persistence.** `AGENTS.md` requires honouring lifetime fields, but the source has
none of this yet. Build it with the roadmap's persistence phase. Persistence is scoped to identity,
excludes R9, and is disposed with the identity. A cursor is never persisted across a server release:
a stale keyset cursor can be accepted at the wrong place.

**R18. Route loading.** `loadQuery`, or similar, starts a route's query before mount, so a router's
loader can avoid a waterfall. Suspense is optional. Decide on fragment arguments
(`@argumentDefinitions`) and support for `@skip`/`@include`. Server rendering stays a non-goal, but
document how the client behaves inside a framework that renders a shell on the server.

**R19. Several windows.** An application with pop-out windows or several tabs opens one socket and
store per window today. Decide whether to share streams, and if not, document the cost.

## 4. Proving it

**R20. A test kit.** `graphql-orm-client/test`: a mock transport keyed by operation name that validates
against the schema, and scripted streams including refusal, continuity loss and reconnect, on a
controllable clock. Consumers currently write these mocks themselves, and so can't test freshness.

**R21. Conformance against the real server.** CI runs an example graphql-orm service behind the router
and proves stream admission, keyed streams, continuity codes, node lookup, version ordering and list
behaviour. Mocks can't prove a document is accepted.

**R22. Budgets.** Checked in CI: 10,000 rows in the store, a burst of 100 events a second, the
compile time of 250 documents against a 45,000-line schema, and the bundle size of the main and react
entry points.

**R24. Release discipline.** While pre-1.0, every breaking change has migration steps in the changelog
and a generator error or warning where one is possible. A behaviour change that alters what a working
application does has a setting. Consumers pin exact versions.

**R25. Agent-ready documentation.** Skills, `llms.txt` and the README describe the default path first.
An agent following them, with no other knowledge, passes the acceptance test at the top.

## Suggested order

1. **R6, R7, R8, R20.** Failures become visible and testable.
2. **R4, then R2, then R3, then R1.** Live by default turns on last, after what makes it safe.
3. **R5, R11.** Strictness arrives once the default path works, and the exception exists.
4. **R9, R10, R12.** These are safety fixes: pull them forward if a consumer needs them.
5. **R13 to R19, then R21, R22, R24, R25,** in the order consumers ask.

## Decisions for the owner

- **R1:** default on, with an opt-out, once R2 to R4 and R6 hold. Recommended.
- **R5:** error by default for streamless `@live` and for polls without a reason; query ownership as
  a project setting rather than a universal rule. Recommended.
- **R19:** share streams between windows, or accept one per window.

## What the server needs

Add these to [graphql-orm-contract.md](graphql-orm-contract.md) as they're confirmed:

- Mark computed and federated fields in the schema, so the compiler can keep them out of a stream (R2).
- Report who a stream admits, or at least make refusal codes stable (R6, R8).
- Report the effective page size in `PageInfo`, sequence numbers and replay, one connection shape, and
  lifetime metadata, as the contract already lists.
- A consistent time format. A generated `String` time can hold `unixepoch()` text, RFC 3339, or
  SQLite's `datetime()` with no zone, so every consumer writes its own parser.
