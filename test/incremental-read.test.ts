import { buildSchema } from "graphql"
import { describe, expect, it, vi } from "vitest"
import { createClient } from "../src/client.js"
import { compile } from "../src/compiler/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { contextOf, normalize } from "../src/store/normalize.js"
import { ROOT_ID, Store, type Selector, type Snapshot } from "../src/store/store.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

// A list long enough for the store to memoise its read (64 records or more), with records shared between rows.
const sdl = `type Query { Items(Page: PageInput): ItemConnection! Item(Id: String!): Item }
input PageInput { Limit: Int, Offset: Int }
type ItemConnection { Edges: [ItemEdge!]!, PageInfo: PageInfo! }
type ItemEdge { Node: Item! }
type PageInfo { TotalCount: Int! }
type Item { Id: String!, Name: String!, RecordVersion: Int!, ExpiresAt: Int, Owner: Owner, Tags: [Tag!]! }
type Owner { Id: String!, Name: String!, Boss: Owner }
type Tag { Label: String! }`
const documents = [
  "fragment ItemRow on Item { Name Owner { Name } }",
  "query Plain { Items(Page: { Limit: 500 }) { Edges { Node { Name RecordVersion Owner { Name Boss { Name } } Tags { Label } } } PageInfo { TotalCount } } }",
  "query Masked { Items(Page: { Limit: 500 }) { Edges { Node { ...ItemRow } } PageInfo { TotalCount } } }",
  "query One($Id: String!) { Item(Id: $Id) { Name RecordVersion Owner { Name Boss { Name } } Tags { Label } } }",
]
const compiled = compile(buildSchema(sdl), documents, { versions: { Item: "RecordVersion" } })
const { Plain, Masked, One } = compiled.operations as Record<string, (typeof compiled.operations)[string]>

const owner = (id: string, name = `owner-${id}`, boss: string | null = null): Record<string, unknown> =>
  ({ __typename: "Owner", Id: id, Name: name, Boss: boss === null ? null : { __typename: "Owner", Id: boss, Name: `owner-${boss}`, Boss: null } })
const item = (id: string, version = 1, ownerId: string | null = "o1", tags: string[] = ["a"]): Record<string, unknown> => ({
  __typename: "Item", Id: id, Name: `item-${id}-v${version}`, RecordVersion: version, ExpiresAt: null,
  Owner: ownerId === null ? null : owner(ownerId), Tags: tags.map((Label) => ({ __typename: "Tag", Label })),
})
const page = (items: Record<string, unknown>[]) => ({
  Items: { __typename: "ItemConnection", Edges: items.map((Node) => ({ __typename: "ItemEdge", Node })), PageInfo: { __typename: "PageInfo", TotalCount: items.length } },
})
const selectorOf = (operation: typeof Plain): Selector => ({ id: ROOT_ID, selections: operation!.selections, variables: {}, fragments: operation!.fragments })
const itemId = (id: string) => encodeNodeId("Item", [id])
const ownerId = (id: string) => encodeNodeId("Owner", [id])

function writeList(store: Store, items: Record<string, unknown>[]): void {
  normalize(store, Plain!.normalization, page(items), contextOf(Plain!, {}))
  store.publish()
}
function writeOne(store: Store, value: Record<string, unknown>): void {
  normalize(store, One!.normalization, { Item: value }, contextOf(One!, { Id: value.Id }))
  store.publish()
}

/** Subscribe, and check after every publish that what the subscriber holds is what a whole read gives. */
function follow(store: Store, operation: typeof Plain, { checkEach = false } = {}) {
  const selector = selectorOf(operation)
  let latest: Snapshot = store.lookup(selector)
  const calls = vi.fn()
  const stop = store.subscribe(latest, (next) => {
    latest = next
    calls()
    // What a subscriber is handed must be what the store holds at that moment, not only once the outer publish ends.
    if (checkEach) check()
  })
  const check = () => {
    const whole = store.lookup(selector)
    expect(latest.data).toEqual(whole.data)
    expect(latest.missing).toBe(whole.missing)
    expect(latest.stale).toBe(whole.stale)
    expect(latest.lifetime).toBe(whole.lifetime)
  }
  return { get latest() { return latest }, calls, check, stop }
}

const rows = (count: number) => Array.from({ length: count }, (_, i) => item(String(i), 1, `o${i % 5}`))
type PlainData = { Items: { Edges: { Node: { Name: string; RecordVersion: number; Owner: { Name: string } | null } }[] } }

describe("incremental reads of a large snapshot", () => {
  it("reads the changed row and what's above it, and keeps every other row's object", () => {
    const store = new Store()
    writeList(store, rows(1000))
    const view = follow(store, Plain)
    // The first change after subscribing builds the memo with a whole read.
    writeOne(store, item("3", 2, "o3"))
    view.check()
    const before = view.latest.data as PlainData
    const get = vi.spyOn(store, "get")
    writeOne(store, item("7", 2, "o2"))
    // Without the memo this is more than 3,000 record reads: every edge, row and owner.
    expect(get.mock.calls.length).toBeLessThan(60)
    get.mockRestore()
    view.check()
    const after = view.latest.data as PlainData
    expect(after.Items.Edges[7]!.Node.Name).toBe("item-7-v2")
    expect(after.Items.Edges[7]).not.toBe(before.Items.Edges[7])
    for (const index of [0, 3, 6, 8, 999]) expect(after.Items.Edges[index]).toBe(before.Items.Edges[index])
    expect(view.calls).toHaveBeenCalledTimes(2)
  })

  it("a record shared by many rows updates every row that shows it", () => {
    const store = new Store()
    writeList(store, rows(200))
    const view = follow(store, Plain)
    for (const name of ["first", "second", "third"]) {
      const record = store.get(ownerId("o2"))!
      store.setField(record, "Name", name)
      store.publish()
      view.check()
      const data = view.latest.data as PlainData
      expect(data.Items.Edges.filter((edge) => edge.Node.Owner?.Name === name)).toHaveLength(40)
    }
  })

  it("an older version never replaces a newer one, whichever read is in use", () => {
    const store = new Store()
    writeList(store, rows(100))
    const view = follow(store, Plain)
    writeOne(store, item("4", 5, "o4"))
    writeOne(store, item("4", 3, "o4"))
    view.check()
    expect((view.latest.data as PlainData).Items.Edges[4]!.Node).toMatchObject({ Name: "item-4-v5", RecordVersion: 5 })
    writeOne(store, item("4", 6, "o4"))
    view.check()
    expect((view.latest.data as PlainData).Items.Edges[4]!.Node.RecordVersion).toBe(6)
  })

  it("a record that changed while nothing linked to it shows its new value when it's linked again", () => {
    const store = new Store()
    writeList(store, rows(100).map((row) => (row.Id === "10" ? item("10", 1, "solo") : row)))
    const view = follow(store, Plain)
    // The first change builds the memo, with the owner in it.
    writeOne(store, item("3", 2, "o3"))
    const row = store.get(itemId("10"))!
    const link = row.fields.get("Owner")
    expect(link).toEqual({ __ref: ownerId("solo") })
    // Unlinked: this read no longer reaches the owner, but the memo has seen it.
    store.setField(row, "Owner", null)
    store.publish()
    view.check()
    store.setField(store.get(ownerId("solo"))!, "Name", "renamed while unlinked")
    store.publish()
    view.check()
    // Linked again by a write that doesn't touch the owner itself.
    store.setField(row, "Owner", link)
    store.publish()
    view.check()
    expect((view.latest.data as PlainData).Items.Edges[10]!.Node.Owner).toMatchObject({ Name: "renamed while unlinked" })
  })

  it("matches a whole read through random writes, deletes, rollbacks, restores and collection", () => {
    let seed = 20261113
    const random = (below: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed % below
    }
    const store = new Store({ retainMs: 0, setTimeout: (callback) => { callback(); return 0 }, clearTimeout: () => {} })
    const versions = new Map<string, number>()
    const make = (id: string, version: number) => item(id, version, random(4) === 0 ? null : `o${random(6)}`, Array.from({ length: random(3) }, (_, i) => `t${i}`))
    const list = () => {
      const count = 70 + random(60)
      const ids = Array.from({ length: 140 }, (_, i) => String(i)).sort(() => random(3) - 1).slice(0, count)
      return ids.map((id) => make(id, versions.get(id) ?? 1))
    }
    writeList(store, list())
    const plain = follow(store, Plain)
    const masked = follow(store, Masked)
    const release = store.retain("plain", selectorOf(Plain))
    for (let step = 0; step < 400; step++) {
      const id = String(random(140))
      switch (random(9)) {
        case 0:
          writeList(store, list())
          break
        case 1:
        case 2: {
          // Sometimes older than what's stored, which must be refused.
          const version = Math.max(1, (versions.get(id) ?? 1) + random(4) - 1)
          if (version >= (versions.get(id) ?? 1)) versions.set(id, version)
          writeOne(store, make(id, version))
          break
        }
        case 3:
          store.delete(itemId(id))
          store.publish()
          break
        case 4: {
          const record = store.get(ownerId(`o${random(6)}`))
          if (record) store.setField(record, "Name", `renamed-${step}`)
          store.publish()
          break
        }
        case 5: {
          const layer = store.optimistic(() => {
            const record = store.get(itemId(id))
            if (record) store.setField(record, "Name", `optimistic-${step}`)
          })
          plain.check()
          store.rollback(layer)
          break
        }
        case 6:
          store.restore([{ id: itemId(id), typename: "Item", fields: [["Id", id], ["Name", `restored-${step}`], ["RecordVersion", versions.get(id) ?? 1], ["Owner", null], ["Tags", { __refs: [] }]] }])
          break
        case 7:
          store.collect()
          break
        case 8: {
          const record = store.get(itemId(id))
          if (record) store.setField(record, "Owner", random(2) ? null : { __ref: ownerId(`o${random(6)}`) })
          store.publish()
          break
        }
      }
      plain.check()
      masked.check()
    }
    expect(plain.calls.mock.calls.length).toBeGreaterThan(100)
    release()
  })

  it("stays right when a subscriber writes and publishes from inside a publish", () => {
    const store = new Store()
    writeList(store, rows(100))
    // Subscribed first, so its nested publish reaches the list before the outer one does.
    const row = { id: itemId("2"), selections: One!.selections[0]!.kind === "link" ? One!.selections[0]!.selections : [], variables: {}, fragments: {} }
    let renames = 0
    store.subscribe(store.lookup(row), () => {
      store.setField(store.get(ownerId("o4"))!, "Name", `nested-${++renames}`)
      store.publish()
    })
    const view = follow(store, Plain, { checkEach: true })
    writeOne(store, item("9", 2, "o4"))
    for (let version = 2; version < 6; version++) {
      writeOne(store, item("2", version, "o2"))
      view.check()
      expect((view.latest.data as PlainData).Items.Edges[4]!.Node.Owner!.Name).toBe(`nested-${renames}`)
    }
    expect(renames).toBe(4)
  })

  it("stops with the store: disposal leaves no subscriber and no later call", () => {
    const store = new Store()
    writeList(store, rows(100))
    const view = follow(store, Plain)
    writeOne(store, item("1", 2))
    writeOne(store, item("2", 2))
    expect(view.calls).toHaveBeenCalledTimes(2)
    store.dispose()
    store.publish()
    expect(view.calls).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(0)
  })

  it("a type with a lifetime is read whole, and still expires on time", () => {
    let now = 1_000_000
    const timers: (() => void)[] = []
    const store = new Store({ lifetimes: { Item: { field: "ExpiresAt", format: "unix-seconds" } }, now: () => now, setTimeout: (callback) => timers.push(callback), clearTimeout: () => {} })
    writeList(store, rows(100))
    for (let i = 0; i < 100; i++) store.setField(store.get(itemId(String(i)))!, "ExpiresAt", i === 9 ? 1001 : 5000)
    store.publish()
    const view = follow(store, Plain)
    writeOne(store, item("3", 2, "o3"))
    writeOne(store, item("4", 2, "o4"))
    view.check()
    expect(view.latest.lifetime).toBeUndefined()
    now = 1_002_000
    for (const fire of timers.splice(0)) fire()
    view.check()
    expect(view.latest.lifetime).toBe("expired")
    expect(view.latest.missing).toBe(true)
  })
})

describe("what a query holds live", () => {
  const liveSDL = `type Query { Tickets(Page: PageInput): TicketConnection! }
type Subscription { TicketChanged(Keys: [String!]): TicketChangedEvent! }
input PageInput { Limit: Int, Offset: Int }
type TicketConnection { Edges: [TicketEdge!]!, PageInfo: PageInfo! }
type TicketEdge { Cursor: String!, Node: Ticket! }
type PageInfo { TotalCount: Int!, HasNextPage: Boolean!, EndCursor: String }
type Ticket { Id: String!, Title: String!, State: String!, RecordVersion: Int! }
type TicketChangedEvent { Action: ChangeAction!, Ticket: Ticket }
enum ChangeAction { CREATED UPDATED DELETED }`
  const live = compile(buildSchema(liveSDL), [
    "fragment TicketRow on Ticket @live { Title State }",
    "query TicketsPage { Tickets(Page: { Limit: 500 }) { Edges { Node { ...TicketRow } } PageInfo { TotalCount } } }",
  ])
  const ticket = (i: number, version = 1) => ({ __typename: "Ticket", Id: String(i), Title: `ticket-${i}-v${version}`, State: "open", RecordVersion: version })
  const tickets = (count: number) => ({
    Tickets: { __typename: "TicketConnection", Edges: Array.from({ length: count }, (_, i) => ({ __typename: "TicketEdge", Node: ticket(i) })), PageInfo: { __typename: "PageInfo", TotalCount: count } },
  })

  it("is worked out again when the rows change, not for each changed value", async () => {
    let count = 100
    const streams = createMockStreams({ schema: liveSDL })
    const clock = createTestClock()
    const client = createClient({
      network: createMockNetwork({ schema: liveSDL, respond: () => ({ data: tickets(count) }) }),
      live: { artifacts: live.live, subscribe: streams.subscribe, debounceMs: 0, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    })
    const list = client.watchQuery(live.operations.TicketsPage!, {})
    list.open()
    await list.refetch()
    client.live!.flush()
    expect(client.liveHealth().types.Ticket!.held).toBe(100)
    const hold = vi.spyOn(client.live!, "hold")
    const stream = streams.find("LiveTicket")[0]!
    for (let i = 0; i < 20; i++) {
      stream.sink.next({ data: { TicketChanged: { __typename: "TicketChangedEvent", Action: "UPDATED", Ticket: ticket(i, 2) } } })
    }
    expect(hold).not.toHaveBeenCalled()
    expect(client.store.get(encodeNodeId("Ticket", ["7"]))!.fields.get("Title")).toBe("ticket-7-v2")

    // A list reads again after an event; let that read finish before the next one is asked for.
    await list.refetch()
    hold.mockClear()
    // A row arriving, and one being deleted, both change what's held.
    count = 101
    await list.refetch()
    client.live!.flush()
    expect(client.liveHealth().types.Ticket!.held).toBe(101)
    hold.mockClear()
    stream.sink.next({ data: { TicketChanged: { __typename: "TicketChangedEvent", Action: "DELETED", Ticket: ticket(5, 3) } } })
    expect(hold).toHaveBeenCalled()
    list.close()
    client.dispose()
  })
})
