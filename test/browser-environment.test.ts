import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const artifact = { kind: "query", name: "Page", text: "query Page { Notes { Id } }", hash: "h", selections: [], normalization: [], lists: [] }

// Bundled as a browser build would be, then run where there's no `process`, which is where the check used to go wrong.
// esbuild defines NODE_ENV itself for the browser platform, so "neutral" stands in for a bundler that leaves it alone.
async function inBrowser(define: Record<string, string>, platform: "browser" | "neutral" = "browser") {
  const result = await build({
    stdin: { contents: `export { createClient } from "./src/client.ts"`, resolveDir: root, loader: "ts" },
    bundle: true, format: "iife", globalName: "lib", platform, mainFields: ["module", "main"], write: false, logLevel: "silent", define,
  })
  const warnings: string[] = []
  const context = vm.createContext({
    console: { warn: (message: string) => warnings.push(message), error: () => {}, log: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController, DOMException, TextEncoder, URL,
  })
  expect(vm.runInContext("typeof process", context)).toBe("undefined")
  vm.runInContext(result.outputFiles[0]!.text, context)
  const lib = vm.runInContext("lib", context) as { createClient(options: unknown): { watchQuery(...args: unknown[]): unknown; dispose(): void } }
  const watch = () => { const client = lib.createClient({ network: { execute: async () => ({ data: {} }) } }); try { client.watchQuery(artifact, {}, { pollMs: 100 }) } finally { client.dispose() } }
  return { watch, warnings }
}

describe("environment detection in a browser bundle", () => {
  it("a production bundle warns about an undeclared poll and keeps the page", async () => {
    const page = await inBrowser({ "process.env.NODE_ENV": '"production"' })
    expect(page.watch).not.toThrow()
    expect(page.warnings.join("\n")).toContain("@poll")
  })
  it("a development bundle throws", async () => {
    const page = await inBrowser({ "process.env.NODE_ENV": '"development"' })
    expect(page.watch).toThrow("@poll")
  })
  it("a bundle that doesn't define NODE_ENV warns, because it can't tell", async () => {
    const page = await inBrowser({}, "neutral")
    expect(page.watch).not.toThrow()
    expect(page.warnings.join("\n")).toContain("@poll")
  })
})
