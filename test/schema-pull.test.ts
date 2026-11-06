import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildSchema, introspectionFromSchema } from "graphql"
import { assertReadOnly } from "../src/doctor/index.js"

const exec = promisify(execFile)
const bin = resolve("bin/graphql-orm-client.mjs")
const dirs: string[] = []
const servers: Server[] = []
// The command imports dist, which a clean checkout doesn't have and a working tree can hold a stale copy of.
beforeAll(() => {
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"])
}, 120_000)
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function project() {
  const dir = mkdtempSync(join(tmpdir(), "schema-pull-"))
  dirs.push(dir)
  writeFileSync(join(dir, "graphql-orm-client.config.json"), JSON.stringify({ schema: "schema.graphql", out: "generated.ts", documents: ["app.ts"] }))
  writeFileSync(join(dir, "schema.graphql"), "type Query { hello: String }")
  writeFileSync(join(dir, "app.ts"), 'graphql(`query Hello { hello }`)')
  return dir
}
async function run(dir: string, args: string[], env = {}) {
  try {
    const result = await exec(process.execPath, [bin, ...args], { cwd: dir, env: { ...process.env, ...env } })
    return { ...result, code: 0 }
  } catch (error: any) { return { stdout: error.stdout as string, stderr: error.stderr as string, code: error.code as number } }
}
async function server(reply: (req: any) => object, status = 200) {
  const s = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => body += c)
    req.on("end", () => {
      assertReadOnly(JSON.parse(body).query)
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(reply(req)))
    })
  })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  return "http://127.0.0.1:" + (s.address() as AddressInfo).port
}
const data = () => introspectionFromSchema(buildSchema("type Query { hello: String } type Widget { z: String a: Int }"))

describe("schema pull", () => {
  it("sorts server output, detects drift without writes, and tracks generated provenance", async () => {
    const dir = project()
    let reversed = false
    let drift = false
    const url = await server(() => {
      const result = drift ? introspectionFromSchema(buildSchema("type Query { hello: String added: Int }")) : data()
      if (reversed) (result.__schema.types as unknown[]).reverse()
      return { data: result }
    })
    const pull = ["schema", "pull", "--url", url]
    expect((await run(dir, pull)).code).toBe(0)
    const original = readFileSync(join(dir, "schema.graphql"), "utf8")
    const hash = readFileSync(join(dir, "schema.graphql.sha256"), "utf8")
    reversed = true
    expect((await run(dir, [...pull, "--check"])).code).toBe(0)
    expect((await run(dir, pull)).code).toBe(0)
    expect(readFileSync(join(dir, "schema.graphql"), "utf8")).toBe(original)
    expect((await run(dir, ["generate"])).code).toBe(0)
    expect((await run(dir, ["generate", "--check"])).code).toBe(0)
    writeFileSync(join(dir, "schema.graphql"), original + "# edited\n")
    const edited = await run(dir, ["generate", "--check"])
    expect(edited.code).toBe(1)
    expect(edited.stderr).toContain("schema pull")
    await run(dir, pull)
    drift = true
    const check = await run(dir, [...pull, "--check"])
    expect(check.code).toBe(1)
    expect(check.stderr).toContain("schema.graphql")
    expect(readFileSync(join(dir, "schema.graphql.sha256"), "utf8")).toBe(hash)
    expect(readFileSync(join(dir, "schema.graphql"), "utf8")).toBe(original)
    await run(dir, pull)
    const generated = await run(dir, ["generate", "--check"])
    expect(generated.code).toBe(1)
    expect(generated.stderr).toContain("run graphql-orm-client generate")
  })
  it("keeps legacy projects without a hash working", async () => {
    const dir = project()
    expect((await run(dir, ["generate"])).code).toBe(0)
    writeFileSync(join(dir, "schema.graphql"), "type Query { hello: String unused: Int }")
    expect((await run(dir, ["generate", "--check"])).code).toBe(0)
    expect(existsSync(join(dir, "schema.graphql.sha256"))).toBe(false)
  })
  it.each([401, 403, 4401])("reports auth code %s without echoing credentials", async (code) => {
    const dir = project()
    const secret = "secret-not-for-output"
    const url = await server(() => ({ errors: [{ message: secret, extensions: { code } }] }))
    const result = await run(dir, ["schema", "pull", "--url", url, "--token-env", "TEST_TOKEN"], { TEST_TOKEN: secret })
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("authentication")
    expect(result.stdout + result.stderr).not.toContain(secret)
    expect(existsSync(join(dir, "schema.graphql.sha256"))).toBe(false)
  })
  it("sends environment headers and never saves or prints credentials", async () => {
    const dir = project()
    const url = await server((req) => {
      expect(req.headers.authorization).toBe("Bearer secret-token")
      expect(req.headers["x-scope"]).toBe("secret-scope")
      return { data: data() }
    })
    const result = await run(dir, ["schema", "pull", "--url", url, "--token-env", "TEST_TOKEN", "--header-env", "x-scope=TEST_SCOPE"], { TEST_TOKEN: "secret-token", TEST_SCOPE: "secret-scope" })
    expect(result.code).toBe(0)
    const contents = result.stdout + result.stderr + readFileSync(join(dir, "schema.graphql")) + readFileSync(join(dir, "schema.graphql.sha256"))
    expect(contents).not.toContain("secret-token")
    expect(contents).not.toContain("secret-scope")
  })
  it("reports disabled introspection and unreachable as unknown with separate codes", async () => {
    const dir = project()
    const url = await server(() => ({ errors: [{ message: "introspection disabled" }] }))
    const disabled = await run(dir, ["schema", "pull", "--url", url])
    expect(disabled.code).toBe(5)
    expect(disabled.stderr).toContain("unknown")
    await new Promise<void>((r) => servers[0]!.close(() => r()))
    const unreachable = await run(dir, ["schema", "pull", "--url", url, "--check"])
    expect(unreachable.code).toBe(3)
    expect(unreachable.stderr).toContain("unknown")
  })
  it.each(["--token", "--header", "--password"])("refuses %s without echo", async (flag) => {
    const result = await run(project(), ["schema", "pull", "--url", "http://localhost", flag, "hidden-secret"])
    expect(result.code).toBe(2)
    expect(result.stderr).not.toContain("hidden-secret")
  })
})
