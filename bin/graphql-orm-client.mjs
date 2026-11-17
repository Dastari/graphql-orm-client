#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { basename, dirname, extname, join, relative, resolve } from "node:path"

const usage = `graphql-orm-client generate [--config graphql-orm-client.config.json] [--check | --watch]
graphql-orm-client schema pull --url <router> [--token-env NAME] [--header-env name=NAME] [--check] [--config path]
                               [--allow-insecure-credentials]
graphql-orm-client doctor --url <router> [--ws-url <url>] [--token-env NAME] [--header-env name=NAME]
                          [--stream-ms 3000] [--strict] [--json] [--server-messages] [--allow-insecure-credentials]
                          [--config graphql-orm-client.config.json]
graphql-orm-client skills list
graphql-orm-client skills install --target agents|codex|claude [--update]`

/** A failure with an exit code. Thrown, so a watch can report one and carry on; the dispatch below exits with it. */
class CliError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.exitCode = code
  }
}

const [command, ...rest] = process.argv.slice(2)

try {
  if (command === "generate") await generateCommand(rest)
  else if (command === "schema" && rest[0] === "pull") await schemaPullCommand(rest.slice(1))
  else if (command === "doctor") await doctorCommand(rest)
  else if (command === "skills") skillsCommand(rest)
  else {
    console.log(usage)
    process.exit(command ? 1 : 0)
  }
} catch (error) {
  if (!(error instanceof CliError)) throw error
  console.error(error.message)
  process.exit(error.exitCode)
}

/**
 * Config (JSON):
 *   schema       path to the router SDL snapshot
 *   documents    directories or files to scan for graphql(...) calls (default ["src"])
 *   out          the generated module
 *   extensions   file extensions to scan (default [".ts", ".tsx"])
 *   keys, versions, identityFields, lifetimes, persistence, scalars, importFrom, functionName   see GenerateOptions
 */
async function generateCommand(args) {
  if (args.includes("--watch")) {
    if (args.includes("--check")) fail("--watch and --check don't go together: --check is for CI", 2)
    return watchCommand(args)
  }
  console.log(await generateOnce(args))
}

/** Generate once and say what happened; throws a CliError for a failure. */
async function generateOnce(args, { unchangedIsCurrent = false } = {}) {
  const { config, base, schema, sources, files, out } = await loadProject(args)
  const snapshotPath = resolve(base, config.schema)
  const tracked = existsSync(snapshotPath + ".sha256")
  const hash = tracked ? digest(readFileSync(snapshotPath, "utf8")) : null
  const { generate } = await import("../dist/compiler/index.js")
  let generated
  try {
    generated = generate(schema, sources, config)
  } catch (error) {
    fail(error.message)
  }
  if (tracked) generated = "// Schema snapshot sha256: " + hash + "\n" + generated
  const current = existsSync(out) ? readFileSync(out, "utf8") : ""
  if (args.includes("--check")) {
    if (current !== generated) fail(`${relative(base, out)} is out of date; run graphql-orm-client generate`)
    return `${relative(base, out)} is current (${sources.length} documents)`
  }
  // A watch leaves an unchanged module alone, so a dev server doesn't reload for nothing.
  if (unchangedIsCurrent && current === generated) return `${relative(base, out)} is current (${sources.length} documents)`
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, generated)
  return `Wrote ${relative(base, out)} (${sources.length} documents from ${files.length} files)`
}

/**
 * `generate --watch`: generate, then again after a document, the schema snapshot or the config changes. A failed run
 * prints its error and the watch carries on. The watched paths come from the config at the start, so a change to
 * `schema`, `documents` or `extensions` needs a restart.
 */
async function watchCommand(args) {
  const configPath = configPathOf(args)
  if (!existsSync(configPath)) fail(`No config at ${configPath}`)
  let config
  try { config = JSON.parse(readFileSync(configPath, "utf8")) }
  catch (error) { fail(`${configPath}: ${error.message}`) }
  if (!config.schema || !config.out) fail("The config needs `schema` and `out`")
  const base = dirname(configPath)
  const out = resolve(base, config.out)
  const extensions = config.extensions ?? [".ts", ".tsx"]
  const one = (path) => ({ directory: dirname(path), recursive: false, accept: (file) => file === basename(path) })
  const targets = [one(configPath), one(resolve(base, config.schema))]
  for (const entry of config.documents ?? ["src"]) {
    const path = resolve(base, entry)
    if (!existsSync(path)) console.error(`Not watching ${entry}: it doesn't exist`)
    else if (statSync(path).isFile()) targets.push(one(path))
    else targets.push({
      directory: path,
      recursive: true,
      accept: (file) => {
        const full = resolve(path, file)
        if (full === out || file.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith("."))) return false
        if (extensions.includes(extname(file))) return true
        // A directory moved in or out is one event for its name, whatever documents it holds.
        return !existsSync(full) || statSync(full).isDirectory()
      },
    })
  }
  const { watchFiles } = await import("../dist/compiler/watch.js")
  watchFiles({
    targets: targets.filter((target) => existsSync(target.directory)),
    run: async () => console.log(await generateOnce(args, { unchangedIsCurrent: true })),
    onError: (error) => console.error(error instanceof CliError ? error.message : error?.stack ?? String(error)),
  })
  console.log(`Watching ${relative(process.cwd(), configPath) || configPath}, its schema and its documents. Ctrl-C stops.`)
}

function configPathOf(args) {
  const configIndex = args.indexOf("--config")
  return resolve(configIndex >= 0 ? args[configIndex + 1] : "graphql-orm-client.config.json")
}

/** The config, its schema snapshot and the documents it names, for generate and doctor. */
async function loadProject(args) {
  const configPath = configPathOf(args)
  if (!existsSync(configPath)) fail(`No config at ${configPath}`)
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const base = dirname(configPath)
  if (!config.schema || !config.out) fail("The config needs `schema` and `out`")
  const { buildSchema } = await import("graphql")
  const { extractDocuments } = await import("../dist/compiler/index.js")
  const out = resolve(base, config.out)
  const extensions = config.extensions ?? [".ts", ".tsx"]
  const files = (config.documents ?? ["src"]).flatMap((entry) => walk(resolve(base, entry), extensions, out))
  const documentPaths = {}
  const sources = files.flatMap((file) => {
    try {
      const fileName = relative(base, file).split("\\").join("/")
      const documents = extractDocuments(readFileSync(file, "utf8"), config.functionName ?? "graphql", { fileName })
      for (const text of documents) (documentPaths[text] ??= []).push(relative(base, file).split("\\").join("/"))
      return documents
    } catch (error) {
      fail(`${relative(base, file)}: ${error.message}`)
    }
  })
  config.documentPaths = documentPaths
  const snapshotPath = resolve(base, config.schema)
  if (command === "generate" && args.includes("--check") && existsSync(snapshotPath + ".sha256") &&
      readFileSync(snapshotPath + ".sha256", "utf8") !== digest(readFileSync(snapshotPath, "utf8")) + "\n")
    fail(config.schema + " hash differs; run graphql-orm-client schema pull --url <router>, then graphql-orm-client generate")
  let schema
  try {
    // Router and subgraph SDL can carry federation directives the plain schema doesn't define.
    schema = buildSchema(readFileSync(resolve(base, config.schema), "utf8"), { assumeValidSDL: true })
  } catch (error) {
    fail(`${config.schema}: ${error.message}`)
  }
  return { config, base, schema, sources, files, out }
}

/**
 * Credentials come only from named environment variables, so they stay out of shell history and process
 * lists. Exit 0 when everything passed, 1 when something didn't or couldn't be tested, 2 for bad usage.
 */
async function doctorCommand(args) {
  const { value, url, headers } = endpointOptions(args)
  const streamMs = value("--stream-ms") === undefined ? 3000 : Number(value("--stream-ms"))
  if (!Number.isFinite(streamMs) || streamMs < 0) fail("--stream-ms takes a number of milliseconds", 2)
  const { config, schema, sources } = await loadProject(args)
  const { compile } = await import("../dist/compiler/index.js")
  const { formatDoctorReport, runDoctor } = await import("../dist/doctor/index.js")
  let compiled
  try {
    compiled = compile(schema, [...new Set(sources)], config)
  } catch (error) {
    fail(`The documents don't compile against the schema snapshot:\n${error.message}`)
  }
  const report = await runDoctor({
    url, wsUrl: value("--ws-url"), headers, compiled, streamMs, strict: args.includes("--strict"), serverMessages: args.includes("--server-messages"),
  })
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report))
  process.exit(report.passed ? 0 : 1)
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex")
}

function endpointOptions(args) {
  const values = (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
  const value = (flag) => values(flag)[0]
  for (const refused of ["--token", "--header", "--password"]) {
    if (args.includes(refused)) fail(`${refused} isn't accepted: put the credential in an environment variable and name it with ${refused === "--header" ? "--header-env name=NAME" : "--token-env NAME"}`, 2)
  }
  const url = value("--url")
  if (!url) fail("This command needs --url <router>", 2)
  const headers = {}
  const tokenEnv = value("--token-env")
  if (tokenEnv) {
    if (!process.env[tokenEnv]) fail(`The environment variable ${tokenEnv} is empty`, 2)
    headers.authorization = `Bearer ${process.env[tokenEnv]}`
  }
  for (const entry of values("--header-env")) {
    const at = entry?.indexOf("=") ?? -1
    if (at <= 0) fail("--header-env takes name=NAME", 2)
    const name = entry.slice(at + 1)
    if (!process.env[name]) fail(`The environment variable ${name} is empty`, 2)
    headers[entry.slice(0, at)] = process.env[name]
  }
  const endpoints = [["--url", url, ["http:", "https:"]]]
  if (value("--ws-url") !== undefined) endpoints.push(["--ws-url", value("--ws-url"), ["ws:", "wss:"]])
  for (const [flag, text, protocols] of endpoints) {
    const endpoint = URL.canParse(text) ? new URL(text) : null
    if (!endpoint) fail(`Invalid ${flag} endpoint`, 2)
    if (!protocols.includes(endpoint.protocol) || endpoint.username || endpoint.password)
      fail(`${flag} takes a ${protocols.join(" or ")} endpoint without embedded credentials`, 2)
    // A credential sent over http: or ws: can be read on the way. This machine is the exception.
    if (Object.keys(headers).length && ["http:", "ws:"].includes(endpoint.protocol) && !isLoopback(endpoint.hostname)) {
      const message = `a credential would be sent in clear text to ${endpoint.origin}`
      if (!args.includes("--allow-insecure-credentials"))
        fail(`Refused: ${message}. Use https: or wss:, or pass --allow-insecure-credentials for a network you trust.`, 2)
      console.error(`Warning: ${message}, as --allow-insecure-credentials allows.`)
    }
  }
  return { value, url, headers }
}

/**
 * Exactly `localhost`, a literal 127.0.0.0/8 address or `[::1]`. `URL` has already lowercased the name and written
 * IPv4 and IPv6 literals in their shortest form, so `127.1` and `[0:0:0:0:0:0:0:1]` arrive as `127.0.0.1` and `[::1]`.
 * Other names, `localhost.` and `*.localhost` among them, can be sent to a DNS server, so they don't count.
 */
function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname)
}

async function schemaPullCommand(args) {
  const { url, headers, value } = endpointOptions(args)
  const configPath = resolve(value("--config") ?? "graphql-orm-client.config.json")
  let config
  try { config = JSON.parse(readFileSync(configPath, "utf8")) }
  catch { fail("Cannot read project config", 2) }
  if (typeof config.schema !== "string") fail("The config needs `schema`", 2)
  const path = resolve(dirname(configPath), config.schema)
  const { readServedSchema } = await import("../dist/doctor/index.js")
  const { lexicographicSortSchema } = await import("graphql")
  // The same text with graphql 16 and 17, so the snapshot and its hash don't depend on the installed version.
  const { printSchemaStable } = await import("../dist/compiler/print.js")
  let snapshot
  try {
    snapshot = printSchemaStable(lexicographicSortSchema(await readServedSchema({ url, headers }))) + "\n"
    // A server may echo request credentials in descriptions. Never persist them.
    if (Object.values(headers).some((secret) => snapshot.includes(secret) || (secret.startsWith("Bearer ") && snapshot.includes(secret.slice(7)))))
      fail("Schema contains a credential value; snapshot not written")
  } catch (error) {
    if (error instanceof CliError) throw error
    fail("Schema: unknown. " + (error.schemaCode ?? "Introspection failed"), error.exitCode ?? 1)
  }
  const hash = digest(snapshot) + "\n"
  if (args.includes("--check")) {
    const differences = []
    if (!existsSync(path) || readFileSync(path, "utf8") !== snapshot) differences.push(config.schema)
    if (!existsSync(path + ".sha256") || readFileSync(path + ".sha256", "utf8") !== hash) differences.push(config.schema + ".sha256")
    if (differences.length) fail("Schema drift: " + differences.join(", ") + "; run graphql-orm-client schema pull --url <router>, then graphql-orm-client generate")
    console.log("Schema snapshot and hash match")
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, snapshot)
  writeFileSync(path + ".sha256", hash)
  console.log("Wrote " + config.schema + " and " + config.schema + ".sha256")
}

function walk(path, extensions, exclude) {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return extensions.includes(extname(path)) && path !== exclude ? [path] : []
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return []
    return walk(join(path, entry.name), extensions, exclude)
  })
}

function skillsCommand([action, ...args]) {
  const source = fileURLToPath(new URL("../skills/", import.meta.url))
  const names = readdirSync(source).filter((name) => existsSync(join(source, name, "SKILL.md")))
  if (!["list", "install"].includes(action)) {
    console.log(usage)
    process.exit(1)
  }
  if (action === "list") {
    for (const name of names) {
      const text = readFileSync(join(source, name, "SKILL.md"), "utf8")
      console.log(`${name}: ${/^description:\s*(.+)$/m.exec(text)?.[1] ?? ""}`)
    }
    return
  }
  const index = args.indexOf("--target")
  const target = index >= 0 ? args[index + 1] : "agents"
  if (!["agents", "codex", "claude"].includes(target)) fail("Choose --target agents, codex or claude")
  const destination = resolve(process.cwd(), target === "claude" ? ".claude/skills" : ".agents/skills")
  const conflicts = names.filter((name) => existsSync(join(destination, name)))
  if (conflicts.length && !args.includes("--update"))
    fail(`Skills already exist: ${conflicts.join(", ")}. Use --update to replace these graphql-orm-client skills.`)
  mkdirSync(destination, { recursive: true })
  for (const name of names) cpSync(join(source, name), join(destination, name), { recursive: true })
  console.log(`Installed ${names.length} graphql-orm-client skills into ${destination}. Existing project instructions were not changed.`)
}

function fail(message, code = 1) {
  throw new CliError(message, code)
}
