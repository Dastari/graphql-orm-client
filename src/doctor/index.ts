/**
 * `graphql-orm-client doctor`: checks a project's documents against the schema a router serves, and opens
 * each live stream briefly. What a router admits can't be known at build time, and it's the commonest cause
 * of data going stale with no sign. It runs introspection and subscriptions only: see `assertReadOnly`.
 */
import { buildClientSchema, getIntrospectionQuery, Kind, parse, validate, type GraphQLSchema, type IntrospectionQuery, type SelectionNode } from "graphql"
import type { LiveArtifact } from "../artifact.js"
import type { CompileResult } from "../compiler/compile.js"

/**
 * - `admitted`: an event arrived, so the stream certainly works.
 * - `not-refused`: no error and no event in the time allowed. Nothing confirms a subscribe, so this is all
 *   that can be said of a quiet stream.
 * - `refused`: the server answered with GraphQL errors.
 * - `missing`: the type has `@live` fragments and no `Changed` subscription.
 * - `invalid`: the stream's document doesn't validate against the served schema.
 * - `unknown`: it couldn't be tested. Never counted as passing.
 */
export type StreamVerdict = "admitted" | "not-refused" | "refused" | "missing" | "invalid" | "unknown"

export interface StreamReport {
  readonly typename: string
  /** The subscription's name; null for a type with no stream. */
  readonly operation: string | null
  readonly verdict: StreamVerdict
  readonly code: string | null
  readonly detail: string
  /** The `@live` fragments on the type, which is what stops being live. */
  readonly fragments: readonly string[]
}

export interface DocumentReport {
  readonly name: string
  readonly problems: readonly string[]
}

export interface DoctorReport {
  readonly url: string
  /** Types in the served schema; null when it couldn't be read. */
  readonly servedTypes: number | null
  readonly schemaProblem: string | null
  /** How many documents were checked; null when the schema couldn't be read, so none were. */
  readonly documentsChecked: number | null
  /** Only documents with problems. */
  readonly documents: readonly DocumentReport[]
  readonly streams: readonly StreamReport[]
  readonly streamMs: number
  readonly passed: boolean
}

export interface DoctorOptions {
  /** The router's GraphQL endpoint, for introspection. */
  readonly url: string
  /** The WebSocket endpoint. Defaults to `url` with `ws` or `wss` as its scheme. */
  readonly wsUrl?: string
  /** Sent on the introspection request, and in `connection_init` for the socket. Never printed. */
  readonly headers?: Readonly<Record<string, string>>
  /** The project's documents, compiled against its schema snapshot. */
  readonly compiled: CompileResult
  /** How long each stream stays open. Default 3000 ms. */
  readonly streamMs?: number
  /** Streams open at once on the one connection. Default 16; the router's default limit is 32. */
  readonly concurrency?: number
  /** Count `not-refused` as a failure. */
  readonly strict?: boolean
  readonly fetch?: typeof globalThis.fetch
  readonly WebSocket?: new (url: string, protocols: string) => DoctorSocket
}

/** The part of a WebSocket the doctor uses. */
export interface DoctorSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(event: "open", listener: () => void): void
  addEventListener(event: "message", listener: (event: { data: unknown }) => void): void
  addEventListener(event: "close", listener: (event: { code: number; reason: string }) => void): void
  addEventListener(event: "error", listener: () => void): void
}

const META_FIELDS = new Set(["__schema", "__type", "__typename"])

/**
 * Refuse anything but a subscription or an introspection query. Everything the doctor sends goes through
 * this, so it can never run a mutation or read application data, whatever it's pointed at.
 */
export function assertReadOnly(text: string): void {
  const document = parse(text)
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue
    if (definition.operation === "subscription") continue
    const introspection =
      definition.operation === "query" &&
      definition.selectionSet.selections.every((selection: SelectionNode) => selection.kind === Kind.FIELD && META_FIELDS.has(selection.name.value))
    if (!introspection) throw new Error(`The doctor only runs subscriptions and introspection, and refused: ${definition.operation} ${definition.name?.value ?? "(unnamed)"}`)
  }
}

async function readServedSchema(options: DoctorOptions): Promise<GraphQLSchema> {
  const query = getIntrospectionQuery()
  assertReadOnly(query)
  const send = options.fetch ?? globalThis.fetch
  const response = await send(options.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json;q=0.9", ...options.headers },
    body: JSON.stringify({ query }),
  })
  const body = (await response.json().catch(() => null)) as { data?: IntrospectionQuery; errors?: { message: string }[] } | null
  if (body?.data?.__schema) return buildClientSchema(body.data)
  const reason = body?.errors?.map((error) => error.message).join("; ") ?? `the endpoint answered ${response.status}`
  throw new Error(`Introspection failed: ${reason}`)
}

function fragmentsByType(compiled: CompileResult): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const [name, fragment] of Object.entries(compiled.fragments)) {
    if (!fragment.live) continue
    const list = result.get(fragment.typeCondition) ?? []
    list.push(name)
    result.set(fragment.typeCondition, list)
  }
  for (const list of result.values()) list.sort()
  return result
}

/** The variables that open a stream without watching any record; null if a stream needs a real record. */
function variablesFor(artifact: LiveArtifact): Record<string, unknown> | null {
  if (artifact.mode === "unkeyed") return {}
  if (artifact.mode === "keys") return { [artifact.keyArgument!]: [] }
  return artifact.keyOptional ? {} : null
}

/** Codes about the connection or the moment, which say nothing about whether this stream is admitted. */
const INCONCLUSIVE_CODES = new Set(["SUBSCRIPTION_SCHEMA_RELOAD", "SERVICE_UNAVAILABLE", "SUBGRAPH_UNAVAILABLE", "SUBSCRIPTION_LIMIT_EXCEEDED"])

type Outcome = Pick<StreamReport, "verdict" | "code" | "detail">
type Frame = { id?: string; type?: string; payload?: unknown }
type ErrorList = readonly { message?: unknown; extensions?: { code?: unknown } }[]

function outcomeOfErrors(errors: ErrorList): Outcome {
  const code = errors.find((error) => error.extensions?.code !== undefined)?.extensions?.code
  const text = errors.map((error) => String(error.message ?? "")).join("; ")
  const named = code === undefined ? null : String(code)
  if (named !== null && INCONCLUSIVE_CODES.has(named)) return { verdict: "unknown", code: named, detail: text }
  return { verdict: "refused", code: named, detail: text }
}

interface Probe {
  readonly key: string
  readonly name: string
  readonly query: string
  readonly variables: Record<string, unknown>
}

/** Open each stream for `streamMs` on one connection, and say what happened to it. */
function probeStreams(probes: readonly Probe[], options: DoctorOptions): Promise<Map<string, Outcome>> {
  const results = new Map<string, Outcome>()
  if (probes.length === 0) return Promise.resolve(results)
  const streamMs = options.streamMs ?? 3000
  const limit = options.concurrency ?? 16
  const Socket = options.WebSocket ?? (globalThis.WebSocket as unknown as NonNullable<DoctorOptions["WebSocket"]>)
  const url = options.wsUrl ?? options.url.replace(/^http/, "ws")
  return new Promise((resolve) => {
    const socket = new Socket(url, "graphql-transport-ws")
    const open = new Map<string, { timer: ReturnType<typeof setTimeout>; answered: ErrorList | null }>()
    let next = 0
    let done = false
    const finish = (reason?: Outcome) => {
      if (done) return
      done = true
      for (const { timer } of open.values()) clearTimeout(timer)
      clearTimeout(ackTimer)
      for (const probe of probes) if (!results.has(probe.key)) results.set(probe.key, reason ?? { verdict: "unknown", code: null, detail: "not tested" })
      try {
        socket.close(1000, "Doctor finished")
      } catch {
        // Already closed.
      }
      resolve(results)
    }
    const conclude = (key: string, outcome: Outcome, stop: boolean) => {
      const entry = open.get(key)
      if (!entry) return
      clearTimeout(entry.timer)
      open.delete(key)
      results.set(key, outcome)
      if (stop) socket.send(JSON.stringify({ id: key, type: "complete" }))
      startMore()
    }
    const startMore = () => {
      while (open.size < limit && next < probes.length) {
        const probe = probes[next++]!
        assertReadOnly(probe.query)
        const timer = setTimeout(() => {
          conclude(probe.key, { verdict: "not-refused", code: null, detail: `no error and no event in ${streamMs} ms; a quiet stream looks the same as an unanswered one` }, true)
        }, streamMs)
        open.set(probe.key, { timer, answered: null })
        socket.send(JSON.stringify({ id: probe.key, type: "subscribe", payload: { operationName: probe.name, query: probe.query, variables: probe.variables } }))
      }
      if (open.size === 0 && next >= probes.length) finish()
    }
    // A server that accepts the socket and never acknowledges must not hang the command.
    const ackTimer = setTimeout(() => finish({ verdict: "unknown", code: null, detail: "the socket was never acknowledged" }), Math.max(streamMs, 5000))
    socket.addEventListener("open", () => {
      const { authorization, ...others } = lowerCased(options.headers ?? {})
      const payload = { ...(authorization ? { authorization } : {}), ...(Object.keys(others).length ? { headers: others } : {}) }
      socket.send(JSON.stringify({ type: "connection_init", payload }))
    })
    socket.addEventListener("error", () => finish({ verdict: "unknown", code: null, detail: "the socket failed" }))
    socket.addEventListener("close", (event) => finish({ verdict: "unknown", code: null, detail: `the socket closed with ${event.code}${event.reason ? ` (${event.reason})` : ""}` }))
    socket.addEventListener("message", (event) => {
      let frame: Frame
      try {
        frame = JSON.parse(String(event.data)) as Frame
      } catch {
        return
      }
      if (frame.type === "connection_ack") {
        clearTimeout(ackTimer)
        return startMore()
      }
      if (frame.type === "ping") return socket.send(JSON.stringify({ type: "pong" }))
      const key = frame.id
      if (key === undefined) return
      if (frame.type === "error") return conclude(key, outcomeOfErrors((frame.payload ?? []) as ErrorList), false)
      if (frame.type === "complete") {
        const answered = open.get(key)?.answered
        return conclude(key, answered ? outcomeOfErrors(answered) : { verdict: "unknown", code: null, detail: "the stream ended with no error and no event" }, false)
      }
      if (frame.type === "next") {
        const payload = (frame.payload ?? {}) as { data?: unknown; errors?: ErrorList }
        if (payload.data) return conclude(key, { verdict: "admitted", code: null, detail: "an event arrived" }, true)
        const entry = open.get(key)
        if (entry && payload.errors?.length) entry.answered = payload.errors
      }
    })
  })
}

function lowerCased(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
}

/** Check the documents against the served schema and open each stream. Never throws for a server's answer. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { compiled } = options
  const streamMs = options.streamMs ?? 3000
  const fragments = fragmentsByType(compiled)
  let schema: GraphQLSchema | null = null
  let schemaProblem: string | null = null
  try {
    schema = await readServedSchema(options)
  } catch (error) {
    schemaProblem = error instanceof Error ? error.message : String(error)
  }

  const documents: DocumentReport[] = []
  if (schema) {
    for (const [name, operation] of Object.entries(compiled.operations)) {
      const problems = validate(schema, parse(operation.text)).map((error) => error.message)
      if (problems.length) documents.push({ name, problems })
    }
  }

  const reports: StreamReport[] = compiled.liveUnavailable.map((typename) => ({
    typename,
    operation: null,
    verdict: "missing",
    code: null,
    detail: "no usable Changed subscription in the schema snapshot; holders must poll",
    fragments: fragments.get(typename) ?? [],
  }))
  const probes: Probe[] = []
  const pending: { artifact: LiveArtifact; key: string }[] = []
  for (const artifact of Object.values(compiled.live)) {
    const base = { typename: artifact.typename, operation: artifact.operation.name, fragments: fragments.get(artifact.typename) ?? [] }
    if (schema) {
      if (!schema.getSubscriptionType()?.getFields()[artifact.field]) {
        reports.push({ ...base, verdict: "missing", code: null, detail: `the served schema has no subscription field ${artifact.field}` })
        continue
      }
      const problems = validate(schema, parse(artifact.operation.text)).map((error) => error.message)
      if (problems.length) {
        reports.push({ ...base, verdict: "invalid", code: null, detail: problems.join("; ") })
        continue
      }
    }
    const variables = variablesFor(artifact)
    if (!variables) {
      reports.push({ ...base, verdict: "unknown", code: null, detail: `${artifact.field} requires a key, so it can't be opened without naming a record` })
      continue
    }
    const key = String(probes.length + 1)
    probes.push({ key, name: artifact.operation.name, query: artifact.operation.text, variables })
    pending.push({ artifact, key })
  }
  const outcomes = await probeStreams(probes, options)
  for (const { artifact, key } of pending) {
    reports.push({
      typename: artifact.typename,
      operation: artifact.operation.name,
      fragments: fragments.get(artifact.typename) ?? [],
      ...(outcomes.get(key) ?? { verdict: "unknown" as const, code: null, detail: "not tested" }),
    })
  }
  reports.sort((a, b) => a.typename.localeCompare(b.typename))
  const failing: readonly StreamVerdict[] = options.strict ? ["refused", "missing", "invalid", "unknown", "not-refused"] : ["refused", "missing", "invalid", "unknown"]
  return {
    url: options.url,
    servedTypes: schema ? Object.keys(schema.getTypeMap()).length : null,
    schemaProblem,
    documentsChecked: schema ? Object.keys(compiled.operations).length : null,
    documents,
    streams: reports,
    streamMs,
    passed: schema !== null && documents.length === 0 && !reports.some((report) => failing.includes(report.verdict)),
  }
}

/** The report as text, for a terminal. Holds no credentials: they are never in the report. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [`Router: ${report.url}`]
  if (report.schemaProblem !== null) {
    lines.push(`Schema: unknown. ${report.schemaProblem}`, "Documents: unknown, because there's no served schema to check them against.")
  } else {
    lines.push(`Schema: ${report.servedTypes} types served`)
    lines.push(`Documents: ${report.documentsChecked} checked, ${report.documents.length} invalid`)
    for (const document of report.documents) lines.push(`  invalid  ${document.name}: ${document.problems.join("; ")}`)
  }
  lines.push(`Streams: ${report.streams.length}, for this identity, open for up to ${report.streamMs} ms each`)
  const width = Math.max(0, ...report.streams.map((stream) => stream.verdict.length))
  const typeWidth = Math.max(0, ...report.streams.map((stream) => stream.typename.length))
  for (const stream of report.streams) {
    const code = stream.code ? `${stream.code}: ` : ""
    const names = stream.fragments.length ? ` [${stream.fragments.join(", ")}]` : ""
    lines.push(`  ${stream.verdict.padEnd(width)}  ${stream.typename.padEnd(typeWidth)}  ${code}${stream.detail}${names}`)
  }
  lines.push(report.passed ? "Passed." : "Failed: see above.")
  return lines.join("\n")
}
