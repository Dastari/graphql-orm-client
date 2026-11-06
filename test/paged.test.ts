import { describe, expect, it } from "vitest"
import { createClient, pageVariables, readFragment, type PagedState } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { compiled, documents, frags, mockNetwork, mockSubscriptions, ops, schema, ticket, ticketPage, ticketServer } from "./fixtures.js"

type TicketsData = { Tickets: { Edges: { Node: object }[]; PageInfo: { TotalCount: number | null } } }

const titles = (state: PagedState<TicketsData>) =>
  (state.data?.Tickets.Edges ?? []).map((edge) => readFragment<{ Title: string }>(frags.TicketRow, edge.Node).Title)

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("@paged compilation", () => {
  it("records the paged field and its page variable, adds the page info and strips the directive", () => {
    expect(ops.TicketsPage.paged).toEqual({
      path: ["Tickets"],
      variable: "Page",
      limit: "Limit",
      offset: "Offset",
      edges: "Edges",
      pageInfo: "PageInfo",
      totalCount: "TotalCount",
      hasNextPage: "HasNextPage",
      hasPreviousPage: "HasPreviousPage",
    })
    expect(ops.TicketsPage.text).not.toContain("@paged")
    expect(ops.TicketsPage.text).toMatch(/PageInfo \{\s+__typename\s+TotalCount\s+HasNextPage\s+HasPreviousPage\s+\}/)
    expect(ops.CatalogPage.paged).toBeUndefined()
  })

  const refuse = (document: string, message: RegExp) =>
    expect(() => compile(schema, [...documents.filter((entry) => entry.startsWith("fragment")), document], { keys: { PageInfo: null } })).toThrow(message)

  it("refuses a page argument that isn't a variable or isn't graphql-orm's PageInput", () => {
    refuse(`query A { Tickets(Page: { Limit: 5 }) @paged { Edges { Node { Id } } } }`, /as a variable/)
    refuse(`query A($Page: KeysetPageInput) { Widgets(Page: $Page) @paged { Edges { Node { Id } } } }`, /Limit and Offset/)
  })

  it("refuses @paged in a fragment, twice in one operation, inside a list or with @connection", () => {
    expect(() => compile(schema, [`fragment F on Query { Tickets(Page: { Limit: 1 }) @paged { Edges { Node { Id } } } }`])).toThrow(/Fragment F uses @paged/)
    refuse(
      `query A($Page: PageInput, $Other: PageInput) {
        a: Tickets(Page: $Page) @paged { Edges { Node { Id } } }
        b: Tickets(Page: $Other) @paged { Edges { Node { Id } } }
      }`,
      /more than one field @paged/
    )
    refuse(`query A($Page: PageInput) { Tickets(Page: $Page) @paged @connection(key: "x") { Edges { Node { Id } } } }`, /also be a @connection/)
    refuse(
      `query A($Page: PageInput) { Search(Text: "x") { ... on Vendor { Tickets(Page: $Page) @paged { Edges { Node { Id } } } } } }`,
      /inside a list/
    )
  })

  it("sets the page variable's limit and offset, keeping its other fields", () => {
    expect(pageVariables(ops.TicketsPage, { Where: { State: { Eq: "open" } } }, 2, 25)).toEqual({
      Where: { State: { Eq: "open" } },
      Page: { Limit: 25, Offset: 50 },
    })
    expect(() => pageVariables(ops.TicketsPage, {}, -1, 25)).toThrow(RangeError)
    expect(() => pageVariables(ops.TicketsPage, {}, 0, 0)).toThrow(RangeError)
    expect(() => pageVariables(ops.CatalogPage, {}, 0, 10)).toThrow(/no @paged field/)
  })
})

describe("watchPagedQuery", () => {
  it("shows one page at a time with the total and page count", async () => {
    const server = ticketServer(23)
    const client = createClient({ network: server.network })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10 })
    paged.open()
    expect(paged.getState()).toMatchObject({ status: "loading", pageIndex: 0, pageSize: 10, placeholder: false })
    await settle()
    expect(paged.getState()).toMatchObject({
      status: "ready",
      totalCount: 23,
      pageCount: 3,
      hasNextPage: true,
      hasPreviousPage: false,
    })
    expect(titles(paged.getState())).toEqual(Array.from({ length: 10 }, (_, index) => `ticket-t${index + 1}`))
    expect(server.requests.at(-1)!.variables).toEqual({ Page: { Limit: 10, Offset: 0 } })

    paged.setPage(2)
    expect(server.requests.at(-1)!.variables).toEqual({ Page: { Limit: 10, Offset: 20 } })
    await settle()
    expect(paged.getState()).toMatchObject({ status: "ready", pageIndex: 2, hasNextPage: false, hasPreviousPage: true })
    expect(titles(paged.getState())).toEqual(["ticket-t21", "ticket-t22", "ticket-t23"])
    paged.close()
  })

  it("keeps the previous page on screen while the next one loads", async () => {
    let release!: () => void
    const server = ticketServer(30)
    const { network, requests } = mockNetwork(async (request) => {
      if ((request.variables.Page as { Offset: number }).Offset > 0) await new Promise<void>((resolve) => (release = resolve))
      return server.network.execute(request, {})
    })
    const client = createClient({ network })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10 })
    const seen: PagedState<TicketsData>[] = []
    paged.subscribe(() => seen.push(paged.getState()))
    paged.open()
    await settle()

    paged.setPage(1)
    expect(requests).toHaveLength(2)
    const waiting = paged.getState()
    expect(waiting).toMatchObject({ status: "refreshing", placeholder: true, pageIndex: 1, totalCount: 30, hasNextPage: true, hasPreviousPage: true })
    expect(titles(waiting)[0]).toBe("ticket-t1")
    // The page never blanks between the two.
    expect(seen.every((state) => state.status === "loading" || state.data !== undefined)).toBe(true)

    release()
    await settle()
    expect(paged.getState()).toMatchObject({ status: "ready", placeholder: false, pageIndex: 1 })
    expect(titles(paged.getState())[0]).toBe("ticket-t11")

    // Two pages forward before either arrives: the page shown stays until the last one does.
    paged.setPage(2)
    paged.setPage(3)
    expect(paged.getState()).toMatchObject({ placeholder: true, pageIndex: 3 })
    expect(titles(paged.getState())[0]).toBe("ticket-t11")
    release()
    await settle()
    expect(paged.getState()).toMatchObject({ status: "ready", placeholder: false, pageIndex: 3, hasNextPage: false })
    paged.close()
  })

  it("caches each page by its variables, so a page seen before shows at once", async () => {
    const server = ticketServer(30)
    const client = createClient({ network: server.network })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10 })
    paged.open()
    await settle()
    paged.setPage(1)
    await settle()
    paged.setPage(0)
    // From the store, without waiting; refreshed in the background (store-and-network).
    expect(paged.getState()).toMatchObject({ placeholder: false, pageIndex: 0 })
    expect(titles(paged.getState())[0]).toBe("ticket-t1")
    expect(server.requests).toHaveLength(3)
    paged.close()

    const cached = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10, pageIndex: 1, policy: "store-or-network" })
    cached.open()
    expect(cached.getState().status).toBe("ready")
    expect(server.requests).toHaveLength(3)
    cached.close()
  })

  it("keeps records normalised across pages: an edit on one page shows on every page", async () => {
    const server = ticketServer(4)
    const { network } = mockNetwork((request) =>
      request.name === "Reopen"
        ? {
            data: {
              ReopenTicket: {
                __typename: "ReopenResult",
                Accepted: true,
                Message: null,
                Ticket: ticket("t3", { Title: "renamed", RecordVersion: 2 }),
                Audit: [],
              },
            },
          }
        : server.network.execute(request, {})
    )
    const client = createClient({ network })
    const small = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 2, pageIndex: 1 })
    const large = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 4 })
    small.open()
    large.open()
    await settle()
    await client.mutate(ops.Reopen, { Id: "t3" })
    expect(titles(small.getState())).toEqual(["renamed", "ticket-t4"])
    expect(titles(large.getState())[2]).toBe("renamed")
    small.close()
    large.close()
  })

  it("keeps the first row in view when the page size changes", async () => {
    const server = ticketServer(60)
    const client = createClient({ network: server.network })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10, pageIndex: 3 })
    paged.open()
    await settle()
    paged.setPageSize(25)
    expect(paged.getState()).toMatchObject({ pageIndex: 1, pageSize: 25, placeholder: true })
    await settle()
    expect(server.requests.at(-1)!.variables).toEqual({ Page: { Limit: 25, Offset: 25 } })
    expect(paged.getState()).toMatchObject({ pageCount: 3, placeholder: false })
    paged.close()
  })

  it("drops the page on new variables unless asked to hold it", async () => {
    const server = ticketServer(12)
    server.setTickets(server.tickets().map((entry, index) => ({ ...entry, State: index % 2 ? "closed" : "open" })))
    const client = createClient({ network: server.network })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 5, pageIndex: 1 })
    paged.open()
    await settle()

    paged.setVariables({ Where: { State: { Eq: "open" } } })
    expect(paged.getState()).toMatchObject({ status: "loading", data: undefined, pageIndex: 0, placeholder: false })
    await settle()
    expect(paged.getState().totalCount).toBe(6)

    paged.setVariables({ Where: { State: { Eq: "closed" } } }, { hold: true })
    expect(paged.getState()).toMatchObject({ status: "refreshing", placeholder: true })
    await settle()
    expect(titles(paged.getState())[0]).toBe("ticket-t2")
    paged.close()
  })

  it("reports a failed page as an error, not as the previous page", async () => {
    const server = ticketServer(20)
    const { network } = mockNetwork((request) =>
      (request.variables.Page as { Offset: number }).Offset > 0
        ? { data: null, errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }] }
        : server.network.execute(request, {})
    )
    const client = createClient({ network })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10 })
    paged.open()
    await settle()
    paged.setPage(1)
    await settle()
    const state = paged.getState()
    expect(state).toMatchObject({ status: "error", placeholder: false, data: undefined })
    expect((state.error as { errors?: { extensions?: { code?: string } }[] }).errors?.[0]?.extensions?.code).toBe("FORBIDDEN")
    paged.close()
  })

  it("polls the page on screen, and only that page", async () => {
    const intervals = new Map<number, { callback: () => void; ms: number }>()
    let next = 0
    const server = ticketServer(30)
    const client = createClient({
      network: server.network,
      polling: {
        liveFallbackMs: null,
        setInterval: (callback, ms) => (intervals.set(++next, { callback, ms }), next),
        clearInterval: (handle) => void intervals.delete(handle as number),
      },
    })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10, pollMs: 5000 })
    paged.open()
    await settle()
    paged.setPage(1)
    await settle()
    expect([...intervals.values()].map((entry) => entry.ms)).toEqual([5000])
    const before = server.requests.length
    for (const entry of intervals.values()) entry.callback()
    expect(server.requests.slice(before).map((request) => request.variables.Page)).toEqual([{ Limit: 10, Offset: 10 }])
    paged.close()
    expect(intervals.size).toBe(0)
  })

  it("keeps the visible page live through Changed events", async () => {
    const server = ticketServer(25)
    const subscriptions = mockSubscriptions()
    const client = createClient({
      network: server.network,
      live: { artifacts: compiled.live, subscribe: subscriptions.subscribe, setTimeout: () => 0, clearTimeout: () => {} },
    })
    const paged = client.watchPagedQuery<TicketsData>(ops.TicketsPage, {}, { pageSize: 10, pageIndex: 1 })
    paged.open()
    await settle()
    client.live!.flush()
    const [stream] = subscriptions.find("LiveTicket")
    expect(stream!.request.variables.Keys).toHaveLength(10)
    stream!.sink.next({
      data: { TicketChanged: { __typename: "TicketChangedEvent", Action: "UPDATED", Ticket: ticket("t12", { Title: "live", RecordVersion: 5 }) } },
    })
    expect(titles(paged.getState())[1]).toBe("live")

    // Another page narrows the subscription to its rows.
    paged.setPage(2)
    await settle()
    client.live!.flush()
    expect(subscriptions.find("LiveTicket")[0]!.request.variables.Keys).toHaveLength(5)
    paged.close()
  })
})

describe("@connection on an offset PageInput", () => {
  it("continues at the number of rows loaded", async () => {
    const server = ticketServer(5)
    const client = createClient({ network: server.network })
    const scroll = client.watchQuery<TicketsData>(ops.TicketsScroll, { Page: { Limit: 2 } })
    scroll.open()
    await scroll.refetch()
    expect(scroll.getState().hasMore).toBe(true)
    await scroll.loadMore()
    expect(server.requests.at(-1)!.variables.Page).toEqual({ Limit: 2, Offset: 2 })
    await scroll.loadMore()
    expect(server.requests.at(-1)!.variables.Page).toEqual({ Limit: 2, Offset: 4 })
    const rows = scroll.getState().data!.Tickets.Edges.map((edge) => readFragment<{ Title: string }>(frags.TicketRow, edge.Node).Title)
    expect(rows).toEqual(["ticket-t1", "ticket-t2", "ticket-t3", "ticket-t4", "ticket-t5"])
    expect(scroll.getState().hasMore).toBe(false)

    // A first-page refresh replaces the head and keeps the rows after it.
    await scroll.refetch()
    expect(scroll.getState().data!.Tickets.Edges).toHaveLength(5)
    scroll.close()
  })

  it("is detected from the schema", () => {
    const connection = (ops.TicketsScroll.selections[0] as { connection?: { offset?: string } }).connection
    expect(connection?.offset).toBe("Offset")
    const keyset = (ops.CatalogScroll.selections[0] as { connection?: { offset?: string } }).connection
    expect(keyset?.offset).toBeUndefined()
    expect(ticketPage([]).Tickets.Edges).toEqual([])
  })
})
