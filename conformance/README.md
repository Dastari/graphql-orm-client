# Real-server conformance

`pnpm conformance` builds a SQLite graphql-orm service and the real router,
then drives the client from `dist/` with assertions through HTTP and graphql-transport-ws. It is separate
from `pnpm check`. Requires Rust 1.97.1, Node 24 and pnpm. The auth-free service is
loopback-only test infrastructure; never deploy it.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright-core install --with-deps chromium
CONFORMANCE_SCRATCH=/path/outside/checkout pnpm conformance
```

Set `CHROME` to an existing Chromium executable. A missing executable prints
`NOT RUN`, not a pass; CI requires Chromium. A present executable that cannot launch
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
a new lock outside the repository for another tag. Adding a workflow matrix entry
runs that version against the same assertions; changed behaviour fails explicitly.
CI runs `graphql-orm-v0.90.1` and `graphql-orm-v0.93.0`. Do not describe another version as verified before running it.

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
against real router introspection and streams. `refused` uses `liveSelection: "as-written"` with a computed field, so no keys-only stream exists to fall back to. `fallback-not-refused` uses a computed field, so the server really refuses full and admits thin. Missing uses the real PageInfo type, which has no Changed stream. Invalid and
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
a federated field keyed on it. On 0.93.0 both are admitted: the fix is in the changelog for 0.92.0 (#312), which itself isn't run. Generated streams
don't select NodeId on either, and recovery runs on the generated stream unchanged.

Introspection through the router lists `SlotKeyInput` as `Name, Site`, while the service's SDL and its NodeId use
`Site, Name`. The suite pins this and proves that a real composite-key event reaches its record, written through
the service's `/slot` route with the repository's `update_by_key`.

## Local measurements

On Node 24.13.1, Rust 1.97.1 and Chromium 158.0.8127.18, a fresh Cargo target
built and installed the service/router in 114.4 seconds. Registry and git source
caches were already populated; this is not a fresh-machine download measurement.
Cached build/install runs took 10.8–30.2 seconds. A complete cached run, including
all 64 recovery cases and seven doctor verdicts, took 121.8 seconds on the final run
(an earlier complete run took 111 seconds). The workflow's
20-minute timeout allows for slower runners and downloads. GitHub Actions has not
been observed; these are local measurements.

R1 generates a default-mode project against the real schema, verifies Widget stream updates and
health, and that a keyless value type (the real PageInfo) stays out of it and doesn't poll. A keyed type with no stream is covered by mock tests: the service has none. The existing real 33-operation test pins router capacity.

## Bounded reads, aggregates and deleted references

R14 checks bounded and complete `readAll` traversal against the generated offset connection.
R15 holds two aliased count roots (including an aliased total) and a generated aggregate,
creates a row through a separate request, and waits for all three totals to advance.
The fixture opts Widget into generated aggregates; its existing row policy declares unrestricted
read visibility. R16 enables preimage delivery, holds a fragment reference, deletes its row
through the router, and checks the store, nullable fragment read and refreshed list.
React's still-mounted-row case runs in the unit suite; the router case uses the core reader.

R17 adds explicit String lifetime expiry and holder re-reads against the real service. The test
uses `Widget.Name` as an explicitly configured unix-seconds field for that scenario only; it does
not infer lifetime from a name or require server lifetime metadata. Chromium also exercises the
IndexedDB adapter across a page reload, stale restoration, identity separation and sensitive-result
exclusion. The application supplies the test schema/release envelope identifiers.

## Burst repair

A held Widget receives a burst of 1000 generated updates from eight concurrent workers,
with its Changed stream going through the real router. The fixture service uses an 8192-event
channel so this load tests the router buffer rather than overflowing the service bus; router
capacity is unchanged. The run logs delivered frame counts
and waits for a counted burst repair read and the final server version in the store. Loss is
timing-dependent, so the test does not require missing frames. Dropped-final-frame repair is
also exercised deterministically with the test kit.
