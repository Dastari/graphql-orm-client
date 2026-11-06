/**
 * The test kit: a mock network, scripted streams and a clock, for testing an application's freshness
 * without a server. Not in the main bundle, and no test runner is needed. The frames match what the
 * router sends, as run against graphql-orm-router 0.8.1.
 */
import { buildSchema, getVariableValues, Kind, parse, validate, type DocumentNode, type GraphQLSchema, type OperationDefinitionNode } from "graphql"
import type { GraphQLResponse, Network, OperationRequest, PollingOptions } from "../client.js"
import type { LiveOptions, SubscriptionSink } from "../live.js"
import type { StoreOptions } from "../store/store.js"

const realSetTimeout = globalThis.setTimeout

function schemaOf(schema: GraphQLSchema | string): GraphQLSchema {
  // Router and subgraph SDL can carry federation directives the plain schema doesn't define.
  return typeof schema === "string" ? buildSchema(schema, { assumeValidSDL: true }) : schema
}

/** Why a document or its variables don't fit the schema, or null when they do. */
function invalid(schema: GraphQLSchema, request: OperationRequest): string | null {
  let document: DocumentNode
  try {
    document = parse(request.text)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const errors = validate(schema, document)
  if (errors.length) return errors.map((error) => error.message).join("; ")
  const operation = document.definitions.find(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION && (!request.name || definition.name?.value === request.name)
  )
  if (!operation) return `the document has no operation named ${request.name}`
  const coerced = getVariableValues(schema, operation.variableDefinitions ?? [], { ...request.variables })
  return coerced.errors?.length ? coerced.errors.map((error) => error.message).join("; ") : null
}

/** The errors a GraphQL response or an `error` frame carries, with a code as graphql-orm sends it. */
export function graphQLErrors(code: string, message: string = code): GraphQLResponse["errors"] & object {
  return [{ message, extensions: { code } }]
}

// Network

/** One operation's answer: a response, or a function of the request. A thrown error fails the request. */
export type MockAnswer = GraphQLResponse | ((variables: Readonly<Record<string, unknown>>, request: OperationRequest) => GraphQLResponse | Promise<GraphQLResponse>)

export interface MockNetworkOptions {
  /** Every request is validated against this, with its variables. A request that doesn't fit fails. */
  readonly schema?: GraphQLSchema | string
  /** Answers by operation name. An operation with no answer fails, so nothing passes by accident. */
  readonly operations?: Readonly<Record<string, MockAnswer>>
  /** Answers operations not in `operations`, for a test that decides from the whole request. */
  readonly respond?: (request: OperationRequest) => GraphQLResponse | Promise<GraphQLResponse>
}

export interface MockNetwork extends Network {
  /** Every request sent, in order. */
  readonly requests: OperationRequest[]
  /** The requests sent for one operation. */
  calls(name: string): readonly OperationRequest[]
  /**
   * Requests the kit itself failed: no answer for the operation, or not valid for the schema. They also
   * reject, and a query keeps a rejection in its state, so check this where a test could miss that.
   */
  readonly failures: string[]
  /** Set or replace an operation's answer. */
  answer(name: string, answer: MockAnswer): void
}

/** A `Network` answered by operation name. Pass `schema` so a document that has drifted fails the test. */
export function createMockNetwork(options: MockNetworkOptions = {}): MockNetwork {
  const schema = options.schema === undefined ? null : schemaOf(options.schema)
  const operations = new Map(Object.entries(options.operations ?? {}))
  const requests: OperationRequest[] = []
  const failures: string[] = []
  const fail = (message: string) => {
    failures.push(message)
    return new Error(message)
  }
  return {
    requests,
    failures,
    calls: (name) => requests.filter((request) => request.name === name),
    answer: (name, answer) => void operations.set(name, answer),
    async execute(request, { signal }) {
      requests.push(request)
      const problem = schema && invalid(schema, request)
      if (problem) throw fail(`${request.name} doesn't fit the schema: ${problem}`)
      const answer = operations.get(request.name)
      if (answer === undefined && !options.respond) throw fail(`No mock answer for operation ${request.name}`)
      const response = answer === undefined ? await options.respond!(request) : typeof answer === "function" ? await answer(request.variables, request) : answer
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      return response
    },
  }
}

// Streams

export interface MockStream {
  readonly request: OperationRequest
  readonly variables: Readonly<Record<string, unknown>>
  /** The sink the client passed, for a frame the methods below don't cover. */
  readonly sink: SubscriptionSink
  /** The client stopped it, or it ended. */
  readonly closed: boolean
  /** Send one frame as it is. */
  next(response: GraphQLResponse): void
  /**
   * Send a `Changed` event for this entity, taking the field names from graphql-orm's convention
   * (`WidgetChanged`, `WidgetChangedEvent`, `Widget`). Use `next` for anything else.
   */
  emit(entity: Readonly<Record<string, unknown>>, options?: { readonly action?: "CREATED" | "UPDATED" | "DELETED"; readonly changeKind?: "DIRECT" | "PROPAGATED" }): void
  /**
   * The server refuses it. `frame` is `error`, as the router answers a subscribe itself, or `next`, an
   * error-only frame then `complete`, as a subgraph's refusal reaches the client. Default `INVALID_INPUT`.
   */
  refuse(code?: string, options?: { readonly frame?: "error" | "next" }): void
  /** Events were lost: an error frame, then `complete`. Default `SUBSCRIPTION_CONTINUITY_LOST`. */
  loseContinuity(code?: "SUBSCRIPTION_CONTINUITY_LOST" | "SUBSCRIPTION_SOURCE_CLOSED"): void
  /** The router retired the graph: `SUBSCRIPTION_SCHEMA_RELOAD`, as an `error` frame. */
  reload(): void
  /** What a retired connection answers: `SERVICE_UNAVAILABLE`, as an `error` frame. */
  unavailable(): void
  /** The socket failed and its reconnect attempts ran out: a close event, not GraphQL errors. */
  fail(event?: { readonly code: number; readonly reason: string; readonly wasClean: boolean }): void
  /** A plain `complete`. */
  end(): void
}

export interface MockStreamsOptions {
  /** A subscribe that doesn't fit the schema throws, with its variables checked too. */
  readonly schema?: GraphQLSchema | string
}

export interface MockStreams {
  /** Pass this as `live.subscribe`. */
  readonly subscribe: NonNullable<LiveOptions["subscribe"]>
  /** The streams open now. */
  readonly open: ReadonlySet<MockStream>
  /** Every stream ever started, in order, open or not. */
  readonly started: readonly MockStream[]
  /** The open streams of one operation. */
  find(name: string): readonly MockStream[]
  /** The one open stream of an operation, narrowed by variables if given; throws unless there is one. */
  one(name: string, variables?: Readonly<Record<string, unknown>>): MockStream
  /** Reload every open stream, as when the router publishes a new graph. */
  reload(): void
  /** Fail every open stream, as when the socket's reconnect attempts run out. */
  fail(): void
  /**
   * A socket drop that the transport recovers from by itself: graphql-ws resubscribes, nothing ends and
   * events in the gap are gone. Calls `onReconnect` listeners, as its `connected` event with `wasRetry`.
   */
  reconnect(): void
  onReconnect(listener: () => void): () => void
}

function eventField(request: OperationRequest): string {
  const document = parse(request.text)
  const operation = document.definitions.find((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION)
  const field = operation?.selectionSet.selections.find((selection) => selection.kind === Kind.FIELD)
  if (!field || field.kind !== Kind.FIELD) throw new Error(`${request.name} selects no field`)
  return field.alias?.value ?? field.name.value
}

/** A `live.subscribe` the test drives, with the frames the router sends. */
export function createMockStreams(options: MockStreamsOptions = {}): MockStreams {
  const schema = options.schema === undefined ? null : schemaOf(options.schema)
  const open = new Set<MockStream>()
  const started: MockStream[] = []
  const reconnects = new Set<() => void>()
  const subscribe = (request: OperationRequest, sink: SubscriptionSink) => {
    const problem = schema && invalid(schema, request)
    if (problem) throw new Error(`${request.name} doesn't fit the schema: ${problem}`)
    let closed = false
    const close = () => {
      closed = true
      open.delete(stream)
    }
    const terminal = (send: () => void) => {
      if (closed) return
      close()
      send()
    }
    const stream: MockStream = {
      request,
      variables: request.variables,
      sink,
      get closed() {
        return closed
      },
      next: (response) => {
        if (!closed) sink.next(response)
      },
      emit: (entity, { action = "UPDATED", changeKind } = {}) => {
        const field = eventField(request)
        const typename = field.replace(/Changed$/, "")
        stream.next({ data: { [field]: { __typename: `${field}Event`, Action: action, ...(changeKind ? { ChangeKind: changeKind } : {}), [typename]: entity } } })
      },
      refuse: (code = "INVALID_INPUT", { frame = "error" } = {}) => {
        if (frame === "error") return terminal(() => sink.error(graphQLErrors(code)))
        stream.next({ data: null, errors: graphQLErrors(code) })
        terminal(() => sink.complete())
      },
      loseContinuity: (code = "SUBSCRIPTION_CONTINUITY_LOST") => {
        stream.next({ data: null, errors: graphQLErrors(code) })
        terminal(() => sink.complete())
      },
      reload: () => terminal(() => sink.error(graphQLErrors("SUBSCRIPTION_SCHEMA_RELOAD", "subscription has been closed due to a schema reload"))),
      unavailable: () => terminal(() => sink.error(graphQLErrors("SERVICE_UNAVAILABLE", "Supergraph used by this connection has been retired"))),
      fail: (event = { code: 1006, reason: "", wasClean: false }) => terminal(() => sink.error(event)),
      end: () => terminal(() => sink.complete()),
    }
    open.add(stream)
    started.push(stream)
    return close
  }
  const find = (name: string) => [...open].filter((stream) => stream.request.name === name)
  return {
    subscribe,
    open,
    started,
    find,
    one(name, variables) {
      const matching = find(name).filter(
        (stream) => !variables || Object.entries(variables).every(([key, value]) => JSON.stringify(stream.variables[key]) === JSON.stringify(value))
      )
      if (matching.length !== 1) throw new Error(`Expected one open ${name} stream${variables ? ` for ${JSON.stringify(variables)}` : ""}, found ${matching.length}`)
      return matching[0]!
    },
    reload: () => [...open].forEach((stream) => stream.reload()),
    fail: () => [...open].forEach((stream) => stream.fail()),
    reconnect: () => [...reconnects].forEach((listener) => listener()),
    onReconnect(listener) {
      reconnects.add(listener)
      return () => void reconnects.delete(listener)
    },
  }
}

// Clock

export interface PendingTimer {
  /** The delay it was set with. */
  readonly ms: number
  /** When it fires, in the clock's time. */
  readonly at: number
  readonly repeats: boolean
}

export interface TestClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** Pass time and fire what falls due, in order. Promises don't settle: use `tick` around requests. */
  advance(ms: number): void
  /** Pass time and fire what falls due, letting requests and their promises settle after each timer. */
  tick(ms?: number): Promise<void>
  /** Timers waiting now. */
  pending(): readonly PendingTimer[]
  /** Spread into `live`: `{ ...clock.live, subscribe }`. */
  readonly live: Required<Pick<LiveOptions, "setTimeout" | "clearTimeout" | "now">>
  /** Pass as `store`. */
  readonly store: Required<Pick<StoreOptions, "setTimeout" | "clearTimeout">>
  /** Pass as `polling`, or spread into it. */
  readonly polling: Required<Pick<PollingOptions, "setInterval" | "clearInterval">>
}

/** A clock the test drives, for the client's timer seams. Starts at `start` milliseconds. */
export function createTestClock(start = 1_000_000): TestClock {
  let time = start
  let next = 0
  const timers = new Map<number, { callback: () => void; ms: number; at: number; repeats: boolean }>()
  const add = (callback: () => void, ms: number, repeats: boolean) => {
    timers.set(++next, { callback, ms, at: time + Math.max(0, ms), repeats })
    return next
  }
  const remove = (handle: unknown) => void timers.delete(handle as number)
  /** The next timer due by `end`; earliest first, then in the order they were set. */
  const due = (end: number) => {
    let found: [number, { callback: () => void; ms: number; at: number; repeats: boolean }] | null = null
    for (const entry of timers) if (entry[1].at <= end && (!found || entry[1].at < found[1].at)) found = entry
    return found
  }
  const fire = ([handle, timer]: [number, { callback: () => void; ms: number; at: number; repeats: boolean }]) => {
    time = Math.max(time, timer.at)
    if (timer.repeats) timer.at = time + Math.max(1, timer.ms)
    else timers.delete(handle)
    timer.callback()
  }
  const settle = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0))
  const clock: TestClock = {
    now: () => time,
    setTimeout: (callback, ms) => add(callback, ms, false),
    clearTimeout: remove,
    setInterval: (callback, ms) => add(callback, ms, true),
    clearInterval: remove,
    advance(ms) {
      const end = time + ms
      for (let timer = due(end); timer; timer = due(end)) fire(timer)
      time = end
    },
    async tick(ms = 0) {
      const end = time + ms
      await settle()
      for (let timer = due(end); timer; timer = due(end)) {
        fire(timer)
        await settle()
      }
      time = end
    },
    pending: () => [...timers.values()].map(({ ms, at, repeats }) => ({ ms, at, repeats })),
    live: { setTimeout: (callback, ms) => add(callback, ms, false), clearTimeout: remove, now: () => time },
    store: { setTimeout: (callback, ms) => add(callback, ms, false), clearTimeout: remove },
    polling: { setInterval: (callback, ms) => add(callback, ms, true), clearInterval: remove },
  }
  return clock
}
