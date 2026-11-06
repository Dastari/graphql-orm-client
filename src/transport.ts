import { markNotSent } from "./outcome.js"
import type { GraphQLResponse, Network, OperationRequest } from "./client.js"
import type { LiveSocketState } from "./health.js"
import type { LiveConnection, SubscriptionSink } from "./live.js"

/** The server answered with an HTTP status and no GraphQL result. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`The GraphQL endpoint answered ${status}`)
    this.name = "HttpError"
  }
}

export interface HttpNetworkOptions {
  /** The router's GraphQL endpoint. */
  readonly url: string | URL
  /** Opt-in read bounds; omitted fields preserve the previous unlimited behaviour. */
  readonly reads?: { readonly deadlineMs?: number; readonly maxResponseBytes?: number }
  /** Independent write bounds. No request is automatically retried. */
  readonly writes?: { readonly deadlineMs?: number; readonly maxResponseBytes?: number }
  /** Defaults to the global `fetch`. Pass a wrapper for logging or additional bounds; mutation requests must never be retried. */
  readonly fetch?: typeof globalThis.fetch
  /** Extra headers, such as `authorization`; a function is called for every request. */
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  /** Defaults to `same-origin`. */
  readonly credentials?: RequestCredentials
}

/**
 * A `Network` that POSTs each operation as GraphQL over HTTP. A response with a GraphQL body is
 * returned as it is, whatever its status, so errors reach the caller with their codes. A
 * response without one throws `HttpError`.
 */
export function createHttpNetwork(options: HttpNetworkOptions): Network {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  return {
    async execute(request: OperationRequest, { signal }) {
      let extra: HeadersInit | undefined
      try {
        extra = typeof options.headers === "function" ? await options.headers() : options.headers
        if (signal?.aborted) throw signal.reason
      } catch (error) { throw markNotSent(error) }
      const bounds = request.kind === "mutation" ? options.writes : options.reads
      const boundedSignal = bounds?.deadlineMs === undefined ? signal
        : signal ? AbortSignal.any([signal, AbortSignal.timeout(bounds.deadlineMs)]) : AbortSignal.timeout(bounds.deadlineMs)
      const headers = new Headers(extra)
      headers.set("content-type", "application/json")
      headers.set("accept", "application/graphql-response+json, application/json;q=0.9")
      const response = await send(options.url, {
        method: "POST",
        headers,
        credentials: options.credentials ?? "same-origin",
        body: JSON.stringify({ operationName: request.name, query: request.text, variables: request.variables }),
        ...(boundedSignal ? { signal: boundedSignal } : {}),
      })
      let body: unknown
      if (bounds?.maxResponseBytes !== undefined) {
        const reader = response.body?.getReader()
        const chunks: Uint8Array[] = []
        let length = 0
        try {
          while (reader) {
            const next = await reader.read()
            if (next.done) break
            length += next.value.byteLength
            if (length > bounds.maxResponseBytes) throw new Error("GraphQL response exceeds configured byte limit")
            chunks.push(next.value)
          }
        } catch (error) { await reader?.cancel().catch(() => {}); throw error }
        const joined = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
        try { body = JSON.parse(new TextDecoder().decode(joined)) } catch { body = null }
      } else body = await response.json().catch(() => null)
      if (!isResponse(body) || (!response.ok && !body.errors?.length)) throw new HttpError(response.status)
      return body
    },
  }
}

function isResponse(value: unknown): value is GraphQLResponse {
  return typeof value === "object" && value !== null && ("data" in value || "errors" in value)
}

/** The part of a graphql-ws `Client` the live layer uses. */
export interface GraphQLWsClientLike {
  subscribe(
    payload: { operationName?: string | null; query: string; variables?: Record<string, unknown> | null },
    sink: { next(value: any): void; error(error: unknown): void; complete(): void }
  ): () => void
  /** Closes the socket and forgets it, so the next subscribe opens a fresh connection. */
  terminate?(): void
  /** Socket events; `graphqlWsTransport` needs `connecting`, `connected` and `closed`. */
  on?(event: "connecting" | "connected" | "closed", listener: (...args: any[]) => void): () => void
}

/** Codes the router uses on a connection whose graph it has retired. */
const RETIRED_CONNECTION_CODES = new Set(["SUBSCRIPTION_SCHEMA_RELOAD", "SERVICE_UNAVAILABLE"])

function endsConnection(errors: unknown): boolean {
  return Array.isArray(errors) && errors.some((error) => RETIRED_CONNECTION_CODES.has(String((error as { extensions?: { code?: unknown } } | null)?.extensions?.code)))
}

/**
 * `live.subscribe` for a graphql-ws client. Missed events aren't replayed after a reconnect, so
 * call `client.refetchActive()` from the graphql-ws `connected` event when `wasRetry` is true.
 *
 * The router pins a connection to the graph it selected. Once that graph is retired, the connection
 * answers every new subscribe with `SERVICE_UNAVAILABLE`, so a stream can only come back on a fresh
 * connection. When the last operation has ended after such an answer, this closes the socket through
 * `ws.terminate()`, for a client graphql-ws wouldn't close by itself (`lazy: false`, or another operation
 * opening meanwhile). It waits a task first: graphql-ws has to finish releasing the operation, because
 * terminating while one is still releasing starts graphql-ws's reconnect loop for an operation that's over.
 */
export function graphqlWsSubscribe(
  ws: GraphQLWsClientLike
): (request: OperationRequest, sink: SubscriptionSink) => () => void {
  let open = 0
  let retired = false
  let waiting = false
  const closeIfRetired = () => {
    if (!retired || open > 0 || waiting) return
    waiting = true
    setTimeout(() => {
      waiting = false
      if (!retired || open > 0) return
      retired = false
      ws.terminate?.()
    }, 0)
  }
  return (request, sink) => {
    open += 1
    let ended = false
    const release = () => {
      if (ended) return
      ended = true
      open -= 1
      closeIfRetired()
    }
    const dispose = ws.subscribe(
      { operationName: request.name, query: request.text, variables: request.variables },
      {
        next: (value: GraphQLResponse) => sink.next(value),
        error: (error) => {
          if (endsConnection(error)) retired = true
          release()
          sink.error(error)
        },
        complete: () => {
          release()
          sink.complete()
        },
      }
    )
    return () => {
      release()
      dispose()
    }
  }
}

/**
 * `live.subscribe` and `live.connection` for a graphql-ws client: spread it into `live`. As well as
 * `graphqlWsSubscribe`, `client.liveHealth()` reports the socket, and a socket that recovers by itself reads
 * the queries holding live records again, so there's no need to call `refetchActive` for those.
 */
export function graphqlWsTransport(ws: GraphQLWsClientLike): {
  readonly subscribe: (request: OperationRequest, sink: SubscriptionSink) => () => void
  readonly connection: LiveConnection
} {
  let state: LiveSocketState = "closed"
  const listeners = new Set<(change: { readonly reconnected: boolean }) => void>()
  const set = (next: LiveSocketState, reconnected = false) => {
    state = next
    for (const listener of [...listeners]) listener({ reconnected })
  }
  if (ws.on) {
    ws.on("connecting", () => set("connecting"))
    ws.on("connected", (_socket: unknown, _payload: unknown, wasRetry: boolean) => set("connected", wasRetry === true))
    ws.on("closed", () => set("closed"))
  } else {
    state = "unknown"
  }
  return {
    subscribe: graphqlWsSubscribe(ws),
    connection: {
      state: () => state,
      subscribe(listener) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
  }
}
