import type { BatchSpec, LinkSelection } from "./artifact.js"
import type { Client } from "./client.js"
import { encodeNodeId, type KeyPart } from "./node-id.js"
import { readSelections } from "./store/read.js"
import type { Variables } from "./store/arguments.js"

/**
 * Enable compiler-generated @batch relations for this client. Coalesces reads for 5 ms,
 * sharing normal records across queries. Install before opening queries. No effect on
 * documents without @batch. Dispose with the client; queued work checks identity disposal.
 *
 * Reading a relation can queue a request, so a read that happens while rendering can too. A queued request only ever reads, is
 * sent once per record however many renders ask, and writes nothing until after render. With no `document`, as when rendering on a
 * server, nothing is sent and the relation stays `pending`, because private reads must never run in server rendering.
 * `withoutDocument: "read"` allows it, for a non-browser client that means to.
 */
export function installRelationBatching(client: Client, options: { readonly withoutDocument?: "skip" | "read" } = {}): void {
  const canSend = () => options.withoutDocument === "read" || typeof document !== "undefined"
  const store = client.store
  if (store.relation) throw new Error("Relation batching is already installed")
  type Job = { selection: LinkSelection; variables: Variables; value: KeyPart; id: string; stateId: string; parents: Set<string> }
  const queued = new Map<string, Job>()
  const active = new Map<string, Job>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let refreshing = false
  store.refreshRelations = selector => {
    refreshing = true
    try { readSelections(store, selector, { inlineSpreads: true }) }
    finally { refreshing = false }
  }
  store.relation = (selection, parent, variables) => {
    const spec = selection.batch!
    const value = store.get(parent)?.fields.get(spec.foreignKey)
    if (value === null) return { status: "missing" }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return { status: "pending" }
    const id = encodeNodeId(selection.types[0]!, [value])
    const stateId = `client:batch:${spec.operation.hash}:${JSON.stringify(value)}`
    const snapshot = readSelections(store, { id, selections: selection.selections, variables, fragments: spec.operation.fragments }, { inlineSpreads: true })
    if (refreshing) {
      store.setField(store.getOrCreate(stateId, "BatchState"), "status", "stale")
      return { status: "pending", stateId }
    }
    const state = store.get(stateId)
    if (state?.fields.get("status") === "error") return { status: "error", stateId, error: state.fields.get("error") }
    if (!snapshot.missing && state?.fields.get("status") !== "stale") return { status: "ready", id, stateId }
    if (state?.fields.get("status") === "missing") return { status: "missing", stateId }
    if (store.collecting || !canSend()) return { status: "pending", stateId }
    const existing = queued.get(stateId) ?? active.get(stateId)
    if (existing) existing.parents.add(parent)
    else {
      queued.set(stateId, { selection, variables, value, id, stateId, parents: new Set([parent]) })
      timer ??= setTimeout(() => { timer = undefined; void flush() }, 5)
    }
    return { status: "pending", stateId }
  }
  async function flush(): Promise<void> {
    if (store.isDisposed) { queued.clear(); return }
    const groups = new Map<string, Job[]>()
    for (const job of queued.values()) {
      const key = `${job.selection.batch!.operation.hash}`
      const group = groups.get(key) ?? []
      group.push(job); groups.set(key, group); active.set(job.stateId, job)
    }
    queued.clear()
    await Promise.all([...groups.values()].map(async jobs => {
      const spec: BatchSpec = jobs[0]!.selection.batch!
      for (let offset = 0; offset < jobs.length; offset += spec.limit) {
        const chunk = jobs.slice(offset, offset + spec.limit)
        let error: unknown
        try {
          const result = await client.execute(spec.operation, { ...jobs[0]!.variables, Where: { [spec.key]: { InList: chunk.map(j => j.value) } }, Page: { Limit: spec.limit } })
          if (result.errors.length) error = result.errors
        } catch (cause) { error = cause }
        if (store.isDisposed) { active.clear(); return }
        for (const job of chunk) {
          const state = store.getOrCreate(job.stateId, "BatchState")
          const complete = !readSelections(store, { id: job.id, selections: job.selection.selections, variables: job.variables, fragments: spec.operation.fragments }, { inlineSpreads: true }).missing
          store.setField(state, "status", error ? "error" : complete ? "ready" : "missing")
          if (error) store.setField(state, "error", error)
          for (const parent of job.parents) store.touch(parent)
          active.delete(job.stateId)
        }
        store.publish()
      }
    }))
  }
}
