import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

// The CLI imports dist, which test/global-setup.ts builds before any test file starts.
const bin = resolve("bin/graphql-orm-client.mjs")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(documents: readonly string[] | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "documents-entries-"))
  dirs.push(dir)
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "schema.graphql"), "type Query { Widgets: [Widget!]! } type Widget { Id: ID! Name: String! }")
  writeFileSync(join(dir, "src/page.ts"), "graphql(`query Widgets { Widgets { Name } }`)")
  writeFileSync(join(dir, "graphql-orm-client.config.json"), JSON.stringify({ schema: "schema.graphql", out: "src/gql.ts", ...(documents ? { documents } : {}) }))
  return (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8" })
}

describe("documents entries", { timeout: 30_000 }, () => {
  it("fails on a glob, naming it, because documents takes directories or files", () => {
    for (const command of [["generate"], ["generate", "--check"]]) {
      const result = project(["src/**/*.ts"])(...command)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('"src/**/*.ts"')
      expect(result.stderr).toContain("not globs")
    }
  })

  it("fails when no entry exists", () => {
    const result = project(["lib", "app"])("generate")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('"lib", "app"')
  })

  it("warns about a missing entry next to ones that exist, and still generates", () => {
    const result = project(["src", "packages/gone"])("generate")
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('documents entry "packages/gone" doesn\'t exist')
    expect(result.stdout).toContain("1 documents from 1 files")
  })

  it("leaves the default, a directory and a file as they were", () => {
    for (const documents of [undefined, ["src"], ["src/page.ts"]]) {
      const result = project(documents)("generate")
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("1 documents from 1 files")
    }
  })
})
