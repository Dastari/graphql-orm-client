import type { OperationArtifact, Selection } from "../artifact.js"
import { encodeNodeId, type KeyPart } from "../node-id.js"
import { storageKey, type Variables } from "./arguments.js"
import { ROOT_ID, type Store, type StoredRecord } from "./store.js"

export interface NormalizeContext {
  readonly keys: Readonly<Record<string, readonly string[]>>
  readonly versions: Readonly<Record<string, string>>
  readonly variables: Variables
}

export function contextOf(artifact: OperationArtifact, variables: Variables): NormalizeContext {
  return { keys: artifact.keys, versions: artifact.versions, variables }
}

/** The NodeId of an object in a response, or null when its type has no complete key in it. */
export function identify(
  value: Record<string, unknown>,
  keys: Readonly<Record<string, readonly string[]>>
): string | null {
  const typename = value.__typename
  if (typeof typename !== "string") return null
  const fields = keys[typename]
  if (!fields || fields.length === 0) return null
  const parts: KeyPart[] = []
  for (const field of fields) {
    const part = value[field]
    if (typeof part !== "string" && typeof part !== "number" && typeof part !== "boolean") return null
    parts.push(part)
  }
  return encodeNodeId(typename, parts)
}

/**
 * Write a response into the store. `rootId` is the record the selections start from (the root
 * record for operations, or an entity for a subscription payload).
 */
export function normalize(
  store: Store,
  selections: readonly Selection[],
  data: Record<string, unknown>,
  context: NormalizeContext,
  rootId: string = ROOT_ID,
  rootTypename = "Query"
): void {
  const root = store.getOrCreate(rootId, rootTypename)
  writeFields(store, root, rootTypename, selections, data, context, true)
}

/** False when the stored record is newer than the incoming one. */
function accepts(
  record: StoredRecord,
  value: Record<string, unknown>,
  versionField: string | undefined
): boolean {
  if (!versionField) return true
  const incoming = value[versionField]
  const stored = record.fields.get(versionField)
  if (typeof incoming !== "number" || typeof stored !== "number") return true
  return incoming >= stored
}

function writeFields(
  store: Store,
  record: StoredRecord,
  typename: string,
  selections: readonly Selection[],
  value: Record<string, unknown>,
  context: NormalizeContext,
  write: boolean
): void {
  for (const selection of selections) {
    switch (selection.kind) {
      case "scalar": {
        if (selection.fieldName === "__typename" || !(selection.responseKey in value)) break
        if (write)
          store.setField(
            record,
            storageKey(selection.fieldName, selection.args, context.variables),
            value[selection.responseKey]
          )
        break
      }
      case "link": {
        if (!(selection.responseKey in value)) break
        const key = storageKey(selection.fieldName, selection.args, context.variables)
        const child = value[selection.responseKey]
        if (child === null || child === undefined) {
          if (write) store.setField(record, key, null)
          break
        }
        if (selection.plural) {
          const refs = (child as unknown[]).map((item, index) =>
            item === null || item === undefined
              ? null
              : writeObject(store, `${record.__id}.${key}.${index}`, selection.selections, item as Record<string, unknown>, context)
          )
          if (write) store.setField(record, key, { __refs: refs })
        } else {
          const ref = writeObject(store, `${record.__id}.${key}`, selection.selections, child as Record<string, unknown>, context)
          if (write) store.setField(record, key, { __ref: ref })
        }
        break
      }
      case "inline": {
        if (selection.possibleTypes === null || selection.possibleTypes.includes(typename))
          writeFields(store, record, typename, selection.selections, value, context, write)
        break
      }
      case "spread":
        // Normalisation selections have every spread inlined by the compiler.
        throw new Error(`Unexpected fragment spread ${selection.name} in normalisation selections`)
    }
  }
}

function writeObject(
  store: Store,
  path: string,
  selections: readonly Selection[],
  value: Record<string, unknown>,
  context: NormalizeContext
): string {
  const typename = value.__typename
  if (typeof typename !== "string")
    throw new Error(`The response object at ${path} has no __typename; was it compiled?`)
  const id = identify(value, context.keys) ?? path
  const record = store.getOrCreate(id, typename)
  const write = accepts(record, value, context.versions[typename])
  // Older data never replaces newer data, but nested records carry their own versions.
  writeFields(store, record, typename, selections, value, context, write)
  return id
}
