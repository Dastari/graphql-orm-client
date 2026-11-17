import { buildSchema } from "graphql"
import { describe, expect, it } from "vitest"
import { CompileError, compile } from "../src/compiler/index.js"
import { createClient, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"

const sdl = `
  type Query { Foos: [Foo!]! }
  type Subscription { FooChanged(Keys: [String!]): FooChangedEvent! }
  type FooChangedEvent { Id: String! Action: String! Foo: Foo }
  type Foo { Id: String! Name: String! RecordVersion: Int! Label(Locale: String): String }
  input FooKeyInput { Id: String! }
`
const schema = buildSchema(sdl)
const fragment = "fragment FooL on Foo @live { Name Label(Locale: $loc) }"
const query = "query Q($loc: String) { Foos { ...FooL } }"

describe("a live fragment whose field takes an operation variable", () => {
  it("leaves the field out of the shared stream and marks the fragment for holder re-reads", () => {
    const warnings: string[] = []
    const compiled = compile(schema, [fragment, query], { onWarning: (warning) => warnings.push(warning) })
    const live = compiled.live.Foo!
    expect(live.operation.text).not.toContain("Label")
    expect(live.operation.text).not.toContain("$loc")
    expect(live.operation.text).toContain("Name")
    expect(live.rereadFragments).toEqual(["FooL"])
    expect(warnings).toContain("Fragment FooL: stream excludes Foo.Label")
  })

  it("updates the other fields from the event, and the variable field after one re-read of each holder with its own variables", async () => {
    const compiled = compile(schema, [fragment, query], { onWarning: () => {} })
    const clock = createTestClock(), streams = createMockStreams()
    let version = 1
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let hold = false
    const network = createMockNetwork({
      schema: sdl,
      operations: {
        Q: async (variables) => {
          const answer = { data: { Foos: [{ __typename: "Foo", Id: "f1", Name: `n${version}`, RecordVersion: version, Label: `${variables.loc}:${version}` }] } }
          if (hold) await held
          return answer
        },
      },
    })
    const client = createClient({ network, store: clock.store, polling: clock.polling, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, resyncJitterMs: 0, onDiagnostic: null } })
    const english = client.watchQuery<any>(compiled.operations.Q!, { loc: "en" })
    const french = client.watchQuery<any>(compiled.operations.Q!, { loc: "fr" })
    english.open(); french.open(); await clock.tick()
    const read = (watch: typeof english) => readFragment<{ Name: string; Label: string | null }>(compiled.fragments.FooL!, watch.getState().data.Foos[0])
    expect(read(english)).toMatchObject({ Name: "n1", Label: "en:1" })
    expect(read(french)).toMatchObject({ Name: "n1", Label: "fr:1" })
    expect(network.calls("Q")).toHaveLength(2)

    version = 2
    hold = true
    streams.one("LiveFoo").emit({ __typename: "Foo", Id: "f1", Name: "n2", RecordVersion: 2 })
    await clock.tick()
    // The event carried Name; Label waits for the re-read, which is under way for each holder with its own $loc.
    expect(read(english)).toMatchObject({ Name: "n2", Label: "en:1" })
    expect(read(french)).toMatchObject({ Name: "n2", Label: "fr:1" })
    expect(network.calls("Q").slice(2).map((request) => request.variables)).toEqual([{ loc: "en" }, { loc: "fr" }])

    release!()
    await clock.tick()
    expect(read(english)).toMatchObject({ Name: "n2", Label: "en:2" })
    expect(read(french)).toMatchObject({ Name: "n2", Label: "fr:2" })
    expect(network.calls("Q")).toHaveLength(4)
    expect(network.failures).toEqual([])
    expect(client.store.get(encodeNodeId("Foo", ["f1"]))).toBeDefined()
    english.close(); french.close(); client.dispose()
  })

  it("names the fragment, field and variable under liveSelection: as-written, whose stream spreads the fragment", () => {
    let error: unknown
    try {
      compile(schema, [fragment, query], { liveSelection: "as-written" })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CompileError)
    const [problem] = (error as CompileError).problems
    expect(problem).toContain("Fragment FooL is live, but Foo.Label takes the operation variable $loc")
    expect(problem).toContain("one stream is shared by every query that holds a Foo")
    expect(problem).toContain("literal argument")
    expect(problem).toContain("@live(enabled: false)")
    expect(problem).toContain('remove liveSelection: "as-written"')
    expect(problem).not.toContain("LiveFoo")
    // A spread fragment's variable is named where it is written.
    const nested = ["fragment Label on Foo { Label(Locale: $loc) }", "fragment FooR on Foo @live { Name ...Label }", "query R($loc: String) { Foos { ...FooR } }"]
    expect(() => compile(schema, nested, { liveSelection: "as-written" })).toThrow("Fragment FooR is live, but Foo.Label (in fragment Label) takes the operation variable $loc")
    // A literal argument is fine as written.
    expect(compile(schema, ['fragment FooE on Foo @live { Name Label(Locale: "en") }'], { liveSelection: "as-written" }).live.Foo).toBeDefined()
  })
})
