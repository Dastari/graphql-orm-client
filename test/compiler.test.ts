import { describe, expect, it } from "vitest"
import { CompileError, compile } from "../src/compiler/index.js"
import { compiled, documents, frags, ops, schema } from "./fixtures.js"

describe("compile", () => {
  it("adds __typename and key fields so every record can be identified", () => {
    const text = ops.FleetPage.text
    expect(text).toMatch(/Node \{\s+__typename\s+Id\s+\.\.\.DeviceRow/)
    expect(text).toMatch(/fragment DeviceRow on Device \{\s+__typename\s+Id\s+Name/)
    expect(text).not.toContain("@live")
  })

  it("sends every fragment an operation uses, once, and nothing else", () => {
    expect(Object.keys(ops.FleetPage.fragments)).toEqual(["DeviceRow", "OrganisationBadge"])
    expect(ops.FleetPage.text.match(/fragment DeviceRow/g)).toHaveLength(1)
    expect(ops.FleetPage.text).not.toContain("DeviceDetail")
  })

  it("keeps spreads masked for readers and inlined for the normaliser", () => {
    const node = JSON.stringify(ops.FleetPage.selections)
    expect(node).toContain('"kind":"spread","name":"DeviceRow"')
    expect(JSON.stringify(ops.FleetPage.normalization)).not.toContain('"kind":"spread"')
  })

  it("records keys, versions, possible types and @live", () => {
    expect(ops.SlotPage.keys.Slot).toEqual(["Site", "Name"])
    expect(ops.FleetPage.keys.PageInfo).toBeUndefined()
    expect(ops.DevicePage.versions.Device).toBe("RowVersion")
    expect(frags.DeviceRow.live).toBe(true)
    expect(frags.DeviceDetail.live).toBe(false)
    const search = ops.SearchPage.selections[0]
    expect(search?.kind === "link" && search.types).toEqual(["Device", "Organisation"])
  })

  it("hashes the operation text deterministically", () => {
    const again = compile(schema, documents, {
      keys: { Slot: ["Site", "Name"], PageInfo: null },
      versions: { Device: "RowVersion" },
    })
    expect(again.operations.FleetPage!.hash).toBe(ops.FleetPage.hash)
    expect(ops.FleetPage.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(compiled.operations.FleetPage!.hash).not.toBe(ops.DevicePage.hash)
  })

  it("rejects documents that do not match the schema", () => {
    expect(() => compile(schema, ["query Broken { Devices { Nope } }"])).toThrow(CompileError)
    expect(() => compile(schema, ["query { Devices { PageInfo { HasNextPage } } }"])).toThrow(/needs a name/)
    expect(() =>
      compile(schema, ["fragment A on Device { Name }", "fragment A on Device { Id }"])
    ).toThrow(/more than once/)
  })
})
