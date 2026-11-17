import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

/**
 * The CLI tests run bin/graphql-orm-client.mjs, which imports dist. A clean checkout has no dist and a working tree can hold a
 * stale one, so build it once here, before any test file starts. Building it in each file's beforeAll raced: test files run in
 * parallel, and one file's CLI could import dist while another's tsc was rewriting it.
 */
export default function setup(): void {
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"])
}
