import type { OperationArtifact } from "./artifact.js"
import type { Client, GraphQLErrorLike } from "./client.js"
import type { LiveOptions } from "./live.js"
import type { Variables } from "./store/arguments.js"

/** A contiguous, increasing integer sequence declared by the application, never inferred. */
export interface StreamSequence<T, V, C> {
  /** Extract the sequence from one selected item. Must be a safe integer. */
  value(item: T): number
  /** Last sequence before the requested range; omitted means baseline at the first item. */
  readonly after?: number
  /** Extract an opaque resume cursor. Omit with `resume` when the service cannot replay. */
  cursor?(item: T): C
  /** Set the operation's resume variables using the last accepted cursor. */
  resume?(variables: V, cursor: C): V
}

/** Options for a volatile subscription; no response is normalized or persisted. */
export interface EphemeralOptions<D, T, V, C = unknown> {
  /** Select one item from each subscription response. */
  select(data: D): T
  /** Maximum items retained, required and positive. Oldest items are dropped and counted. */
  readonly bufferSize: number
  readonly sequence?: StreamSequence<T, V, C>
  /** Automatic retries in a row, default 8; an item arriving starts the count again. Refusals fail immediately. */
  readonly maxRetries?: number
}

/** Continuity describes observed sequence numbers, not server admission or future delivery. */
export interface EphemeralState<T, C = unknown> {
  readonly status: "connecting" | "open" | "reconnecting" | "ended" | "failed"
  readonly items: readonly T[]
  readonly cursor: C | undefined
  readonly sequence: number | undefined
  readonly continuity: "unprovable" | "observed" | "gap"
  /** First observed missing range; sticky until disposal. */
  readonly gap: { readonly expected: number; readonly received: number } | null
  /** Items evicted from the buffer, independent of transport continuity. */
  readonly dropped: number
  readonly error: Error | null
}

/** A stream with coalesced external-store notifications and an explicit lifetime. */
export interface EphemeralStream<T, C = unknown> {
  getState(): EphemeralState<T, C>
  subscribe(listener: () => void): () => void
  /** Start once. An ended, failed or disposed handle cannot restart. */
  open(): void
  /** Cancel transport and timers and synchronously erase items and cursor. */
  dispose(): void
}

const transient = new Set(["SUBSCRIPTION_CONTINUITY_LOST", "SUBSCRIPTION_SOURCE_CLOSED", "SUBSCRIPTION_SCHEMA_RELOAD", "SERVICE_UNAVAILABLE", "SUBGRAPH_UNAVAILABLE", "SUBSCRIPTION_LIMIT_EXCEEDED"])

/**
 * Create a bounded, volatile stream for data that doesn't belong in the store: progress, AI text deltas, terminal output, search
 * results. Call `open()` to subscribe and `dispose()` to erase it; it also ends with the client's identity. Imported from
 * `graphql-orm-client/streams`, so an application that doesn't use it doesn't bundle it.
 */
export function createStream<D, T, V extends Variables, C = unknown>(
  client: Client, artifact: OperationArtifact<D, V>, variables: V, options: EphemeralOptions<D, T, V, C>
): EphemeralStream<T, C> {
  let stream: EphemeralStream<T, C> | undefined
  const extension = client.liveExtension(() => stream?.dispose())
  try {
    stream = ephemeral(artifact, variables, options, extension.live, extension.remove)
    return stream
  } catch (error) {
    extension.remove()
    throw error
  }
}

function ephemeral<D, T, V extends Variables, C>(
  artifact: OperationArtifact<D, V>, variables: V, options: EphemeralOptions<D, T, V, C>,
  live: LiveOptions, release: () => void
): EphemeralStream<T, C> {
  if (artifact.kind !== "subscription") throw new Error(`${artifact.name} is not a subscription`)
  if (!Number.isSafeInteger(options.bufferSize) || options.bufferSize < 1) throw new RangeError("bufferSize must be a positive safe integer")
  const retries = options.maxRetries ?? 8
  if (!Number.isSafeInteger(retries) || retries < 0) throw new RangeError("maxRetries must be a nonnegative safe integer")
  const spec = options.sequence
  if (spec?.after !== undefined && !Number.isSafeInteger(spec.after)) throw new RangeError("sequence.after must be a safe integer")
  if (!!spec?.cursor !== !!spec?.resume) throw new Error("sequence.cursor and sequence.resume must be declared together")
  const after = live.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const cancel = live.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let state: EphemeralState<T, C> = { status: "connecting", items: [], cursor: undefined, sequence: spec?.after, continuity: spec ? "observed" : "unprovable", gap: null, dropped: 0, error: null }
  let snapshot = state
  const listeners = new Set<() => void>()
  let notification: unknown = null
  let retry: unknown = null
  let stop: (() => void) | undefined
  let connection: (() => void) | undefined
  let opened = false
  let disposed = false
  let terminal = false
  let generation = 0
  let attempts = 0
  let restarting = false
  const publish = () => {
    if (notification !== null || disposed) return
    // A frame-sized timer also works in Node and is driven by the live test clock.
    notification = after(() => {
      notification = null
      snapshot = state
      for (const listener of [...listeners]) listener()
    }, 16)
  }
  const halt = () => { generation++; stop?.(); stop = undefined }
  const finish = (status: "ended" | "failed", error: Error | null) => {
    terminal = true
    halt()
    connection?.(); connection = undefined
    if (retry !== null) cancel(retry)
    retry = null
    state = { ...state, status, error }
    publish()
  }
  const reconnect = (error: Error | null) => {
    if (disposed || terminal || retry !== null || restarting) return
    restarting = true
    try {
      halt()
      if (live.restart === false || attempts >= retries) return finish("failed", error ?? new Error("Stream retry limit reached"))
      const config = typeof live.restart === "object" ? live.restart : {}
      const min = Math.max(1, config.minMs ?? 1000)
      const max = Math.max(min, config.maxMs ?? 60_000)
      const delay = Math.max(1, Math.min(max, min * 2 ** Math.min(attempts++, 30)) * (0.5 + Math.random() * 0.5))
      state = { ...state, status: "reconnecting", error, continuity: state.gap ? "gap" : "unprovable" }
      publish()
      retry = after(() => { retry = null; start() }, delay)
    } finally { restarting = false }
  }
  const fail = (error: unknown, errors?: readonly GraphQLErrorLike[]) => {
    const reason = error instanceof Error ? error : new Error(errors?.[0]?.message ?? "Stream transport failed")
    if (errors?.length && !errors.every((entry) => transient.has(String(entry.extensions?.code)))) finish("failed", reason)
    else reconnect(reason)
  }
  const start = () => {
    if (disposed || terminal) return
    const current = ++generation
    const active = () => !disposed && !terminal && generation === current
    try {
      const nextVariables = spec?.resume && state.cursor !== undefined ? spec.resume(variables, state.cursor) : variables
      const dispose = live.subscribe({ kind: artifact.kind, name: artifact.name, text: artifact.text, hash: artifact.hash, variables: nextVariables }, {
        next(response) {
          if (!active()) return
          if (response.errors?.length) return fail(new Error(response.errors[0]!.message), response.errors)
          if (!response.data) return
          try {
            const item = options.select(response.data as D)
            const sequence = spec?.value(item)
            if (spec && !Number.isSafeInteger(sequence)) throw new Error("Stream sequence must be a safe integer")
            if (sequence !== undefined && state.sequence !== undefined && sequence <= state.sequence) return
            const gap = sequence !== undefined && state.sequence !== undefined && sequence !== state.sequence + 1
              ? state.gap ?? { expected: state.sequence + 1, received: sequence } : state.gap
            attempts = 0
            const items = [...state.items, item]
            const dropped = Math.max(0, items.length - options.bufferSize)
            state = { ...state, status: "open", items: dropped ? items.slice(dropped) : items, cursor: spec?.cursor ? spec.cursor(item) : undefined, sequence, gap, continuity: gap ? "gap" : spec?.resume ? "observed" : state.continuity, dropped: state.dropped + dropped, error: null }
            publish()
          } catch (error) { finish("failed", error instanceof Error ? error : new Error(String(error))) }
        },
        error(error) {
          if (!active()) return
          const errors = Array.isArray(error) ? error as GraphQLErrorLike[] : undefined
          fail(error, errors)
        },
        complete() { if (active()) finish("ended", null) },
      })
      if (active()) stop = dispose
      else dispose()
    } catch (error) { if (active()) fail(error) }
  }
  return {
    getState: () => snapshot,
    subscribe(listener) { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    open() {
      if (opened || disposed) return
      opened = true
      connection = live.connection?.subscribe(({ reconnected }) => {
        if (terminal || disposed) return
        if (reconnected || live.connection?.state() === "closed") reconnect(null)
      })
      start()
    },
    dispose() {
      if (disposed) return
      disposed = true
      halt(); connection?.(); connection = undefined
      if (retry !== null) cancel(retry)
      if (notification !== null) cancel(notification)
      retry = notification = null
      state = snapshot = { ...state, status: "ended", items: [], cursor: undefined, sequence: undefined, continuity: "unprovable", gap: null, dropped: 0, error: null }
      release()
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}
