import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { extractDocuments, generate } from "../src/compiler/index.js"
import { documents, schema } from "./fixtures.js"

const root = join(import.meta.dirname, "..")
const outDir = join(root, "test", "generated")

describe("extractDocuments", () => {
  it("finds graphql() templates and strings, and refuses interpolation", () => {
    const code = [
      "const A = graphql(`query A { Device(Id: \"x\") { Name } }`)",
      "const B = graphql(\n  \"fragment B on Device { Name }\"\n)",
      "notgraphql(`query C { x }`)",
    ].join("\n")
    expect(extractDocuments(code)).toEqual(['query A { Device(Id: "x") { Name } }', "fragment B on Device { Name }"])
    expect(() => extractDocuments("graphql(`query ${name} { x }`)")).toThrow(/interpolate/)
  })
})

describe("generate", () => {
  const options = {
    keys: { Slot: ["Site", "Name"], PageInfo: null },
    versions: { Device: "RowVersion" },
    importFrom: "../../src/index.js",
  }
  const source = generate(schema, documents, options)

  it("emits typed artifacts, live artifacts and graphql() overloads", () => {
    expect(source).toContain("export type DeviceRowFragment = {")
    expect(source).toContain('as unknown as FragmentArtifact<DeviceRowFragment, "DeviceRow">')
    expect(source).toContain("export type FleetPageVariables = { readonly Where?: DeviceWhereInput | null }")
    expect(source).toContain("export type DeviceWhereInput = { readonly Name?: StringFilter | null; readonly OrganisationId?: StringFilter | null }")
    expect(source).toContain("export const live = ")
    expect(source).toMatch(/export function graphql\(source: "fragment DeviceRow on Device @live \{/)
  })

  it("refuses a graphql() call with more than one definition", () => {
    expect(() => generate(schema, ["fragment A on Device { Name } fragment B on Device { Id }"])).toThrow(/exactly one/)
  })

  it("type-checks: masked roots, typed fragments, typed variables and overloads", () => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, "graphql.ts"), source)
    const fleetSource = documents.find((document) => document.startsWith("query FleetPage"))!
    writeFileSync(
      join(outDir, "usage.ts"),
      `import { DeviceDetailFragment, DeviceRowFragment, FleetPageQuery, OrganisationBadgeFragment, SearchPageQuery, graphql } from "./graphql.js"
import { readFragment, type Client } from "../../src/index.js"

declare const client: Client

export async function usage() {
  const fleet = graphql(${JSON.stringify(fleetSource)})
  const { snapshot } = await client.execute(fleet, { Where: { Name: { Eq: "a" } } })
  const edge = snapshot.data.Devices.Edges[0]!
  const cursor: string = edge.Cursor
  const total: number | null = snapshot.data.Devices.PageInfo.TotalCount
  const row = readFragment(DeviceRowFragment, edge.Node)
  const name: string = row.Name
  const org = row.Organisation ? readFragment(OrganisationBadgeFragment, row.Organisation) : null
  const display: string | undefined = org?.DisplayName
  // @ts-expect-error the root sees a masked reference, not the row's fields
  edge.Node.Name
  // @ts-expect-error a reference only opens the fragment that produced it
  readFragment(DeviceDetailFragment, edge.Node)
  // @ts-expect-error variables are typed
  await client.execute(FleetPageQuery, { Where: { Name: { Eq: 1 } } })
  const search = await client.execute(SearchPageQuery, { Text: "a" })
  for (const hit of search.snapshot.data.Search) {
    if (hit.__typename === "Device") {
      const deviceName: string = hit.Name
      void deviceName
    } else {
      const orgName: string = hit.DisplayName
      void orgName
    }
  }
  return [cursor, total, name, display]
}
`
    )
    writeFileSync(
      join(outDir, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.json", include: ["./*.ts"], compilerOptions: { noEmit: true } })
    )
    const tsc = join(root, "node_modules", ".bin", "tsc")
    let output = ""
    try {
      execFileSync(tsc, ["-p", join(outDir, "tsconfig.json")], { cwd: root, encoding: "utf8" })
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? error)
    }
    expect(output).toBe("")
  }, 60_000)
})
