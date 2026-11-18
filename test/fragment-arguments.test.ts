import { buildSchema, graphql, parse, validate } from "graphql"
import { describe, expect, it } from "vitest"
import { createClient, fragmentSelector, hasFragment, readFragment } from "../src/client.js"
import { CompileError, compile, generate, type CompileOptions } from "../src/compiler/index.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const sdl = `
  type Query { Widget(Id: String!): Widget, Widgets(Where: WidgetWhereInput): [Widget!]!, Search: [Hit!]! }
  union Hit = Widget | Vendor
  type Subscription { WidgetChanged(Keys: [String!]): WidgetChangedEvent! }
  type WidgetChangedEvent { Action: String!, Widget: Widget }
  input WidgetWhereInput { Name: StringFilter, And: [WidgetWhereInput!] }
  input StringFilter { Eq: String }
  enum NoteKind { OPEN CLOSED }
  type Widget {
    Id: String!
    Name: String!
    RecordVersion: Int!
    Image(Size: Int = 50): String
    Pic(Size: Int! = 50): String
    Matches(Where: WidgetWhereInput): String
    Sizes(Of: [Int]): String
    Caption(Locale: String): String
    Notes(Limit: Int!, Kind: NoteKind): [Note!]!
    Vendor: Vendor
  }
  type Note { Id: String!, Body: String! }
  type Vendor { Id: String!, Logo(Size: Int): String, Mark(Size: Int = 16): String }
`
const schema = buildSchema(sdl)

// What 0.1.0-alpha.13 and main before fragment arguments produce for a document without them.
const PLAIN_TEXT = "query Q($Id: String!) {\n  Widget(Id: $Id) {\n    __typename\n    Id\n    RecordVersion\n    ...Plain\n  }\n}\n\nfragment Plain on Widget {\n  __typename\n  Id\n  RecordVersion\n  Name\n  Image(Size: 3)\n}"
const PLAIN_HASH = "b50b7a51e7155851d0678809f97b8c763fb538aad3c2306709e70d470b265a04"

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
    Pic: ({ Size }: { Size: number }) => `pic@${Size}`,
    Matches: ({ Where }: { Where?: unknown }) => JSON.stringify(Where ?? "absent"),
    Sizes: (args: { Of?: unknown }) => JSON.stringify("Of" in args ? args.Of : "absent"),
    Caption: ({ Locale }: { Locale: string | null }) => `${id}/${Locale}`,
    Notes: ({ Limit, Kind }: { Limit: number; Kind: string | null }) =>
      Array.from({ length: Limit }, (_, index) => ({ Id: `${id}-${Kind ?? "any"}-n${index}`, Body: `${Kind ?? "ANY"} ${index}` })),
    Vendor: { Id: "v1", Logo: (args: { Size?: number | null }) => `v1@${"Size" in args ? args.Size : "absent"}`, Mark: ({ Size }: { Size: number | null }) => `mark@${Size}` },
  })
  const rootValue = { Widget: ({ Id }: { Id: string }) => widget(Id), Widgets: () => [widget("w1")], Search: () => [{ __typename: "Widget", ...widget("w1") }, { __typename: "Vendor", ...widget("w1").Vendor }] }
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
    // An argument with no default that a spread doesn't pass is left out.
    expect(operation.text).toContain("Notes(Limit: 1) {")
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

  it("leaves out an argument given an unbound fragment argument, so the schema's default applies, as for an unset variable", async () => {
    const documents = [
      `fragment Free on Widget @argumentDefinitions(size: {type: "Int"}, name: {type: "String"}) {
        Image(Size: $size)
        Pic(Size: $size)
        Matches(Where: {Name: {Eq: $name}})
        Sizes(Of: [$size, 1])
      }`,
      `query Free($Id: String!, $Unset: Int) {
        none: Widget(Id: $Id) { ...Free }
        some: Widget(Id: $Id) { ...Free @arguments(size: 7, name: "x") }
        unset: Widget(Id: $Id) { ...Free @arguments(size: $Unset) }
      }`,
    ]
    const { compiled, network, client } = setup(documents)
    const operation = compiled.operations.Free!
    expect(validate(schema, parse(operation.text))).toEqual([])
    expect(operation.text).toContain("  Image\n")
    expect(operation.text).toContain("  Pic\n")
    // A filter field left out filters nothing; written as null it would mean "name is null".
    expect(operation.text).toContain("Matches(Where: {Name: {}})")
    expect(operation.text).toContain("Sizes(Of: [null, 1])")
    const { snapshot, errors } = await client.execute<any>(operation, { Id: "w1" })
    expect(errors).toEqual([])
    expect(network.failures).toEqual([])
    const read = (alias: string) => readFragment<any>(compiled.fragments.Free!, snapshot.data[alias])
    expect(read("none")).toMatchObject({ Image: "w1@50:1", Pic: "pic@50", Matches: '{"Name":{}}', Sizes: "[null,1]" })
    expect(read("some")).toMatchObject({ Image: "w1@7:1", Pic: "pic@7", Matches: '{"Name":{"Eq":"x"}}', Sizes: "[7,1]" })
    // An operation variable passed and not set is sent as the variable, so the server applies the schema's default; the
    // fragment's own default doesn't, since the text can't say "this default unless $Unset is set".
    expect(read("unset")).toMatchObject({ Image: "w1@50:1" })
    const record = client.store.get(encodeNodeId("Widget", ["w1"]))!
    expect([...record.fields.keys()]).toEqual(expect.arrayContaining(["Image", "Pic", 'Matches({"Where":{"Name":{}}})', 'Sizes({"Of":[null,1]})', 'Image({"Size":7})', 'Image({"Size":null})']))
    client.dispose()
  })

  it("lets a fragment's default apply when the spreading fragment passes on an argument it has no value for", async () => {
    const documents = [
      `fragment Logo on Vendor @argumentDefinitions(size: {type: "Int", defaultValue: 32}) { Logo(Size: $size) }`,
      `fragment Mark on Vendor @argumentDefinitions(size: {type: "Int"}) { Mark(Size: $size) Bare: Logo(Size: $size) }`,
      `fragment Outer on Widget @argumentDefinitions(size: {type: "Int"}) { Vendor { ...Logo @arguments(size: $size) ...Mark @arguments(size: $size) } }`,
      `query Through($Id: String!) { a: Widget(Id: $Id) { ...Outer } b: Widget(Id: $Id) { ...Outer @arguments(size: 99) } }`,
    ]
    const { compiled, network, client } = setup(documents)
    const operation = compiled.operations.Through!
    expect(validate(schema, parse(operation.text))).toEqual([])
    const { snapshot, errors } = await client.execute<any>(operation, { Id: "w1" })
    expect(errors).toEqual([])
    expect(network.failures).toEqual([])
    const vendor = (alias: string) => readFragment<any>(compiled.fragments.Outer!, snapshot.data[alias]).Vendor
    // Not passed on: Logo's own default, then the schema's default for Mark, and no argument at all for Logo without one.
    expect(readFragment<any>(compiled.fragments.Logo!, vendor("a"))).toMatchObject({ Logo: "v1@32" })
    expect(readFragment<any>(compiled.fragments.Mark!, vendor("a"))).toMatchObject({ Mark: "mark@16", Bare: "v1@absent" })
    expect(readFragment<any>(compiled.fragments.Logo!, vendor("b"))).toMatchObject({ Logo: "v1@99" })
    expect(readFragment<any>(compiled.fragments.Mark!, vendor("b"))).toMatchObject({ Mark: "mark@99", Bare: "v1@99" })
    client.dispose()
  })

  it("fails when a copy's name is taken by a fragment of the application", () => {
    const documents = [thumb, `query One { Widget(Id: "w1") { ...Thumb @arguments(size: 10) } }`]
    const copy = /fragment (Thumb_[0-9a-f]{8})/.exec(compile(schema, documents).operations.One!.text)![1]!
    expect(problemsOf(() => compile(schema, [...documents, `fragment ${copy} on Widget { Id }`]))).toEqual([
      `Fragment ${copy} has the name the compiler gives the copy of fragment Thumb for {size: 10}; rename it`,
    ])
  })

  it("fails, at once, for a fragment that spreads itself with a growing value", () => {
    const documents = [
      `fragment R on Widget @argumentDefinitions(w: {type: "WidgetWhereInput!"}) { Name ...R @arguments(w: {And: [$w]}) }`,
      `query Q { Widget(Id: "w1") { ...R @arguments(w: {Name: {Eq: "a"}}) } }`,
    ]
    expect(problemsOf(() => compile(schema, documents))).toEqual(["Fragment R spreads itself: R → R"])
  })

  it("allows one fragment with different arguments under type conditions that can't both match", () => {
    const tag = `fragment Tag on Hit @argumentDefinitions(size: {type: "Int"}) { __typename }`
    expect(() => compile(schema, [tag, `query Q { Search { ... on Widget { ...Tag @arguments(size: 1) } ... on Vendor { ...Tag @arguments(size: 2) } } }`])).not.toThrow()
    expect(problemsOf(() => compile(schema, [tag, `query Q { Search { ... on Widget { ...Tag @arguments(size: 1) } ...Tag @arguments(size: 2) } }`]))).toEqual([
      "operation Q: fragment Tag is spread twice on one object with different arguments (size: 1) and (size: 2); spread each under its own alias",
    ])
  })

  it("keeps a fragment's arguments out of a batched relation's request", async () => {
    const batchSchema = buildSchema(`
      type Query { Tickets: [Ticket!]!, Vendors(Where: VendorWhereInput, Page: PageInput): VendorConnection! }
      type Ticket { Id: String!, VendorId: String, Vendor: Vendor, Label(Size: Int): String }
      type Vendor { Id: String!, Name: String! }
      type VendorConnection { Edges: [VendorEdge!]! }
      type VendorEdge { Node: Vendor! }
      input VendorWhereInput { Id: StringFilter }
      input StringFilter { InList: [String!] }
      input PageInput { Limit: Int }
    `)
    const compiled = compile(batchSchema, [
      `fragment Row on Ticket @argumentDefinitions(size: {type: "Int", defaultValue: 3}) { Label(Size: $size) Vendor @batch(foreignKey: "VendorId", root: "Vendors", key: "Id") { Name } }`,
      `query Rows($Size: Int) { Tickets { ...Row @arguments(size: $Size) } }`,
    ])
    const requests: Record<string, unknown>[] = []
    const client = createClient({ network: { execute: async (request) => {
      requests.push(request.variables)
      if (!request.name.startsWith("Batch_")) return { data: { Tickets: [{ __typename: "Ticket", Id: "t1", VendorId: "v1", Label: "l" }] } }
      return { data: { Vendors: { __typename: "VendorConnection", Edges: [{ __typename: "VendorEdge", Node: { __typename: "Vendor", Id: "v1", Name: "Acme" } }] } } }
    } } })
    const { installRelationBatching } = await import("../src/relations.js")
    installRelationBatching(client, { withoutDocument: "read" })
    const { snapshot } = await client.execute<any>(compiled.operations.Rows!, { Size: 4 })
    const read = () => readFragment<any>(compiled.fragments.Row!, snapshot.data.Tickets[0])
    expect(read().Vendor.status).toBe("pending")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(read().Vendor).toMatchObject({ status: "ready", data: { Name: "Acme" } })
    expect(read().Label).toBe("l")
    const batch = requests[1]!
    expect(Object.keys(batch).sort()).toEqual(["Page", "Size", "Where"])
    client.dispose()
  })

  it("compiles a document without fragment arguments to the same text and hash as before", () => {
    const operation = compile(schema, [`fragment Plain on Widget { Name Image(Size: 3) }`, `query Q($Id: String!) { Widget(Id: $Id) { ...Plain } }`]).operations.Q!
    expect(operation.text).toBe(PLAIN_TEXT)
    expect(operation.hash).toBe(PLAIN_HASH)
  })

  it("leaves a fragment without arguments as it is, beside one with them", () => {
    const documents = [thumb, `fragment Plain on Widget { Name ...Thumb @arguments(size: 3) }`, `query Q($Id: String!) { Widget(Id: $Id) { ...Plain } }`]
    const operation = compile(schema, documents).operations.Q!
    expect(operation.text).toMatch(/^fragment Plain on Widget \{\n {2}__typename\n {2}Id\n {2}RecordVersion\n {2}Name\n {2}\.\.\.Thumb_[0-9a-f]{8}\n\}/m)
    const widget = operation.selections[0] as import("../src/artifact.js").LinkSelection
    expect(widget.selections.find((selection) => selection.kind === "spread")).toEqual({ kind: "spread", name: "Plain", typeCondition: "Widget", possibleTypes: ["Widget"] })
  })
})

describe("fragment arguments with @skip and @include", () => {
  const detail = `fragment Detail on Widget @argumentDefinitions(full: {type: "Boolean!", defaultValue: false}) {
    Name
    Caption(Locale: "en") @include(if: $full)
  }`
  const details = `query Details($Id: String!, $Full: Boolean!) {
    brief: Widget(Id: $Id) { ...Detail }
    literal: Widget(Id: $Id) { ...Detail @arguments(full: true) }
    passed: Widget(Id: $Id) { ...Detail @arguments(full: $Full) }
  }`
  const merged = `query Merged($Id: String!, $show: Boolean!) {
    w: Widget(Id: $Id) { Name }
    w: Widget(Id: $Id) { ...Thumb @arguments(size: 5) @include(if: $show) }
    big: Widget(Id: $Id) { ...Thumb @arguments(size: 500) }
  }`

  it("evaluates a condition on a fragment's argument in each spread's scope: a default, a literal, an operation variable", async () => {
    for (const full of [false, true]) {
      const { compiled, network, client } = setup([detail, details])
      const operation = compiled.operations.Details!
      expect(operation.text).toContain("@include(if: false)")
      expect(operation.text).toContain("@include(if: true)")
      expect(operation.text).toContain("@include(if: $Full)")
      const { snapshot, errors } = await client.execute<any>(operation, { Id: "w1", Full: full })
      expect(errors).toEqual([])
      expect(network.failures).toEqual([])
      const read = (alias: string) => {
        const { store, selector } = fragmentSelector(compiled.fragments.Detail!, snapshot.data[alias])
        return store.lookup<any>(selector)
      }
      // A field its condition leaves out is neither in the data nor missing.
      expect(read("brief").data).not.toHaveProperty("Caption")
      expect(read("brief").missing).toBe(false)
      expect(read("literal").data).toMatchObject({ Name: "name-w1", Caption: "w1/en" })
      expect(read("passed").missing).toBe(false)
      if (full) expect(read("passed").data).toMatchObject({ Caption: "w1/en" })
      else expect(read("passed").data).not.toHaveProperty("Caption")
      client.dispose()
    }
  })

  it("reads a conditional spread of a fragment with arguments inside a merged link, beside the same fragment under another alias", async () => {
    for (const show of [false, true]) {
      const { compiled, network, client } = setup([thumb, merged])
      const { snapshot, errors } = await client.execute<any>(compiled.operations.Merged!, { Id: "w1", show })
      expect(errors).toEqual([])
      expect(network.failures).toEqual([])
      expect(snapshot.data.w.Name).toBe("name-w1")
      expect(hasFragment(compiled.fragments.Thumb!, snapshot.data.w)).toBe(show)
      if (show) expect(readFragment<any>(compiled.fragments.Thumb!, snapshot.data.w)).toMatchObject({ Image: "w1@5:1" })
      expect(readFragment<any>(compiled.fragments.Thumb!, snapshot.data.big)).toMatchObject({ Image: "w1@500:1" })
      client.dispose()
    }
  })

  it("keeps records a condition on a fragment's argument includes while a query holds them", async () => {
    const documents = [
      `fragment Kept on Widget @argumentDefinitions(on: {type: "Boolean!"}) { Notes(Limit: 1) @include(if: $on) { Body } }`,
      `query Holds { Widget(Id: "w1") { ...Kept @arguments(on: true) } }`,
    ]
    const { compiled, client } = setup(documents)
    const watched = client.watchQuery<any>(compiled.operations.Holds!, {})
    watched.open()
    await watched.refetch()
    const note = encodeNodeId("Note", ["w1-any-n0"])
    expect(client.store.get(note)).toBeDefined()
    client.store.collect()
    expect(client.store.get(note)).toBeDefined()
    watched.close()
    client.dispose()
  })

  it("refuses one fragment with different arguments in two fields of one response key, which read as one object", () => {
    const tag = `fragment Tag on Widget @argumentDefinitions(on: {type: "Boolean!"}) { Caption(Locale: "x") @include(if: $on) }`
    expect(problemsOf(() => compile(schema, [tag, `query Q { w: Widget(Id: "w1") { ...Tag @arguments(on: true) } w: Widget(Id: "w1") { ...Tag @arguments(on: false) } }`]))).toEqual([
      "operation Q: fragment Tag is spread twice on one object with different arguments (on: true) and (on: false); spread each under its own alias",
    ])
  })

  it("generates a conditional field of a fragment with arguments as optional, and a conditional spread of one as maybe absent", () => {
    const output = generate(schema, [thumb, detail, details, merged], { onWarning: () => {} })
    expect(output).toContain('export type DetailFragment = { readonly __typename: "Widget"; readonly Name: string; readonly Caption?: string | null }')
    expect(output).toContain('readonly brief: { readonly __typename: "Widget" } & FragmentRefs<"Detail"> | null')
    expect(output).toMatch(/readonly w: \{ readonly __typename: "Widget"; readonly Name: string \} & \(\{\} \| FragmentRefs<"Thumb">\) \| null/)
    expect(output).toContain('readonly big: { readonly __typename: "Widget" } & FragmentRefs<"Thumb"> | null')
  })
})
