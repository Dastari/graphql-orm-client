// @vitest-environment jsdom
import { buildSchema } from "graphql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { compile } from "../src/compiler/index.js"
import { classifyError, createClient, createHttpNetwork, errorsAtPath, markNoResponse, type ClientOptions, type GraphQLResponse, type OperationRequest } from "../src/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  type Query { Online: Online! Foos: [Foo!]! Foo(Id: ID!): Foo }
  type Mutation { Touch(Id: ID!): TouchResult! }
  type TouchResult { Success: Boolean! Foo: Foo }
  type Online { PageInfo: PageInfo! Label: String! }
  type PageInfo { TotalCount: Int }
  type Foo { Id: ID! Name: String! Note: String }
`)
const compiled = compile(schema, [
  "query Count { Online { Label PageInfo { TotalCount } } }",
  "query Foos { Foos { Id Name Note } }",
  "query Detail($Id: ID!) { Foo(Id: $Id) { Id Name } }",
  "mutation Touch($Id: ID!) { Touch(Id: $Id) { Success Foo { Id Name } } }",
])
const ops = compiled.operations
const count = (value: number | null, label = "online", errors?: GraphQLResponse["errors"]): GraphQLResponse => ({
  data: { Online: { __typename: "Online", Label: label, PageInfo: { __typename: "PageInfo", TotalCount: value } } },
  ...(errors ? { errors } : {}),
})
const foo = (id: string, name = `foo-${id}`) => ({ __typename: "Foo", Id: id, Name: name })
const offline = () => markNoResponse(new TypeError("Failed to fetch"))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("a response's data and errors arrive in one state change", () => {
  const cases = [
    ["legacy", [{ message: "x", path: ["Online", "PageInfo", "TotalCount"] }], "online", "ready:null:online:errors=1"],
    ["preserve-errors", [{ message: "x", path: ["Online", "PageInfo", "TotalCount"] }], "renamed", "ready:7:renamed:errors=1"],
    ["preserve-errors", [{ message: "pathless" }], "online", "ready:null:online:errors=1"],
  ] as const
  it.each(cases)("under %s, with %j", async (partialResults, errors, label, last) => {
    const replies = [count(7), count(null, label, errors)]
    const client = createClient({ partialResults, network: { execute: async () => replies.shift()! } })
    const watched = client.watchQuery<any>(ops.Count!, {}, "store-and-network")
    const seen: string[] = []
    watched.subscribe(() => {
      const s = watched.getState()
      seen.push(`${s.status}:${s.data?.Online.PageInfo.TotalCount}:${s.data?.Online.Label}:errors=${s.errors.length}`)
    })
    watched.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    seen.length = 0
    await watched.refetch()
    expect(seen).toEqual(["refreshing:7:online:errors=0", last])
    client.dispose()
  })

  it("a later store write still reaches the query, with the errors of the response that set them", async () => {
    const replies = [count(7), count(null, "online", [{ message: "x", path: ["Online", "PageInfo", "TotalCount"] }]), count(9, "later")]
    const client = createClient({ network: { execute: async () => replies.shift()! } })
    const watched = client.watchQuery<any>(ops.Count!, {})
    watched.open()
    await watched.refetch()
    await watched.refetch()
    // Another read of the same records: the store watch shows its data; the errors stay those of this query's own last response.
    await client.query(ops.Count!, {}, { policy: "network-only" })
    expect(watched.getState().data.Online).toMatchObject({ Label: "later", PageInfo: { TotalCount: 9 } })
    expect(watched.getState()).toMatchObject({ status: "ready", errors: [{ message: "x" }] })
    client.dispose()
  })
})

describe("a response that leaves out a selected field", () => {
  const setup = (answers: GraphQLResponse[], options: Partial<ClientOptions> = {}) => {
    const network = createMockNetwork({ respond: () => answers.length > 1 ? answers.shift()! : answers[0]! })
    const client = createClient({ network, ...options })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    return { network, client, warn }
  }

  it("warns once per operation and path, naming the operation, type, record and response key", async () => {
    const { client, warn } = setup([{ data: { Foos: [{ __typename: "Foo", Id: "1", Note: null }, { __typename: "Foo", Id: "2", Note: "n" }] } }])
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await watched.refetch()
    expect(watched.getState().status).toBe("ready")
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]![0])
    expect(message).toContain("Foos")
    expect(message).toContain("Foo")
    expect(message).toContain(encodeNodeId("Foo", ["1"]))
    expect(message).toContain('"Name"')
    expect(message).toContain("Foos.0.Name")
    await watched.refetch()
    expect(warn).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it("says nothing for a null at a nullable field", async () => {
    const { client, warn } = setup([{ data: { Foos: [{ ...foo("1"), Note: null }] } }])
    await client.query(ops.Foos!, {})
    expect(warn).not.toHaveBeenCalled()
    client.dispose()
  })

  it("says nothing for a field under a legacy @skip or @include", async () => {
    const legacy = compile(schema, ["query Maybe($Show: Boolean!) { Foos { Id Name @include(if: $Show) Note @skip(if: $Show) } }"], { conditionalDirectives: "legacy" })
    const { client, warn } = setup([{ data: { Foos: [{ __typename: "Foo", Id: "1" }] } }])
    await client.query(legacy.operations.Maybe!, { Show: false })
    expect(warn).not.toHaveBeenCalled()
    client.dispose()
  })

  it("says nothing for a field an error is reported at", async () => {
    const { client, warn } = setup([{ data: { Foos: [{ __typename: "Foo", Id: "1", Note: null }] }, errors: [{ message: "denied", path: ["Foos", 0, "Name"] }] }])
    await client.query(ops.Foos!, {})
    expect(warn).not.toHaveBeenCalled()
    client.dispose()
  })

  it("missingFields: \"error\" reports it as an error at that path, and \"off\" says nothing", async () => {
    const answer = { data: { Foos: [{ __typename: "Foo", Id: "1", Note: null }] } }
    const strict = setup([answer], { missingFields: "error" })
    const watched = strict.client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await watched.refetch()
    const state = watched.getState()
    expect(state.status).toBe("ready")
    expect(errorsAtPath(state.errors, ["Foos", 0, "Name"])).toEqual([
      expect.objectContaining({ path: ["Foos", 0, "Name"], extensions: { code: "RESPONSE_FIELD_MISSING" } }),
    ])
    expect(errorsAtPath(state.errors, ["Foos", 0, "Note"])).toEqual([])
    expect(classifyError(state.errors)!.kind).toBe("unknown")
    expect(strict.warn).not.toHaveBeenCalled()
    strict.client.dispose()
    vi.restoreAllMocks()
    const off = setup([answer], { missingFields: "off" })
    await off.client.query(ops.Foos!, {})
    expect(off.warn).not.toHaveBeenCalled()
    off.client.dispose()
  })

  it("doesn't read again in a loop while the record stays incomplete", async () => {
    const { client, network, warn } = setup([{ data: { Foo: { __typename: "Foo", Id: "1" } } }])
    const watched = client.watchQuery<any>(ops.Detail!, { Id: "1" })
    watched.open()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const sent = network.requests.length
    expect(sent).toBe(1)
    // Another response touches the same record without completing it.
    network.answer("Touch", { data: { Touch: { __typename: "TouchResult", Success: true, Foo: { __typename: "Foo", Id: "1" } } } })
    await client.mutate(ops.Touch!, { Id: "1" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(network.calls("Detail").length).toBeLessThanOrEqual(2)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const settled = network.calls("Detail").length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(network.calls("Detail").length).toBe(settled)
    expect(warn.mock.calls.filter(([message]) => String(message).includes("Detail")).length).toBe(1)
    client.dispose()
  })
})

describe("refetchQueries selects open queries by their variables", () => {
  const setup = () => {
    const network = createMockNetwork({ operations: { Detail: (variables) => ({ data: { Foo: foo(String(variables.Id)) } }), Touch: { data: { Touch: { __typename: "TouchResult", Success: true, Foo: foo("a") } } } } })
    const client = createClient({ network })
    const a = client.watchQuery(ops.Detail!, { Id: "a" })
    const b = client.watchQuery(ops.Detail!, { Id: "b" })
    a.open()
    b.open()
    return { client, network, a, b }
  }
  const fetched = (network: ReturnType<typeof setup>["network"], from: number) => network.calls("Detail").slice(from).map((request) => request.variables.Id)

  it("with a predicate", async () => {
    const { client, network } = setup()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const from = network.calls("Detail").length
    const changed = new Set(["a"])
    await client.refetchQueries([{ query: ops.Detail!, variables: (v) => changed.has(v.Id) }])
    expect(fetched(network, from)).toEqual(["a"])
    client.dispose()
  })

  it("with a partial object, by artifact or by name", async () => {
    const { client, network } = setup()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let from = network.calls("Detail").length
    await client.refetchQueries([{ query: ops.Detail!, variables: { Id: "b" } }])
    expect(fetched(network, from)).toEqual(["b"])
    from = network.calls("Detail").length
    await client.refetchQueries([{ query: "Detail", variables: { Id: "a" } }])
    expect(fetched(network, from)).toEqual(["a"])
    from = network.calls("Detail").length
    await client.refetchQueries([{ query: "Detail", variables: { Id: "c" } }])
    expect(fetched(network, from)).toEqual([])
    client.dispose()
  })

  it("from mutate, and the existing forms are unchanged", async () => {
    const { client, network } = setup()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let from = network.calls("Detail").length
    await client.mutate(ops.Touch!, { Id: "a" }, { refetchQueries: [{ query: ops.Detail!, variables: (v: { Id: string }) => v.Id === "a" }] })
    expect(fetched(network, from)).toEqual(["a"])
    from = network.calls("Detail").length
    await client.refetchQueries([ops.Detail!])
    expect(fetched(network, from).sort()).toEqual(["a", "b"])
    from = network.calls("Detail").length
    await client.refetchQueries(["Detail"])
    expect(fetched(network, from).sort()).toEqual(["a", "b"])
    from = network.calls("Detail").length
    await client.refetchQueries("active")
    expect(fetched(network, from).sort()).toEqual(["a", "b"])
    client.dispose()
  })
})

describe("read deadline", () => {
  const hanging = () => {
    const calls: RequestInit[] = []
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(init!)
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
    }) as typeof globalThis.fetch
    return { fetch, calls }
  }
  const request = (kind: OperationRequest["kind"]): OperationRequest => ({ kind, name: "Foos", text: "query Foos { Foos { Id } }", hash: "", variables: {} })

  it("a read that never answers ends in error at the default deadline of 30 seconds", async () => {
    vi.useFakeTimers()
    const { fetch } = hanging()
    const client = createClient({ network: createHttpNetwork({ url: "http://example.test/graphql", fetch }) })
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(watched.getState().status).toBe("loading")
    await vi.advanceTimersByTimeAsync(1)
    expect(watched.getState().status).toBe("error")
    expect(classifyError(watched.getState().error)!.kind).toBe("network")
    client.dispose()
  })

  it("can be changed or removed, and writes still have none by default", async () => {
    vi.useFakeTimers()
    const { fetch } = hanging()
    const settled = (promise: Promise<unknown>) => {
      let done = false
      promise.then(() => (done = true), () => (done = true))
      return () => done
    }
    const short = settled(createHttpNetwork({ url: "http://x", fetch, reads: { deadlineMs: 50 } }).execute(request("query"), {}))
    const none = settled(createHttpNetwork({ url: "http://x", fetch, reads: { deadlineMs: null } }).execute(request("query"), {}))
    const write = settled(createHttpNetwork({ url: "http://x", fetch }).execute(request("mutation"), {}))
    await vi.advanceTimersByTimeAsync(50)
    expect(short()).toBe(true)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(none()).toBe(false)
    expect(write()).toBe(false)
  })

  it("the deadline timer is cleared once the response is read", async () => {
    vi.useFakeTimers()
    const fetch = (async () => new Response(JSON.stringify({ data: { Foos: [] } }))) as typeof globalThis.fetch
    await createHttpNetwork({ url: "http://x", fetch }).execute(request("query"), {})
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("read retry", () => {
  const setup = (failures: number, options: { retry?: boolean | object; failure?: () => unknown } = {}) => {
    const clock = createTestClock()
    let failed = 0
    const network = createMockNetwork({
      operations: {
        Foos: () => {
          if (failed < failures) {
            failed++
            throw (options.failure ?? offline)()
          }
          return { data: { Foos: [foo("1")] } }
        },
        Touch: () => {
          throw offline()
        },
      },
    })
    const client = createClient({ network, store: clock.store, reads: { retry: options.retry ?? { random: () => 0.5 } } })
    return { clock, network, client }
  }

  it("a read that fails twice before any response and then succeeds ends ready, with no call from the application", async () => {
    const { clock, network, client } = setup(2)
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await clock.tick()
    expect(network.calls("Foos").length).toBe(1)
    expect(watched.getState().status).toBe("loading")
    await clock.tick(60_000)
    expect(network.calls("Foos").length).toBe(3)
    expect(watched.getState()).toMatchObject({ status: "ready", error: null })
    client.dispose()
  })

  it("backs off with jitter, and stops after the configured attempts", async () => {
    const { clock, network, client } = setup(10, { retry: { retries: 2, baseMs: 100, maxMs: 150, random: () => 0 } })
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await clock.tick()
    // Half-jitter: between half and all of min(maxMs, baseMs * 2^attempt).
    expect(clock.pending().map((timer) => timer.ms)).toEqual([50])
    await clock.tick(50)
    expect(clock.pending().map((timer) => timer.ms)).toEqual([75])
    await clock.tick(75)
    expect(network.calls("Foos").length).toBe(3)
    expect(watched.getState().status).toBe("error")
    expect(clock.pending()).toEqual([])
    client.dispose()
  })

  it("is off unless asked for", async () => {
    const clock = createTestClock()
    const network = createMockNetwork({ operations: { Foos: () => { throw offline() } } })
    const client = createClient({ network, store: clock.store })
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await clock.tick(60_000)
    expect(network.calls("Foos").length).toBe(1)
    expect(watched.getState().status).toBe("error")
    client.dispose()
  })

  it("doesn't retry a read that got a response", async () => {
    const { clock, network, client } = setup(1, { failure: () => new Error("bad response") })
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await clock.tick(60_000)
    expect(network.calls("Foos").length).toBe(1)
    expect(watched.getState().status).toBe("error")
    client.dispose()
  })

  it("never sends a write twice", async () => {
    const { clock, network, client } = setup(0)
    await expect(client.mutate(ops.Touch!, { Id: "1" })).rejects.toThrow()
    await clock.tick(60_000)
    expect(network.calls("Touch").length).toBe(1)
    client.dispose()
  })

  it("disposal during a retry's wait sends nothing more", async () => {
    const { clock, network, client } = setup(5)
    const watched = client.watchQuery<any>(ops.Foos!, {})
    const states: string[] = []
    watched.subscribe(() => states.push(watched.getState().status))
    watched.open()
    await clock.tick()
    expect(network.calls("Foos").length).toBe(1)
    client.dispose()
    await clock.tick(60_000)
    expect(network.calls("Foos").length).toBe(1)
    expect(states).toEqual([])
    expect(clock.pending()).toEqual([])
  })

  it("closing during a retry's wait sends nothing more", async () => {
    const { clock, network, client } = setup(5)
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await clock.tick()
    watched.close()
    await clock.tick(60_000)
    expect(network.calls("Foos").length).toBe(1)
    client.dispose()
  })

  it("a newer read replaces the waiting retry", async () => {
    const { clock, network, client } = setup(1)
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await clock.tick()
    expect(network.calls("Foos").length).toBe(1)
    await watched.refetch()
    expect(network.calls("Foos").length).toBe(2)
    expect(watched.getState().status).toBe("ready")
    await clock.tick(60_000)
    expect(network.calls("Foos").length).toBe(2)
    client.dispose()
  })
})

describe("coming back online", () => {
  it("re-reads open queries in error, and can be turned off", async () => {
    for (const refetchOnOnline of [undefined, false]) {
      let fail = true
      const network = createMockNetwork({ operations: { Foos: () => { if (fail) throw offline(); return { data: { Foos: [foo("1")] } } } } })
      const client = createClient({ network, ...(refetchOnOnline === false ? { reads: { refetchOnOnline } } : {}) })
      const watched = client.watchQuery<any>(ops.Foos!, {})
      const idle = client.watchQuery<any>(ops.Detail!, { Id: "1" })
      network.answer("Detail", { data: { Foo: foo("1") } })
      watched.open()
      idle.open()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(watched.getState().status).toBe("error")
      fail = false
      window.dispatchEvent(new Event("online"))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(network.calls("Foos").length).toBe(refetchOnOnline === false ? 1 : 2)
      expect(network.calls("Detail").length).toBe(1)
      expect(watched.getState().status).toBe(refetchOnOnline === false ? "error" : "ready")
      client.dispose()
    }
  })

  it("stops listening when the client is disposed", async () => {
    const network = createMockNetwork({ operations: { Foos: () => { throw offline() } } })
    const client = createClient({ network })
    const watched = client.watchQuery<any>(ops.Foos!, {})
    watched.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.dispose()
    window.dispatchEvent(new Event("online"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(network.calls("Foos").length).toBe(1)
  })
})
