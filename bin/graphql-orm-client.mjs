#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, extname, join, relative, resolve } from "node:path"

const usage = `graphql-orm-client generate [--config graphql-orm-client.config.json] [--check]
graphql-orm-client skills list
graphql-orm-client skills install --target agents|codex|claude [--update]`

const [command, ...rest] = process.argv.slice(2)

if (command === "generate") await generateCommand(rest)
else if (command === "skills") skillsCommand(rest)
else {
  console.log(usage)
  process.exit(command ? 1 : 0)
}

/**
 * Config (JSON):
 *   schema       path to the router SDL snapshot
 *   documents    directories or files to scan for graphql(...) calls (default ["src"])
 *   out          the generated module
 *   extensions   file extensions to scan (default [".ts", ".tsx"])
 *   keys, versions, scalars, importFrom, functionName   see GenerateOptions
 */
async function generateCommand(args) {
  const configIndex = args.indexOf("--config")
  const configPath = resolve(configIndex >= 0 ? args[configIndex + 1] : "graphql-orm-client.config.json")
  if (!existsSync(configPath)) fail(`No config at ${configPath}`)
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const base = dirname(configPath)
  if (!config.schema || !config.out) fail("The config needs `schema` and `out`")
  const { buildSchema } = await import("graphql")
  const { extractDocuments, generate } = await import("../dist/compiler/index.js")
  const out = resolve(base, config.out)
  const extensions = config.extensions ?? [".ts", ".tsx"]
  const files = (config.documents ?? ["src"]).flatMap((entry) => walk(resolve(base, entry), extensions, out))
  const sources = files.flatMap((file) => {
    try {
      return extractDocuments(readFileSync(file, "utf8"), config.functionName ?? "graphql")
    } catch (error) {
      fail(`${relative(base, file)}: ${error.message}`)
    }
  })
  let schema
  try {
    // Router and subgraph SDL can carry federation directives the plain schema doesn't define.
    schema = buildSchema(readFileSync(resolve(base, config.schema), "utf8"), { assumeValidSDL: true })
  } catch (error) {
    fail(`${config.schema}: ${error.message}`)
  }
  let generated
  try {
    generated = generate(schema, sources, config)
  } catch (error) {
    fail(error.message)
  }
  if (args.includes("--check")) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : ""
    if (current !== generated) fail(`${relative(base, out)} is out of date; run graphql-orm-client generate`)
    console.log(`${relative(base, out)} is current (${sources.length} documents)`)
    return
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, generated)
  console.log(`Wrote ${relative(base, out)} (${sources.length} documents from ${files.length} files)`)
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

function fail(message) {
  console.error(message)
  process.exit(1)
}
