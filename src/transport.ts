import type { GraphQLResponse, Network, OperationRequest } from "./client.js"
import type { SubscriptionSink } from "./live.js"

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
  /** Defaults to the global `fetch`. Pass a wrapper to add retries, timeouts or logging. */
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
      const extra = typeof options.headers === "function" ? await options.headers() : options.headers
      const headers = new Headers(extra)
      headers.set("content-type", "application/json")
      headers.set("accept", "application/graphql-response+json, application/json;q=0.9")
      const response = await send(options.url, {
        method: "POST",
        headers,
        credentials: options.credentials ?? "same-origin",
        body: JSON.stringify({ operationName: request.name, query: request.text, variables: request.variables }),
        ...(signal ? { signal } : {}),
      })
      const body: unknown = await response.json().catch(() => null)
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
 * `ws.terminate()`; graphql-ws's own idle close can't be relied on here, because the router's `error`
 * and `complete` for one operation can count as two releases in graphql-ws.
 */
export function graphqlWsSubscribe(
  ws: GraphQLWsClientLike
): (request: OperationRequest, sink: SubscriptionSink) => () => void {
  let open = 0
  let retired = false
  return (request, sink) => {
    open += 1
    let ended = false
    const release = () => {
      if (ended) return
      ended = true
      open -= 1
      if (retired && open === 0) {
        retired = false
        ws.terminate?.()
      }
    }
    const dispose = ws.subscribe(
      { operationName: request.name, query: request.text, variables: request.variables },
      {
        next: (value: GraphQLResponse) => sink.next(value),
        error: (error) => {
          if (endsConnection(error)) retired = true
          // Release first: the sink may subscribe again at once, and that must reach a fresh socket.
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
