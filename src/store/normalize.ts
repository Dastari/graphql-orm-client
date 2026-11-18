import type { LinkSelection, OperationArtifact, Selection } from "../artifact.js"
import { decodeNodeId, encodeNodeId, type KeyPart } from "../node-id.js"
import { argumentValue, fieldStorageKey, included, storageKey, type Variables } from "./arguments.js"
import { ROOT_ID, type Store, type StoredRecord } from "./store.js"

export interface NormalizeContext {
  /**
   * Loaded-range refresh boundaries, by `@connection` key: where the stored list's kept tail starts. Infinity replaces the
   * complete range. A connection not named here merges as a first page or a next page.
   */
  readonly connectionTails?: Readonly<Record<string, number>>
  readonly keys: Readonly<Record<string, readonly string[]>>
  readonly lifetimes?: OperationArtifact["lifetimes"]
  readonly versions: Readonly<Record<string, string>>
  /** Types whose version is a decimal integer, compared as a big integer. */
  readonly versionCompare?: OperationArtifact["versionCompare"]
  readonly variables: Variables
  /** Collects the ids of objects stored under a path because they have no key. */
  readonly embedded?: Set<string>
}

export function contextOf(artifact: OperationArtifact, variables: Variables): NormalizeContext {
  return { keys: artifact.keys, versions: artifact.versions, versionCompare: artifact.versionCompare, lifetimes: artifact.lifetimes, variables }
}

/**
 * The NodeId of an object in a response: the server's `NodeId` field when the object carries one for its own type,
 * else encoded from its key fields; null when its type has no complete key in it. A `NodeId` that names another type
 * is ignored, so one object can never be written over a record of another type.
 */
export function identify(
  value: Record<string, unknown>,
  keys: Readonly<Record<string, readonly string[]>>
): string | null {
  const typename = value.__typename
  if (typeof typename !== "string") return null
  if (typeof value.NodeId === "string" && decodeNodeId(value.NodeId)?.typename === typename) return value.NodeId
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
  store.configureLifetimes(context.lifetimes)
  const root = store.getOrCreate(rootId, rootTypename)
  writeFields(store, root, rootTypename, selections, data, context, true)
  store.wrote(root, selections, data, context.variables, false)
}

/** False when the stored record is newer than the incoming one. Versions that can't be compared accept the write. */
function accepts(
  record: StoredRecord,
  value: Record<string, unknown>,
  versionField: string | undefined,
  compare: "decimal" | undefined
): boolean {
  if (!versionField) return true
  const incoming = value[versionField]
  const stored = record.fields.get(versionField)
  if (compare === "decimal") {
    const next = decimal(incoming), previous = decimal(stored)
    return next === null || previous === null || next >= previous
  }
  if (typeof incoming !== "number" || typeof stored !== "number") return true
  return incoming >= stored
}

/**
 * A decimal integer version as a bigint, so a string past 2^53 compares exactly; null when it isn't one. A number past 2^53
 * has already lost its exact value in JSON parsing, so it's null too, and the write is accepted.
 */
function decimal(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null
  // A version is an integer of a few dozen digits at most; a longer string isn't one.
  return typeof value === "string" && /^-?\d{1,64}$/.test(value) ? BigInt(value) : null
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
    // What `@skip`/`@include` left out of the request isn't written, even if the response carries that key.
    if (!included(selection.conditions, context.variables)) continue
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
        if (selection.batch) break
        if (!(selection.responseKey in value)) break
        const key = fieldStorageKey(selection, context.variables)
        const child = value[selection.responseKey]
        if (child === null || child === undefined) {
          if (write) store.setField(record, key, null)
          break
        }
        if (selection.connection && !selection.plural) {
          const id = writeConnection(store, `${record.__id}.${key}`, selection, child as Record<string, unknown>, context, write)
          if (write) store.setField(record, key, { __ref: id })
          break
        }
        if (selection.plural) {
          const refs = (child as unknown[]).map((item, index) =>
            item === null || item === undefined
              ? null
              : writeObject(store, `${record.__id}.${key}.${index}`, selection.selections, item as Record<string, unknown>, context, write)
          )
          if (write) store.setField(record, key, { __refs: refs })
        } else {
          const ref = writeObject(store, `${record.__id}.${key}`, selection.selections, child as Record<string, unknown>, context, write)
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
  context: NormalizeContext,
  parent = true
): string {
  const typename = value.__typename
  if (typeof typename !== "string")
    throw new Error(`The response object at ${path} has no __typename; was it compiled?`)
  const id = identify(value, context.keys) ?? path
  if (id === path) context.embedded?.add(id)
  const record = store.getOrCreate(id, typename)
  const write = accepts(record, value, context.versions[typename], context.versionCompare?.[typename])
  // Older data never replaces newer data, but nested records carry their own versions.
  writeFields(store, record, typename, selections, value, context, write)
  // A record without a key under a parent refused as older came with that older write.
  if (write && (parent || id !== path)) store.wrote(record, selections, value, context.variables, id === path)
  return id
}

/** Stored on a connection record: how many edges the last first-page fetch returned. */
export const HEAD_LENGTH = "__headLength"

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
  context: NormalizeContext,
  parent: boolean
): string {
  const spec = selection.connection!
  const typename = value.__typename
  if (typeof typename !== "string") throw new Error(`The connection at ${id} has no __typename; was it compiled?`)
  context.embedded?.add(id)
  const record = store.getOrCreate(id, typename)
  const page = argumentValue(selection.args, spec.paging[0] ?? "", context.variables) as Record<string, unknown> | null | undefined
  const offset = spec.offset ? page?.[spec.offset] : undefined
  const tailFrom = context.connectionTails?.[spec.key]
  const appending = tailFrom === undefined && (spec.offset
    ? typeof offset === "number" && offset > 0
    : page?.[spec.after] !== undefined && page?.[spec.after] !== null)

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
    const tail = existing.slice(tailFrom ?? previousHead).filter((edge) => edge !== null && !fresh.has(edge))
    // Pages read one at a time can show a row twice when it moves between reads.
    merged = [...fresh, ...tail]
    keepPageInfo = tail.length > 0
    store.setField(record, HEAD_LENGTH, incoming.length)
  }
  store.setField(record, edgesKey, { __refs: merged })
  // The list's age restarts only when this response replaced every row it holds, under a parent the store accepted it for: a
  // next page, or a first page that kept the pages loaded after it, doesn't say the rows read earlier are still the list's rows.
  if (parent && !appending && !keepPageInfo) store.wrote(record, selection.selections, value, context.variables, true)

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
