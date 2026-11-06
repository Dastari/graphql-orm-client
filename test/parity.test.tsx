// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { OperationError, createClient, readFragment } from "../src/client.js"
import { ClientProvider, useMutation, useQuery, useSubscription } from "../src/react/index.js"
import { widget, catalog, frags, mockNetwork, mockSubscriptions, ops, ticket, ticketPage, ticketServer } from "./fixtures.js"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
type TicketsData = { Tickets: { Edges: { Node: object }[] } }
const title = (ref: unknown) => readFragment<{ Title: string }>(frags.TicketRow, ref as never).Title

function timers() {
  const intervals = new Map<number, { callback: () => void; ms: number }>()
  let next = 0
  return {
    intervals,
    setInterval: (callback: () => void, ms: number) => (intervals.set(++next, { callback, ms }), next),
    clearInterval: (handle: unknown) => void intervals.delete(handle as number),
  }
}

const reopened = (overrides: Record<string, unknown> = {}) => ({
  ReopenTicket: {
    __typename: "ReopenResult",
    Accepted: true,
    Message: "reopened",
    Ticket: ticket("t1", { State: "open", RecordVersion: 2 }),
    Audit: [
      { __typename: "AuditEntry", At: "2026-11-04T10:00:00Z", By: "toby" },
      { __typename: "AuditEntry", At: "2026-11-04T10:01:00Z", By: "agent" },
    ],
    ...overrides,
  },
})

describe("useQuery for an Apollo port", () => {
  function Lookup({ text, skip }: { text: string; skip?: boolean }) {
    const query = useQuery<{ LookupName: string | null }>(ops.LookupName, { Text: text }, skip ? { skip } : {})
    return (
      <>
        <p>{`${query.status}:${query.data?.LookupName ?? "-"}`}</p>
        <button onClick={() => void query.refetch({ Text: "second" })}>switch</button>
      </>
    )
  }

  it("refetch(variables) merges them into the current variables and switches to them", async () => {
    const { network, requests } = mockNetwork(({ variables }) => ({ data: { LookupName: `name of ${String(variables.Text)}` } }))
    const client = createClient({ network })
    const view = render(
      <ClientProvider client={client}>
        <Lookup text="first" />
      </ClientProvider>
    )
    await screen.findByText("ready:name of first")
    await act(async () => screen.getByText("switch").click())
    await screen.findByText("ready:name of second")
    expect(requests.map((request) => request.variables.Text)).toEqual(["first", "second"])

    // A new variables argument replaces what refetch switched to.
    view.rerender(
      <ClientProvider client={client}>
        <Lookup text="third" />
      </ClientProvider>
    )
    await screen.findByText("ready:name of third")
  })

  it("skip sends nothing and reports idle", async () => {
    const { network, requests } = mockNetwork(() => ({ data: { LookupName: "x" } }))
    const client = createClient({ network })
    const view = render(
      <ClientProvider client={client}>
        <Lookup text="a" skip />
      </ClientProvider>
    )
    expect(screen.getByText("idle:-")).toBeTruthy()
    expect(requests).toHaveLength(0)
    view.rerender(
      <ClientProvider client={client}>
        <Lookup text="a" />
      </ClientProvider>
    )
    await screen.findByText("ready:x")
  })

  it("replaces and stops a query's poll interval with its pollMs option", async () => {
    const clock = timers()
    const { network } = mockNetwork(() => ({ data: { LookupName: "x" } }))
    const client = createClient({ network, polling: { ...clock, liveFallbackMs: null } })
    function Polled({ pollMs }: { pollMs?: number }) {
      const query = useQuery(ops.LookupName, { Text: "a" }, pollMs === undefined ? {} : { pollMs })
      return <p>{query.status}</p>
    }
    const ui = (pollMs?: number) => (
      <ClientProvider client={client}>
        <Polled {...(pollMs === undefined ? {} : { pollMs })} />
      </ClientProvider>
    )
    const view = render(ui(5000))
    await screen.findByText("ready")
    expect([...clock.intervals.values()].map((entry) => entry.ms)).toEqual([5000])
    view.rerender(ui(60_000))
    expect([...clock.intervals.values()].map((entry) => entry.ms)).toEqual([60_000])
    view.rerender(ui())
    expect(clock.intervals.size).toBe(0)
    view.rerender(ui(1000))
    view.unmount()
    expect(clock.intervals.size).toBe(0)
  })

  it("follows Apollo's fetch policies under their own names", async () => {
    const { network, requests } = mockNetwork(() => ({ data: { LookupName: "fresh" } }))
    const client = createClient({ network })
    await client.query(ops.LookupName, { Text: "a" })
    expect(requests).toHaveLength(1)

    // cache-first: store-or-network answers from the store.
    const first = client.watchQuery(ops.LookupName, { Text: "a" }, "store-or-network")
    first.open()
    expect(first.getState().status).toBe("ready")
    expect(requests).toHaveLength(1)
    first.close()

    // cache-and-network: shows the stored result and fetches.
    const both = client.watchQuery(ops.LookupName, { Text: "a" }, "store-and-network")
    expect(both.getState().status).toBe("ready")
    both.open()
    expect(requests).toHaveLength(2)
    both.close()

    // network-only: shows nothing until the server answers.
    const network_ = client.watchQuery(ops.LookupName, { Text: "a" }, "network-only")
    expect(network_.getState()).toMatchObject({ status: "loading", data: undefined })
    network_.open()
    await settle()
    expect(network_.getState().status).toBe("ready")
    expect(requests).toHaveLength(3)
    network_.close()
  })
})

describe("imperative reads: client.query", () => {
  it("answers from the store when complete, else fetches; network-only always fetches", async () => {
    const server = ticketServer(3)
    const client = createClient({ network: server.network })
    const { data, errors } = await client.query<TicketsData>(ops.TicketsPage, { Page: { Limit: 3, Offset: 0 } })
    expect(data.Tickets.Edges.map((edge) => title(edge.Node))).toEqual(["ticket-t1", "ticket-t2", "ticket-t3"])
    expect(errors).toEqual([])
    await client.query(ops.TicketsPage, { Page: { Limit: 3, Offset: 0 } })
    expect(server.requests).toHaveLength(1)
    await client.query(ops.TicketsPage, { Page: { Limit: 3, Offset: 0 } }, { policy: "network-only" })
    expect(server.requests).toHaveLength(2)
    await expect(client.query(ops.Ping, {})).rejects.toThrow(/not a query/)
  })

  it("keeps what it read for the retention period", async () => {
    const timeouts: (() => void)[] = []
    const { network } = mockNetwork(() => ({ data: { LookupName: "x" } }))
    const client = createClient({ network, store: { setTimeout: (callback) => timeouts.push(callback), clearTimeout: () => {} } })
    await client.query(ops.LookupName, { Text: "a" })
    expect(client.store.lookup({ id: "client:root", selections: ops.LookupName.selections, variables: { Text: "a" }, fragments: {} }).missing).toBe(false)
    timeouts.forEach((callback) => callback())
    expect(client.store.lookup({ id: "client:root", selections: ops.LookupName.selections, variables: { Text: "a" }, fragments: {} }).missing).toBe(true)
  })
})

describe("abort signals", () => {
  it("cancels a query and a mutation, rolling back its optimistic layer", async () => {
    const server = ticketServer(1)
    const { network } = mockNetwork(async (request) => {
      await settle()
      return request.name === "Reopen" ? { data: reopened() } : server.network.execute(request, {})
    })
    const client = createClient({ network })
    const aborted = new AbortController()
    aborted.abort()
    await expect(client.query(ops.LookupName, { Text: "a" }, { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" })

    const list = client.watchQuery<TicketsData>(ops.TicketsPage, { Page: { Limit: 1, Offset: 0 } })
    list.open()
    await list.refetch()
    const controller = new AbortController()
    const pending = client.mutate(ops.Reopen, { Id: "t1" }, {
      signal: controller.signal,
      optimisticResponse: reopened({ Ticket: ticket("t1", { Title: "guess", RecordVersion: 2 }) }),
    })
    expect(title(list.getState().data!.Tickets.Edges[0]!.Node)).toBe("guess")
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(title(list.getState().data!.Tickets.Edges[0]!.Node)).toBe("ticket-t1")
    list.close()
  })
})

describe("unkeyed results", () => {
  it("stores an unkeyed mutation result embedded, with its keyed records normalised", async () => {
    const server = ticketServer(2)
    const { network } = mockNetwork((request) => (request.name === "Reopen" ? { data: reopened() } : request.name === "Ping" ? { data: { Ping: true } } : server.network.execute(request, {})))
    const client = createClient({ network })
    const list = client.watchQuery<TicketsData>(ops.TicketsPage, { Page: { Limit: 2, Offset: 0 } })
    list.open()
    await list.refetch()
    const { data } = await client.mutate<{
      ReopenTicket: { Accepted: boolean; Message: string | null; Ticket: object | null; Audit: { At: string; By: string }[] }
    }>(ops.Reopen, { Id: "t1" })
    expect(data.ReopenTicket).toMatchObject({ Accepted: true, Message: "reopened", Audit: [{ By: "toby" }, { By: "agent" }] })
    expect(title(data.ReopenTicket.Ticket)).toBe("ticket-t1")
    expect(readFragment<{ State: string }>(frags.TicketRow, list.getState().data!.Tickets.Edges[0]!.Node as never).State).toBe("open")
    // A second mutation's result doesn't overwrite the first's.
    await client.mutate(ops.Reopen, { Id: "t1" })
    expect(data.ReopenTicket.Audit).toHaveLength(2)
    expect((await client.mutate<{ Ping: boolean }>(ops.Ping, {})).data.Ping).toBe(true)
    list.close()
  })

  it("reads hand-written roots: a scalar, an unkeyed object and a list of unkeyed rows", async () => {
    let rows = [
      { __typename: "ReportRow", Label: "a", Count: 1 },
      { __typename: "ReportRow", Label: "b", Count: 2 },
    ]
    const { network, requests } = mockNetwork(({ name, variables }) => {
      if (name === "LookupName") return { data: { LookupName: variables.Text === "none" ? null : "Acme" } }
      if (name === "QueueSummary")
        return { data: { TicketSummary: { __typename: "TicketSummary", Open: 3, Closed: 9, Oldest: ticket("t7") } } }
      return { data: { ReportRows: rows } }
    })
    const client = createClient({ network })
    expect((await client.query(ops.LookupName, { Text: "a" })).data).toEqual({ LookupName: "Acme" })
    expect((await client.query(ops.LookupName, { Text: "none" })).data).toEqual({ LookupName: null })
    expect((await client.query(ops.QueueSummary, { Queue: "q" })).data).toEqual({
      TicketSummary: { __typename: "TicketSummary", Open: 3, Closed: 9, Oldest: { __typename: "Ticket", Id: "t7", RecordVersion: 1, Title: "ticket-t7" } },
    })
    const report = client.watchQuery<{ ReportRows: { Label: string; Count: number }[] }>(ops.Report, { Limit: 10 })
    report.open()
    await settle()
    expect(report.getState().data!.ReportRows.map((row) => row.Label)).toEqual(["a", "b"])
    rows = [{ __typename: "ReportRow", Label: "c", Count: 5 }]
    await report.refetch()
    expect(report.getState().data!.ReportRows).toEqual([{ __typename: "ReportRow", Label: "c", Count: 5 }])
    report.close()
    expect(requests).toHaveLength(5)
  })
})

describe("partial errors", () => {
  const partial = {
    data: { LookupName: null },
    errors: [{ message: "Name is restricted", path: ["LookupName"], extensions: { code: "FORBIDDEN" } }],
  }

  it("keep the data and surface the errors with their codes", async () => {
    const { network } = mockNetwork(() => partial)
    const client = createClient({ network })
    const watched = client.watchQuery(ops.LookupName, { Text: "a" })
    watched.open()
    await settle()
    expect(watched.getState()).toMatchObject({ status: "ready", data: { LookupName: null }, error: null })
    expect(watched.getState().errors[0]?.extensions?.code).toBe("FORBIDDEN")
    const read = await client.query(ops.LookupName, { Text: "b" })
    expect(read.errors[0]?.extensions?.code).toBe("FORBIDDEN")
    watched.close()
  })

  it("reach useMutation as an OperationError with the codes", async () => {
    const { network } = mockNetwork(() => ({ data: reopened(), errors: [{ message: "audit delayed", extensions: { code: "AUDIT_DELAYED" } }] }))
    const client = createClient({ network })
    let mutation!: ReturnType<typeof useMutation>
    function Button() {
      mutation = useMutation(ops.Reopen)
      return <p>{mutation.error ? "failed" : "ok"}</p>
    }
    render(
      <ClientProvider client={client}>
        <Button />
      </ClientProvider>
    )
    const result = await act(() => mutation.commit({ Id: "t1" }))
    expect(result.errors).toHaveLength(1)
    expect(mutation.error).toBeInstanceOf(OperationError)
    expect((mutation.error as OperationError).errors[0]?.extensions?.code).toBe("AUDIT_DELAYED")
  })
})

describe("refetchQueries", () => {
  it("refetches open queries by artifact or name, and after a mutation", async () => {
    const server = ticketServer(2)
    const { network, requests } = mockNetwork((request) =>
      request.name === "Reopen" ? { data: reopened() } : request.name === "CatalogPage" ? { data: catalog([widget("d1")]) } : server.network.execute(request, {})
    )
    const client = createClient({ network })
    const tickets = client.watchQuery(ops.TicketsPage, { Page: { Limit: 2, Offset: 0 } })
    const widgets = client.watchQuery(ops.CatalogPage, {})
    tickets.open()
    widgets.open()
    await settle()
    const count = (name: string) => requests.filter((request) => request.name === name).length
    await client.refetchQueries([ops.TicketsPage])
    expect([count("TicketsPage"), count("CatalogPage")]).toEqual([2, 1])
    await client.refetchQueries(["CatalogPage"])
    expect([count("TicketsPage"), count("CatalogPage")]).toEqual([2, 2])
    await client.mutate(ops.Reopen, { Id: "t1" }, { refetchQueries: [ops.TicketsPage] })
    expect(count("TicketsPage")).toBe(3)
    widgets.close()
    await client.refetchQueries(["CatalogPage"])
    expect(count("CatalogPage")).toBe(2)
    tickets.close()
  })
})

describe("plain subscriptions", () => {
  const event = (id: string, overrides: Record<string, unknown> = {}) => ({
    data: { TicketChanged: { __typename: "TicketChangedEvent", Action: "UPDATED", Ticket: ticket(id, overrides) } },
  })

  it("write each event into the store and pass it on with masked references", async () => {
    const server = ticketServer(2)
    const subscriptions = mockSubscriptions()
    const client = createClient({ network: server.network, live: { subscribe: subscriptions.subscribe } })
    const list = client.watchQuery<TicketsData>(ops.TicketsPage, { Page: { Limit: 2, Offset: 0 } })
    list.open()
    await settle()
    const received: string[] = []
    const stop = client.subscribe<{ TicketChanged: { Action: string; Ticket: object } }>(ops.TicketFeed, { Keys: ["t1"] }, {
      next: ({ data }) => received.push(`${data.TicketChanged.Action}:${title(data.TicketChanged.Ticket)}`),
    })
    const [stream] = subscriptions.find("TicketFeed")
    expect(stream!.request.variables).toEqual({ Keys: ["t1"] })
    stream!.sink.next(event("t1", { Title: "first", RecordVersion: 2 }))
    expect(title(list.getState().data!.Tickets.Edges[0]!.Node)).toBe("first")
    const size = client.store.size
    for (let index = 3; index < 20; index += 1) stream!.sink.next(event("t1", { Title: `v${index}`, RecordVersion: index }))
    // Each event's payload replaces the last one's; nothing piles up.
    expect(client.store.size).toBe(size)
    expect(received.at(-1)).toBe("UPDATED:v19")
    stop()
    expect(subscriptions.open.size).toBe(0)
    list.close()
  })

  it("report an event without data as an OperationError with its code", () => {
    const subscriptions = mockSubscriptions()
    const client = createClient({ network: mockNetwork(() => ({ data: {} })).network, live: { subscribe: subscriptions.subscribe } })
    const errors: Error[] = []
    let completed = false
    client.subscribe(ops.TicketFeed, {}, { error: (error) => errors.push(error), complete: () => (completed = true) })
    const [stream] = subscriptions.find("TicketFeed")
    stream!.sink.next({ data: null, errors: [{ message: "lost", extensions: { code: "SUBSCRIPTION_CONTINUITY_LOST" } }] })
    stream!.sink.complete()
    expect((errors[0] as OperationError).errors[0]?.extensions?.code).toBe("SUBSCRIPTION_CONTINUITY_LOST")
    expect(completed).toBe(true)
    client.dispose()
    expect(subscriptions.open.size).toBe(0)
  })

  it("need a transport, and a subscription document", () => {
    const client = createClient({ network: mockNetwork(() => ({ data: {} })).network })
    expect(() => client.subscribe(ops.TicketFeed, {}, {})).toThrow(/live.subscribe/)
    expect(() => client.subscribe(ops.LookupName as never, {}, {})).toThrow(/not a subscription/)
  })

  it("run from useSubscription while mounted", async () => {
    const subscriptions = mockSubscriptions()
    const client = createClient({ network: mockNetwork(() => ({ data: {} })).network, live: { subscribe: subscriptions.subscribe } })
    const seen: string[] = []
    function Feed({ on }: { on: boolean }) {
      const feed = useSubscription<{ TicketChanged: { Ticket: object } }>(ops.TicketFeed, on ? { Keys: ["t1"] } : null, {
        onData: ({ data }) => seen.push(title(data.TicketChanged.Ticket)),
      })
      return <p>{feed.data ? title(feed.data.TicketChanged.Ticket) : "waiting"}</p>
    }
    const view = render(
      <ClientProvider client={client}>
        <Feed on />
      </ClientProvider>
    )
    expect(screen.getByText("waiting")).toBeTruthy()
    act(() => subscriptions.find("TicketFeed")[0]!.sink.next(event("t1", { Title: "hello" })))
    expect(screen.getByText("hello")).toBeTruthy()
    expect(seen).toEqual(["hello"])
    view.rerender(
      <ClientProvider client={client}>
        <Feed on={false} />
      </ClientProvider>
    )
    expect(subscriptions.open.size).toBe(0)
  })
})

describe("live events", () => {
  it("don't leave their payload records in the store", async () => {
    const server = ticketServer(1)
    const subscriptions = mockSubscriptions()
    const { compiled } = await import("./fixtures.js")
    const client = createClient({
      network: server.network,
      live: { artifacts: compiled.live, subscribe: subscriptions.subscribe, setTimeout: () => 0, clearTimeout: () => {} },
    })
    const list = client.watchQuery(ops.TicketsPage, { Page: { Limit: 1, Offset: 0 } })
    list.open()
    await settle()
    client.live!.flush()
    const [stream] = subscriptions.find("LiveTicket")
    const send = (version: number) =>
      stream!.sink.next({
        data: { TicketChanged: { __typename: "TicketChangedEvent", Action: "UPDATED", Ticket: ticket("t1", { Title: `v${version}`, RecordVersion: version }) } },
      })
    send(2)
    const size = client.store.size
    for (let version = 3; version < 10; version += 1) send(version)
    expect(client.store.size).toBe(size)
    expect(ticketPage([ticket("t1")]).Tickets.Edges).toHaveLength(1)
    list.close()
  })
})
