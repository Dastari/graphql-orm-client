# Changelog

## Unreleased

### Added: `classifyError`, to tell one failure from another

`classifyError(error)` and `classifyErrors(error)` take a `QueryState.error`, what `mutate` or `commit` rejected with, or
`QueryState.errors`, and give each error a `kind`: `conflict`, `cursor-invalid`, `not-found`, `unauthenticated`, `forbidden`,
`unavailable`, `internal`, `network`, `cancelled` and the rest, with `unknown` for a code this version doesn't know. Each keeps the
code as sent, the path, graphql-orm's `correlationId` and `extensions.outcome`. Use it in place of matching message text.

`createHttpNetwork` now marks a request that got no response (a failed connection or a passed deadline), so `classifyError` reports
`network`. What it throws is unchanged. A custom network can do the same with `markNoResponse`.

### Changed: an event costs what it changed, not the length of the list showing it

One `Changed` event for one row used to read every query showing that row from top to bottom, twice: once for the query's
data and once to work out which records it holds live. On a 10,000-row list that was 25 ms an event. Now the store keeps a memo
for each large subscriber and reads only the written records and what's above them, and a query works out what it holds only
when rows arrive, leave or are relinked. Measured with the mock network, per event: 0.25 ms to 0.05 ms at 100 rows, 1.6 ms to
0.15 ms at 1,000, and 25 ms to 1.3 ms at 10,000
([#68](https://github.com/Dastari/graphql-orm-client/issues/68)).

No setting and no regeneration: results, notifications and ordering are the same. Three things to know:

- `Snapshot.seen` on a large subscription can now include records an earlier read reached and the latest didn't. Nothing in the
  package's documented API exposes it; code that reads `client.store` directly and treats `seen` as exact should call
  `store.lookup(selector)` for an exact set.
- `store.subscribe`'s callback gets a second argument, `{ structural }`: the records the batch created, replaced, removed or
  relinked.
- The memo uses about 300 bytes a row, and the main bundle grew by about 2 KB (0.8 KB gzipped).
### Fixed: a render React threw away left its query behind for good

`useQuery` calls `client.watchQuery` during render. When React discarded that render without running its effects (a suspended
sibling, an interrupted transition, StrictMode's extra render), the query stayed registered until the client was disposed, so a
page with changing variables, such as a search box, grew without bound. A query nobody has opened is now held only by its handles
and freed with them; handles for the same variables still share it
([#71](https://github.com/Dastari/graphql-orm-client/issues/71)). Nothing to change in applications.

### Added: a complete example

`docs/example.md` builds two related graphql-orm entities, their service, and a page that lists, adds and closes rows and stays
current, checked against graphql-orm 0.94.0.

### Changed: conformance runs against graphql-orm 0.170.0 and router 0.15.5

The real-server suite now runs on `graphql-orm-v0.90.1`, `v0.94.0`, `v0.126.0` (router 0.11.0) and `v0.170.0` (router 0.15.5)
([#56](https://github.com/Dastari/graphql-orm-client/issues/56), [#78](https://github.com/Dastari/graphql-orm-client/issues/78)).
The package's behaviour doesn't change. What the runs found, recorded in `docs/graphql-orm-contract.md`:

- From router 0.11.0, `schema pull` and the doctor need `"introspection": true` in the router's configuration; without it they
  exit 5.
- From router 0.8.3 a schema reload no longer sends `complete` after `error`, so Node clients need no `allowSynchronousEvents: false`.
- From router 0.9.0 a router that drops frames ends the streams with `SUBSCRIPTION_CONTINUITY_LOST`, and they restart and read.
  `live.burstRead` stays on by default, still needed for routers before 0.9.0.
- `node` for a missing row is null once an owner field is selected, so `refetchFragment` of a row deleted elsewhere removes it.

Nothing to change in applications.

### Added: graphql 17 as a peer

The `graphql` peer range is now `^16.9.0 || ^17.0.0`, so an application on graphql 17 no longer gets a peer warning or a second
copy of `graphql` ([#80](https://github.com/Dastari/graphql-orm-client/issues/80)). CI runs `pnpm check` and `pnpm build` with
both.

What you get from `generate` and `schema pull` is the same text with either version. graphql 17 prints an object value as
`{ a: 1 }` where 16 prints `{a: 1}`, and prints a schema default as written where 16 prints it coerced, with the input fields' own
defaults filled in. Left alone, that would have changed operation text and hashes, the persistence `schemaHash`, and the schema
snapshot and its `.sha256` whenever a project changed graphql version, so `generate --check` and `schema pull --check` would fail
for a team on mixed versions. The compiler and `schema pull` now print both as graphql 16 does. Nothing changes for a project on 16.

Moving an application to graphql 17:

1. Install graphql 17 and remove any override that held it at 16.
2. Run `graphql-orm-client generate --check` and `graphql-orm-client schema pull --check`; both should pass with no changes.
3. graphql 17 validates more of a schema than 16 did, for example argument and input field defaults. A router snapshot 16
   accepted can fail `generate` on 17; the message names the default to fix, and the fix belongs in the service's schema.
4. Validation messages from `generate` and `doctor` come from graphql and read differently on 17. Don't match on their text.

### Fixed: a keyless type with a `Changed` stream was skipped without a word

A type can have a usable `Changed` stream and still have no key, usually because the project set `keys: { Type: null }`. Its fragments
can't be live, and under `live: "default"`, an area pattern or `strict.fragmentNotLive` nothing said so. The compiler now reports each
such type once, naming its unmarked fragments and the configured identity, at the `strict.fragmentNotLive` level (`"warn"` unless set).
An explicit `@live` on one fails under `strict.liveWithoutStream` saying the identity is configured off, where it used to say the type
had no usable `Changed` stream ([#58](https://github.com/Dastari/graphql-orm-client/issues/58)).

No regeneration needed to keep working. On regenerating:

- If you set `strict.fragmentNotLive: "error"`, the build fails for these fragments. Mark each one `@live(enabled: false)` if it's meant
  to stay as it is, or remove the `keys` entry, or set `fragmentNotLive: "warn"` to get the earlier build back.
- A test matching the old `@live` error text ("no usable Changed stream") on such a type needs the new text.

### Added: a summary line per `live.default` pattern

`generate` prints one line per pattern in `live: { default: [...] }`, for example
`live.default "src/area/**": 3 files, 11 fragments: 4 newly live, 5 opted out, 1 keyless, 1 without a stream`, so a trial says what it
changed without a diff of the generated module. `compile(...).liveAreas` holds the same report with fragment names, and
`GenerateOptions.onSummary` receives the lines (default `console.log`)
([#59](https://github.com/Dastari/graphql-orm-client/issues/59)). Nothing prints under `"explicit"` or `"default"`. A script that reads
`graphql-orm-client generate`'s standard output under an area pattern sees these lines before `Wrote ...`.

### Fixed: a live fragment with an operation variable failed naming a generated operation

With the default stream projection, a `@live` fragment may select a field that takes an operation variable (`Label(Locale: $loc)`): the
stream leaves it out, and each query holding the record reads it again with its own variables. This already worked; it is now tested
and documented. Under `liveSelection: "as-written"`, whose stream spreads the fragment, it failed with `Variable "$loc" is not defined by
operation "LiveFoo"`, naming an operation nobody wrote. It now fails naming the fragment, the field and the variable, why (one stream
serves every holder), and the fixes: a literal argument, moving the field to a fragment that isn't live, `@live(enabled: false)`, or
leaving `"as-written"` ([#64](https://github.com/Dastari/graphql-orm-client/issues/64)). Nothing to change in applications.

### Fixed: generated input types required non-null fields that have a default

An input object field that is non-null with a default, such as `Limit: Int! = 50` or `Tags: [String!]! = []`, may be left out: the
server applies the default. The generated type made it required, so callers repeated server defaults. It is now optional and not
nullable (`readonly Limit?: number`), in nested inputs and lists of inputs as well, as a variable with a default already was
([#65](https://github.com/Dastari/graphql-orm-client/issues/65)).

Regenerate to get the new types. A module generated before keeps compiling and working; nothing changes at run time. After
regenerating, callers that pass these fields still compile and may drop them. Code that reads such a field from a value typed as the
generated input type now sees `number | undefined` and needs a fallback.

### Fixed: persistence copied and encoded the whole store on every flush, and kept doing so over budget

Each flush copied every record, serialised it and encoded the result again only to measure it. A store over `maxBytes`
paid that on every flush, deleted the saved snapshot each time and reported `PERSISTENCE_SIZE` each time
([#70](https://github.com/Dastari/graphql-orm-client/issues/70)). Now a flush serialises only the records written since
the last one and measures UTF-8 length without encoding. Over budget it reports `PERSISTENCE_SIZE` and deletes the
saved snapshot once, then saves nothing until the store fits, when it saves a complete snapshot again. Nothing partial
is saved. Nothing to change in applications. If you counted `PERSISTENCE_SIZE` diagnostics, expect one each time the
store goes over, not one per flush.

### Changed: a saved snapshot older than 7 days isn't restored

The persistence envelope now records `savedAt`, the time of its last write, and `persistClient` takes `maxAgeMs`
([#75](https://github.com/Dastari/graphql-orm-client/issues/75)). A snapshot older than that, by default 7 days, is
reported as `PERSISTENCE_EXPIRED`, deleted and not restored: the application starts as it would with nothing saved.
So is one saved more than a minute later than the device clock says it is now; the minute allows for a clock that
time synchronisation stepped back. A read-only window leaves it in place. The clock is
`Date.now` unless you pass `now`.

- To keep restoring a snapshot of any age, as before, pass `maxAgeMs: Infinity`.
- The envelope format is now 2. A snapshot saved by 0.1.0-alpha.12 or earlier is deleted on first load and not
  restored, as every release's snapshots already were (the envelope carries the package version).

### Changed: data holds the key, `NodeId` and version fields only where the document selects them

The compiler adds each record's key fields, `NodeId` and `RecordVersion` to every selection, so the store can identify and order
records. Until now they were also read into the data of every query and fragment, so a list's rows held `Id` and `RecordVersion`
although the document selected neither. A `Changed` event advances `RecordVersion`, so the data of every query showing a
versioned row changed on every event for it, and the component holding a list rendered again with a new `Edges` array even when
everything it shows is behind fragments
([#87](https://github.com/Dastari/graphql-orm-client/issues/87)).

Now they're still sent and stored, and a query or fragment reads them only where its own document selects them. The operation
text, what's stored, ordering, streams and refetches are unchanged; the generated types follow the data.

To move:

1. Regenerate (`graphql-orm-client generate`). Until you do, the old module keeps the old behaviour.
2. Fix what the type checker reports. Each error is a read of `Id`, `NodeId` or the version where the document doesn't select
   it, such as `key={Node.Id}` under `Node { ...Row }`. Select the field there (`Node { Id ...Row }`). A mutation result reads
   only what the mutation selects, too.
3. Code that reads data without the generated types (`any`, `JSON.stringify` of results, snapshot tests) won't be reported:
   search it for those fields.

`identityFields: "always"` in the generator config (or compile options) restores reading them everywhere, with no other change.
`readAll` still deduplicates rows that select no key.

### Changed: a version field that isn't a number fails generation

The store orders records by comparing versions as numbers. A `versions` entry naming a field that isn't `Int` or `Float`, such
as a `String` holding a 64-bit value, was never compared, so its type quietly had last-write-wins
([#74](https://github.com/Dastari/graphql-orm-client/issues/74)). Generation now fails with `versions.<Type>: <Type>.<field> is
<type>, not Int or Float`. It also fails when the field doesn't exist, or is a list, a Boolean or an object.

To move, give the entry the comparison it needs:

- `{ "field": "Revision", "compare": "decimal" }`: a decimal integer sent as a string, compared exactly as a big integer, past
  2^53 too. A JSON number is compared too, but only up to 2^53, where a number stops being exact. A value that can't be
  compared (not a decimal integer, or a number past 2^53) can't be ordered, and the last write to arrive wins.
- `{ "field": "Revision", "compare": "number" }`: a custom scalar sent as a JSON number.
- `null`: no ordering for the type, which is what it had.

Nothing changes for `RecordVersion` or a configured `Int` or `Float` field. A `versions` entry for a type the schema doesn't
have, which did nothing, now prints a generator warning; it still builds.

### Fixed: a server `NodeId` is checked against the record's type

The store used a response object's `NodeId` as its identity whenever it decoded, whatever type it named. It now uses it only
when it names the object's own `__typename`; otherwise the object is identified by its key fields, as a type without `NodeId`
is. graphql-orm always encodes the object's own type, so nothing changes for a response it serves.

### Changed: a write answered without `data` is refused only for pre-execution error codes

`mutateOutcome` and `commitOutcome` reported every response with no `data` key as `refused`. Hive Router, which graphql-orm-router
is built on, answers every pipeline error that way, including `PLAN_EXECUTION_FAILED` and `GATEWAY_TIMEOUT`, which can come after a
subgraph committed the write. Such a response is now `refused` only when every error's code is a known pre-execution failure
(parse, validation, variables, authentication, authorization, persisted document, request limits; the list is in
docs/design.md); otherwise it's `unconfirmed`, and `reconcile` runs
([#62](https://github.com/Dastari/graphql-orm-client/issues/62)). `mutate` and `commit` return and throw as before.

Migration: none needed for most applications. An application that treated `refused` as final now sees `unconfirmed` for a router
execution failure, a timeout, or an error with no code, and should show it as "may have happened". To keep the earlier rule, set
`createClient({ network, writeWithoutData: "refused" })`.

### Added: `confirm`, for writes whose mutation doesn't select `Success`

`mutateOutcome(CloseTicket, variables, { confirm: data => data.CloseTicket != null })`, for a hand-written command that returns the
changed entity (no `Success` or `Error` field) and raises an error when it doesn't commit, confirms a write by a rule the caller
names, in place of requiring `Success: true` on every root. Don't use a non-null root as the rule for a result that has its own
`Success` or `Error` field: it is non-null when the write failed too. It's asked only about a response with data and no errors, so partial errors stay
`unconfirmed`; `false` or a throw leaves it `unconfirmed`
([#60](https://github.com/Dastari/graphql-orm-client/issues/60)). `MutateOptions<T>` is exported for its type. Nothing changes
without it.

### Added: `refusedCodes`, so a known refusal skips the reconciliation read

`refusedCodes: ["NOT_FOUND", "CONFLICT"]` on `mutateOutcome` or `commitOutcome` reads a write as `refused`, with no `reconcile`,
when no error has an `extensions.outcome`, every error has one of those codes at the path of a root field (exactly one path
element), and every root field the operation selects is null with its own such error
([#61](https://github.com/Dastari/graphql-orm-client/issues/61)). Anything else stays `unconfirmed`: an error further down can null
a root, or all of `data`, after the root committed, and roots run in order, so an earlier root with no error may have committed
before a later one was refused. A pathless error counts for no root. On a response with no `data` key the codes add to the
pre-execution list. Nothing changes without it.

### Fixed: `useFragmentList` redid every row on every render

`useFragmentList` compared its references by the array's identity, so the documented `Edges.map(...)`, a new array each
render, unsubscribed and resubscribed every row and read each one twice on every render of the parent, and one row changing
read all of them again. It now compares rows by record, fragments, variables and store: a render with the same rows reads
nothing and changes no subscription, each row keeps its subscription while it stays in the list, and a change to one row reads
that row ([#69](https://github.com/Dastari/graphql-orm-client/issues/69)). A row from a client disposed with its identity is
read again and never subscribed, here and in `useFragment`, so it can't show the previous identity's data. The rows it returns
are otherwise the same. Nothing to change in applications.

### Changed: a socket closed for authentication waits for new credentials

When the server closed the socket with 4401 (the router's answer to a missing, invalid or expired bearer) or 4403, the live
layer took it for an outage and reconnected with back-off, with the same credentials, for as long as records were held. Now
every stream stops, every type holding records reports reason `unauthenticated` with `code` `"4401"` or `"4403"`, the queries
holding them poll (`polling.liveFallbackMs`), and nothing subscribes again on a timer
([#73](https://github.com/Dastari/graphql-orm-client/issues/73)). `graphqlWsTransport` sees a 4403 at the close event, before
graphql-ws retries it by itself, and stops those retries. An `UNAUTHENTICATED` error on one stream is unchanged: the router
sends it when the same connection will recover, and it stays a refusal of that stream.

- Added `client.reconnectLive()`: call it once the socket's credentials are renewed (for graphql-ws, once `connectionParams`
  returns them). The held types subscribe again and their queries read. A `connected` socket reported by `graphqlWsTransport`
  starts them again too, once per stop: a stop within a minute of such a resume waits for `reconnectLive()`. Disposing the
  client for a new identity clears the stop. `retryAt` is null while stopped, and a refusal window still running at resume
  applies as before.
- Added `LiveReason` and `LiveEndReason` `unauthenticated`, `LiveTypeStatus.unauthenticated`, and `closeCode` on a
  `LiveConnection` change. `createMockStreams().fail(event)` closes every open stream with a given close event.

Migration: an application that recovered by letting the client reconnect, with a `connectionParams` that fetches a fresh token
on every connect, either calls `client.reconnectLive()` after renewing the token, or sets `live: { unauthenticated: "restart" }`
for the previous behaviour. A custom `LiveConnection` can pass `closeCode` so a close is seen before its sinks fail. Code that
switches over `LiveReason` or `LiveEndReason` has one more case.

## 0.1.0-alpha.12 (2026-11-07)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.12/graphql-orm-client-0.1.0-alpha.12.tgz`.

No regeneration is needed. Regenerate to see the new `live.default` warning.

### Changed: disposing a client no longer deletes its saved data

`persistClient` used to delete an identity's saved data when its client was disposed. A pop-out window calling `dispose()` on close deleted what the main window had saved. Now:

- `persistence.clear()` deletes it, and stops the identity's other windows saving it. **If you use `persistClient`, call it on sign-out:** `void persistence.clear(); client.dispose()`. Without this the data stays on the device. An application with one window per identity can pass `deleteOnDispose: true` instead, which restores the earlier behaviour.
- `readOnly: true` makes a window restore and never write or delete. Use it for a pop-out. Otherwise the window's own smaller snapshot can replace the main window's, since the last write wins.

Applications that don't use `graphql-orm-client/persistence` aren't affected.

### Fixed: an undeclared `pollMs` threw in a production browser bundle

The check for production read `typeof process` first, which is `"undefined"` in a browser, and `process.env?.NODE_ENV`, which bundlers don't replace. So in a built page an undeclared `pollMs` threw and could blank the page. Now it reads `process.env.NODE_ENV` as bundlers write it:

- Where it's `production`, it warns and still polls, as documented.
- Where it's set to anything else, as in development and tests, it throws.
- Where the bundle doesn't define it, it warns: with nothing saying which environment it is, it doesn't crash the page. This used to throw. To get the error there, set `polling.undeclared: "error"`.
- **Changed:** `polling.undeclared: "error"` now throws in every environment, including production. It used to warn in production like the default. If you set it, set `"warn"` in production builds, or leave it unset.

`live.onDiagnostic`'s default, which stays quiet in production, now reads the same way, so a production browser bundle no longer logs live diagnostics to the console. Pass `live: { onDiagnostic: (d) => console.warn(d.message) }` to keep them.

### Changed: refreshing a keyset list costs one request, not one per loaded page

`refetch()`, polls and live re-reads of a regenerated keyset `@connection` used to read the loaded range a page at a time, so three loaded pages cost three requests on every poll. Now the first request asks for every loaded row, up to `live.maxRereadRows` (100), and later requests ask only for the rows still missing. Offset lists already did this. The rows read are the same: the loaded rows, plus the room on a partly filled last page, so a row created there still appears.

- `live.maxRereadPages` (10) now counts requests, not pages. A keyset list loaded past ten pages, which used to keep a possibly stale tail and set `QueryState.listRefreshTruncated`, now refreshes up to 1,000 rows. Set `maxRereadPages` lower to bound it.
- `live.maxRereadRows` now applies to keyset lists too. Set it to your service's maximum page size, as alpha.11 asked. A larger value isn't an error: graphql-orm's generated keyset roots clamp the page to their maximum and the client reads the rest.
- To keep one request per page, set `live.maxRereadRows` to your page size. It also bounds offset refresh.

### Added: a warning for a `live.default` pattern that matches no fragment

A pattern in `live: { default: [...] }` matches the file a fragment is written in, not the files that spread it. A page whose rows come from fragments in a shared folder needs that folder in the pattern. `generate` now warns about a pattern that matches no file defining a fragment, since it makes nothing live.

### Migration from alpha.11

1. If you use `persistClient`, call `void persistence.clear()` before `client.dispose()` on sign-out, or pass `deleteOnDispose: true` if each identity has one window. Pass `readOnly: true` in a pop-out window.
2. If you set `polling.undeclared: "error"`, set `"warn"` in production builds, or leave it unset.
3. If you read live diagnostics from the console in production, pass `live: { onDiagnostic: (d) => console.warn(d.message) }`.
4. Check `live.maxRereadRows` against your service's maximum page size: a keyset refresh now asks for up to that many rows in one request. Set it to your page size to keep one request per page, and lower `live.maxRereadPages` to bound a long list.
5. Regenerate, and fix any `live.default` pattern the generator says matches nothing.

## 0.1.0-alpha.11 (2026-11-07)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.11/graphql-orm-client-0.1.0-alpha.11.tgz`.

Regenerate. Most of what's new turns on when you do, and a module generated earlier keeps working as it did, apart from the burst read and the settings marked below.

### Build errors after regenerating

Each of these can be relaxed while you migrate:

- **`@live` on a type with no usable `Changed` stream fails the build,** including on an interface or union fragment, which used to be silently not live. Remove it, use `@live(enabled: false)`, or declare `@poll(reason: "...")`. `strict: { liveWithoutStream: "warn" }` relaxes it.
- **`@skip` and `@include` fail the build.** An omitted field used to read as missing, generated types marked it required, and streams lost the condition. Split the query. `conditionalDirectives: "legacy"` keeps the old behaviour while you do.
- **`@poll` needs a reason.** `strict: { pollWithoutReason: "warn" }` relaxes it.
- Fragment arguments stay unsupported, now with a clear error.
- **New warning, no error:** `generate` names any fragment on a keyed type with a `Changed` stream that isn't live, because it won't update on screen and nothing says so at run time. Mark it `@live`, or `@live(enabled: false)` if that's meant. `strict: { fragmentNotLive: "off" }` silences it, and `"error"` fails the build.

### Changed at run time

- **Lists stay correct (R3).** After regenerating, a list of a live type opens one stream for the type before its first read, even when empty. New rows, removed rows, re-sorting and totals then follow, in the same order, with loaded pages kept. It costs the server a row-policy check per event per subscriber, and `live: { listStreams: false }` makes lists poll instead. A list opens a stream only for a type with a `@live` fragment somewhere in the project. `refetch()` and polls on a regenerated `@connection` read the loaded range, not only the first page, up to `live.maxRereadPages` (10) and `live.maxRereadRows` (100). Past that they keep the tail and set `QueryState.listRefreshTruncated`. Set `maxRereadRows` to your service's maximum.
- **Burst read, on by default, with no regeneration needed.** The router can drop subscription frames under a burst with no signal (graphql-orm#359). So when a type gets at least 32 events, the queries holding it read once more after they settle. **Cost per burst:** one extra read per query holding the type, coalesced across types and at most one per `live.minRereadMs`. `live: { burstRead: false }` turns it off. A burst under 32 events, or one where every frame is lost, still can't be noticed.
- **`live.maxKeyedSubscriptions: 0` now means one stream per type in `keys` mode too, with no regeneration needed.** It used to be ignored there, so a project setting it got a narrowed stream replaced whenever its held set changed. The server now does a row-policy check per event per subscriber, including rows nobody holds. Remove the setting to keep narrowing. Where the argument is required it stays narrowed, and health shows `keyRequired`.
- **An undeclared `pollMs` throws from `watchQuery` outside production, on a regenerated module.** Declare `@poll(reason: "...")` on the query. In production, and on a module generated earlier, it warns and still polls. `polling.undeclared: "warn" | "off"` relaxes this.
- **`useQuery` renders idle on the server,** starting no watch or I/O. `{ serverSnapshot: "legacy" }` restores the previous snapshot.

### Added, all opt-in

- `client.loadQuery` and `useLoadedQuery`: start a route's read before mount, with no second request. Forward the router's abort signal. Unused loads close after 30 s (`timeoutMs`) and open again if mounted later.
- `@sensitive` on a query or mutation: the result stays out of the store, and it's a plain value. `client.mutateOutcome` and `commitOutcome`: `confirmed`, `refused`, `failed` or `unconfirmed`, never retried. No graphql-orm version sends a refusal signal yet, so a write refused during execution reads as `unconfirmed`. `createHttpNetwork` gets separate `reads` and `writes` bounds. `errorsAtPath` and `partialResults: "preserve-errors"`.
- `live: "default"` or `{ default: ["src/area/**"] }` in the generator (R1), and `@live(enabled: false)`. The default stays `"explicit"`. Each newly live type costs an operation on a connection, and the router allows 32 by default.
- `strict`, `queryOwners` and `subscriptionPaths` in the generator (R5).
- Entry points: `graphql-orm-client/streams` (`createStream`, for progress, AI text deltas, terminal output), `/read-all` (`readAll`), `/relations` (`@batch`, `installRelationBatching`), `/persistence` (`persistClient`, `indexedDBAdapter`). `@batch` sends nothing when rendering on a server.
- `{ deleted: "null" }` on `useFragment` and `readFragment` types a removed record as null, and `store: { deletedRecords: "omit" }` drops missing rows from lists during the re-read. Generated aggregates and aliased counts of live types stay current. Generator `lifetimes` declares a lifetime field and its format.
- `liveHealth()` gains `reads` by cause, `streams` and `refusedStreams`, and each type gains `burstReads` and `lastBurstReadAt`. They're absent with no live layer.

### Fixed

- A generated `@connection` list with room on its page lost its last row when one was created above it. Found by running an agent's page against a real router.
- A compile on a large schema took about 24 s since alpha.10, re-extending the schema per live type. It now takes under a second on the budget's 45,000-line schema.

### Migration from alpha.10

1. Regenerate, and deal with any build errors above. Read the warnings: each names a fragment that won't update.
2. If you set `maxKeyedSubscriptions: 0`, decide whether you want the un-narrowed stream, since it costs the server more.
3. If you set `pollMs`, add `@poll(reason: "...")` to those queries.
4. If you render a shell on a server, check it renders idle as you expect.
5. Set `live.maxRereadRows` to your service's maximum page size.
6. Run `doctor` against the deployed identity.

## 0.1.0-alpha.10 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.10/graphql-orm-client-0.1.0-alpha.10.tgz`.

**Regenerate before adopting graphql-orm 0.93.0.** The fix below needs the stream to select the change kind, and a module
generated earlier doesn't. `generate --check` fails on such a module, because the generated streams changed.

### Fixed: a child delete removed its parent

Since graphql-orm 0.93.0 (#290), deleting a child under a relation with `propagate_change = "up"` sends subscribers of the
parent an event with action `DELETED` and change kind `PROPAGATED`. The parent still exists, but the client removed it from the
store, so it disappeared from every open view until a read restored it.

- Generated streams now select the change kind where the type serves it, in the service's casing. This includes
  `liveSelection: "as-written"`, whose stream text otherwise stays as it was.
- `DELETED` with `PROPAGATED` keeps the record and reads the queries holding it again. Deleting N children sends N events, and
  they coalesce through `live.minRereadMs`.
- `DELETED` with `DIRECT` still removes the record.
- A service that doesn't serve the change kind, and a module generated before this release, keep the old behaviour: every
  `DELETED` removes the record.
- This was the only place an event's action removes a record. `client.subscribe` leaves a `DELETED` action to the application,
  so a hand-written subscription handler must check the change kind itself.

### Changed: streams compile from what they can carry (R2)

After regenerating, a stream selects key fields, the version and scalars with no arguments. It never selects `NodeId`, a
relation or a scalar with arguments. Queries re-read what the stream can't carry, which also catches a changed relation link. If
the server refuses that selection with `INVALID_INPUT`, the client uses keys only for its lifetime, and health keeps reason
`selection-refused`. `doctor` adds the verdicts `fallback-admitted` and `fallback-not-refused`.

- Composite keys need no `keys` setting. Their names come from `<Type>KeyInput` and their order from a held record's `NodeId`, by
  exact match, because introspection through the router doesn't give the order (graphql-orm#356). If no order matches, health shows
  `identity-mismatch`: that type opens no stream and polls.
- `key` mode reads key fields from the stored record, and no longer decodes `NodeId`.

### Changed: no lost events (R4)

- Replacing a stream starts the new one first and keeps the old one for `live.settleMs` (default 250 ms). An old stream closes only
  once a wanted stream covers every held record it covers.
- In `keys` mode a key keeps its chunk until released, so adding a key replaces one stream.
- **More requests:** a live query reads once more when its records first gain a stream. This narrows the first-read gap and
  doesn't close it, because nothing acknowledges a subscribe (graphql-orm#341).
- `SUBSCRIPTION_LIMIT_EXCEEDED` is now an outage on the ordinary back-off, not a five-minute refusal. Open streams stay, and
  uncovered records poll.
- Automatic re-reads share `live.minRereadMs` (default 2000 ms) per query, and pause while `polling.isActive()` is false. This also
  applies to the re-read after a restart or reconnect, which can now wait up to that long.

### Added

- `graphql-orm-client schema pull --url <router>`, and `--check` to detect drift without writing (R23). It writes sorted SDL and
  `<schema>.sha256`. Once that file exists, `generate --check` also fails on a hand-edited snapshot. Projects without it behave as
  before.
- `pnpm budgets` and its CI workflow (R22), in this repository only.

### Migration from alpha.9

1. Regenerate, then read the generator's warnings. Each names a fragment and field the stream now excludes, which that fragment's
   queries will re-read on an event.
2. To regenerate without the new stream selection, set `liveSelection: "as-written"` in the generator config. The change-kind
   fix still applies. An as-written stream selects `NodeId`, which a server before graphql-orm 0.92.0 refuses on an entity that has it, so
   those types get no live events there: use the default selection on those versions. Run on 0.90.1 (refused) and 0.93.0 (admitted).
3. To keep the old read count, set `live: { settleMs: false }`. Overlap stays on either way, at 250 ms.
4. If a re-read's timing matters, set `live.minRereadMs`.
5. Run `doctor` against the deployed identity to see which types fall back to keys only.
6. Check any hand-written subscription handler that removes a record on `DELETED`: it needs the change kind too.

## 0.1.0-alpha.9 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.9/graphql-orm-client-0.1.0-alpha.9.tgz`.
No artifact or generated-module change: no need to regenerate.

- **Behaviour change: refused streams back off by default (R6).** `live.refusalBackoff` is now on with no
  configuration. A refused stream waits five minutes, sends nothing for it meanwhile, and subscribes again and
  reads when the window ends. Every window now varies by 20% either way, including one you set. The queries holding it poll
  during the window (`polling.liveFallbackMs`, 30 s), so their records still refresh. `SUBGRAPH_UNAVAILABLE` joins
  the codes that are never refusals.

  To keep the behaviour you had: `live: { refusalBackoff: false }` for alpha.7 and alpha.8's ordinary back-off, or
  `live: { restart: false, refusalBackoff: false }` for alpha.5 and alpha.6's. To keep the window with no poll, set
  `polling: { liveFallbackMs: null }`, but that also turns off the poll for types with no stream. An application
  with its own back-off around `live.subscribe` should remove it.
- `graphql-orm-client doctor --url <router>` (R8) checks every document against the schema the router serves and
  opens each live stream briefly, for the identity whose credential you name. It prints `admitted`, `not-refused`,
  `refused <code>`, `missing`, `invalid` or `unknown` per type, and exits non-zero for all but the first two.
  `--strict` fails `not-refused` too. Credentials come only from named environment variables (`--token-env`,
  `--header-env`). It runs introspection and subscriptions only, never a query for data or a mutation.

What it ran against: unit tests with mocks, and a real `graphql-orm-router` 0.8.1 built from the
`graphql-orm-v0.90.1` tag, with real sockets and a test-owned subgraph that refuses like graphql-orm's source does.
Not run against a generated graphql-orm service. The refusal runs were on Node only.

Migration from alpha.8 (from an earlier version, follow its steps as well):

1. Decide about refused streams: the default now waits five minutes between attempts and polls meanwhile, where
   alpha.8 retried about once a minute with no poll. Set `live: { refusalBackoff: false }` to keep alpha.8's.
2. Expect polling reads for a refused type, every `polling.liveFallbackMs` (30 s) per query holding it, paused when
   the page is hidden. Past the router's 32 operations per connection, the extra streams count as refused too.
3. To see what your router refuses before you deploy, run `graphql-orm-client doctor`.

## 0.1.0-alpha.8 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.8/graphql-orm-client-0.1.0-alpha.8.tgz`.
No artifact or generated-module change: no need to regenerate.

- **Fix: a stream could stay down after a schema reload on Node (0.1.0-alpha.7).** The socket was closed while
  graphql-ws was still releasing the operation, which started its reconnect loop. On Node, where `ws` delivers
  the router's `error` and `complete` in one tick, 1 run in 8 then ended every restart as soon as it started.
  `graphqlWsSubscribe` now waits a task before closing. Not seen in headless Chromium, where alpha.7 recovered
  in 5 of 5 runs; if your client runs on Node, see [the design](docs/design.md#ended-streams).
- Live health (R7). `client.liveHealth()`, `client.subscribeLiveHealth(listener)` and, in the React bindings,
  `useLiveHealth(typename?)` report `live`, `unconfirmed`, `connecting`, `polling`, `refused`, `unavailable` or
  `idle` per type, with the reason, code, poll, times and fragments, and the socket's state. It works with no
  live layer.
- `graphqlWsTransport(ws)` gives `subscribe` and `connection`: spread it into `live`. It reports the socket, and
  a socket that recovers by itself reads the queries holding live records again, so you can remove a
  `refetchActive` call from graphql-ws's `connected` event. `graphqlWsSubscribe` is unchanged and still needs that
  call.
- **New console output:** a `@live` fragment that settles into `refused`, `unavailable` or `polling` warns once,
  naming the fragment, except where `process.env.NODE_ENV` is `production`. Pass `live: { onDiagnostic }` to send
  these elsewhere, or `null` to turn them off. A client with no `live` option uses the default.
- `client.live.status()` gains `lastEventAt`, `retryAt` and `confirmed`. Existing fields are unchanged. No
  regeneration needed.

- A test kit, `graphql-orm-client/test` (R20). `createMockNetwork({ schema, operations })` answers by
  operation name and fails anything unanswered or not valid for the schema. `createMockStreams({ schema })`
  is a `live.subscribe` with the router's frames: `emit`, `refuse`, `loseContinuity`, `reload`, `unavailable`,
  `fail`, `end`, and `reconnect` for a recovery the transport makes by itself. `createTestClock()` fills the
  `live`, `store` and `polling` timer seams. It needs `graphql`, which is already a peer dependency, and no
  test runner. Nothing else changes.

What it ran against: unit tests with mocks, and a real `graphql-orm-router` 0.8.1 built from the
`graphql-orm-v0.90.1` tag, with real sockets and a test-owned subgraph, on Node and in headless Chromium.
Not run against a generated graphql-orm service, or in Firefox or Safari. The test kit and the status API
were tested with mocks; the status states were also read during the router runs.

Migration from alpha.7 (from alpha.5 or alpha.6, follow alpha.7's steps as well):

1. Nothing is required. Update the archive URL.
2. Expect one console warning per fragment and reason for a `@live` fragment that can't stay live, outside
   production. Pass `live: { onDiagnostic }` to send them elsewhere, or `null` to turn them off. A test that fails
   on console output needs one of these.
3. Optional: replace `subscribe: graphqlWsSubscribe(ws)` with `...graphqlWsTransport(ws)`, and remove any
   `refetchActive` call from graphql-ws's `connected` event.

## 0.1.0-alpha.7 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.7/graphql-orm-client-0.1.0-alpha.7.tgz`.
No artifact or generated-module change: no need to regenerate.

- **Fix: a `@live` stream that ended stayed down, and data went stale with no sign of it.** A router
  schema reload, a socket out of retries or a plain `complete` left the stream closed, with nothing read,
  until the held records next changed, which they couldn't without a stream. Any end the client didn't ask
  for now restarts the type's streams and reads the queries that show the type. The first restart is within
  `live.resyncJitterMs`; repeated ends back off to about once a minute with jitter (`live.restart: { minMs,
  maxMs }`), and no change to the held records shortens the wait.
- **Fix: a schema reload no longer counts as a refusal** under `refusalBackoff`, on either channel, and
  neither does `SERVICE_UNAVAILABLE`, which is what a retired connection answers. In alpha.6 a reload of a
  quiet stream started a five-minute window.
- **Fix: a stream can come back after a schema reload.** The router pins a connection to its graph, and
  answers every new subscribe on a retired one with `SERVICE_UNAVAILABLE`. `graphqlWsSubscribe` now closes
  that socket through `ws.terminate()` once its last operation has ended, so the next subscribe gets a fresh
  connection. `GraphQLWsClientLike` gains an optional `terminate`.
- `client.live.status()` gains `restarting`, `restartAttempts` and `lastEnd` (`{ reason, code, at }`) per
  type. Existing fields are unchanged. New exports: `LiveEnd`, `LiveEndReason`, `StreamRestart`. `live` gains
  `restart` and a `now` test seam.
- A window under `refusalBackoff` now ends with a read of the queries that show the type.

**Known issue, found after publishing:** on Node, where `ws` delivers the router's `error` and `complete` in one
tick, 1 run in 8 stayed down after a schema reload. In headless Chromium it recovered in 5 of 5 runs. The fix is in
the next release.

What it ran against: unit tests with mocks, and a real `graphql-orm-router` 0.8.1 built from the
`graphql-orm-v0.90.1` tag, with real `graphql-ws` 6.4.1 sockets and a test-owned Node subgraph that speaks
graphql-transport-ws. Not run against a generated graphql-orm service; the frames the router forwards are
what was tested.

Migration from alpha.5 or alpha.6:

1. Nothing is required. Update the archive URL.
2. Expect more requests when streams fail: a type whose stream keeps ending now costs about one subscribe,
   and one read per query that shows it, a minute. A refused stream with no `refusalBackoff` is included;
   set `refusalBackoff: true` for one attempt in five minutes. Past the router's 32 operations per connection
   (its default; the client's `key` mode allows 50), the extra streams are refused with
   `SUBSCRIPTION_LIMIT_EXCEEDED` and count here too.
3. A retry that started on the next change to the held records now waits for its back-off. That includes
   `refusalBackoff: { types: { Type: false } }`, which now means the ordinary back-off and not retry on change.
4. Remove any retry, back-off or refetch you wrapped around `live.subscribe`. Keep calling
   `client.refetchActive()` from graphql-ws's `connected` event when `wasRetry` is true: a reconnect graphql-ws
   handles itself doesn't end the stream.
5. A custom `live.subscribe` that doesn't use `graphqlWsSubscribe` must open a fresh connection after
   `SUBSCRIPTION_SCHEMA_RELOAD`, or its restarts keep answering `SERVICE_UNAVAILABLE`.
6. To keep the old behaviour while you migrate, set `live: { restart: false }`. Ended streams then stay down
   until the held records change, and data can stay stale indefinitely. The reload and refusal fix still applies.

Documentation published with this release corrects 0.1.0-alpha.6: **the skills shipped in alpha.6 tell agents
to pass `store.scope` and `store.types` and to use a list updater, none of which exist,** and alpha.6's README,
design, contract and roadmap describe options that aren't built. Reinstall skills with
`graphql-orm-client skills install --target <target> --update`. Examples now use a neutral domain.

## 0.1.0-alpha.6 (2026-11-06)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.6/graphql-orm-client-0.1.0-alpha.6.tgz`.
No artifact or generated-module change.

- One-time secrets can stay out of the store (#11). `client.mutate(Mutation, variables, { policy:
  "no-store" })`, and `commit(variables, { policy: "no-store" })` in `useMutation`, return the full
  typed result and write none of the response into the store: not its unkeyed objects, and not keyed
  records in the same payload either, so no other view updates from it. Fragment references in the
  result still open. It is refused together with `optimisticResponse`, and an unknown `policy` throws.
  Default behaviour (`policy: "store"`) is unchanged. New type `MutationPolicy`.
- Back-off for refused streams (#13). `live: { refusalBackoff }`, off by default, remembers a stream
  the server refused (GraphQL errors answering the subscribe, or an error-only frame and then
  `complete`, before any event): no request for it for a window (`true` is five minutes), however
  often the held records change, then it subscribes again by itself. `{ ms, types: { Type: ms | true
  | false } }` sets a window per type and keeps a type on immediate retry with `false`. A stream is
  a type's `Changed` subscription, per record in `key` mode. `SUBSCRIPTION_CONTINUITY_LOST` and
  `SUBSCRIPTION_SOURCE_CLOSED` still restart at once, transport failures are never remembered, and
  disposing the client clears the memory. `client.live.status()` gains `backedOff`. New exports:
  `DEFAULT_REFUSAL_BACKOFF_MS`, `RefusalBackoff`. Default behaviour is unchanged.

## 0.1.0-alpha.5 (2026-11-04)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.5/graphql-orm-client-0.1.0-alpha.5.tgz`.
Regenerate the typed module (`graphql-orm-client generate`): artifacts gain `paged` and
`connection.offset`.

- Page-number navigation for offset connections. Mark a list field that takes graphql-orm's
  `PageInput` `@paged` and read it with `usePagedQuery(Query, variables, { pageIndex, pageSize,
  scope })`, or `client.watchPagedQuery` outside React. The client sets `Limit` and `Offset`,
  stores each page under its own variables, keeps records normalised across pages, and reports
  `totalCount`, `pageCount`, `hasNextPage`, `hasPreviousPage` and `placeholder`. The previous page
  stays on screen (`refreshing`) while another loads. Live events and polling update the visible
  page. `pageVariables` and `pagedState` are exported.
- `@connection` on an offset `PageInput` continues at the number of rows loaded.
- `client.query(Query, variables, { policy, signal })` reads a query outside React; complete stored
  data answers `store-or-network` without a request.
- Plain subscriptions: `client.subscribe` and `useSubscription` run an application's own
  subscription documents through `live.subscribe`, writing each event into the store.
  `live.artifacts` is now optional. An event without data reports an `OperationError` with its codes.
- `client.refetchQueries([...] | "active")`, and `mutate(..., { refetchQueries, signal })`.
- `useQuery`: `skip`, `refetch(variables)` (merged, and the query switches to them), and a new
  `idle` status for skipped queries (previously `loading`).
- Poll intervals belong to the handle that asked for them: a new `pollMs`, or none, replaces the
  old interval, and closing the handle stops it. Previously the shortest interval ever requested
  stayed for the query's lifetime.
- `useMutation` and `useRefetchableFragment` report GraphQL errors as `OperationError`, so
  `extensions.code` is available.
- Each `watchQuery` handle opens and closes at most once at a time.
- A request whose signal is already aborted is not sent.
- A live event's payload object is no longer left in the store until garbage collection.
- Documentation: a "Coming from Apollo" mapping in the design, and the effective-page-size gap in
  the graphql-orm contract.

## 0.1.0-alpha.4 (2026-11-03)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.4/graphql-orm-client-0.1.0-alpha.4.tgz`.
No artifact or API change.

- A query closed and reopened in the same tick fetches again. `close()` aborted the request but
  kept it as in flight, so the reopen waited on it and the query stayed `loading` with no error.
  React's StrictMode closes and reopens every effect on mount, so `useQuery` hung in development.
  A late result of an aborted request also no longer clears a newer request.

## 0.1.0-alpha.3 (2026-11-01)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.3/graphql-orm-client-0.1.0-alpha.3.tgz`.
Regenerate artifacts to use the new stream; older artifacts keep the previous behaviour.

- In `key` mode, a type holding more records than `maxKeyedSubscriptions` uses one stream of the
  type when the field's `Key` is optional, as graphql-orm generates it, instead of polling the
  rest. `maxKeyedSubscriptions: 0` always uses that stream.

## 0.1.0-alpha.2 (2026-11-01)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.2/graphql-orm-client-0.1.0-alpha.2.tgz`.
`RecordVersion` detection needs graphql-orm 0.87.0, and continuity recovery needs graphql-orm 0.88.0
(`workspace-2026.10.31.2`). With an earlier server both are inactive and everything else works.

- The live layer recovers from lost events. When graphql-orm (0.88.0) ends a `Changed` stream with
  `SUBSCRIPTION_CONTINUITY_LOST` or `SUBSCRIPTION_SOURCE_CLOSED`, it subscribes again after a
  random delay below `live.resyncJitterMs` (default 1 s), then refetches the queries that show
  that type. A stream that ends any other way is released and starts again on the next change to
  the held records; it used to stay counted as open.

- The compiler selects graphql-orm's `RecordVersion: Int!` (graphql-orm 0.87.0) on every type
  that has it, and the store orders writes by it, so managed versions need no `versions`
  configuration. `versions` still names another field for a type, and `null` turns it off.

## 0.1.0-alpha.1 (2026-10-31)

Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.1/graphql-orm-client-0.1.0-alpha.1.tgz`.
`@refetchable` needs graphql-orm 0.86.0 and graphql-orm-router 0.8.0 (workspace release
`workspace-2026.10.30.4`); everything else works with earlier versions.

- Built-in transport: `createHttpNetwork({ url, headers, fetch, credentials })` sends GraphQL
  over HTTP and throws `HttpError` for a response without a GraphQL body.
  `graphqlWsSubscribe(ws)` adapts a graphql-ws client for `live.subscribe`. graphql-ws stays
  the application's dependency; the adapter is checked against its types.
- `useMutation(Mutation)` in `graphql-orm-client/react`: `commit`, `inFlight` and `error`.
- `@refetchable` fragments. The compiler adds a `node(NodeId)` query to the fragment artifact
  (`fragment.refetch`, named `<Fragment>Refetch` or `queryName`). `client.refetchFragment` and
  `useRefetchableFragment` read one record again; a null result without errors removes it. The
  compiler refuses a type that doesn't implement `Node`, a schema without `node(NodeId)`,
  fragments that use operation variables, and name clashes. Needs graphql-orm 0.86.0 and
  graphql-orm-router 0.8.0.
- Records of a type with graphql-orm's generated `NodeId: ID!` are stored under the server's
  `NodeId`. The compiler selects it on such types and on `interface Node`, so composite and
  non-`Id` keys need no `keys` configuration. The encoding is tested against graphql-orm's
  shared vectors.

## 0.1.0-alpha.0 (2026-10-30)

First alpha. Install from the GitHub release archive:
`pnpm add https://github.com/Dastari/graphql-orm-client/releases/download/v0.1.0-alpha.0/graphql-orm-client-0.1.0-alpha.0.tgz`.

- Compiler: validates documents against the schema; adds `__typename` and key fields; emits operation text, a sha256 hash, masked reader selections, inlined normalisation selections, per-type keys and versions, and `@live` flags.
- Store: one record per NodeId, with storage keys per argument set and keyless objects kept under their parent. An older record version never replaces a newer one. Reads give masked fragment references with structural sharing. Subscriptions notify only affected readers. Retention and garbage collection, and synchronous disposal.
- Client: `execute`, shared `watchQuery`, `preload`, `mutate` and `readFragment`. Request cancellation on disposal.
- React: `ClientProvider`, `useQuery`, `useFragment` and `useFragmentList`.
- Optimistic mutations: `mutate(..., { optimisticResponse })` writes a layer that is rolled back field by field, never over a newer write.
- Polling: `pollMs` on `watchQuery` and `useQuery`. A live fallback polls queries showing `@live` records that no subscription covers. Polls pause while inactive.
- Pagination:
  - `@connection(key, paging)` merges pages into one stored list per filter. A cursor appends; a first-page refresh keeps the later pages.
  - `loadMore`, `hasMore` and `loadingMore` on `watchQuery` and `useQuery`.
  - The compiler adds the cursor and page-info fields, and strips client directives from the operation text.
- Generator:
  - `graphql-orm-client generate [--config] [--check]`, with `extractDocuments` and `generate` from `graphql-orm-client/compiler`.
  - Typed artifacts. Masked `FragmentRefs` types. Enum and input types. Union variants keyed by `__typename`.
  - `live` and `liveUnavailable` exports. A `graphql()` overload per exact document.
  - Router or subgraph SDL is accepted.
  - Typed `readFragment`, `useFragment` and `useFragmentList` refuse a reference from a different fragment.
- Live layer:
  - The compiler emits one subscription per type with `@live` fragments, and picks `keys`, `key` or `unkeyed` mode from the schema.
  - `LiveManager` keeps subscriptions open for exactly the held records and writes events into the store.
  - DELETED removes the record and refetches the queries that showed it.
  - Status reports overflow. `client.refetchActive()` is available for use after a reconnect.
- Design, graphql-orm contract, roadmap, agent guidance and four bundled skills.
