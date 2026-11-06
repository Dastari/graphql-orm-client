import { describe, expect, it } from "vitest"
import { CompileError, compile } from "../src/compiler/index.js"
import { compiled, documents, frags, ops, schema } from "./fixtures.js"

describe("compile", () => {
  it("adds __typename and key fields so every record can be identified", () => {
    const text = ops.CatalogPage.text
    expect(text).toMatch(/Node \{\s+__typename\s+Id\s+\.\.\.WidgetRow/)
    expect(text).toMatch(/fragment WidgetRow on Widget \{\s+__typename\s+Id\s+Name/)
    expect(text).not.toContain("@live")
  })

  it("sends every fragment an operation uses, once, and nothing else", () => {
    expect(Object.keys(ops.CatalogPage.fragments)).toEqual(["VendorBadge", "WidgetRow"])
    expect(ops.CatalogPage.text.match(/fragment WidgetRow/g)).toHaveLength(1)
    expect(ops.CatalogPage.text).not.toContain("WidgetDetail")
  })

  it("keeps spreads masked for readers and inlined for the normaliser", () => {
    const node = JSON.stringify(ops.CatalogPage.selections)
    expect(node).toContain('"kind":"spread","name":"WidgetRow"')
    expect(JSON.stringify(ops.CatalogPage.normalization)).not.toContain('"kind":"spread"')
  })

  it("records keys, versions, possible types and @live", () => {
    expect(ops.SlotPage.keys.Slot).toEqual(["Site", "Name"])
    expect(ops.CatalogPage.keys.PageInfo).toBeUndefined()
    expect(ops.WidgetPage.versions.Widget).toBe("RowVersion")
    expect(frags.WidgetRow.live).toBe(true)
    expect(frags.WidgetDetail.live).toBe(false)
    const search = ops.SearchPage.selections[0]
    expect(search?.kind === "link" && search.types).toEqual(["Vendor", "Widget"])
  })

  it("hashes the operation text deterministically", () => {
    const again = compile(schema, documents, {
      keys: { Slot: ["Site", "Name"], PageInfo: null },
      versions: { Widget: "RowVersion" },
    })
    expect(again.operations.CatalogPage!.hash).toBe(ops.CatalogPage.hash)
    expect(ops.CatalogPage.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(compiled.operations.CatalogPage!.hash).not.toBe(ops.WidgetPage.hash)
  })

  it("rejects documents that do not match the schema", () => {
    expect(() => compile(schema, ["query Broken { Widgets { Nope } }"])).toThrow(CompileError)
    expect(() => compile(schema, ["query { Widgets { PageInfo { HasNextPage } } }"])).toThrow(/needs a name/)
    expect(() =>
      compile(schema, ["fragment A on Widget { Name }", "fragment A on Widget { Id }"])
    ).toThrow(/more than once/)
  })
})
