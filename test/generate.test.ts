import { buildSchema } from "graphql"
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
      "const A = graphql(`query A { Widget(Id: \"x\") { Name } }`)",
      "const B = graphql(\n  \"fragment B on Widget { Name }\"\n)",
      "notgraphql(`query C { x }`)",
    ].join("\n")
    expect(extractDocuments(code)).toEqual(['query A { Widget(Id: "x") { Name } }', "fragment B on Widget { Name }"])
    expect(() => extractDocuments("graphql(`query ${name} { x }`)")).toThrow(/interpolate/)
  })
})

describe("generate", () => {
  const options = {
    keys: { Slot: ["Site", "Name"], PageInfo: null },
    versions: { Widget: "RowVersion" },
    importFrom: "../../src/index.js",
  }
  const source = generate(schema, documents, options)

  it("emits typed artifacts, live artifacts and graphql() overloads", () => {
    expect(source).toContain("export type WidgetRowFragment = {")
    expect(source).toContain('as unknown as FragmentArtifact<WidgetRowFragment, "WidgetRow">')
    expect(source).toContain("export type CatalogPageVariables = { readonly Where?: WidgetWhereInput | null }")
    expect(source).toContain("export type WidgetWhereInput = { readonly Name?: StringFilter | null; readonly VendorId?: StringFilter | null }")
    expect(source).toContain("export const live = ")
    expect(source).toMatch(/export function graphql\(source: "fragment WidgetRow on Widget @live \{/)
  })

  it("refuses a graphql() call with more than one definition", () => {
    expect(() => generate(schema, ["fragment A on Widget { Name } fragment B on Widget { Id }"])).toThrow(/exactly one/)
  })

  it("type-checks: masked roots, typed fragments, typed variables and overloads", () => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, "graphql.ts"), source)
    const catalogSource = documents.find((document) => document.startsWith("query CatalogPage"))!
    writeFileSync(
      join(outDir, "usage.ts"),
      `import { WidgetDetailFragment, WidgetRowFragment, CatalogPageQuery, VendorBadgeFragment, SearchPageQuery, TicketRowFragment, TicketsPageQuery, graphql } from "./graphql.js"
import { readFragment, type Client } from "../../src/index.js"

declare const client: Client

export async function usage() {
  const catalog = graphql(${JSON.stringify(catalogSource)})
  const { snapshot } = await client.execute(catalog, { Where: { Name: { Eq: "a" } } })
  const edge = snapshot.data.Widgets.Edges[0]!
  const cursor: string = edge.Cursor
  const total: number | null = snapshot.data.Widgets.PageInfo.TotalCount
  const row = readFragment(WidgetRowFragment, edge.Node)
  const name: string = row.Name
  const vendor = row.Vendor ? readFragment(VendorBadgeFragment, row.Vendor) : null
  const display: string | undefined = vendor?.DisplayName
  // @ts-expect-error the root sees a masked reference, not the row's fields
  edge.Node.Name
  // @ts-expect-error a reference only opens the fragment that produced it
  readFragment(WidgetDetailFragment, edge.Node)
  // @ts-expect-error variables are typed
  await client.execute(CatalogPageQuery, { Where: { Name: { Eq: 1 } } })
  const search = await client.execute(SearchPageQuery, { Text: "a" })
  for (const hit of search.snapshot.data.Search) {
    if (hit.__typename === "Widget") {
      const widgetName: string = hit.Name
      void widgetName
    } else {
      const orgName: string = hit.DisplayName
      void orgName
    }
  }
  // A @paged query takes its variables without the page; the client sets Limit and Offset.
  const paged = client.watchPagedQuery(TicketsPageQuery, { Where: { State: { Eq: "open" } } }, { pageSize: 25 })
  const pageState = paged.getState()
  const pageCount: number | null = pageState.pageCount
  const firstTitle: string | undefined = pageState.data
    ? readFragment(TicketRowFragment, pageState.data.Tickets.Edges[0]!.Node).Title
    : undefined
  const pagedTotal: number | null | undefined = pageState.data?.Tickets.PageInfo.TotalCount
  return [cursor, total, name, display, pageCount, firstTitle, pagedTotal]
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

it("emits a schema fingerprint only when persistence is enabled", () => {
  const s = buildSchema(`type Query { value: String }`)
  expect(generate(s, [`query One { value }`])).not.toContain('export const schemaHash')
  expect(generate(s, [`query One { value }`], {persistence:true})).toMatch(/export const schemaHash = "[a-f0-9]{64}"/)
})
