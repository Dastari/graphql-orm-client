import { describe, expect, it } from "vitest"
import { decodeNodeId, encodeNodeId } from "../src/node-id.js"

describe("NodeId", () => {
  it("round-trips single, composite and awkward keys", () => {
    for (const [typename, parts] of [
      ["Device", ["9b2c0f2e-1d1a-4f6e-9c1e-0a1b2c3d4e5f"]],
      ["Slot", ["north", "a"]],
      ["Organisation", ["acme:sub.team_1"]],
      ["Ticket", [42]],
      ["Note", ["ünïcødé ✓"]],
    ] as const) {
      const id = encodeNodeId(typename, parts)
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeNodeId(id)).toEqual({ typename, keyParts: [...parts] })
    }
  })

  it("matches graphql-orm's shared encoding vectors", () => {
    for (const [typename, parts, id] of [
      ["ManagedSlot", ["north", "a"], "WyJNYW5hZ2VkU2xvdCIsIm5vcnRoIiwiYSJd"],
      ["Ticket", [42], "WyJUaWNrZXQiLDQyXQ"],
      ["Note", ["ünïcødé ✓"], "WyJOb3RlIiwiw7xuw69jw7hkw6kg4pyTIl0"],
      ["Quote", ['say "hi"\\n'], "WyJRdW90ZSIsInNheSBcImhpXCJcXG4iXQ"],
    ] as const) {
      expect(encodeNodeId(typename, parts)).toBe(id)
      expect(decodeNodeId(id)).toEqual({ typename, keyParts: [...parts] })
    }
  })

  it("keeps the same key distinct across types", () => {
    expect(encodeNodeId("Device", ["x"])).not.toBe(encodeNodeId("DeviceLocation", ["x"]))
  })

  it("rejects malformed values", () => {
    for (const value of ["", "not base64!", btoa("not json"), btoa(JSON.stringify(["Device"])), btoa(JSON.stringify([1, "x"]))]) {
      expect(decodeNodeId(value)).toBeNull()
    }
  })

  it("refuses an empty type or key", () => {
    expect(() => encodeNodeId("", ["x"])).toThrow()
    expect(() => encodeNodeId("Device", [])).toThrow()
  })
})
