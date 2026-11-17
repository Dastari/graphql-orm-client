import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { watchFiles, type WatchOptions } from "../src/compiler/watch.js"

/** A stand-in for `fs.watch` that a test fires by hand. */
function fakeWatch() {
  const listeners: { directory: string; recursive: boolean; listener: (event: string, file: string | null) => void }[] = []
  const closed: string[] = []
  const watch: NonNullable<WatchOptions["watch"]> = (directory, { recursive }, listener) => {
    listeners.push({ directory, recursive, listener })
    return { close: () => void closed.push(directory), on: () => ({}) as never }
  }
  const fire = (directory: string, file: string | null) => {
    for (const entry of listeners) if (entry.directory === directory) entry.listener("change", file)
  }
  return { watch, fire, listeners, closed }
}

describe("watchFiles", () => {
  afterEach(() => void vi.useRealTimers())

  it("runs at the start, and once after a burst of changes settles", async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const run = vi.fn()
    const watching = watchFiles({ targets: [{ directory: "/src", recursive: true, accept: (file) => file.endsWith(".ts") }], run, onError: () => {}, debounceMs: 50, watch: fake.watch })
    await watching.idle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(fake.listeners).toMatchObject([{ directory: "/src", recursive: true }])
    for (let index = 0; index < 5; index++) {
      fake.fire("/src", "a.ts")
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    await watching.idle()
    expect(run).toHaveBeenCalledTimes(2)
    watching.close()
  })

  it("ignores a file the target doesn't accept, and counts a change with no file name", async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const run = vi.fn()
    const watching = watchFiles({ targets: [{ directory: "/src", recursive: true, accept: (file) => file !== "generated.ts" }], run, onError: () => {}, debounceMs: 5, watch: fake.watch })
    await watching.idle()
    fake.fire("/src", "generated.ts")
    await vi.advanceTimersByTimeAsync(20)
    expect(run).toHaveBeenCalledTimes(1)
    fake.fire("/src", null)
    await vi.advanceTimersByTimeAsync(20)
    await watching.idle()
    expect(run).toHaveBeenCalledTimes(2)
    watching.close()
  })

  it("reports a failed run and keeps watching", async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const errors: unknown[] = []
    let fails = true
    const run = vi.fn(() => {
      if (fails) throw new Error("bad document")
    })
    const watching = watchFiles({ targets: [{ directory: "/src", recursive: true, accept: () => true }], run, onError: (error) => errors.push(error), debounceMs: 5, watch: fake.watch })
    await watching.idle()
    expect(errors).toMatchObject([{ message: "bad document" }])
    fails = false
    fake.fire("/src", "a.ts")
    await vi.advanceTimersByTimeAsync(10)
    await watching.idle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
    watching.close()
  })

  it("never runs twice at once, and runs once more for changes made during a run", async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    let active = 0
    let most = 0
    let release: () => void = () => {}
    const run = vi.fn(async () => {
      active++
      most = Math.max(most, active)
      await new Promise<void>((resolve) => (release = resolve))
      active--
    })
    const watching = watchFiles({ targets: [{ directory: "/src", recursive: true, accept: () => true }], run, onError: () => {}, debounceMs: 5, watch: fake.watch })
    for (let index = 0; index < 3; index++) {
      fake.fire("/src", "a.ts")
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    release()
    await watching.idle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(most).toBe(1)
    watching.close()
  })

  it("stops on close, starting nothing new", async () => {
    vi.useFakeTimers()
    const fake = fakeWatch()
    const run = vi.fn()
    const watching = watchFiles({ targets: [{ directory: "/a", recursive: false, accept: () => true }, { directory: "/b", recursive: true, accept: () => true }], run, onError: () => {}, debounceMs: 5, watch: fake.watch })
    await watching.idle()
    fake.fire("/a", "x")
    watching.close()
    await vi.advanceTimersByTimeAsync(20)
    expect(run).toHaveBeenCalledTimes(1)
    expect(fake.closed.sort()).toEqual(["/a", "/b"])
  })
})

describe("generate --watch", () => {
  it("regenerates after a document or schema change, and reports an error without exiting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "generate-watch-"))
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "schema.graphql"), "type Query { hello: String }")
    writeFileSync(join(dir, "src/app.ts"), "graphql(`query Hello { hello }`)")
    writeFileSync(join(dir, "graphql-orm-client.config.json"), JSON.stringify({ schema: "schema.graphql", documents: ["src"], out: "src/generated.ts" }))
    const child = spawn(process.execPath, [resolve("bin/graphql-orm-client.mjs"), "generate", "--watch"], { cwd: dir })
    try {
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      const until = async (check: () => boolean, what: string) => {
        for (let waited = 0; !check(); waited += 25) {
          if (waited > 10_000) throw new Error(`Timed out waiting for ${what}.\nstdout: ${stdout}\nstderr: ${stderr}`)
          if (child.exitCode !== null) throw new Error(`The watch exited with ${child.exitCode}.\nstderr: ${stderr}`)
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      const generated = () => readFileSync(join(dir, "src/generated.ts"), "utf8")
      const writes = () => stdout.split("Wrote src/generated.ts").length - 1
      await until(() => writes() === 1, "the first generation")
      expect(generated()).toContain("HelloQuery")

      writeFileSync(join(dir, "src/app.ts"), "graphql(`query Hello { hello }`)\ngraphql(`query Again { hello }`)")
      await until(() => writes() === 2, "a document change")
      expect(generated()).toContain("AgainQuery")

      writeFileSync(join(dir, "src/app.ts"), "graphql(`query Broken { nothing }`)")
      await until(() => stderr.includes("nothing"), "the error")
      expect(child.exitCode).toBeNull()
      expect(generated()).toContain("AgainQuery")

      writeFileSync(join(dir, "schema.graphql"), "type Query { hello: String nothing: Int }")
      await until(() => writes() === 3, "a schema change")
      expect(generated()).toContain("BrokenQuery")

      // A directory moved in, then out, is one event for a name with no extension.
      mkdirSync(join(dir, "outside/feature"), { recursive: true })
      writeFileSync(join(dir, "outside/feature/page.ts"), "graphql(`query Moved { hello }`)")
      renameSync(join(dir, "outside/feature"), join(dir, "src/feature"))
      await until(() => writes() === 4, "a directory moved in")
      expect(generated()).toContain("MovedQuery")
      renameSync(join(dir, "src/feature"), join(dir, "outside/feature"))
      await until(() => writes() === 5, "a directory moved out")
      expect(generated()).not.toContain("MovedQuery")

      writeFileSync(join(dir, "src/notes.md"), "not a document")
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(writes()).toBe(5)
      expect(stdout).not.toContain("is current")
    } finally {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it("refuses --watch with --check", () => {
    const result = (() => {
      try {
        execFileSync(process.execPath, [resolve("bin/graphql-orm-client.mjs"), "generate", "--watch", "--check"], { encoding: "utf8", stdio: "pipe" })
        return { status: 0, stderr: "" }
      } catch (error) {
        return error as { status: number; stderr: string }
      }
    })()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--check")
  })
})
