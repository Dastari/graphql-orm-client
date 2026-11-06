import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { gzipSync } from "node:zlib"
import os from "node:os"
import { performance } from "node:perf_hooks"
import { build } from "esbuild"
import { buildSchema } from "graphql"
import { compile } from "../dist/compiler/index.js"
import { Store, createClient, readFragment, fragmentSelector } from "../dist/index.js"
import { normalize, contextOf } from "../dist/store/normalize.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../dist/test/index.js"
import { artifacts, data, row, smallSDL, largeFixture } from "./fixtures.mjs"
import { measureWindows } from "./windows.mjs"

if (!global.gc) throw new Error("Run with --expose-gc")
const compiled = artifacts()
const operation = compiled.operations.TicketsPage
const fragment = compiled.fragments.TicketRow
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = {}
const samples = {}
async function measure(name, work) {
  const values = []
  for (let i = 0; i < 5; i++) values.push(await work())
  samples[name] = values
  results[name] = median(values)
}

const input = data(10000)
const context = contextOf(operation, {})
for (let i = 0; i < 5; i++) {
  const store = new Store()
  global.gc()
  const before = process.memoryUsage().heapUsed
  let start = performance.now()
  normalize(store, operation.normalization, input, context)
  store.publish()
  const write = performance.now() - start
  global.gc()
  const heap = process.memoryUsage().heapUsed - before
  // Read references and then each fragment, exactly as a table adapter would.
  const selector = { id: "client:root", selections: operation.selections, variables: {}, fragments: operation.fragments }
  let snapshot = store.lookup(selector)
  assert.equal(snapshot.data.Tickets.Edges.length, 10000)
  start = performance.now()
  let checksum = 0
  for (const edge of snapshot.data.Tickets.Edges) checksum += readFragment(fragment, edge.Node).Title.length
  const read = performance.now() - start
  assert.ok(checksum > 10000)
  snapshot = null
  start = performance.now()
  store.collect()
  const gc = performance.now() - start
  assert.equal(store.size, 1, "only ROOT_ID may remain after collection")
  global.gc()
  const afterGC = Math.max(0, process.memoryUsage().heapUsed - before)
  for (const [name, value] of Object.entries({ storeWriteMs: write, storeReadMs: read, storeCollectMs: gc,
    storeHeapBytes: heap, storeAfterGCBytes: afterGC })) (samples[name] ??= []).push(value)
  store.dispose()
}
for (const name of Object.keys(samples)) results[name] = median(samples[name])

await measure("burstMs", async () => {
  const streams = createMockStreams({ schema: smallSDL })
  const clock = createTestClock()
  const client = createClient({
    network: createMockNetwork({ schema: smallSDL, respond: () => ({ data: data(100) }) }),
    live: { artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  })
  const list = client.watchQuery(operation, {})
  list.open()
  await list.refetch()
  client.live.flush()
  const stream = streams.find("LiveTicket")[0]
  assert.ok(stream)
  let notifications = 0
  const stops = list.getState().data.Tickets.Edges.map(edge => {
    const { store, selector } = fragmentSelector(fragment, edge.Node)
    return store.subscribe(store.lookup(selector), () => notifications++)
  })
  const start = performance.now()
  let processingMs = 0
  // 100 changed records over one simulated second. The test clock avoids scheduler noise.
  for (let i = 0; i < 100; i++) {
    clock.advance(10)
    const eventStart = performance.now()
    stream.sink.next({ data: { TicketChanged: { __typename: "TicketChangedEvent",
      Action: "UPDATED", Ticket: row(i, 2) } } })
    processingMs += performance.now() - eventStart
  }
  const elapsed = performance.now() - start
  assert.equal(notifications, 100, "one notification per changed row; no fan-out to unchanged rows")
  for (const edge of list.getState().data.Tickets.Edges)
    assert.match(readFragment(fragment, edge.Node).Title, /-v2$/)
  results.burstNotifications = notifications
  ;(samples.burstProcessingMs ??= []).push(processingMs)
  stops.forEach(stop => stop())
  list.close()
  client.dispose()
  return elapsed
})
results.burstProcessingMs = median(samples.burstProcessingMs)

const fixture = largeFixture()
assert.equal(fixture.sdl.split("\n").length, 45000)
assert.equal(fixture.documents.length, 250)
await measure("compileMs", () => {
  const start = performance.now()
  const output = compile(buildSchema(fixture.sdl), fixture.documents)
  assert.equal(Object.keys(output.operations).length, 125)
  assert.equal(Object.keys(output.fragments).length, 125)
  return performance.now() - start
})
for (const [name, entry] of [["main", "dist/index.js"], ["react", "dist/react/index.js"]]) {
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, minify: true,
    platform: "browser", format: "esm", external: ["react", "react/*", "graphql", "graphql/*"] })
  const bytes = bundle.outputFiles[0].contents
  results[name + "RawBytes"] = bytes.length
  results[name + "GzipBytes"] = gzipSync(bytes, { level: 9 }).length
}
const windows = await measureWindows(compiled)
if (windows) {
  for (const entry of windows) {
    results["windows" + entry.windows + "HeapBytes"] = entry.heapBytes
    results["windows" + entry.windows + "Sockets"] = entry.sockets
  }
  results.windowMarginalHeapBytes = Math.max(
    (windows[1].heapBytes - windows[0].heapBytes) / 2,
    (windows[2].heapBytes - windows[1].heapBytes) / 3)
}
const limits = JSON.parse(await readFile(new URL("./limits.json", import.meta.url), "utf8"))
const failures = []
for (const [name, budget] of Object.entries(limits.budgets)) {
  if (!windows && (name.startsWith("window"))) continue
  if (!Number.isFinite(results[name])) failures.push(name + ": missing measurement")
  else if (results[name] > budget.max) failures.push(`${name}: ${results[name]} > ${budget.max}`)
}
console.log(JSON.stringify({ machine: { date: new Date().toISOString(), node: process.version,
  os: os.type() + " " + os.release(), cpu: os.cpus()[0].model, cpus: os.cpus().length,
  chromium: windows ? windows[0].browserVersion : null },
  results, samples, windows, status: windows ? (failures.length ? "FAIL" : "PASS") : "INCOMPLETE: window budget not run",
  failures }, null, 2))
if (failures.length) process.exitCode = 1
