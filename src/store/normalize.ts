import type { LinkSelection, OperationArtifact, Selection } from "../artifact.js"
import { encodeNodeId, type KeyPart } from "../node-id.js"
import { argumentValue, fieldStorageKey, storageKey, type Variables } from "./arguments.js"
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
        const key = fieldStorageKey(selection, context.variables)
        const child = value[selection.responseKey]
        if (child === null || child === undefined) {
          if (write) store.setField(record, key, null)
          break
        }
        if (selection.connection && !selection.plural) {
          const id = writeConnection(store, `${record.__id}.${key}`, selection, child as Record<string, unknown>, context)
          if (write) store.setField(record, key, { __ref: id })
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

/** Stored on a connection record: how many edges the last first-page fetch returned. */
const HEAD_LENGTH = "__headLength"

/**
 * Merge one page into a connection's stored list. A page that continues after a cursor is
 * appended. A first page replaces the head and keeps the pages loaded after it, so polling the
 * first page doesn't throw away what the user scrolled to.
 */
function writeConnection(
  store: Store,
  id: string,
  selection: LinkSelection,
  value: Record<string, unknown>,
  context: NormalizeContext
): string {
  const spec = selection.connection!
  const typename = value.__typename
  if (typeof typename !== "string") throw new Error(`The connection at ${id} has no __typename; was it compiled?`)
  const record = store.getOrCreate(id, typename)
  const page = argumentValue(selection.args, spec.paging[0] ?? "", context.variables) as Record<string, unknown> | null | undefined
  const appending = page?.[spec.after] !== undefined && page?.[spec.after] !== null

  const edgesSelection = findLink(selection.selections, spec.edges)
  const pageInfoSelection = findLink(selection.selections, spec.pageInfo)
  const others = selection.selections.filter(
    (entry) => !(entry.kind === "link" && (entry.fieldName === spec.edges || entry.fieldName === spec.pageInfo))
  )
  writeFields(store, record, typename, others, value, context, true)

  const edgesKey = edgesSelection ? fieldStorageKey(edgesSelection, context.variables) : spec.edges
  const existing = (record.fields.get(edgesKey) as { __refs?: (string | null)[] } | undefined)?.__refs ?? []
  const incoming = ((value[edgesSelection?.responseKey ?? spec.edges] as Record<string, unknown>[] | null) ?? []).map(
    (edge, index) => {
      const node = edge[spec.node] as Record<string, unknown> | null | undefined
      const nodeId = node ? identify(node, context.keys) : null
      const cursor = edge[spec.cursor]
      const edgeId = `${id}.edge:${nodeId ?? (typeof cursor === "string" ? cursor : index)}`
      return writeObject(store, edgeId, edgesSelection?.selections ?? [], edge, context)
    }
  )
  let merged: (string | null)[]
  let keepPageInfo = false
  if (appending) {
    const seen = new Set(existing)
    merged = [...existing, ...incoming.filter((edge) => !seen.has(edge))]
  } else {
    const previousHead = typeof record.fields.get(HEAD_LENGTH) === "number" ? (record.fields.get(HEAD_LENGTH) as number) : existing.length
    const fresh = new Set(incoming)
    const tail = existing.slice(previousHead).filter((edge) => edge !== null && !fresh.has(edge))
    merged = [...incoming, ...tail]
    keepPageInfo = tail.length > 0
    store.setField(record, HEAD_LENGTH, incoming.length)
  }
  store.setField(record, edgesKey, { __refs: merged })

  if (pageInfoSelection) {
    const pageInfoKey = fieldStorageKey(pageInfoSelection, context.variables)
    const pageInfoValue = value[pageInfoSelection.responseKey] as Record<string, unknown> | null | undefined
    const previousRef = (record.fields.get(pageInfoKey) as { __ref?: string } | undefined)?.__ref
    const previous = previousRef ? store.get(previousRef) : undefined
    const kept = keepPageInfo && previous
      ? { endCursor: previous.fields.get(spec.endCursor), hasNextPage: previous.fields.get(spec.hasNextPage) }
      : null
    if (pageInfoValue) {
      const pageInfoId = writeObject(store, `${id}.${pageInfoKey}`, pageInfoSelection.selections, pageInfoValue, context)
      store.setField(record, pageInfoKey, { __ref: pageInfoId })
      // A head refresh that kept later pages continues from the last loaded page, not the head.
      const pageInfoRecord = store.get(pageInfoId)
      if (kept && pageInfoRecord) {
        store.setField(pageInfoRecord, spec.endCursor, kept.endCursor)
        store.setField(pageInfoRecord, spec.hasNextPage, kept.hasNextPage)
      }
    } else {
      store.setField(record, pageInfoKey, null)
    }
  }
  return id
}

function findLink(selections: readonly Selection[], fieldName: string): LinkSelection | undefined {
  for (const selection of selections) {
    if (selection.kind === "link" && selection.fieldName === fieldName) return selection
    if (selection.kind === "inline") {
      const found = findLink(selection.selections, fieldName)
      if (found) return found
    }
  }
  return undefined
}
