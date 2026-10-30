/**
 * Record identity across a federated graphql-orm graph.
 *
 * A `NodeId` is base64url (no padding) of the JSON array `[typename, ...keyParts]`. Entity keys
 * are only unique within a type, so the type name is part of the identity. Clients treat it as
 * opaque; only the client and graphql-orm encode or decode it.
 */
export type NodeId = string & { readonly __nodeId: unique symbol }

/** A complete-key value as it appears on the wire. */
export type KeyPart = string | number | boolean

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Encode a type name and its complete key, in primary-key order. */
export function encodeNodeId(typename: string, keyParts: readonly KeyPart[]): NodeId {
  if (!typename) throw new Error("A NodeId needs a type name")
  if (keyParts.length === 0) throw new Error(`A NodeId for ${typename} needs at least one key part`)
  return toBase64Url(JSON.stringify([typename, ...keyParts])) as NodeId
}

/** Decode a NodeId; null when it is malformed. */
export function decodeNodeId(
  value: string
): { typename: string; keyParts: KeyPart[] } | null {
  const json = fromBase64Url(value)
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length < 2) return null
  const [typename, ...keyParts] = parsed
  if (typeof typename !== "string" || typename === "") return null
  if (!keyParts.every((part) => ["string", "number", "boolean"].includes(typeof part))) return null
  return { typename, keyParts: keyParts as KeyPart[] }
}
