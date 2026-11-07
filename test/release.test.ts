import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { PERSISTENCE_PACKAGE_VERSION } from "../src/persistence/index.js"

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; files: string[] }
const changelog = readFileSync("CHANGELOG.md", "utf8")
const skills = readdirSync("skills").map((name) => ({ name, text: readFileSync(join("skills", name, "SKILL.md"), "utf8") }))

it("the version in package.json is in the changelog, with how to install it", () => {
  const heading = changelog.indexOf(`## ${pkg.version} `)
  expect(heading, `CHANGELOG.md needs a section for ${pkg.version}`).toBeGreaterThan(-1)
  const section = changelog.slice(heading, changelog.indexOf("\n## ", heading + 1))
  expect(section).toContain(`/v${pkg.version}/graphql-orm-client-${pkg.version}.tgz`)
})

it("anything unreleased sits above the released versions", () => {
  const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((match) => match[1]!)
  expect(headings.indexOf("Unreleased")).toBeLessThanOrEqual(0)
})

it("a persistence envelope carries the package's version", () => {
  expect(PERSISTENCE_PACKAGE_VERSION).toBe(pkg.version)
})

it("each shipped skill has a name matching its folder, and a description an agent can choose by", () => {
  for (const { name, text } of skills) {
    expect(text.match(/^name: (.+)$/m)?.[1]).toBe(name)
    const description = text.match(/^description: (.+)$/m)?.[1] ?? ""
    expect(description.length, `${name}'s description`).toBeGreaterThan(40)
    expect(description.length, `${name}'s description is a list, not a choice`).toBeLessThanOrEqual(400)
  }
})

it("shipped skills speak to the consumer, not to this project's planning", () => {
  for (const { name, text } of skills) {
    expect(text, `${name} mentions a requirement number`).not.toMatch(/\bR\d{1,2}\b/)
    expect(text, `${name} mentions the project's owner`).not.toMatch(/\bthe owner (must decide|decided|approved|accepted)/i)
  }
})
