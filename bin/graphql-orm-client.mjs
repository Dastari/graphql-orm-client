#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const source = fileURLToPath(new URL("../skills/", import.meta.url));
const names = readdirSync(source).filter((name) => existsSync(join(source, name, "SKILL.md")));
const [command, action, ...args] = process.argv.slice(2);
const usage =
  "graphql-orm-client skills list\ngraphql-orm-client skills install --target agents|codex|claude [--update]";

if (command !== "skills" || !["list", "install"].includes(action)) {
  console.log(usage);
  process.exit(command ? 1 : 0);
}

if (action === "list") {
  for (const name of names) {
    const text = readFileSync(join(source, name, "SKILL.md"), "utf8");
    console.log(`${name}: ${/^description:\s*(.+)$/m.exec(text)?.[1] ?? ""}`);
  }
  process.exit(0);
}

const index = args.indexOf("--target");
const target = index >= 0 ? args[index + 1] : "agents";
if (!["agents", "codex", "claude"].includes(target)) {
  console.error("Choose --target agents, codex or claude");
  process.exit(1);
}
const destination = resolve(process.cwd(), target === "claude" ? ".claude/skills" : ".agents/skills");
const conflicts = names.filter((name) => existsSync(join(destination, name)));
if (conflicts.length && !args.includes("--update")) {
  console.error(
    `Skills already exist: ${conflicts.join(", ")}. Use --update to replace these graphql-orm-client skills.`
  );
  process.exit(1);
}
mkdirSync(destination, { recursive: true });
for (const name of names) cpSync(join(source, name), join(destination, name), { recursive: true });
console.log(
  `Installed ${names.length} graphql-orm-client skills into ${destination}. Existing project instructions were not changed.`
);
