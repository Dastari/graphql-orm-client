import { readAll } from "../src/read-all.js"
import { expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { catalog, widget, ops, frags, mockNetwork } from "./fixtures.js"
it("readAll bounds pages, normalises rows and reports the exact total", async () => {
  const mock = mockNetwork(({ variables }) => {
    const page = variables.Page as { after?: string; limit: number }
    const ids = page.after ? ["b", "c"] : ["a", "b"]
    return { data: catalog(ids.map(id => widget(id)), { hasNext: true, total: 9 }) }
  })
  const client = createClient({ network: mock.network })
  const result = await readAll(client, ops.CatalogScroll, {}, { limit: 3 })
  expect(result.total).toBe(9)
  expect(result.truncated).toBe(true)
  expect(result.rows.map(ref => readFragment<{ Name: string }>(frags.WidgetRow, ref).Name)).toEqual(["widget-a", "widget-b", "widget-c"])
  expect(mock.requests).toHaveLength(2)
})
it("rejects missing bounds, missing connection metadata, and cancellation", async () => {
  const mock = mockNetwork(() => ({ data: catalog([]) }))
  const client = createClient({ network: mock.network })
  await expect(readAll(client, ops.CatalogScroll, {}, { limit: 0 })).rejects.toThrow("positive")
  await expect(readAll(client, ops.CatalogPage, {}, { limit: 5 })).rejects.toThrow("@connection")
  await expect(readAll(client, ops.CatalogScroll, {}, { limit: 5, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" })
  expect(mock.requests).toHaveLength(0)
})
it("rejects an unknown total rather than inferring one", async () => {
  const mock = mockNetwork(() => { const data = catalog([]); data.Widgets.PageInfo.TotalCount = null as unknown as number; return { data } })
  await expect(readAll(createClient({ network: mock.network }), ops.CatalogScroll, {}, { limit: 5 })).rejects.toThrow("exact TotalCount")
})
it("does not return an old cached tail on a new traversal", async () => {
  let ids = ["a", "b", "c"]
  const mock = mockNetwork(({ variables }) => {
    const after = (variables.Page as { after?: string })?.after
    const start = after ? ids.indexOf(after.replace("c-", "")) + 1 : 0
    const shown = ids.slice(start, start + 2)
    return { data: catalog(shown.map(id => widget(id)), { total: ids.length, hasNext: start + shown.length < ids.length }) }
  })
  const client = createClient({ network: mock.network })
  expect((await readAll(client, ops.CatalogScroll, {}, { limit: 10 })).rows).toHaveLength(3)
  ids = ["z"]
  const next = await readAll(client, ops.CatalogScroll, {}, { limit: 10 })
  expect(next.rows.map(ref => readFragment<{ Name: string }>(frags.WidgetRow, ref).Name)).toEqual(["widget-z"])
  expect(next.total).toBe(1)
  expect(next.truncated).toBe(false)
})
it("stops a traversal disposed with its identity", async () => {
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  const mock = mockNetwork(async () => { await wait; return { data: catalog([widget("a")]) } })
  const client = createClient({ network: mock.network })
  const reading = readAll(client, ops.CatalogScroll, {}, { limit: 10 })
  client.dispose(); release()
  await expect(reading).rejects.toMatchObject({ name: "AbortError" })
  expect(client.store.size).toBe(0)
})
