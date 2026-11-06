import { execFileSync, spawnSync } from "node:child_process"
import { buildSchema, introspectionFromSchema, parse } from "graphql"
import { describe, expect, it } from "vitest"
import { compile } from "../src/compiler/index.js"
import { assertReadOnly, formatDoctorReport, runDoctor, type DoctorOptions, type DoctorSocket } from "../src/doctor/index.js"

const sdl = `
  type Query { Ticket(Id: ID!): Ticket, Slot(Site: String!, Name: String!): Slot, Note(Id: ID!): Note, Vendor(Id: ID!): Vendor, Order(Id: ID!): Order }
  type Mutation { Close(Id: ID!): Ticket }
  type Subscription {
    TicketChanged(Keys: [ID!]): TicketChangedEvent!
    SlotChanged(Key: String): SlotChangedEvent!
    VendorChanged: VendorChangedEvent!
    OrderChanged(Key: String!): OrderChangedEvent!
  }
  enum ChangeAction { CREATED UPDATED DELETED }
  type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
  type SlotChangedEvent { Action: ChangeAction!, Slot: Slot }
  type VendorChangedEvent { Action: ChangeAction!, Vendor: Vendor }
  type OrderChangedEvent { Action: ChangeAction!, Order: Order }
  type Ticket { Id: ID!, Title: String!, Secret: String! }
  type Slot { Id: ID!, State: String! }
  type Vendor { Id: ID!, Name: String! }
  type Order { Id: ID!, Total: Int! }
  type Note { Id: ID!, Body: String! }
`
const snapshot = buildSchema(sdl)
const documents = [
  `fragment TicketTitle on Ticket @live { Title }`,
  `fragment SlotState on Slot @live { State }`,
  `fragment VendorName on Vendor @live { Name }`,
  `fragment OrderTotal on Order @live { Total }`,
  `fragment NoteBody on Note @live { Body }`,
  `query TicketPage($Id: ID!) { Ticket(Id: $Id) { ...TicketTitle } }`,
  `query SlotPage { Slot(Site: "a", Name: "b") { ...SlotState } }`,
  `query VendorPage($Id: ID!) { Vendor(Id: $Id) { ...VendorName } }`,
  `query OrderPage($Id: ID!) { Order(Id: $Id) { ...OrderTotal } }`,
  `query NotePage($Id: ID!) { Note(Id: $Id) { ...NoteBody } }`,
  `mutation CloseTicket($Id: ID!) { Close(Id: $Id) { Id } }`,
]
const compiled = compile(snapshot, documents)

type Script = (name: string, send: (frame: object) => void, id: string) => void

/** A router the test scripts: introspection answers from `served`, streams from `script`. */
function router(options: { served?: string | null; script?: Script; init?: (socket: FakeSocket) => void; introspectionStatus?: number } = {}) {
  const served = options.served === undefined ? sdl : options.served
  const sent: { kind: "http" | "ws"; body: string }[] = []
  const inits: unknown[] = []
  const httpHeaders: unknown[] = []
  const subscribed: { name: string; variables: unknown }[] = []
  const completed: string[] = []
  class Socket implements FakeSocket {
    static last: Socket
    listeners: Record<string, ((event: any) => void)[]> = {}
    closed = false
    constructor(
      readonly url: string,
      readonly protocol: string
    ) {
      Socket.last = this
      setTimeout(() => this.fire("open", {}), 0)
    }
    addEventListener(event: string, listener: (event: any) => void) {
      ;(this.listeners[event] ??= []).push(listener)
    }
    fire(event: string, payload: object) {
      for (const listener of this.listeners[event] ?? []) listener(payload)
    }
    deliver(frame: object) {
      this.fire("message", { data: JSON.stringify(frame) })
    }
    close() {
      this.closed = true
    }
    send(data: string) {
      const frame = JSON.parse(data)
      if (frame.type === "connection_init") {
        inits.push(frame.payload)
        if (options.init) return options.init(this)
        return this.deliver({ type: "connection_ack" })
      }
      if (frame.type === "complete") return void completed.push(frame.id)
      if (frame.type === "subscribe") {
        sent.push({ kind: "ws", body: frame.payload.query })
        subscribed.push({ name: frame.payload.operationName, variables: frame.payload.variables })
        options.script?.(frame.payload.operationName, (reply) => this.deliver({ id: frame.id, ...reply }), frame.id)
      }
    }
  }
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push({ kind: "http", body: JSON.parse(String(init.body)).query })
    httpHeaders.push(init.headers)
    if (served === null) return new Response(JSON.stringify({ errors: [{ message: "introspection is disabled" }] }), { status: options.introspectionStatus ?? 200 })
    return new Response(JSON.stringify({ data: introspectionFromSchema(buildSchema(served)) }))
  }) as unknown as typeof globalThis.fetch
  return { sent, inits, httpHeaders, subscribed, completed, fetch, WebSocket: Socket as unknown as NonNullable<DoctorOptions["WebSocket"]>, socket: () => Socket.last }
}
interface FakeSocket extends DoctorSocket {
  deliver(frame: object): void
  fire(event: string, payload: object): void
}

const base = { url: "https://router.example/graphql", compiled, streamMs: 5 }
const of = (report: { streams: readonly { typename: string; verdict: string }[] }, typename: string) => report.streams.find((stream) => stream.typename === typename)

describe("assertReadOnly", () => {
  it("allows subscriptions and introspection", () => {
    expect(() => assertReadOnly("subscription S { A { b } }")).not.toThrow()
    expect(() => assertReadOnly("query I { __schema { types { name } } }")).not.toThrow()
    expect(() => assertReadOnly("{ __typename }")).not.toThrow()
  })

  it("refuses mutations, and queries that read application data", () => {
    expect(() => assertReadOnly("mutation M { Close(Id: 1) { Id } }")).toThrow(/refused: mutation M/)
    expect(() => assertReadOnly("query Q { Ticket(Id: 1) { Id } }")).toThrow(/refused: query Q/)
    expect(() => assertReadOnly("query Q { __typename Ticket(Id: 1) { Id } }")).toThrow(/refused/)
    expect(() => assertReadOnly("query Q { ...F } fragment F on Query { Ticket(Id: 1) { Id } }")).toThrow(/refused/)
  })
})

describe("runDoctor", () => {
  it("sends only introspection and subscriptions, for a project with mutations and queries", async () => {
    const server = router()
    await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
    expect(server.sent.length).toBeGreaterThan(1)
    for (const { kind, body } of server.sent) {
      const operation = parse(body).definitions.find((definition) => definition.kind === "OperationDefinition") as { operation: string }
      expect(operation.operation).toBe(kind === "http" ? "query" : "subscription")
      expect(() => assertReadOnly(body)).not.toThrow()
    }
    expect(server.sent.filter(({ body }) => body.includes("Close("))).toEqual([])
  })

  it("opens a stream without watching a record: an empty key list, or no key when it's optional", async () => {
    const server = router()
    await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
    expect(server.subscribed.map((entry) => [entry.name, entry.variables]).sort()).toEqual([
      ["LiveSlot", {}],
      ["LiveTicket", { Keys: [] }],
      ["LiveVendor", {}],
    ])
  })

  it("calls a quiet stream not-refused, and closes it; only an event earns admitted", async () => {
    const server = router({
      script: (name, send) => {
        if (name === "LiveVendor") send({ type: "next", payload: { data: { VendorChanged: { Action: "UPDATED" } } } })
      },
    })
    const report = await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
    expect(of(report, "Vendor")).toMatchObject({ verdict: "admitted", operation: "LiveVendor", fragments: ["VendorName"] })
    expect(of(report, "Ticket")).toMatchObject({ verdict: "not-refused" })
    expect(server.completed).toHaveLength(3)
    expect(server.socket()).toMatchObject({ closed: true })
  })

  const refusals: [string, Script][] = [
    ["an error frame", (name, send) => name === "LiveTicket" && send({ type: "error", payload: [{ message: "no", extensions: { code: "INVALID_INPUT" } }] })],
    [
      "an error-only frame then complete",
      (name, send) => {
        if (name !== "LiveTicket") return
        send({ type: "next", payload: { data: null, errors: [{ message: "no", extensions: { code: "INVALID_INPUT" } }] } })
        send({ type: "complete" })
      },
    ],
  ]
  for (const [label, script] of refusals) {
    it(`names a stream refused with ${label}, with a failing result`, async () => {
      const server = router({ script })
      const report = await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(of(report, "Ticket")).toMatchObject({ verdict: "refused", code: "INVALID_INPUT", detail: "no", fragments: ["TicketTitle"] })
      expect(report.passed).toBe(false)
    })
  }

  it("doesn't call an outage a refusal: it's unknown", async () => {
    for (const code of ["SERVICE_UNAVAILABLE", "SUBSCRIPTION_SCHEMA_RELOAD", "SUBSCRIPTION_LIMIT_EXCEEDED"]) {
      const server = router({ script: (name, send) => name === "LiveTicket" && send({ type: "error", payload: [{ message: "busy", extensions: { code } }] }) })
      const report = await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(of(report, "Ticket")).toMatchObject({ verdict: "unknown", code })
      expect(report.passed).toBe(false)
    }
  })

  it("reports a stream that ends with nothing as unknown, not as working", async () => {
    const server = router({ script: (name, send) => name === "LiveTicket" && send({ type: "complete" }) })
    const report = await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
    expect(of(report, "Ticket")).toMatchObject({ verdict: "unknown", detail: "the stream ended with no error and no event" })
  })

  it("names a type with no stream as missing, and one that requires a key as unknown", async () => {
    const server = router()
    const report = await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
    expect(of(report, "Note")).toMatchObject({ verdict: "missing", operation: null, fragments: ["NoteBody"] })
    expect(of(report, "Order")).toMatchObject({ verdict: "unknown", detail: expect.stringContaining("requires a key") })
    expect(report.passed).toBe(false)
  })

  describe("against a schema that has moved on", () => {
    const passingCompiled = compile(snapshot, documents.filter((document) => !/Note|Order/.test(document)))

    it("passes when everything fits and nothing is refused", async () => {
      const server = router()
      const report = await runDoctor({ ...base, compiled: passingCompiled, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(report).toMatchObject({ passed: true, documentsChecked: 4, documents: [] })
      expect(report.servedTypes).toBeGreaterThan(0)
    })

    it("names a document that no longer validates", async () => {
      const server = router({ served: sdl.replace("type Slot { Id: ID!, State: String! }", "type Slot { Id: ID! }") })
      const report = await runDoctor({ ...base, compiled: passingCompiled, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(report.documents.map((entry) => entry.name)).toEqual(["SlotPage"])
      expect(report.documents[0]!.problems.join()).toContain("State")
      expect(of(report, "Slot")).toMatchObject({ verdict: "invalid" })
      expect(report.passed).toBe(false)
    })

    it("names a stream the schema no longer has as missing", async () => {
      const server = router({ served: sdl.replace("VendorChanged: VendorChangedEvent!", "") })
      const report = await runDoctor({ ...base, compiled: passingCompiled, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(of(report, "Vendor")).toMatchObject({ verdict: "missing", detail: expect.stringContaining("VendorChanged") })
      expect(server.subscribed.map((entry) => entry.name)).not.toContain("LiveVendor")
    })

    it("fails under --strict on what is merely not refused", async () => {
      const server = router()
      const report = await runDoctor({ ...base, compiled: passingCompiled, strict: true, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(report.passed).toBe(false)
    })

    it("reports documents as unknown when the schema can't be read, and still opens streams", async () => {
      const server = router({ served: null })
      const report = await runDoctor({ ...base, compiled: passingCompiled, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(report).toMatchObject({ passed: false, servedTypes: null, documentsChecked: null, schemaProblem: "Introspection failed: introspection is disabled" })
      expect(report.streams.every((stream) => stream.verdict === "not-refused")).toBe(true)
      const text = formatDoctorReport(report)
      expect(text).toContain("Schema: unknown.")
      expect(text).toContain("Documents: unknown")
      expect(text).not.toContain("0 invalid")
    })
  })

  describe("when the socket fails", () => {
    it("reports every stream unknown when the connection is refused", async () => {
      const server = router({ init: (socket) => socket.fire("close", { code: 4401, reason: "Unauthorized" }) })
      const report = await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(report.streams.filter((stream) => stream.operation !== null && stream.typename !== "Order").map((stream) => [stream.verdict, stream.detail])).toEqual(
        expect.arrayContaining([["unknown", "the socket closed with 4401 (Unauthorized)"]])
      )
      expect(report.passed).toBe(false)
    })

    it("doesn't hang on a socket that is never acknowledged", async () => {
      const server = router({ init: () => {} })
      const report = await runDoctor({ ...base, streamMs: 5, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(of(report, "Ticket")).toMatchObject({ verdict: "unknown", detail: "the socket was never acknowledged" })
    }, 10_000)

    it("reports streams still open when the socket drops as unknown", async () => {
      const server = router({
        script: (name) => {
          if (name === "LiveTicket") setTimeout(() => server.socket().fire("close", { code: 1006, reason: "" }), 0)
        },
      })
      const report = await runDoctor({ ...base, streamMs: 1000, fetch: server.fetch, WebSocket: server.WebSocket })
      expect(of(report, "Ticket")).toMatchObject({ verdict: "unknown", detail: "the socket closed with 1006" })
    })
  })

  describe("credentials", () => {
    it("sends them on the request and in connection_init, and they're nowhere in the report", async () => {
      const server = router({ script: (name, send) => name === "LiveTicket" && send({ type: "error", payload: [{ message: "no", extensions: { code: "FORBIDDEN" } }] }) })
      const report = await runDoctor({
        ...base,
        headers: { authorization: "Bearer sekret", "x-tenant": "t1" },
        fetch: server.fetch,
        WebSocket: server.WebSocket,
      })
      expect(server.inits).toEqual([{ authorization: "Bearer sekret", headers: { "x-tenant": "t1" } }])
      expect(server.httpHeaders[0]).toMatchObject({ authorization: "Bearer sekret", "x-tenant": "t1" })
      expect(JSON.stringify(report)).not.toContain("sekret")
      expect(formatDoctorReport(report)).not.toContain("sekret")
    })
  })

  it("keeps to the concurrency limit, and tests every stream", async () => {
    let open = 0
    let most = 0
    const server = router({
      script: (_name, send) => {
        open += 1
        most = Math.max(most, open)
        setTimeout(() => {
          open -= 1
          send({ type: "complete" })
        }, 1)
      },
    })
    const report = await runDoctor({ ...base, concurrency: 1, fetch: server.fetch, WebSocket: server.WebSocket })
    expect(most).toBe(1)
    expect(server.subscribed).toHaveLength(3)
    expect(report.streams.filter((stream) => stream.detail === "not tested")).toEqual([])
  })

  it("derives the socket URL from the endpoint, unless told otherwise", async () => {
    const server = router()
    await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket })
    expect(server.socket()).toMatchObject({ url: "wss://router.example/graphql", protocol: "graphql-transport-ws" })
    await runDoctor({ ...base, wsUrl: "ws://elsewhere/ws", fetch: server.fetch, WebSocket: server.WebSocket })
    expect(server.socket()).toMatchObject({ url: "ws://elsewhere/ws" })
  })

  it("prints each verdict with the fragments it affects", async () => {
    const server = router({ script: (name, send) => name === "LiveTicket" && send({ type: "error", payload: [{ message: "no", extensions: { code: "INVALID_INPUT" } }] }) })
    const text = formatDoctorReport(await runDoctor({ ...base, fetch: server.fetch, WebSocket: server.WebSocket }))
    expect(text).toMatch(/refused\s+Ticket\s+INVALID_INPUT: no \[TicketTitle\]/)
    expect(text).toMatch(/not-refused\s+Slot/)
    expect(text).toMatch(/missing\s+Note/)
    expect(text).toContain("for this identity")
    expect(text).toContain("Failed")
  })
})

describe("the doctor command", () => {
  const bin = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ["bin/graphql-orm-client.mjs", "doctor", ...args], { encoding: "utf8", env: { ...process.env, ...env } })

  it("refuses a credential on the command line", () => {
    for (const flag of ["--token", "--header", "--password"]) {
      const result = bin(["--url", "http://x", flag, "sekret"])
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("environment variable")
      expect(result.stderr).not.toContain("sekret")
    }
  })

  it("needs a URL, and a credential variable that is set", () => {
    expect(bin([]).status).toBe(2)
    const result = bin(["--url", "http://x", "--token-env", "NOT_SET_ANYWHERE"], { NOT_SET_ANYWHERE: "" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("NOT_SET_ANYWHERE")
  })

  it("is listed in the usage", () => {
    expect(execFileSync(process.execPath, ["bin/graphql-orm-client.mjs"], { encoding: "utf8" })).toContain("doctor --url")
  })
})

it("reports working thin fallback separately, retaining strict uncertainty and unknown failures", async () => {
  for (const thin of ["event", "quiet", "unavailable"] as const) {
    let probes = 0
    const fake = router({ script: (_name, send) => {
      probes++
      if (probes === 1) send({ type: "error", payload: [{ message: "unsupported", extensions: { code: "INVALID_INPUT" } }] })
      else if (thin === "event") send({ type: "next", payload: { data: { TicketChanged: { Ticket: { Id: "a" } } } } })
      else if (thin === "unavailable") send({ type: "error", payload: [{ extensions: { code: "SERVICE_UNAVAILABLE" } }] })
    } })
    const only = compile(snapshot, documents.filter((document) => /Ticket/.test(document)))
    const report = await runDoctor({ url: "http://router.test/graphql", compiled: only, ...fake, streamMs: 5 })
    expect(report.streams[0]!.verdict).toBe(thin === "event" ? "fallback-admitted" : thin === "quiet" ? "fallback-not-refused" : "unknown")
    expect(report.passed).toBe(thin !== "unavailable")
  }
})
