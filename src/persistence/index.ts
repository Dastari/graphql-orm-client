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
  /**
   * UTF-8 payload budget, default 1 MiB. A store over it saves nothing, and its saved snapshot is deleted once; it is
   * saved again in full once it fits. While over, a flush serialises only the records written since the last one.
   */
  readonly maxBytes?: number
  /**
   * Oldest snapshot to restore, in milliseconds since it was last written. Default 7 days. An older snapshot, or one
   * whose time is later than now, is deleted and not restored. `Infinity` restores a snapshot of any age.
   */
  readonly maxAgeMs?: number
  /** Clock for `savedAt` and `maxAgeMs`, default `Date.now`. */
  readonly now?: () => number
  /** Coalescing delay, default 250 ms. */
  readonly throttleMs?: number
  /** Restore but never write or delete, for a secondary window such as a pop-out. `clear()` still deletes. */
  readonly readOnly?: boolean
  /** Delete the saved data when the client is disposed, as before this option. Only for an application with one window per identity. */
  readonly deleteOnDispose?: boolean
  readonly onDiagnostic?: (diagnostic: { code: string; message: string }) => void
}
/** Restore completion and explicit write boundary, useful before navigating away. */
export interface Persistence {
  readonly ready: Promise<void>
  flush(): Promise<void>
  /** Delete this identity's saved data and stop saving it, here and in its other windows. Call on sign-out. */
  clear(): Promise<void>
}
// Kept in sync with package.json; tested to prevent forgotten release updates.
/** Package revision written into every persistence envelope. */
export const PERSISTENCE_PACKAGE_VERSION = "0.1.0-alpha.12"
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
 * Attach opt-in persistence to one identity's client. Disposing the client keeps what's saved, because other windows
 * of the identity share it: call `clear()` on sign-out, then dispose. This entry point is separate from the main bundle.
 * Failures are diagnostic-only.
 */
export function persistClient(client: Client, options: PersistenceOptions): Persistence {
  if (!options.identityKey) return { ready: Promise.resolve(), flush: async () => {}, clear: async () => {} }
  if (!options.schemaHash || !options.serverRelease) throw new Error("Persistence needs schemaHash and serverRelease")
  const { adapter, identityKey, schemaHash, serverRelease, readOnly = false, deleteOnDispose = false } = options
  const key = `graphql-orm-client:${JSON.stringify(identityKey)}`
  const budget = options.maxBytes ?? 1048576
  const delay = options.throttleMs ?? 250
  const maxAge = options.maxAgeMs ?? 7 * 24 * 3600_000
  const now = options.now ?? Date.now
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(delay) || delay < 0 || delay > 2147483647) throw new Error("Invalid persistence budget or delay")
  if (!(maxAge > 0)) throw new Error("Invalid persistence maxAgeMs")
  const report = (code: string, error: unknown) => {
    try { options.onDiagnostic?.({ code, message: error instanceof Error ? error.message : String(error) }) } catch { /* diagnostics must not affect reads */ }
  }
  let stopped = client.store.isDisposed
  let timer: ReturnType<typeof setTimeout> | null = null
  let restoring = true
  let dirty = false
  const safeDelete = () => serial(adapter, key, () => adapter.delete(key)).catch(e => report("PERSISTENCE_DELETE", e))
  const stop = () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  // Another window's sign-out has to stop this one saving, or its next write would put the data back.
  const channel = () => typeof BroadcastChannel === "function" ? new BroadcastChannel(key) : null
  const windows = stopped ? null : channel()
  ;(windows as { unref?: () => void } | null)?.unref?.()
  if (windows) windows.onmessage = () => {
    stop()
    if (!readOnly) void safeDelete() // ordered after a write of ours that was already under way
  }
  // Each saved record's JSON is measured at the first flush after it's written, so a flush costs what changed. The text is kept
  // only while the snapshot fits, which bounds it by the budget; over budget the sizes alone say when it fits again.
  const sizes = new Map<string, number>()
  const texts = new Map<string, string>()
  const written = new Set<string>()
  let measured = false // the first flush measures every record, including any written before persistence was attached
  let recordBytes = 0
  let over = false
  const flush = async () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (stopped || restoring || !dirty || readOnly) return
    const store = client.store
    const records = store.persistenceSnapshot(measured ? written : undefined)
    if (!records) return
    dirty = false
    try {
      for (const id of written) { recordBytes -= sizes.get(id) ?? 0; sizes.delete(id); texts.delete(id) }
      written.clear()
      measured = true
      for (const record of records) {
        const text = JSON.stringify(record), bytes = utf8Length(text)
        sizes.set(record.id, bytes); recordBytes += bytes
        if (!over) texts.set(record.id, text)
      }
      const head = JSON.stringify({ format: 2, packageVersion: PERSISTENCE_PACKAGE_VERSION, identityKey, schemaHash, serverRelease, savedAt: now() }).slice(0, -1) + ',"records":['
      // The head, each record, a comma between records and the closing "]}".
      if (utf8Length(head) + recordBytes + Math.max(0, sizes.size - 1) + 2 > budget) {
        texts.clear()
        if (over) return
        over = true
        report("PERSISTENCE_SIZE", "Snapshot exceeds persistence budget; nothing is saved until it fits")
        await safeDelete(); return
      }
      if (over) {
        over = false
        for (const record of store.persistenceSnapshot(sizes.keys())!) texts.set(record.id, JSON.stringify(record))
      }
      const payload = head + [...texts.values()].join(",") + "]}"
      await serial(adapter, key, async () => { if (!stopped) await adapter.set(key, payload) })
    } catch (error) {
      // What was measured may be incomplete, so the next flush measures everything again.
      measured = false; sizes.clear(); texts.clear(); recordBytes = 0
      report("PERSISTENCE_WRITE", error)
    }
  }
  const schedule = () => {
    dirty = true
    if (!stopped && !restoring && !readOnly && timer === null) timer = setTimeout(() => { timer = null; void flush() }, delay)
  }
  if (!stopped) client.store.observeWrites(changed => { for (const id of changed) written.add(id); schedule() }, () => {
    stop()
    windows?.close()
    if (deleteOnDispose && !readOnly) void safeDelete()
  })
  const restore = stopped ? () => {} : client.store.beginRestore()
  const ready = (async () => {
    try {
      const payload = await adapter.get(key)
      if (stopped || payload === null) return
      if (payload.length > budget || utf8Length(payload) > budget) throw new Error("Persisted payload exceeds budget")
      const envelope = JSON.parse(payload)
      // Format 1, written up to 0.1.0-alpha.12, has no savedAt; it also carries an earlier packageVersion.
      if (envelope?.format !== 2 || envelope.packageVersion !== PERSISTENCE_PACKAGE_VERSION || envelope.identityKey !== identityKey || envelope.schemaHash !== schemaHash || envelope.serverRelease !== serverRelease) throw new Error("Persistence envelope mismatch")
      if (typeof envelope.savedAt !== "number" || !Number.isFinite(envelope.savedAt)) throw new Error("Persistence envelope has no savedAt")
      if (!Array.isArray(envelope.records) || !envelope.records.every(validRecord)) throw new Error("Corrupt persisted records")
      const age = now() - envelope.savedAt
      if (!(age >= 0 && age <= maxAge)) {
        report("PERSISTENCE_EXPIRED", age < 0 ? "Persisted snapshot was saved later than now" : "Persisted snapshot is older than maxAgeMs")
        if (!readOnly) await safeDelete()
        return
      }
      restore(envelope.records)
    } catch (error) {
      report("PERSISTENCE_RESTORE", error)
      if (!stopped && !readOnly) await safeDelete()
    } finally { restore([]); restoring = false; if (dirty && !stopped) schedule() }
  })()
  const clear = async () => {
    stop()
    windows?.close()
    // A channel of its own, because sign-out can run after the client was disposed.
    const others = channel()
    others?.postMessage("clear")
    others?.close()
    await safeDelete()
  }
  return { ready, flush: async () => { await ready; await flush() }, clear }
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

/** UTF-8 length without encoding. A lone surrogate counts 3 bytes, as TextEncoder writes U+FFFD for it. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

function validValue(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true
  if (Array.isArray(value)) return value.every(validValue)
  const object = value as Record<string, unknown>
  if ("__ref" in object && typeof object.__ref !== "string") return false
  if ("__refs" in object && (!Array.isArray(object.__refs) || !object.__refs.every(v => v === null || typeof v === "string"))) return false
  return Object.values(object).every(validValue)
}
