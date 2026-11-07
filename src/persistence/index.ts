import type { Client } from "../client.js"

/** Async string storage supplied by the consumer. Operations must complete atomically. */
export interface PersistenceAdapter {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
/** Persistence is disabled without an explicit nonempty identity key. */
export interface PersistenceOptions {
  readonly adapter: PersistenceAdapter
  readonly identityKey?: string
  readonly schemaHash: string
  /** Deployment revision supplied by the application; change on every server release. */
  readonly serverRelease: string
  /** UTF-8 payload budget, default 1 MiB. */
  readonly maxBytes?: number
  /** Coalescing delay, default 250 ms. */
  readonly throttleMs?: number
  readonly onDiagnostic?: (diagnostic: { code: string; message: string }) => void
}
/** Restore completion and explicit write boundary, useful before navigating away. */
export interface Persistence {
  readonly ready: Promise<void>
  flush(): Promise<void>
}
// Kept in sync with package.json; tested to prevent forgotten release updates.
/** Package revision written into every persistence envelope. */
export const PERSISTENCE_PACKAGE_VERSION = "0.1.0-alpha.11"
const queues = new WeakMap<PersistenceAdapter, Map<string, Promise<void>>>()
function serial(adapter: PersistenceAdapter, key: string, action: () => Promise<void>): Promise<void> {
  let map = queues.get(adapter)
  if (!map) { map = new Map(); queues.set(adapter, map) }
  const next = (map.get(key) ?? Promise.resolve()).then(action)
  const settled = next.catch(() => {})
  map.set(key, settled)
  void settled.then(() => { if (map!.get(key) === settled) map!.delete(key) })
  return next
}

/**
 * Attach opt-in persistence to one identity's client. Dispose the client on identity changes.
 * This entry point is separate from the main bundle. Failures are diagnostic-only.
 */
export function persistClient(client: Client, options: PersistenceOptions): Persistence {
  if (!options.identityKey) return { ready: Promise.resolve(), flush: async () => {} }
  if (!options.schemaHash || !options.serverRelease) throw new Error("Persistence needs schemaHash and serverRelease")
  const { adapter, identityKey, schemaHash, serverRelease } = options
  const key = `graphql-orm-client:${JSON.stringify(identityKey)}`
  const budget = options.maxBytes ?? 1048576
  const delay = options.throttleMs ?? 250
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(delay) || delay < 0 || delay > 2147483647) throw new Error("Invalid persistence budget or delay")
  const report = (code: string, error: unknown) => {
    try { options.onDiagnostic?.({ code, message: error instanceof Error ? error.message : String(error) }) } catch { /* diagnostics must not affect reads */ }
  }
  let stopped = client.store.isDisposed
  let timer: ReturnType<typeof setTimeout> | null = null
  let restoring = true
  let dirty = false
  const safeDelete = () => serial(adapter, key, () => adapter.delete(key)).catch(e => report("PERSISTENCE_DELETE", e))
  const flush = async () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (stopped || restoring || !dirty) return
    const records = client.store.persistenceSnapshot()
    if (!records) return
    dirty = false
    try {
      const payload = JSON.stringify({ format: 1, packageVersion: PERSISTENCE_PACKAGE_VERSION, identityKey, schemaHash, serverRelease, records })
      if (new TextEncoder().encode(payload).length > budget) {
        report("PERSISTENCE_SIZE", "Snapshot exceeds persistence budget")
        await safeDelete(); return
      }
      await serial(adapter, key, async () => { if (!stopped) await adapter.set(key, payload) })
    } catch (error) { report("PERSISTENCE_WRITE", error) }
  }
  const schedule = () => {
    dirty = true
    if (!stopped && !restoring && timer === null) timer = setTimeout(() => { timer = null; void flush() }, delay)
  }
  if (!stopped) client.store.observeWrites(schedule, () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    void safeDelete()
  })
  const restore = stopped ? () => {} : client.store.beginRestore()
  const ready = (async () => {
    try {
      const payload = await adapter.get(key)
      if (stopped || payload === null) return
      if (new TextEncoder().encode(payload).length > budget) throw new Error("Persisted payload exceeds budget")
      const envelope = JSON.parse(payload)
      if (envelope?.format !== 1 || envelope.packageVersion !== PERSISTENCE_PACKAGE_VERSION || envelope.identityKey !== identityKey || envelope.schemaHash !== schemaHash || envelope.serverRelease !== serverRelease) throw new Error("Persistence envelope mismatch")
      if (!Array.isArray(envelope.records) || !envelope.records.every(validRecord)) throw new Error("Corrupt persisted records")
      restore(envelope.records)
    } catch (error) {
      report("PERSISTENCE_RESTORE", error)
      if (!stopped) await safeDelete()
    } finally { restore([]); restoring = false; if (dirty && !stopped) schedule() }
  })()
  return { ready, flush: async () => { await ready; await flush() } }
}
function validRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false
  const r = record as { id?: unknown; typename?: unknown; fields?: unknown }
  return typeof r.id === "string" && typeof r.typename === "string" && Array.isArray(r.fields) && r.fields.every(f => Array.isArray(f) && f.length === 2 && typeof f[0] === "string" && validValue(f[1]))
}

/** Thin IndexedDB string adapter. Database errors reject and are handled by persistClient. */
export function indexedDBAdapter(name = "graphql-orm-client"): PersistenceAdapter {
  let database: Promise<IDBDatabase> | undefined
  const open = () => database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots")
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined }; resolve(request.result) }
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => reject(new Error("IndexedDB open blocked"))
  })
  const run = async (key: string, mode: IDBTransactionMode, value?: string, remove = false): Promise<string | null> => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", mode)
      const store = tx.objectStore("snapshots")
      const request = remove ? store.delete(key) : value === undefined ? store.get(key) : store.put(value, key)
      tx.oncomplete = () => resolve(typeof request.result === "string" ? request.result : null)
      tx.onerror = tx.onabort = () => reject(tx.error ?? request.error)
    })
  }
  return { get: key => run(key, "readonly"), set: async (key, value) => { await run(key, "readwrite", value) }, delete: async key => { await run(key, "readwrite", undefined, true) } }
}

function validValue(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true
  if (Array.isArray(value)) return value.every(validValue)
  const object = value as Record<string, unknown>
  if ("__ref" in object && typeof object.__ref !== "string") return false
  if ("__refs" in object && (!Array.isArray(object.__refs) || !object.__refs.every(v => v === null || typeof v === "string"))) return false
  return Object.values(object).every(validValue)
}
