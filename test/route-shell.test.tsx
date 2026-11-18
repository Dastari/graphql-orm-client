import { expect, it, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { createClient } from "../src/index.js"
import { ClientProvider, useQuery } from "../src/react/index.js"
import { ops } from "./fixtures.js"

it("imports all entry points and renders an idle shell without browser globals or effects", async () => {
  expect(typeof window).toBe("undefined")
  expect(typeof document).toBe("undefined")
  await Promise.all([import("../src/index.js"), import("../src/react/index.js"), import("../src/compiler/index.js"), import("../src/test/index.js")])
  const execute = vi.fn(), timer = vi.fn(), subscribe = vi.fn()
  const client = createClient({ network: { execute }, store: { setTimeout: timer }, live: { artifacts: {}, subscribe, setTimeout: timer } })
  function Shell({ legacy = false }: { legacy?: boolean }) { const state = useQuery(ops.CatalogPage, {}, { serverSnapshot: legacy ? "legacy" : "idle" }); return <p>{state.status}</p> }
  expect(renderToString(<ClientProvider client={client}><Shell/></ClientProvider>)).toBe("<p>idle</p>")
  expect(execute).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled()
  expect((client as any).resources.size).toBe(0)
  expect(renderToString(<ClientProvider client={client}><Shell legacy/></ClientProvider>)).toBe("<p>loading</p>")
  expect(execute).not.toHaveBeenCalled()
  client.dispose()
})

it("the suspending loader read renders its Suspense fallback on the server and starts nothing", async () => {
  const { Suspense } = await import("react")
  const { useSuspenseLoadedQuery } = await import("../src/react/index.js")
  const execute = vi.fn()
  const client = createClient({ network: { execute } })
  // A server never creates a handle (`loadQuery` is browser I/O); the hook refuses before reading it.
  const handle = { client } as unknown as Parameters<typeof useSuspenseLoadedQuery>[0]
  function Route() { useSuspenseLoadedQuery(handle); return <p>data</p> }
  const html = renderToString(<ClientProvider client={client}><Suspense fallback={<p>shell</p>}><Route/></Suspense></ClientProvider>)
  expect(html).toContain("<p>shell</p>")
  expect(html).not.toContain("<p>data</p>")
  // React marks the boundary to render in the browser, with the reason.
  expect(html).toMatch(/browser only/)
  expect(execute).not.toHaveBeenCalled()
  client.dispose()
})
