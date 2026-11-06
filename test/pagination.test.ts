import { describe, expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { widget, catalog, frags, mockNetwork, ops } from "./fixtures.js"

type Scroll = { Widgets: { Edges: { Node: object }[]; PageInfo: { TotalCount: number | null } } }

const names = (client: ReturnType<typeof createClient>, data: Scroll | undefined) =>
  (data?.Widgets.Edges ?? []).map((edge) => readFragment<{ Name: string }>(frags.WidgetRow, edge.Node).Name)

/** A server with widgets d1…d5, served two per page. */
function pagedServer() {
  let head = ["d1", "d2"]
  const all = ["d1", "d2", "d3", "d4", "d5"]
  const mock = mockNetwork(({ variables }) => {
    const page = variables.Page as { after?: string | null; limit?: number } | undefined
    const start = page?.after ? all.indexOf(page.after.replace("c-", "")) + 1 : 0
    const ids = page?.after ? all.slice(start, start + 2) : head
    const end = page?.after ? start + ids.length : 2
    return { data: catalog(ids.map((id) => widget(id)), { hasNext: end < all.length, total: all.length }) }
  })
  return { ...mock, setHead: (ids: string[]) => (head = ids) }
}

describe("pagination", () => {
  it("strips @connection and selects cursors and page info", () => {
    expect(ops.CatalogScroll.text).not.toContain("@connection")
    const query = ops.CatalogScroll.text.split("fragment")[0]!
    expect(query).toMatch(/\n {6}Cursor\n/)
    expect(query).toMatch(/PageInfo \{[^}]*HasNextPage[^}]*EndCursor/)
  })

  it("appends each next page to one stored list", async () => {
    const { network, requests } = pagedServer()
    const client = createClient({ network })
    const scroll = client.watchQuery<Scroll>(ops.CatalogScroll, { Page: { limit: 2 } })
    scroll.open()
    await scroll.refetch()
    expect(names(client, scroll.getState().data)).toEqual(["widget-d1", "widget-d2"])
    expect(scroll.getState().hasMore).toBe(true)

    await scroll.loadMore()
    expect(requests.at(-1)!.variables.Page).toEqual({ limit: 2, after: "c-d2" })
    expect(names(client, scroll.getState().data)).toEqual(["widget-d1", "widget-d2", "widget-d3", "widget-d4"])

    await scroll.loadMore()
    expect(names(client, scroll.getState().data)).toHaveLength(5)
    expect(scroll.getState().hasMore).toBe(false)
    expect(scroll.getState().loadingMore).toBe(false)
  })

  it("a first-page refresh replaces the head and keeps the pages loaded after it", async () => {
    const server = pagedServer()
    const client = createClient({ network: server.network })
    const scroll = client.watchQuery<Scroll>(ops.CatalogScroll, { Page: { limit: 2 } })
    scroll.open()
    await scroll.refetch()
    await scroll.loadMore()
    server.setHead(["d2", "d9"])
    await scroll.refetch()
    expect(names(client, scroll.getState().data)).toEqual(["widget-d2", "widget-d9", "widget-d3", "widget-d4"])
    // Continue after the last loaded page, not after the refreshed head.
    await scroll.loadMore()
    expect(server.requests.at(-1)!.variables.Page).toMatchObject({ after: "c-d4" })
  })

  it("keeps a separate list per filter", async () => {
    const { network } = mockNetwork(({ variables }) => {
      const where = variables.Where as { Name?: { Eq?: string } } | undefined
      return { data: catalog(where?.Name?.Eq ? [widget("a")] : [widget("a"), widget("b")]) }
    })
    const client = createClient({ network })
    const all = await client.execute<Scroll>(ops.CatalogScroll, { Page: { limit: 10 } })
    const one = await client.execute<Scroll>(ops.CatalogScroll, { Where: { Name: { Eq: "a" } }, Page: { limit: 10 } })
    expect(all.snapshot.data.Widgets.Edges).toHaveLength(2)
    expect(one.snapshot.data.Widgets.Edges).toHaveLength(1)
  })

  it("needs the paging argument as a variable to load more", async () => {
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1")], { hasNext: true }) }))
    const client = createClient({ network })
    const fixed = client.watchQuery(ops.CatalogPage, {})
    fixed.open()
    await fixed.refetch()
    // CatalogPage has no @connection, so there is nothing to continue.
    expect(fixed.getState().hasMore).toBe(false)
    await expect(fixed.loadMore()).resolves.toBeUndefined()
  })
})
