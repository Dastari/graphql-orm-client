import type { LinkSelection, OperationArtifact, Selection } from "./artifact.js"
import { OperationError, refData, type Client } from "./client.js"
import type { Variables } from "./store/arguments.js"
import { identify } from "./store/normalize.js"

/** Node type selected by a root connection, preserving generated fragment references. */
export type ReadAllRow<T> = T extends object ? { [K in keyof T]: T[K] extends { Edges: readonly { Node: infer N }[] } ? N : never }[keyof T] : never

/**
 * Traverse one root @connection up to a required row limit. TotalCount must be selected.
 * Pages have no shared snapshot: moving rows are deduplicated by opaque record identity,
 * but concurrent writes can still cause omissions. The total is the last page's exact count.
 * Imported from `graphql-orm-client/read-all`, so an application that doesn't use it doesn't bundle it.
 */
export async function readAll<T, V extends Variables>(
  client: Client, artifact: OperationArtifact<T, V>, variables: V,
  options: { limit: number; pageSize?: number; signal?: AbortSignal }
): Promise<{ rows: ReadAllRow<T>[]; total: number; truncated: boolean }> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw new Error("readAll requires a positive integer limit")
  const pageSize = options.pageSize ?? options.limit
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error("readAll pageSize must be a positive integer")
  const roots = artifact.normalization.filter((s): s is LinkSelection => s.kind === "link" && !!s.connection)
  if (artifact.kind !== "query" || roots.length !== 1) throw new Error("readAll requires exactly one root @connection")
  const root = roots[0]!, spec = root.connection!
  const arg = root.args.find(a => a.name === spec.paging[0])
  if (arg?.kind !== "variable" || !spec.limit) throw new Error("readAll requires a compiled variable page input with a limit")
  const link = (selections: readonly Selection[], name: string) => selections.find((s): s is LinkSelection => s.kind === "link" && s.fieldName === name)
  const info = link(root.selections, spec.pageInfo), edges = link(root.selections, spec.edges)
  const total = info?.selections.find(s => s.kind === "scalar" && s.fieldName === "TotalCount")
  const node = edges && link(edges.selections, spec.node)
  const moreField = info?.selections.find(s => s.kind === "scalar" && s.fieldName === spec.hasNextPage)
  const cursorField = info?.selections.find(s => s.kind === "scalar" && s.fieldName === spec.endCursor)
  if (!info || !edges || !node || !total || total.kind !== "scalar") throw new Error("readAll requires Node and PageInfo.TotalCount selections")
  if (!moreField || moreField.kind !== "scalar" || (!spec.offset && !cursorField)) throw new Error("readAll requires selected continuation PageInfo fields")
  const rows = new Map<string, ReadAllRow<T>>()
  let next: Variables = { ...variables, [arg.variable]: { ...(variables[arg.variable] as object), [spec.limit]: Math.min(options.limit, pageSize), ...(spec.offset ? { [spec.offset]: 0 } : { [spec.after]: null }) } }
  let offset = 0
  const cursors = new Set<unknown>()
  for (;;) {
    const result = await client.executeResponse(artifact, next as V, { signal: options.signal })
    if (result.errors.length) throw new OperationError(artifact.name, result.errors)
    const connection = result.response[root.responseKey] as Record<string, any>
    const page = connection?.[info.responseKey]
    const count = page?.[total.responseKey]
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("readAll requires an exact TotalCount from the server")
    const batch = connection[edges.responseKey] as Record<string, any>[]
    const snapshot = (result.snapshot.data as any)[root.responseKey]
    const normalized = new Map<string, ReadAllRow<T>>()
    for (const edge of snapshot[edges.responseKey]) {
      const row = edge?.[node.responseKey]
      const id = refData(row)?.id ?? (row && identify(row, artifact.keys ?? {}))
      if (id) normalized.set(id, row)
    }
    for (const edge of batch) {
      const row = edge[node.responseKey]
      const id = row && identify(row, artifact.keys ?? {})
      if (!id || !normalized.has(id)) throw new Error("readAll requires normalised node identity")
      if (rows.size < options.limit || rows.has(id)) rows.set(id, normalized.get(id)!)
    }
    const more = page[moreField.responseKey]
    if (typeof more !== "boolean") throw new Error("readAll requires HasNextPage from the server")
    if (!more || rows.size >= options.limit) return { rows: [...rows.values()], total: count, truncated: more || count > rows.size }
    if (!batch.length) throw new Error("readAll pagination made no progress")
    offset += batch.length
    const cursor = cursorField?.kind === "scalar" ? page[cursorField.responseKey] : null
    if (!spec.offset && (cursor == null || cursors.has(cursor))) throw new Error("readAll pagination cursor made no progress")
    cursors.add(cursor)
    next = { ...next, [arg.variable]: { ...(next[arg.variable] as object), [spec.limit]: Math.min(options.limit - rows.size, pageSize), ...(spec.offset ? { [spec.offset]: offset } : { [spec.after]: cursor }) } }
  }
}
