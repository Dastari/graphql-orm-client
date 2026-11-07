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
