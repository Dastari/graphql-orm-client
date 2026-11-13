import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client.js"
import { catalog, mockNetwork, ops, widget } from "./fixtures.js"

setFlagsFromString("--expose-gc")
const gc = runInNewContext("gc") as () => void

type Internals = { resources: Map<string, unknown>; unopened: Map<string, WeakRef<object>> }
const internals = (client: object) => client as unknown as Internals

describe("watchQuery handles that are never opened", () => {
  it("leave nothing in the open queries", () => {
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network })
    for (let i = 0; i < 1000; i++) client.watchQuery(ops.WidgetPage!, { Id: `w${i}` })
    expect(internals(client).resources.size).toBe(0)
    client.dispose()
  })

  it("are freed once nothing refers to them, as after a render React threw away", async () => {
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network })
    ;(() => {
      for (let i = 0; i < 200; i++) client.watchQuery(ops.WidgetPage!, { Id: `w${i}` })
    })()
    expect(internals(client).unopened.size).toBe(200)
    for (let attempt = 0; attempt < 20 && internals(client).unopened.size > 0; attempt++) {
      gc()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(internals(client).unopened.size).toBe(0)
    client.dispose()
  })

  it("still share one query with other handles for the same variables", async () => {
    const { network, requests } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network })
    const first = client.watchQuery(ops.CatalogPage!, {}, "store-or-network")
    const second = client.watchQuery(ops.CatalogPage!, {}, "store-or-network")
    await first.refetch()
    expect(second.getState().status).toBe("ready")
    expect(second.getState().data).toBe(first.getState().data)
    second.open()
    first.open()
    expect(requests).toHaveLength(1)
    first.close()
    second.close()
    client.dispose()
  })

  it("a closed query is shared again by a handle created after it closed, and reopened as one", async () => {
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network })
    const first = client.watchQuery(ops.CatalogPage!, {})
    first.open()
    await first.refetch()
    first.close()
    expect(internals(client).resources.size).toBe(0)
    const later = client.watchQuery(ops.CatalogPage!, {})
    expect(later.getState().data).toBe(first.getState().data)
    later.open()
    first.open()
    expect(internals(client).resources.size).toBe(1)
    // One query, so one set of users: closing one handle keeps it open for the other.
    later.close()
    expect(internals(client).resources.size).toBe(1)
    first.close()
    expect(internals(client).resources.size).toBe(0)
    client.dispose()
  })

  it("keep nothing after the client is disposed", () => {
    const { network } = mockNetwork(() => ({ data: catalog([widget("d1")]) }))
    const client = createClient({ network })
    const handle = client.watchQuery(ops.CatalogPage!, {})
    client.dispose()
    handle.open()
    handle.close()
    expect(internals(client).resources.size).toBe(0)
    expect(internals(client).unopened.size).toBe(0)
  })
})
