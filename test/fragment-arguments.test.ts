import { buildSchema, graphql, parse, validate } from "graphql"
import { describe, expect, it } from "vitest"
import { createClient, readFragment } from "../src/client.js"
import { CompileError, compile, generate, type CompileOptions } from "../src/compiler/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const sdl = `
  type Query { Widget(Id: String!): Widget, Widgets(Where: WidgetWhereInput): [Widget!]! }
  type Subscription { WidgetChanged(Keys: [String!]): WidgetChangedEvent! }
  type WidgetChangedEvent { Action: String!, Widget: Widget }
  input WidgetWhereInput { Name: StringFilter }
  input StringFilter { Eq: String }
  enum NoteKind { OPEN CLOSED }
  type Widget {
    Id: String!
    Name: String!
    RecordVersion: Int!
    Image(Size: Int = 50): String
    Caption(Locale: String): String
    Notes(Limit: Int!, Kind: NoteKind): [Note!]!
    Vendor: Vendor
  }
  type Note { Id: String!, Body: String! }
  type Vendor { Id: String!, Logo(Size: Int): String }
`
const schema = buildSchema(sdl)

const thumb = `fragment Thumb on Widget @argumentDefinitions(size: {type: "Int!", defaultValue: 64}) { Name Image(Size: $size) }`
const page = `query Page($Id: String!, $Big: Int!) {
  small: Widget(Id: $Id) { ...Thumb }
  large: Widget(Id: $Id) { ...Thumb @arguments(size: $Big) }
  fixed: Widget(Id: $Id) { ...Thumb @arguments(size: 10) }
}`

/** The server: graphql-js executing the text the client sends, so it's checked as GraphQL and answered as written. */
function server(options: { version?: () => number } = {}) {
  const version = options.version ?? (() => 1)
  const widget = (id: string) => ({
    Id: id,
    Name: `name-${id}`,
    RecordVersion: version(),
    Image: ({ Size }: { Size: number | null }) => `${id}@${Size}:${version()}`,
    Caption: ({ Locale }: { Locale: string | null }) => `${id}/${Locale}`,
    Notes: ({ Limit, Kind }: { Limit: number; Kind: string | null }) =>
      Array.from({ length: Limit }, (_, index) => ({ Id: `${id}-${Kind ?? "any"}-n${index}`, Body: `${Kind ?? "ANY"} ${index}` })),
    Vendor: { Id: "v1", Logo: ({ Size }: { Size: number | null }) => `v1@${Size}` },
  })
  const rootValue = { Widget: ({ Id }: { Id: string }) => widget(Id), Widgets: () => [widget("w1")] }
  return createMockNetwork({
    schema: sdl,
    respond: async (request) => {
      const result = await graphql({ schema, source: request.text, variableValues: request.variables, rootValue })
      return JSON.parse(JSON.stringify(result))
    },
  })
}

function setup(documents: readonly string[], options: CompileOptions & { version?: () => number } = {}) {
  const compiled = compile(schema, documents, { onWarning: () => {}, ...options })
  const network = server(options)
  const clock = createTestClock(), streams = createMockStreams()
  const client = createClient({
    network,
    store: clock.store,
    polling: { ...clock.polling, undeclared: "off" },
    live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, settleMs: false, debounceMs: 0, resyncJitterMs: 0, onDiagnostic: null },
  })
  return { compiled, network, clock, streams, client }
}

function problemsOf(run: () => unknown): readonly string[] {
  try {
    run()
  } catch (error) {
    if (error instanceof CompileError) return error.problems
    throw error
  }
  throw new Error("expected a CompileError")
}

describe("fragment arguments", () => {
  it("reads one fragment spread twice with different values, under aliases, each with its own values", async () => {
    const { compiled, network, client } = setup([thumb, page])
    const operation = compiled.operations.Page!
    // What's sent is plain GraphQL: a copy of the fragment per argument set, with the value written in.
    expect(operation.text).not.toMatch(/@argumentDefinitions|@arguments/)
    expect(validate(schema, parse(operation.text))).toEqual([])
    const copies = [...operation.text.matchAll(/^fragment (Thumb_[0-9a-f]{8}) on Widget/gm)].map((match) => match[1])
    expect(copies).toHaveLength(3)
    expect(operation.text).toContain("Image(Size: 64)")
    expect(operation.text).toContain("Image(Size: $Big)")
    expect(operation.text).toContain("Image(Size: 10)")
    expect(operation.fragments).toEqual({ Thumb: compiled.fragments.Thumb })

    const { snapshot, errors } = await client.execute<any>(operation, { Id: "w1", Big: 512 })
    expect(errors).toEqual([])
    expect(network.failures).toEqual([])
    const read = (ref: unknown) => readFragment<{ Name: string; Image: string | null }>(compiled.fragments.Thumb!, ref)
    expect(read(snapshot.data.small)).toMatchObject({ Name: "name-w1", Image: "w1@64:1" })
    expect(read(snapshot.data.large)).toMatchObject({ Name: "name-w1", Image: "w1@512:1" })
    expect(read(snapshot.data.fixed)).toMatchObject({ Name: "name-w1", Image: "w1@10:1" })
    // One record keeps every value, each under its own arguments.
    const record = client.store.get(encodeNodeId("Widget", ["w1"]))!
    expect([...record.fields.keys()].filter((key) => key.startsWith("Image"))).toEqual(['Image({"Size":64})', 'Image({"Size":512})', 'Image({"Size":10})'])
    // From the store, with no request, the same.
    const watched = client.watchQuery<any>(operation, { Id: "w1", Big: 512 }, "store-or-network")
    watched.open()
    expect(read(watched.getState().data?.large)).toMatchObject({ Name: "name-w1", Image: "w1@512:1" })
    expect(network.calls("Page")).toHaveLength(1)
    watched.close()
    client.dispose()
  })

  it("generates exact types: the fragment's own data, and a reference to it under each alias", () => {
    const output = generate(schema, [thumb, page], { onWarning: () => {} })
    expect(output).toContain('export type ThumbFragment = { readonly __typename: "Widget"; readonly Name: string; readonly Image: string | null }')
    expect(output).toContain(
      'export type PageQuery = { readonly small: { readonly __typename: "Widget" } & FragmentRefs<"Thumb"> | null; readonly large: { readonly __typename: "Widget" } & FragmentRefs<"Thumb"> | null; readonly fixed: { readonly __typename: "Widget" } & FragmentRefs<"Thumb"> | null }',
    )
    expect(output).toContain("export type PageVariables = { readonly Id: string; readonly Big: number }")
  })

  it("fails generate for a spread missing a required argument, naming the fragment and the argument", () => {
    const documents = [
      `fragment Avatar on Widget @argumentDefinitions(size: {type: "Int!"}, locale: {type: "String"}) { Image(Size: $size) Caption(Locale: $locale) }`,
      `query One { Widget(Id: "w1") { ...Avatar } }`,
    ]
    expect(() => generate(schema, documents, { onWarning: () => {} })).toThrow(
      "Fragment Avatar needs argument size (Int!): operation One: the spread ...Avatar doesn't pass it in @arguments",
    )
    // A default, or passing it, is enough; an optional argument may be left out.
    expect(() => generate(schema, [documents[0]!, `query Two { Widget(Id: "w1") { ...Avatar @arguments(size: 1) } }`], { onWarning: () => {} })).not.toThrow()
  })

  it("fails for unknown, mistyped and misplaced arguments, and bad declarations", () => {
    const avatar = `fragment Avatar on Widget @argumentDefinitions(size: {type: "Int!", defaultValue: 1}) { Image(Size: $size) }`
    const of = (...documents: string[]) => problemsOf(() => compile(schema, [avatar, ...documents]))
    expect(of(`query Q { Widget(Id: "w1") { ...Avatar @arguments(width: 3) } }`)).toEqual([
      "operation Q: the spread ...Avatar passes width, which fragment Avatar doesn't declare; it declares size",
    ])
    expect(of(`query Q { Widget(Id: "w1") { ...Avatar @arguments(size: "big") } }`)).toEqual([
      'operation Q: the spread ...Avatar passes size: "big" is not a valid Int!, where fragment Avatar declares size: Int!',
    ])
    expect(of(`query Q { Widget(Id: "w1") { ...Avatar @arguments(size: null) } }`)[0]).toContain("null is not a valid Int!")
    expect(of(`query Q($S: String) { Widget(Id: "w1") { ...Avatar @arguments(size: $S) } }`)).toEqual([
      "operation Q: the spread ...Avatar passes size: $S is String, where fragment Avatar declares size: Int!",
    ])
    expect(of(`fragment Plain on Widget { Name }`, `query Q { Widget(Id: "w1") { ...Plain @arguments(size: 3) } }`)).toEqual([
      "operation Q: the spread ...Plain passes @arguments, but fragment Plain declares no arguments; add @argumentDefinitions to it",
    ])
    expect(of(`query Q @argumentDefinitions(size: {type: "Int"}) { Widget(Id: "w1") { Name } }`)).toEqual([
      "Operation Q: @argumentDefinitions belongs on a fragment definition; an operation declares variables",
    ])
    expect(of(`query Q { Widget(Id: "w1") @arguments(size: 1) { Name } }`)).toEqual(["Operation Q: @arguments belongs on a fragment spread"])

    const declared = (declaration: string, body = "Name") => problemsOf(() => compile(schema, [`fragment Bad on Widget @argumentDefinitions(${declaration}) { ${body} }`]))
    expect(declared(`size: "Int"`)).toEqual(['Fragment Bad argument size: declare it as name: {type: "Int!", defaultValue: 10}, with defaultValue optional'])
    expect(declared(`size: {type: "Int", default: 1}`)[0]).toContain("declare it as")
    expect(declared(`size: {type: "Int!!"}`)).toEqual(['Fragment Bad argument size: "Int!!" is not a GraphQL type'])
    expect(declared(`size: {type: "Widget"}`)).toEqual(["Fragment Bad argument size: Widget is not an input type in the schema"])
    expect(declared(`size: {type: "Int", defaultValue: "x"}`)).toEqual(['Fragment Bad argument size: the default "x" is not a valid Int'])
    expect(declared(`size: {type: "Int"}, size: {type: "Int"}`)).toEqual(["Fragment Bad argument size is declared more than once"])
    // An argument is used only where its declared type fits, as a variable would be.
    expect(declared(`size: {type: "String"}`, "Image(Size: $size)")).toEqual([
      'Fragment Bad: Argument "$size" of type "String" used in position expecting type "Int".',
    ])
  })

  it("refuses one fragment spread twice on one object with different arguments", () => {
    const avatar = `fragment Avatar on Widget @argumentDefinitions(size: {type: "Int", defaultValue: 1}) { Image(Size: $size) }`
    expect(problemsOf(() => compile(schema, [avatar, `query Q { Widget(Id: "w1") { ...Avatar ... on Widget { ...Avatar @arguments(size: 2) } } }`]))).toEqual([
      "operation Q: fragment Avatar is spread twice on one object with different arguments (size: 1) and (size: 2); spread each under its own alias",
    ])
    // The same values twice are one copy.
    const same = compile(schema, [avatar, `query Q { Widget(Id: "w1") { ...Avatar @arguments(size: 1) ...Avatar } }`]).operations.Q!
    expect([...same.text.matchAll(/^fragment /gm)]).toHaveLength(1)
  })

  it("passes a fragment's arguments on to a fragment it spreads, and keeps a local name apart from an operation variable", async () => {
    const documents = [
      `fragment Logo on Vendor @argumentDefinitions(size: {type: "Int"}) { Logo(Size: $size) }`,
      `fragment Card on Widget @argumentDefinitions(size: {type: "Int", defaultValue: 8}, limit: {type: "Int!"}, kind: {type: "NoteKind"}) {
        Image(Size: $size)
        Caption(Locale: $Locale)
        Notes(Limit: $limit, Kind: $kind) { Body }
        Vendor { ...Logo @arguments(size: $size) }
      }`,
      // $size here is the operation's, and only the operation's fields read it.
      `query Cards($size: Int, $Locale: String) {
        a: Widget(Id: "w1") { OwnImage: Image(Size: $size) ...Card @arguments(limit: 1) }
        b: Widget(Id: "w1") { ...Card @arguments(size: $size, limit: 2, kind: OPEN) }
      }`,
    ]
    const { compiled, network, client } = setup(documents)
    const operation = compiled.operations.Cards!
    expect(validate(schema, parse(operation.text))).toEqual([])
    // An argument with no default that a spread doesn't pass is null.
    expect(operation.text).toContain("Notes(Limit: 1, Kind: null)")
    const { snapshot, errors } = await client.execute<any>(operation, { size: 300, Locale: "fr" })
    expect(errors).toEqual([])
    expect(network.failures).toEqual([])
    expect(snapshot.data.a.OwnImage).toBe("w1@300:1")
    const card = (ref: unknown) => readFragment<any>(compiled.fragments.Card!, ref)
    const a = card(snapshot.data.a), b = card(snapshot.data.b)
    expect(a).toMatchObject({ Image: "w1@8:1", Caption: "w1/fr", Notes: [{ Body: "ANY 0" }] })
    expect(b).toMatchObject({ Image: "w1@300:1", Caption: "w1/fr", Notes: [{ Body: "OPEN 0" }, { Body: "OPEN 1" }] })
    expect(readFragment<any>(compiled.fragments.Logo!, a.Vendor)).toMatchObject({ Logo: "v1@8" })
    expect(readFragment<any>(compiled.fragments.Logo!, b.Vendor)).toMatchObject({ Logo: "v1@300" })
    client.dispose()
  })

  it("keeps records reached only through a fragment's arguments while a query holds them", async () => {
    const documents = [
      `fragment Notes on Widget @argumentDefinitions(limit: {type: "Int!"}) { Notes(Limit: $limit) { Body } }`,
      `query Held { Widget(Id: "w1") { ...Notes @arguments(limit: 2) } }`,
    ]
    const { compiled, client } = setup(documents)
    const watched = client.watchQuery<any>(compiled.operations.Held!, {})
    watched.open()
    await watched.refetch()
    const note = encodeNodeId("Note", ["w1-any-n1"])
    expect(client.store.get(note)).toBeDefined()
    client.store.collect()
    expect(client.store.get(note)).toBeDefined()
    expect(readFragment<any>(compiled.fragments.Notes!, watched.getState().data.Widget).Notes).toHaveLength(2)
    watched.close()
    client.dispose()
    expect(client.store.get(note)).toBeUndefined()
  })

  it("keeps fields with arguments out of a live fragment's stream, and reads them again in each holder", async () => {
    let version = 1
    const live = `fragment LiveThumb on Widget @live @argumentDefinitions(size: {type: "Int!", defaultValue: 64}) { Name Image(Size: $size) }`
    const query = `query Live($Id: String!) { small: Widget(Id: $Id) { ...LiveThumb } large: Widget(Id: $Id) { ...LiveThumb @arguments(size: 512) } }`
    const { compiled, network, clock, streams, client } = setup([live, query], { version: () => version })
    const artifact = compiled.live.Widget!
    expect(artifact.operation.text).not.toContain("Image")
    expect(artifact.operation.text).toContain("Name")
    expect(artifact.rereadFragments).toEqual(["LiveThumb"])
    const watched = client.watchQuery<any>(compiled.operations.Live!, { Id: "w1" })
    watched.open()
    await clock.tick()
    const read = (alias: string) => readFragment<any>(compiled.fragments.LiveThumb!, watched.getState().data[alias])
    expect(read("small")).toMatchObject({ Name: "name-w1", Image: "w1@64:1" })
    expect(read("large")).toMatchObject({ Name: "name-w1", Image: "w1@512:1" })
    version = 2
    streams.one("LiveWidget").emit({ __typename: "Widget", Id: "w1", Name: "renamed", RecordVersion: 2 })
    await clock.tick()
    expect(network.calls("Live")).toHaveLength(2)
    expect(read("small")).toMatchObject({ Name: "name-w1", Image: "w1@64:2" })
    expect(read("large")).toMatchObject({ Name: "name-w1", Image: "w1@512:2" })
    expect(network.failures).toEqual([])
    watched.close()
    client.dispose()
  })

  it("refuses a live fragment with arguments under liveSelection: as-written, and a @refetchable one", () => {
    const live = `fragment LiveThumb on Widget @live @argumentDefinitions(size: {type: "Int", defaultValue: 1}) { Name Image(Size: $size) }`
    const [asWritten] = problemsOf(() => compile(schema, [live], { liveSelection: "as-written" }))
    expect(asWritten).toContain('Fragment LiveThumb is live and declares arguments. With liveSelection: "as-written" the Widget stream spreads LiveThumb')
    // A live fragment passing a literal to one with arguments is fine as written, and its argument isn't taken for an operation variable.
    const nested = [`fragment Image on Widget @argumentDefinitions(size: {type: "Int"}) { Image(Size: $size) }`, `fragment Row on Widget @live { Name ...Image @arguments(size: 4) }`]
    expect(compile(schema, nested, { liveSelection: "as-written", onWarning: () => {} }).live.Widget!.operation.text).toContain("Image(Size: 4)")

    const nodeSchema = buildSchema(`${sdl.replace("type Widget {", "interface Node { NodeId: ID! }\n  type Widget implements Node { NodeId: ID!").replace("type Query {", "type Query { node(NodeId: ID!): Node,")}`)
    const refetchable = `fragment Again on Widget @refetchable @argumentDefinitions(size: {type: "Int", defaultValue: 1}) { Image(Size: $size) }`
    expect(problemsOf(() => compile(nodeSchema, [refetchable], { onWarning: () => {} }))[0]).toContain("Fragment Again is @refetchable and declares arguments")
    // A @refetchable fragment that passes literal values on is fine.
    const passes = [`fragment Image on Widget @argumentDefinitions(size: {type: "Int"}) { Image(Size: $size) }`, `fragment Again on Widget @refetchable { ...Image @arguments(size: 2) }`]
    expect(compile(nodeSchema, passes, { onWarning: () => {} }).fragments.Again!.refetch!.text).toContain("Image(Size: 2)")
  })

  it("reads a @sensitive result through the copies, with the values written in", async () => {
    const documents = [thumb, `query Secret($Id: String!) @sensitive { Widget(Id: $Id) { ...Thumb @arguments(size: 5) } }`]
    const { compiled, client } = setup(documents)
    const { snapshot } = await client.execute<any>(compiled.operations.Secret!, { Id: "w1" })
    expect(snapshot.data.Widget).toMatchObject({ Name: "name-w1", Image: "w1@5:1" })
    client.dispose()
  })

  it("leaves a fragment without arguments as it is, beside one with them", () => {
    const documents = [thumb, `fragment Plain on Widget { Name ...Thumb @arguments(size: 3) }`, `query Q($Id: String!) { Widget(Id: $Id) { ...Plain } }`]
    const operation = compile(schema, documents).operations.Q!
    expect(operation.text).toMatch(/^fragment Plain on Widget \{\n {2}__typename\n {2}Id\n {2}RecordVersion\n {2}Name\n {2}\.\.\.Thumb_[0-9a-f]{8}\n\}/m)
    const widget = operation.selections[0] as import("../src/artifact.js").LinkSelection
    expect(widget.selections.find((selection) => selection.kind === "spread")).toEqual({ kind: "spread", name: "Plain", typeCondition: "Widget", possibleTypes: ["Widget"] })
  })
})
