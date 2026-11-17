import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildSchema } from "graphql"
import { afterEach, describe, expect, it, vi } from "vitest"
import { compile, generate } from "../src/compiler/index.js"
import { createClient, hasFragment, readFragment, selectorOf, type GraphQLResponse, type OperationRequest } from "../src/index.js"
import { missingFields } from "../src/missing.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockStreams, createTestClock } from "../src/test/index.js"

const schema = buildSchema(`
  type Query { Widget(Id: ID!): Widget }
  type Subscription { WidgetChanged(Key: ID): WidgetEvent! }
  type WidgetEvent { Action: String! Widget: Widget }
  type Vendor { Id: ID! Name: String! }
  type Widget { Id: ID! Name: String! Note: String Sku: String RecordVersion: Int! Vendor: Vendor }
`)
const sources = [
  `fragment Extra on Widget @live(enabled: false) { Sku }`,
  `query Page($detail: Boolean!) { Widget(Id: "w1") { Id Name Note @include(if: $detail) ...Extra @skip(if: $detail) Vendor @include(if: $detail) { Id Name } } }`,
  `query Defaulted($detail: Boolean = false) { Widget(Id: "w1") { Id Name Note @include(if: $detail) } }`,
]
const compiled = compile(schema, sources)
const ops = compiled.operations
const W1 = encodeNodeId("Widget", ["w1"])
const V1 = encodeNodeId("Vendor", ["v1"])

/** What the server sends for each value of `$detail`. */
function answer(detail: boolean, version = 1, overrides: Record<string, unknown> = {}): GraphQLResponse {
  const widget = detail
    ? { __typename: "Widget", Id: "w1", Name: `name-${version}`, Note: `note-${version}`, RecordVersion: version, Vendor: { __typename: "Vendor", Id: "v1", Name: "vendor" } }
    : { __typename: "Widget", Id: "w1", Name: `name-${version}`, Sku: `sku-${version}`, RecordVersion: version }
  return { data: { Widget: { ...widget, ...overrides } } }
}

function setup(reply: (request: OperationRequest) => GraphQLResponse = (request) => answer(request.variables.detail === true)) {
  const requests: OperationRequest[] = []
  const client = createClient({ network: { execute: async (request) => { requests.push(request); return reply(request) } } })
  return { client, requests }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("@skip and @include evaluated with the operation's variables", () => {
  it("records each condition, with the variable's declared default, and keeps the directive on the wire", () => {
    const widget = ops.Page!.selections.find((selection) => selection.kind === "link")!
    if (widget.kind !== "link") throw new Error("expected a link")
    expect(widget.selections.find((selection) => selection.kind === "scalar" && selection.fieldName === "Note")?.conditions).toEqual([{ directive: "include", if: { variable: "detail" } }])
    expect(widget.selections.find((selection) => selection.kind === "spread")?.conditions).toEqual([{ directive: "skip", if: { variable: "detail" } }])
    expect(JSON.stringify(ops.Page!.normalization)).toContain(`"conditions":[{"directive":"skip","if":{"variable":"detail"}}]`)
    expect(ops.Page!.text).toContain("@include(if: $detail)")
    expect(ops.Page!.text).toContain("@skip(if: $detail)")
    expect(JSON.stringify(ops.Defaulted!.selections)).toContain(`{"directive":"include","if":{"variable":"detail","default":false}}`)
  })

  for (const detail of [false, true]) it(`reads complete with $detail ${detail}`, async () => {
    const { client } = setup()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { snapshot } = await client.execute<any>(ops.Page!, { detail })
    expect(snapshot.missing).toBe(false)
    const widget = snapshot.data.Widget
    expect("Note" in widget).toBe(detail)
    expect("Vendor" in widget).toBe(detail)
    expect(hasFragment(compiled.fragments.Extra!, widget)).toBe(!detail)
    if (!detail) expect(readFragment(compiled.fragments.Extra!, widget)).toEqual({ __typename: "Widget", Sku: "sku-1" })
    else expect(widget.Vendor).toEqual({ __typename: "Vendor", Id: "v1", Name: "vendor" })
    expect(warn).not.toHaveBeenCalled()
    client.dispose()
  })

  it("reports a field its condition keeps but the response leaves out, and not one it skips", () => {
    const kept = answer(true).data!
    delete (kept.Widget as Record<string, unknown>).Note
    expect(missingFields(ops.Page!, kept, [], { detail: true }).map((field) => field.path)).toEqual([["Widget", "Note"]])
    expect(missingFields(ops.Page!, answer(false).data!, [], { detail: false })).toEqual([])
  })

  it("takes the declared default for a variable left out", async () => {
    const { client, requests } = setup(() => answer(false))
    const { snapshot } = await client.execute<any>(ops.Defaulted!, {})
    expect(snapshot.missing).toBe(false)
    expect("Note" in snapshot.data.Widget).toBe(false)
    expect(requests[0]!.variables).toEqual({})
    // An explicit value overrides the default.
    expect(client.store.lookup(selectorOf(ops.Defaulted!, { detail: true })).missing).toBe(true)
    client.dispose()
  })

  it("re-reads on a change of the variable without treating the record as missing", async () => {
    const { client, requests } = setup()
    const brief = client.watchQuery<any>(ops.Page!, { detail: false })
    brief.open()
    await brief.refetch()
    const sent = requests.length
    let notified = 0
    brief.subscribe(() => notified++)

    const detailed = client.watchQuery<any>(ops.Page!, { detail: true })
    detailed.open()
    await detailed.refetch()
    expect(detailed.getState().data.Widget.Note).toBe("note-1")
    expect(client.store.lookup(selectorOf(ops.Page!, { detail: true })).missing).toBe(false)
    // The write of Note and Vendor touched nothing the brief query reads, so it neither changed nor read again.
    expect(requests.slice(sent).map((request) => request.variables)).toEqual([{ detail: true }])
    expect(brief.getState().data.Widget).toEqual({ __typename: "Widget", Id: "w1", Name: "name-1" })
    expect(client.store.lookup(selectorOf(ops.Page!, { detail: false })).missing).toBe(false)

    // Back to the first value: the stored record is complete for it, with no read for a missing field.
    const again = client.watchQuery<any>(ops.Page!, { detail: false }, "store-or-network")
    expect(again.getState().status).toBe("ready")
    again.open()
    expect(requests.length).toBe(sent + 1)
    expect(notified).toBe(0)
    for (const query of [brief, detailed, again]) query.close()
    client.dispose()
  })

  it("never lets an older response replace a newer record under either value", async () => {
    const replies = [answer(true, 3), answer(false, 2, { Name: "older" }), answer(true, 1, { Note: "older" })]
    const { client } = setup(() => replies.shift()!)
    await client.execute(ops.Page!, { detail: true })
    await client.execute(ops.Page!, { detail: false })
    await client.execute(ops.Page!, { detail: true })
    const record = client.store.get(W1)!
    expect(record.fields.get("Name")).toBe("name-3")
    expect(record.fields.get("Note")).toBe("note-3")
    expect(record.fields.get("RecordVersion")).toBe(3)
    client.dispose()
  })

  it("collects a record only a skipped selection reached", async () => {
    const timers: (() => void)[] = []
    const client = createClient({
      network: { execute: async (request) => answer(request.variables.detail === true) },
      store: { retainMs: 1000, setTimeout: (callback) => timers.push(callback), clearTimeout: () => {} },
    })
    const detailed = client.watchQuery(ops.Page!, { detail: true })
    detailed.open()
    await detailed.refetch()
    const brief = client.watchQuery(ops.Page!, { detail: false })
    brief.open()
    await brief.refetch()
    expect(client.store.get(V1)).toBeDefined()
    detailed.close()
    timers.shift()!()
    // Under $detail false nothing reaches the vendor: it goes, and the widget stays.
    expect(client.store.get(V1)).toBeUndefined()
    expect(client.store.get(W1)).toBeDefined()
    brief.close()
    client.dispose()
  })

  it("drops what a disposed identity read, whatever the variables", async () => {
    const { client } = setup()
    await client.execute(ops.Page!, { detail: true })
    client.dispose()
    expect(client.store.get(W1)).toBeUndefined()
    expect(client.store.get(V1)).toBeUndefined()
  })

  it("fails the build when operations spreading one fragment give its variable different defaults", () => {
    expect(() => compile(schema, [
      `fragment Maybe on Widget { Note @include(if: $detail) }`,
      `query A($detail: Boolean = true) { Widget(Id: "w1") { ...Maybe } }`,
      `query B($detail: Boolean = false) { Widget(Id: "w1") { ...Maybe } }`,
    ])).toThrow(/Fragment Maybe: @include uses \$detail, which operations A, B give different defaults/)
    // One default, or one operation that gives none and always sends it, is fine.
    const same = compile(schema, [
      `fragment Maybe on Widget { Note @include(if: $detail) }`,
      `query A($detail: Boolean = true) { Widget(Id: "w1") { ...Maybe } }`,
      `query B($detail: Boolean!) { Widget(Id: "w1") { ...Maybe } }`,
    ])
    expect(same.fragments.Maybe!.selections.find((selection) => selection.kind === "scalar" && selection.fieldName === "Note")?.conditions)
      .toEqual([{ directive: "include", if: { variable: "detail", default: true } }])
  })

  it("evaluates literal conditions, on inline fragments too", async () => {
    const literal = compile(schema, [`query Literal { Widget(Id: "w1") { Id Name @include(if: true) Note @skip(if: true) ... on Widget @include(if: false) { Sku } } }`])
    const { client } = setup(() => ({ data: { Widget: { __typename: "Widget", Id: "w1", Name: "n", RecordVersion: 1 } } }))
    const { snapshot } = await client.execute<any>(literal.operations.Literal!, {})
    expect(snapshot.missing).toBe(false)
    expect(snapshot.data.Widget).toEqual({ __typename: "Widget", Id: "w1", Name: "n" })
    client.dispose()
  })
})

describe("generated types for conditional selections", () => {
  it("makes a conditional field, link and spread optional, and a field selected once without a condition required", () => {
    const types = generate(schema, [...sources, `query Mixed($a: Boolean!) { Widget(Id: "w1") { Name Name @include(if: $a) Vendor { Id } Vendor @include(if: $a) { Name } } }`], { onWarning: () => {} })
    expect(types).toContain(`readonly Note?: string | null`)
    expect(types).toContain(`readonly Vendor?: { readonly __typename: "Vendor"; readonly Id: string; readonly Name: string } | null`)
    expect(types).toContain(`({} | FragmentRefs<"Extra">)`)
    expect(types).toMatch(/export type MixedQuery = \{ readonly Widget: \{ readonly __typename: "Widget"; readonly Name: string; readonly Vendor: \{ readonly __typename: "Vendor"; readonly Id: string; readonly Name\?: string \} \| null \} \| null \}/)
  })

  it("typechecks: optional fields need handling, and a conditional spread needs hasFragment", () => {
    const dir = resolve("test/generated/conditional-types")
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/graphql.ts`, generate(schema, sources, { importFrom: "../../../src/index.js", onWarning: () => {} }))
    writeFileSync(`${dir}/consumer.ts`, `import { hasFragment, readFragment } from "../../../src/index.js"
import { ExtraFragment, type PageQuery, type PageVariables } from "./graphql.js"
declare const data: PageQuery
const widget = data.Widget!
const note: string | null | undefined = widget.Note
// @ts-expect-error a conditional field can be left out
const required: string | null = widget.Note
// @ts-expect-error a conditional spread can be left out
readFragment(ExtraFragment, widget)
if (hasFragment(ExtraFragment, widget)) {
  const sku: string | null = readFragment(ExtraFragment, widget).Sku
  void sku
}
// @ts-expect-error the condition's variable is required
const variables: PageVariables = {}
void note; void required; void variables
`)
    execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--types", "node", "--target", "ES2022", "--module", "NodeNext", `${dir}/consumer.ts`], { stdio: "pipe" })
  }, 30_000)
})

describe("live projections and conditional selections", () => {
  const liveSources = [
    `fragment Row on Widget @live { Name Note @include(if: $detail) }`,
    `query Rows($detail: Boolean!) { Widget(Id: "w1") { ...Row } }`,
  ]

  it("leaves out of the stream a field live fragments select only conditionally, and re-reads its holders", () => {
    const warnings: string[] = []
    const live = compile(schema, liveSources, { onWarning: (message) => warnings.push(message) }).live.Widget!
    expect(live.operation.text).toContain("Name")
    expect(live.operation.text).not.toContain("Note")
    expect(live.rereadFragments).toEqual(["Row"])
    expect(warnings).toContain("Fragment Row: stream excludes Widget.Note, selected under @skip or @include")
    // Under a conditional spread or inline fragment too.
    for (const fragment of [`fragment Row on Widget @live { Name ...Notes @include(if: $detail) }`, `fragment Row on Widget @live { Name ... on Widget @skip(if: $detail) { Note } }`]) {
      const nested = compile(schema, [fragment, `fragment Notes on Widget { Note }`, liveSources[1]!], { onWarning: () => {} }).live.Widget!
      expect(nested.operation.text).not.toContain("Note")
      expect(nested.rereadFragments).toContain("Row")
    }
  })

  it("carries a field one live fragment selects unconditionally, and none a literal condition always skips", () => {
    const both = compile(schema, [...liveSources, `fragment Plain on Widget @live { Note }`, `query Plain { Widget(Id: "w1") { ...Plain } }`], { onWarning: () => {} }).live.Widget!
    expect(both.operation.text).toContain("Note")
    expect(both.rereadFragments).toEqual([])
    const never = compile(schema, [`fragment Row on Widget @live { Name Note @skip(if: true) }`, `query Rows { Widget(Id: "w1") { ...Row } }`], { onWarning: () => {} }).live.Widget!
    expect(never.operation.text).not.toContain("Note")
    expect(never.rereadFragments).toEqual([])
  })

  it("keeps the previous projection under the deprecated legacy setting", () => {
    const legacy = compile(schema, liveSources, { conditionalDirectives: "legacy", onWarning: () => {} }).live.Widget!
    expect(legacy.operation.text).toContain("Note")
  })

  it("an event re-reads a holder with its own variables, and a reconnect replays that read", async () => {
    const live = compile(schema, liveSources, { onWarning: () => {} })
    const clock = createTestClock()
    const streams = createMockStreams()
    const requests: OperationRequest[] = []
    let version = 1
    const client = createClient({
      network: { execute: async (request) => { requests.push(request); return { data: { Widget: { __typename: "Widget", Id: "w1", Name: `name-${version}`, Note: `note-${version}`, RecordVersion: version } } } } },
      store: clock.store,
      polling: clock.polling,
      live: { ...clock.live, artifacts: live.live, subscribe: streams.subscribe, connection: { state: () => "connected", subscribe: (listener) => streams.onReconnect(() => listener({ reconnected: true })) }, debounceMs: 0, settleMs: false, minRereadMs: 1, resyncJitterMs: 0, onDiagnostic: null },
    })
    const query = client.watchQuery<any>(live.operations.Rows!, { detail: true })
    query.open()
    await clock.tick()
    expect(query.getState().data.Widget).toBeDefined()
    const stream = streams.one("LiveWidget")
    expect(stream.request.text).not.toContain("Note")
    version = 2
    stream.emit({ __typename: "Widget", Id: "w1", Name: "name-2", RecordVersion: 2 })
    await clock.tick(10)
    expect(requests.length).toBe(2)
    expect(requests[1]!.variables).toEqual({ detail: true })
    expect(client.store.get(W1)!.fields.get("Note")).toBe("note-2")
    version = 3
    streams.reconnect()
    await clock.tick(10)
    expect(requests.length).toBeGreaterThan(2)
    expect(requests.at(-1)!.variables).toEqual({ detail: true })
    expect(client.store.get(W1)!.fields.get("Note")).toBe("note-3")
    query.close()
    client.dispose()
  })
})
