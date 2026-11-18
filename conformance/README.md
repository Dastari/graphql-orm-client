# Real-server conformance

`pnpm conformance` builds a SQLite graphql-orm service and the real router,
then drives the client from `dist/` with assertions through HTTP and graphql-transport-ws. It is separate
from `pnpm check`. Requires Rust 1.97.1, Node 24 and pnpm. The auth-free service is
loopback-only test infrastructure; never deploy it.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright-core install --with-deps chromium firefox webkit
CONFORMANCE_SCRATCH=/path/outside/checkout pnpm conformance
```

Set `CHROME`, `FIREFOX` or `WEBKIT` to an existing executable for that browser. A missing executable prints
`NOT RUN`, not a pass; CI requires all three. A present executable that cannot launch
fails the run. `PORT_BASE` defaults to 42000 and must reserve five ports within
42000–42099. Runs are serial. Use a different base for concurrent invocations.
The runner creates its own temporary directory if `CONFORMANCE_SCRATCH` is absent.
Keep it to reuse Cargo output. Each invocation gets a separate runtime subdirectory. Check free disk first: allow at least 10 GB for a cold
build. Manifests, binaries, schema snapshots, descriptors, browser bundles and
doctor projects are written there, never into the checkout. Rust output is ignored
as an additional guard. The package's `files` allowlist excludes this directory.

The default fixture uses git tag `graphql-orm-v0.90.1` (revision `adfa608d`) and its
router 0.8.1. `service/Cargo.lock` pins its dependencies. `GRAPHQL_ORM_TAG` controls
both dependencies and the router; the runner creates a variant manifest and resolves
a new lock outside the repository for another tag. It reads the router version from what it installed and passes it to the suite as `ROUTER_VERSION`,
so assertions that differ by router version say which they expect. Adding a workflow matrix entry
runs that version against the same assertions; changed behaviour fails explicitly.
CI runs `graphql-orm-v0.90.1` and `v0.94.0` (router 0.8.1), `v0.126.0` (router 0.11.0) and `v0.170.0` (router 0.15.5, the
current release on 2026-11-17). Do not describe another version as verified before running it. 0.91.1 and 0.93.0 left the matrix
when 0.170.0 joined it: 0.91.1 behaves as 0.90.1 where the suite separates them (a stream selecting `NodeId` is refused, and a child
delete sends its parent nothing), and 0.93.0 as 0.94.0. 0.92.0 isn't run.

What the runner and suite change by version:

- **graphql-orm 0.143.0** made `schema_roots!` require a handwritten root's field names. The fixture's test-owned subscription root
  carries `#[graphql_orm_root_fields]` behind the `root-field-names` feature, which the runner turns on from 0.143.0. Earlier tags
  don't have the attribute.
- **Router 0.8.3** made `error` terminal (graphql-orm#339): a reload sends `error` alone. 0.8.1 sends `error`, then `complete`.
- **Router 0.9.0** signals a subscriber's lost frames with `SUBSCRIPTION_CONTINUITY_LOST` (graphql-orm#359). See [Burst repair](#burst-repair).
- **Router 0.9.1** keeps the subgraph's declaration order through composition (graphql-orm#356), so introspection lists `SlotKeyInput`
  as `Site, Name`, the order `NodeId` encodes. 0.8.1 lists `Name, Site`.
- **Router 0.11.0** turned introspection off by default (`INTROSPECTION_DISABLED`). The suite and the doctor read the schema through
  it, so the runner's router configuration sets `"introspection": true` from 0.11.0; its requests already carry a bearer, which
  introspection then needs. Router 0.8.1 refuses that field as unknown.

Set `GRAPHQL_ORM_LOG_INTERNAL_ERRORS=1`, as CI does, to see the cause of a service `INTERNAL_ERROR`. The service keeps its database in a file in the run's scratch directory, with one connection. It used `sqlite::memory:`, which lives in its one pool connection. sqlx 0.8.6 replaces that connection when its check on release fails (as after a cancelled request), after 10 idle minutes or after 30, and the new connection has an empty database. A CI run on 0.94.0 logged `no such table: widgets` right after the recovery groups, and an earlier local run's `UpdateVendor` failure was probably the same. Which of the three replaced the connection wasn't recorded.

The service uses neutral Widget, Vendor, composite-key Slot and Ticket entities. Ticket's relation to Vendor has `propagate_change = "up"`, so from 0.93.0 deleting a Ticket sends its Vendor a `DELETED` event with change kind `PROPAGATED`.
Widget has a managed version with an explicit SQL default; Ticket has a relation,
a computed Summary and a hand-written computed RecordVersion. The second subgraph
is deliberately a small Node federation extension, owning Widget.RemoteName through
the NodeId key and Vendor.RemoteName through the persisted Id key. The latter is
admitted and resolved per event; the NodeId-key variant follows NodeId's admission (see below). The source of entity events and all database writes is the Rust ORM.

R18 also preloads a query and mounts its handle later, asserting one HTTP read through the real router.

R13 seeds 200 Ticket/Vendor pairs and reads their related names through masked fragments.
The HTTP bridge counts requests forwarded to the real router: two parent pages and two
100-key relation chunks. Fixture rows are removed before the other list assertions.

Assertions cover empty Keys, keys/key/unkeyed streams, creation outside the held
keys, scalar admission, NodeId and computed/relation refusals, federation fetch
admission, delete preimage grants, managed versions, delayed server snapshots,
router node lookup, filter/sort/count/offset/keyset lists, schema reload frames,
a retired connection and the 32-operation limit. Continuity tests create lagged and
closed test-owned broadcast channels and use graphql-orm's actual
`continuity_events` adapter through the router. They do not claim to overflow the
global generated ORM event bus over a slow socket.

Recovery repeats reload, router kill and policy refusal followed by acceptance eight
times with both ws event scheduling modes. Browser reload and kill recovery each
repeat eight times. Browser HTTP reads use a bridge to the same router so that CORS
is independent of the WebSocket behaviour under test. Doctor invokes the built CLI
against real router introspection and streams. `refused` uses `liveSelection: "as-written"` with a computed field, so no keys-only stream exists to fall back to. `fallback-not-refused` uses a computed field, so the server really refuses full and admits thin. `polling` and `missing` use the real PageInfo type, which has no Changed stream: `polling` declares `@poll(reason)`, and `missing` declares none, with `strict.liveWithoutStream` lowered to `warn` so it generates. Invalid and
required-key unknown deliberately alter the local schema snapshot; they do not
simulate router responses. The required-key unknown path is a conservative doctor
classification, not evidence that generated Changed streams require keys. Admission uses a real ORM update, while empty Keys remains quiet.

## Fixture accommodations and known server gaps

On 0.90.1 the generated operation catalogue omits `ExpectedVersion` from managed
UpdateWidget and DeleteWidget metadata. Serving that catalogue unchanged makes
router startup fail with `authorization argument metadata is stale for
Mutation.DeleteWidget`. The test host fills argument declarations from the served
SDL, then uses the protocol crate to recompute descriptor fingerprints. This is a
fixture accommodation, not a fix in graphql-orm or the client. The descriptors are
fingerprinted, not cryptographically signed. Router JWTs use a fresh process-local
RSA key and JWKS endpoint; no credentials are committed.

The composite Slot is excluded from generated GraphQL mutations (repository writes
seed it). Otherwise the generated placeholder `gomCompositeKeyWritesUnavailable`
has no operation catalogue entry and the router rejects the descriptor.

A stream selecting NodeId is refused on 0.90.1 with `next { errors: [{ extensions: { code: "INVALID_INPUT" } }] }`, then `complete`, and so is
a federated field keyed on it. From 0.93.0 (run on 0.94.0, 0.126.0 and 0.170.0) both are admitted: the fix is in the changelog for 0.92.0 (#312), which itself isn't run. Generated streams
don't select NodeId on either, and recovery runs on the generated stream unchanged.

Introspection through router 0.8.1 lists `SlotKeyInput` as `Name, Site`, while the service's SDL and its NodeId use
`Site, Name`; from router 0.9.1 introspection lists `Site, Name`. The suite pins both and proves that a real composite-key event reaches its record, written through
the service's `/slot` route with the repository's `update_by_key`.

## Local measurements

On Node 24.13.1, Rust 1.97.1 and Chromium 158.0.8127.18, a fresh Cargo target
built and installed the service/router in 114.4 seconds. Registry and git source
caches were already populated; this is not a fresh-machine download measurement.
Cached build/install runs took 10.8–30.2 seconds. A complete cached run, including
all 64 recovery cases and seven doctor verdicts, took 121.8 seconds on the final run
(an earlier complete run took 111 seconds). The workflow's
30-minute timeout allows for slower runners and downloads. GitHub Actions has not
been observed; these are local measurements.

On 2026-11-17, with the same Node and Rust, the Node scenarios on each matrix tag took 3.5–5 minutes with cached builds, longer than
before because of the burst measurements below. Building the router at `graphql-orm-v0.170.0` into a target that held only the
service took 151 seconds. The browsers installed on that host couldn't launch (missing system libraries), so the browser
scenarios were reported `NOT RUN` locally and run only in CI.

R1 generates a default-mode project against the real schema, verifies Widget stream updates and
health, and that a keyless value type (the real PageInfo) stays out of it and doesn't poll. A keyed type with no stream is covered by mock tests: the service has none. The existing real 33-operation test pins router capacity.

## Bounded reads, aggregates and deleted references

R14 checks bounded and complete `readAll` traversal against the generated offset connection.
R28 sends a fragment with arguments, one passed as an operation variable and one left to its default, through the router,
which gets a copy of the fragment with the values written in, and reads the fragment with those values. Two spreads of one
fragment with different values under aliases are covered by mock tests, which execute the sent text with graphql-js: the
service has no entity field that takes arguments.
A keyset `@connection` loaded in three pages, the last partly filled, refreshes with one `{limit: 6}`
request on `refetch()` and on each live re-read, and a row created inside the range appears.
R15 holds two aliased count roots (including an aliased total) and a generated aggregate,
creates a row through a separate request, and waits for all three totals to advance.
The fixture opts Widget into generated aggregates; its existing row policy declares unrestricted
read visibility. R16 enables preimage delivery, holds a fragment reference, deletes its row
through the router, and checks the store, nullable fragment read and refreshed list.
React's still-mounted-row case runs in the unit suite; the router case uses the core reader.

R17 adds explicit String lifetime expiry and holder re-reads against the real service. The test
uses `Widget.Name` as an explicitly configured unix-seconds field for that scenario only; it does
not infer lifetime from a name or require server lifetime metadata. Each browser also exercises the
IndexedDB adapter across a page reload, stale restoration, identity separation and sensitive-result
exclusion. The application supplies the test schema/release envelope identifiers.

Two windows in one browser context share IndexedDB and BroadcastChannel, as a pop-out does. A `readOnly` window restores and writes nothing, disposing a plain window leaves what's saved, and `clear()` in one window deletes it and stops another saving it again.

The WebKit is Playwright's headless Linux build, which isn't Safari on iOS. A phone suspending a page or dropping its socket when the app goes to the background isn't covered in any browser.

## Burst repair

The suite measures bursts three ways:

- **A tight burst.** A test-owned `Burst(Count)` subscription in the fixture sends its frames as fast as the socket takes them, then
  completes: 1000 and 5000 frames, twice each, on a bare socket through the router. This is what overflowed router 0.8.1's buffers
  in graphql-orm#359. On router 0.8.1 (`graphql-orm-v0.90.1` and `v0.94.0`, ten runs of each size) about 30% arrived (288–422 of 1000,
  1414–1596 of 5000), the last frame among them, then `complete`: nothing said frames were missing. On routers 0.11.0 and 0.15.5
  every burst ended with an `error` frame carrying `SUBSCRIPTION_CONTINUITY_LOST` before any `next`. From router 0.9.0 the suite requires
  every frame or that code; before it, the counts are logged. Router 0.9.0 can't tell whose frames were dropped, so a loss ends every
  subscription open on the router with that code; the suite checks that a client holding a Widget sees its stream end as `lost`,
  restarts it, reads again and receives the next event. A run whose burst loses nothing prints `NOT RUN` for that check.
- **Generated events on bare sockets.** 1000 generated updates from eight concurrent workers, at about 80 writes a second, counted on
  a bare socket through the router and on one connected straight to the service at the same time. Every run on routers 0.8.1, 0.11.0
  and 0.15.5 delivered 1001 of 1001 through both. A generated frame carries the row as it is when the frame is sent, not as the write
  left it: the 1001 frames carried about 72 distinct versions, and the final row can arrive before the last frames do, so the count
  waits for two quiet seconds.
- **A client holding the row.** The same generated burst to a held Widget through `graphqlWsTransport`. The run waits for a counted
  burst repair read, or from router 0.9.0 for the stream to end as `lost` (a restart clears the burst window), then for the final
  server version in the store, and logs the frames delivered. Loss is timing-dependent, so the test doesn't require missing frames.
  Repeated six times each on 2026-11-17: router 0.8.1 lost frames once (963 of 1002, no signal; the burst read repaired it); routers
  0.11.0 and 0.15.5 lost frames three times in twelve, each time ending the stream with `SUBSCRIPTION_CONTINUITY_LOST`, after which the
  restart read reached the final row with no burst read. In the other runs every frame arrived and the burst read found nothing new.
  Dropped-final-frame repair is also exercised deterministically with the test kit.

The fixture service uses an 8192-event channel so these loads test the router rather than overflowing the service bus; router
capacity is unchanged.
