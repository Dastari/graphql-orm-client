// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react"
import { StrictMode } from "react"
import { describe, expect, it } from "vitest"
import { createClient, type OperationRequest } from "../src/client.js"
import { ClientProvider, useFragmentList, usePagedQuery } from "../src/react/index.js"
import { frags, mockNetwork, ops, ticketServer } from "./fixtures.js"

type TicketsData = { Tickets: { Edges: { Node: object }[] } }

function TicketTable(props: { where?: Record<string, unknown> | null; pageIndex: number; pageSize?: number; scope?: string | null }) {
  const page = usePagedQuery<TicketsData>(ops.TicketsPage, props.where === undefined ? {} : props.where === null ? null : { Where: props.where }, {
    pageIndex: props.pageIndex,
    pageSize: props.pageSize ?? 10,
    ...(props.scope !== undefined ? { scope: props.scope } : {}),
  })
  const rows = useFragmentList<{ Title: string }>(frags.TicketRow, page.data?.Tickets.Edges.map((edge) => edge.Node))
  return (
    <p>
      {`${page.status} ${page.placeholder ? "placeholder" : "page"} ${page.pageIndex + 1}/${page.pageCount ?? "?"} of ${page.totalCount ?? "?"}: ${rows.map((row) => row.Title).join(",") || "none"}`}
    </p>
  )
}

/** A network that holds back requests for pages after the first until `release()`. */
function gatedServer(count: number) {
  const server = ticketServer(count)
  const waiting: (() => void)[] = []
  const gated = mockNetwork(async (request: OperationRequest) => {
    const page = request.variables.Page as { Offset: number }
    const filtered = Object.keys((request.variables.Where as object | undefined) ?? {}).length > 0
    if (page.Offset > 0 || filtered) await new Promise<void>((resolve) => waiting.push(resolve))
    return server.network.execute(request, {})
  })
  return { ...gated, server, release: () => waiting.splice(0).forEach((resolve) => resolve()) }
}

describe("usePagedQuery", () => {
  it("shows the previous page while the next one loads, then the next one", async () => {
    const { network, requests, release } = gatedServer(25)
    const client = createClient({ network })
    const view = render(
      <ClientProvider client={client}>
        <TicketTable pageIndex={0} pageSize={10} />
      </ClientProvider>
    )
    await screen.findByText(/^ready page 1\/3 of 25: ticket-t1,/)

    view.rerender(
      <ClientProvider client={client}>
        <TicketTable pageIndex={1} pageSize={10} />
      </ClientProvider>
    )
    expect(screen.getByText(/^refreshing placeholder 2\/3 of 25: ticket-t1,/)).toBeTruthy()
    expect(requests.at(-1)!.variables.Page).toEqual({ Limit: 10, Offset: 10 })
    await act(async () => release())
    await screen.findByText(/^ready page 2\/3 of 25: ticket-t11,/)

    // Back to a page seen before: from the store at once.
    view.rerender(
      <ClientProvider client={client}>
        <TicketTable pageIndex={0} pageSize={10} />
      </ClientProvider>
    )
    expect(screen.getByText(/page 1\/3 of 25: ticket-t1,/).textContent).not.toContain("placeholder")
  })

  it("keeps the page across a filter change only within the same scope", async () => {
    const { network, release } = gatedServer(10)
    const client = createClient({ network })
    const ui = (where: Record<string, unknown>, scope?: string) => (
      <ClientProvider client={client}>
        <TicketTable where={where} pageIndex={0} {...(scope ? { scope } : {})} />
      </ClientProvider>
    )
    const view = render(ui({}, "vendor-1"))
    await screen.findByText(/^ready page/)
    view.rerender(ui({ State: { Eq: "open" } }, "vendor-1"))
    expect(screen.getByText(/^refreshing placeholder/)).toBeTruthy()
    await act(async () => release())
    await screen.findByText(/^ready page 1\/1 of 10/)

    // No scope: another filter blanks the table instead of showing rows it doesn't match.
    view.rerender(ui({ State: { Eq: "closed" } }))
    expect(screen.getByText(/^loading page 1\/\? of \?: none/)).toBeTruthy()
    await act(async () => release())
    await screen.findByText(/^ready page 1\/0 of 0: none/)
  })

  it("is idle when skipped, and loads under StrictMode", async () => {
    const { network, requests } = ticketServer(3)
    const client = createClient({ network })
    const view = render(
      <ClientProvider client={client}>
        <TicketTable where={null} pageIndex={0} />
      </ClientProvider>
    )
    expect(screen.getByText(/^idle page 1\/\?/)).toBeTruthy()
    expect(requests).toHaveLength(0)
    view.rerender(
      <StrictMode>
        <ClientProvider client={client}>
          <TicketTable pageIndex={0} />
        </ClientProvider>
      </StrictMode>
    )
    await screen.findByText("ready page 1/1 of 3: ticket-t1,ticket-t2,ticket-t3")
  })
})
