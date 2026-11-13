# CI budgets

Run `pnpm install`, `pnpm exec playwright install --with-deps chromium`, then `pnpm budgets`.
This builds the package and runs independently of `pnpm check`. Node is launched with
`--expose-gc`. No generated schema, browser bundle or report is written into the repository.

Every threshold, its baseline and margin is in [limits.json](limits.json). Timings use the median
of five samples; every full command repeats these samples. A missing browser prints
"window budget not run" and fails. `pnpm budgets --skip-window` explicitly omits the window
measurement and reports INCOMPLETE, never PASS; it still enforces the remaining budgets.
CI installs Chromium and never uses this escape.

- Store: normalize 10,000 versioned rows in connection edges through the built writer; publish,
  read one masked fragment per row, then collect with no retention. Assert only the root remains.
  Heap is the delta after forced GC, with input and artifacts allocated before the baseline.
  Also measure the heap remaining after collection. These are retained JS bytes, not peak RSS.
- Live: the real built live manager, validated mock network and streams from the shipped test kit,
  100 retained rows and 100 individual fragment subscribers. Advance the test clock 10 ms per event
  for 100 events, with a different row changed on each. Measure wall and event-processing time,
  verify all final versions, and assert exactly 100 notifications across all subscribers.
  This measures a simulated 100 events/s, not socket throughput or React render time.
  The same workload runs again with 1,000 and 10,000 rows and as many subscribers, and reports the mean
  time inside one event's delivery (`eventMs1000`, `eventMs10000`). These exist to fail if an event
  goes back to costing a read of the whole list.
- Compiler: generate exactly 45,000 nonblank SDL lines at runtime (500 neutral entity types, Where
  inputs, connections, Changed events), and 250 documents: 125 live fragments plus 125 root queries.
  Time schema parsing/construction and the real compile together; validate artifact counts.
- Bundle: esbuild minifies each actual `pnpm build` entry (`dist/index.js` and
  `dist/react/index.js`) and follows its imports, then gzip level 9. React and GraphQL peers remain
  external, as in an application that supplies them. Every reachable package module is counted
  once per standalone entry; shared modules are counted in **both** reported standalone totals.
  Do not add the two totals to estimate an app importing both; there are no split chunks in this
  measurement. Declarations and compiler/test subpaths are excluded.
- Windows: serve a real page on loopback ports 43000–43099. Open the first page and use its
  `window.open` to open 2, then 5 pop-out tool windows (1, 3, 6 total).
  Each creates its own built client, retained 10,000-row query/store and graphql-ws client.
  A test-owned `ws` server acknowledges the protocol and counts actual open sockets; each page
  must also start a live subscription. It is not a graphql-orm service or router.
  Force Chromium GC via CDP; sum Runtime.getHeapUsage.usedSize over distinct V8 isolate IDs
  (same-process pop-outs can share an isolate, which must not be counted twice).
  Report totals and the larger incremental bytes/window of the 1→3 and 3→6 steps. This includes
  page/runtime and query snapshots as well as the store, but excludes native renderer memory,
  browser process RSS, GPU memory and server cost. No server event workload is run here.

The `files` allowlist in package.json excludes budgets and its dependencies are development-only.
Verify with `pnpm pack --dry-run`. The separate budgets workflow uploads the raw JSON report.
Baselines are from one machine, not a promise about other devices; do not update limits automatically
when a run fails.
