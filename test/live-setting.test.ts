import { buildSchema, extendSchema, parse } from "graphql"
import { describe, expect, it, vi } from "vitest"
import { compile, generate } from "../src/compiler/index.js"
import { createClient, readFragment } from "../src/client.js"
import { encodeNodeId } from "../src/node-id.js"
import { createMockNetwork, createMockStreams, createTestClock } from "../src/test/index.js"
const schema = buildSchema(`type Query { Widgets: [Widget!]! Note: Note } type Widget { Id: ID! Name: String! RecordVersion: Int! } type Note { Id: ID! Body: String } type Subscription { WidgetChanged: Event! } type Event { Action: String! Widget: Widget }`)
const row = 'fragment Row on Widget { Name RecordVersion }'
const page = 'query Page { Widgets { ...Row } }'
describe('live generation settings', () => {
  it('keeps explicit default and supports default, area paths and opt-out', () => {
    expect(compile(schema, [row, page]).live).toEqual({})
    expect(compile(schema, [row, page], { live: 'explicit' }).operations.Page?.lists).toEqual([])
    expect(compile(schema, [row, page], { live: 'default' }).operations.Page?.lists).toEqual(['Widget'])
    for (const [file, enabled] of [['src/area/row.ts', true], ['src/other/row.ts', false]] as const) {
      const result = compile(schema, [row, page], { live: { default: ['src/area/**'] }, documentPaths: { [row]: [file], [page]: ['src/area/page.ts'] } })
      expect(result.fragments.Row?.live).toBe(enabled)
      expect(result.operations.Page?.lists).toEqual(enabled ? ['Widget'] : [])
    }
    const warnings: string[] = []
    expect(compile(schema, [row], { live: { default: ['src/area/**'] }, onWarning: (w) => warnings.push(w) }).fragments.Row?.live).toBe(false)
    expect(warnings.filter((w) => w.startsWith('live.default'))).toEqual(['live.default pattern "src/area/**" matches no file that defines a fragment, so it makes nothing live. A pattern matches the file a fragment is written in, not the files that spread it. No fragment here has a source path to match.'])
    // The first area holds only the page that spreads the fragment, so it's named. The second holds the fragment's own file.
    warnings.length = 0
    const elsewhere = compile(schema, [row, page], { live: { default: ['src/area/**', 'src/shared/**'] }, documentPaths: { [row]: ['src/shared/row.ts'], [page]: ['src/area/page.ts'] }, onWarning: (w) => warnings.push(w) })
    expect(elsewhere.fragments.Row?.live).toBe(true)
    expect(warnings.filter((w) => w.startsWith('live.default'))).toEqual(['live.default pattern "src/area/**" matches no file that defines a fragment, so it makes nothing live. A pattern matches the file a fragment is written in, not the files that spread it.'])
    for (const live of ['explicit', 'default', { default: ['src/**'] }] as const) {
      const disabled = row.replace('Widget {', 'Widget @live(enabled: false) {')
      const result = compile(schema, [disabled, page], { live })
      expect(result.live).toEqual({})
      expect(result.operations.Page?.lists).toEqual([])
      expect(result.operations.Page?.text).not.toContain('@live')
    }
    expect(compile(schema, [row.replace('Widget {', 'Widget @live(enabled: true) {')]).live.Widget).toBeDefined()
  })
  it('leaves a keyless value type alone in default mode, so a query showing one does not start polling', () => {
    const withSpec = buildSchema(`type Query { Widget: Widget } type Subscription { WidgetChanged(Key: ID): WidgetEvent! } type WidgetEvent { Action: String! Widget: Widget } type Widget { Id: ID! Spec: Spec } type Spec { Model: String }`)
    const result = compile(withSpec, ['fragment SpecRow on Spec { Model }', 'query One { Widget { Spec { ...SpecRow } } }'], { live: 'default', onWarning: () => {} })
    expect(result.fragments.SpecRow!.live).toBe(false)
    expect(result.liveUnavailable).toEqual([])
  })

  it('warns once about fragments that could be live and are not, at the level the project set', () => {
    const live = buildSchema(`type Query { Widget: Widget Note: Note Spec: Spec } type Subscription { WidgetChanged(Key: ID): WidgetEvent! } type WidgetEvent { Action: String! Widget: Widget } type Widget { Id: ID! Name: String! } type Note { Id: ID! Body: String } type Spec { Model: String }`)
    const sources = ['fragment Quiet on Widget { Name }', 'fragment Loud on Widget @live { Name }', 'fragment Meant on Widget @live(enabled: false) { Name }', 'fragment NoStream on Note { Body }', 'fragment Keyless on Spec { Model }']
    const warnings: string[] = []
    compile(live, sources, { onWarning: (message) => warnings.push(message) })
    const notLive = warnings.filter((message) => message.includes('strict.fragmentNotLive'))
    expect(notLive).toHaveLength(1)
    expect(notLive[0]).toContain('Fragment Quiet ')
    expect(notLive[0]).not.toMatch(/Loud|Meant|NoStream|Keyless/)
    const off: string[] = []
    compile(live, sources, { strict: { fragmentNotLive: 'off' }, onWarning: (message) => off.push(message) })
    expect(off.filter((message) => message.includes('strict.fragmentNotLive'))).toEqual([])
    expect(() => compile(live, sources, { strict: { fragmentNotLive: 'error' }, onWarning: () => {} })).toThrow(/Quiet/)
    const defaulted: string[] = []
    compile(live, sources, { live: 'default', onWarning: (message) => defaulted.push(message) })
    expect(defaulted.filter((message) => message.includes('strict.fragmentNotLive'))).toEqual([])
  })

  it('reports implicit streamless fragments but errors on explicit intent', () => {
    const warning = vi.fn()
    const note = 'fragment NoteBody on Note { Body }'
    const result = compile(schema, [note], { live: 'default', onWarning: warning })
    expect(result.liveUnavailable).toEqual(['Note'])
    expect(result.fragments.NoteBody?.live).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('no-stream'))
    expect(() => compile(schema, [note.replace('Note {', 'Note @live {')], { live: 'default' })).toThrow('no usable Changed')
    const required = buildSchema('type Query { Widgets: [Widget!]! } type Widget { Id: ID! Name: String RecordVersion: Int } type Subscription { WidgetChanged(Scope: ID!): Event } type Event { Action: String Widget: Widget }')
    expect(compile(required, [row, page], { live: 'default', onWarning: warning }).liveUnavailable).toEqual(['Widget'])
    expect(() => compile(required, [row.replace('Widget {', 'Widget @live {')])).toThrow('no usable Changed')
    const abstract = buildSchema('interface Node { Id: ID! } type Widget implements Node { Id: ID! } type Query { Node: Node }')
    expect(compile(abstract, ['fragment AbstractRow on Node { Id }'], { live: 'default' }).liveUnavailable).toEqual([])
    expect(() => compile(abstract, ['fragment AbstractRow on Node @live { Id }'])).toThrow('no usable Changed')
  })
  it('updates without directives, orders versions, replays reads after reconnect, collects and disposes identity', async () => {
    const compiled = compile(schema, [row, page, 'fragment NoteBody on Note { Body }', 'query NotePage { Note { ...NoteBody } }'], { live: 'default', onWarning: () => {} })
    const clock = createTestClock(), streams = createMockStreams()
    const widget = (Name: string, RecordVersion: number) => ({ __typename: 'Widget', Id: 'w1', Name, RecordVersion })
    let value = widget('first', 1)
    const network = createMockNetwork({ operations: { Page: () => ({ data: { Widgets: [value] } }), NotePage: { data: { Note: { __typename: 'Note', Id: 'n1', Body: 'body' } } } } })
    const client = createClient({ network, store: { ...clock.store, retainMs: 10 }, polling: clock.polling, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, resyncJitterMs: 0, onDiagnostic: null } })
    const watch = client.watchQuery<any>(compiled.operations.Page!, {})
    const note = client.watchQuery(compiled.operations.NotePage!, {})
    watch.open(); note.open(); await clock.tick()
    expect(client.liveTypeHealth('Note')).toMatchObject({ state: 'polling', reason: 'no-stream', pollMs: 30000 })
    const id = encodeNodeId('Widget', ['w1'])
    const read = () => readFragment<{ Name: string }>(compiled.fragments.Row!, watch.getState().data.Widgets[0]).Name
    const stream = streams.one('LiveWidget')
    stream.emit(widget('new', 3)); await clock.tick()
    expect(read()).toBe('new')
    stream.emit(widget('old', 2)); await clock.tick()
    expect(read()).toBe('new')
    value = widget('replayed', 4)
    stream.loseContinuity(); await clock.tick(4000)
    expect(network.requests.length).toBeGreaterThan(2)
    expect(read()).toBe('replayed')
    watch.close(); note.close(); await clock.tick(100)
    client.store.collect()
    expect(client.store.get(id)).toBeUndefined()
    client.dispose()
    expect(client.store.isDisposed).toBe(true)
    stream.emit(widget("late old identity", 10))
    expect(client.store.get(id)).toBeUndefined()
  })
})
it('keeps 40 default-live types visible at the 32-operation capacity boundary', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `Item${i}`)
  const schema = buildSchema(`type Query { ${names.map(n => `${n}: [${n}!]!`).join(' ')} }
    type Subscription { ${names.map(n => `${n}Changed: ${n}Event!`).join(' ')} }
    ${names.map(n => `type ${n} { Id: ID! Value: String } type ${n}Event { Action: String! ${n}: ${n} }`).join(' ')}`)
  const sources = names.map(n => `fragment ${n}Row on ${n} { Value }`)
  sources.push(`query Many { ${names.map(n => `${n} { ...${n}Row }`).join(' ')} }`)
  const compiled = compile(schema, sources, { live: 'default' })
  const clock = createTestClock(), streams = createMockStreams()
  const network = createMockNetwork({ operations: { Many: { data: Object.fromEntries(names.map(n => [n, [{ __typename: n, Id: 'one', Value: n }]])) } } })
  const client = createClient({ network, store: clock.store, polling: clock.polling, live: { ...clock.live, artifacts: compiled.live, subscribe: streams.subscribe, debounceMs: 0, settleMs: false, onDiagnostic: null } })
  const watch = client.watchQuery(compiled.operations.Many!, {})
  watch.open(); await clock.tick()
  expect(streams.open.size).toBe(40)
  for (const name of names.slice(32)) streams.one(`Live${name}`).refuse('SUBSCRIPTION_LIMIT_EXCEEDED')
  await clock.tick()
  expect(streams.open.size).toBe(32)
  for (const name of names.slice(32)) expect(client.liveTypeHealth(name)).toMatchObject({ state: 'connecting', reason: 'over-cap', pollMs: 30000 })
  expect(client.liveTypeHealth(names[0]!)).toMatchObject({ state: 'unconfirmed' })
  watch.close(); client.dispose()
})

describe('keyless types with a stream, and what each area pattern covered', () => {
  const streamed = buildSchema(`type Query { Foos: [Foo!]! Bars: [Bar!]! }
    type Subscription { FooChanged(Keys: [String!]): FooChangedEvent! BarChanged(Keys: [String!]): BarChangedEvent! }
    type FooChangedEvent { Id: String! Action: String! Foo: Foo } type BarChangedEvent { Id: String! Action: String! Bar: Bar }
    type Foo { Id: String! Name: String! } type Bar { Id: String! Name: String! }
    input FooKeyInput { Id: String! } input BarKeyInput { Id: String! }`)
  const plain = 'fragment FooFields on Foo { Id Name }'
  const other = 'fragment FooName on Foo { Name }'
  const foos = 'query Foos { Foos { ...FooFields ...FooName } }'
  const keyless = { keys: { Foo: null } } as const
  const cause = 'Foo has a Changed stream, but its identity is configured off (keys: { Foo: null }), so it can\'t be live'

  it('reports one diagnostic per type under default, an area pattern and explicit', () => {
    for (const live of ['default', 'explicit', { default: ['src/**'] }] as const) {
      const warnings: string[] = []
      const result = compile(streamed, [plain, other, foos], { ...keyless, live, documentPaths: { [plain]: ['src/foo.ts'], [other]: ['src/foo.ts'], [foos]: ['src/page.ts'] }, onWarning: (w) => warnings.push(w) })
      expect(result.live).toEqual({})
      const named = warnings.filter((w) => w.includes('configured off'))
      expect(named).toEqual([`${cause} and fragments FooFields, FooName won't update on screen. Remove that keys entry or name its key fields, or mark them @live(enabled: false) if that's meant. [strict.fragmentNotLive]`])
    }
  })

  it('follows strict.fragmentNotLive, and @live(enabled: false) silences it', () => {
    const off: string[] = []
    compile(streamed, [plain], { ...keyless, live: 'default', strict: { fragmentNotLive: 'off' }, onWarning: (w) => off.push(w) })
    expect(off).toEqual([])
    expect(() => compile(streamed, [plain], { ...keyless, live: 'default', strict: { fragmentNotLive: 'error' }, onWarning: () => {} })).toThrow(cause)
    const meant: string[] = []
    compile(streamed, [plain.replace('Foo {', 'Foo @live(enabled: false) {')], { ...keyless, live: 'default', onWarning: (w) => meant.push(w) })
    expect(meant).toEqual([])
    // A keyless type with no stream is a value type: still nothing to say.
    const value: string[] = []
    compile(buildSchema('type Query { Spec: Spec } type Spec { Model: String }'), ['fragment SpecRow on Spec { Model }'], { live: 'default', onWarning: (w) => value.push(w) })
    expect(value).toEqual([])
  })

  it('names the configured identity, not a missing stream, when the fragment is explicitly @live', () => {
    const marked = 'fragment FooFields on Foo @live { Id Name }'
    expect(() => compile(streamed, [marked, 'query Foos { Foos { ...FooFields } }'], { ...keyless, live: 'explicit' }))
      .toThrow(`Fragment FooFields (<document 1>): ${cause}. Remove that keys entry or name its key fields, use @live(enabled: false), or add @poll(reason: "why polling is needed") [strict.liveWithoutStream]`)
    expect(() => compile(streamed, [marked], keyless)).not.toThrow(/no usable Changed stream/)
    // A stream type whose key can't be found says that instead.
    const noKey = buildSchema('type Query { Foo: Foo } type Subscription { FooChanged: FooEvent! } type FooEvent { Action: String! Foo: Foo } type Foo { Code: String! }')
    expect(() => compile(noKey, ['fragment F on Foo @live { Code }'])).toThrow('the compiler finds no key fields for it (no Id field and no FooKeyInput), so it can\'t be live. Name them in keys: { Foo: [...] }')
    // With a declared polling reason it compiles and polls, as any streamless live type does.
    expect(compile(streamed, [marked.replace('@live', '@live @poll(reason: "keyless")')], keyless).liveUnavailable).toEqual(['Foo'])
  })

  it('reports what each live.default pattern covered', () => {
    const sources = {
      'fragment BarRow on Bar { Name }': 'src/area/bar.ts',
      'fragment BarMarked on Bar @live { Id }': 'src/area/bar.ts',
      'fragment BarOff on Bar @live(enabled: false) { Name }': 'src/area/off.ts',
      'fragment FooRow on Foo { Name }': 'src/area/foo.ts',
      'fragment NoteRow on Note { Body }': 'src/area/note.ts',
      'fragment Elsewhere on Bar { Name }': 'src/other/bar.ts',
    }
    const withNote = extendSchema(streamed, parse('type Note { Id: ID! Body: String } extend type Query { Note: Note }'))
    const documentPaths = Object.fromEntries(Object.entries(sources).map(([text, file]) => [text, [file]]))
    const options = { ...keyless, live: { default: ['src/area/**', 'src/none/**'] }, documentPaths, onWarning: () => {} }
    expect(compile(withNote, Object.keys(sources), options).liveAreas).toEqual([
      { pattern: 'src/area/**', files: ['src/area/bar.ts', 'src/area/foo.ts', 'src/area/note.ts', 'src/area/off.ts'], fragments: ['BarMarked', 'BarOff', 'BarRow', 'FooRow', 'NoteRow'], newlyLive: ['BarRow'], alreadyLive: ['BarMarked'], optedOut: ['BarOff'], keyless: ['FooRow'], withoutStream: ['NoteRow'], abstract: [] },
      { pattern: 'src/none/**', files: [], fragments: [], newlyLive: [], alreadyLive: [], optedOut: [], keyless: [], withoutStream: [], abstract: [] },
    ])
    expect(compile(withNote, Object.keys(sources), { ...options, live: 'default' }).liveAreas).toBeUndefined()
    const lines: string[] = []
    generate(withNote, Object.keys(sources), { ...options, onSummary: (line) => lines.push(line) })
    expect(lines).toEqual([
      'live.default "src/area/**": 4 files, 5 fragments: 1 newly live, 1 already live, 1 opted out, 1 keyless, 1 without a stream',
      'live.default "src/none/**": 0 files, 0 fragments: 0 newly live',
    ])
    const none: string[] = []
    generate(withNote, Object.keys(sources), { ...options, live: 'default', onSummary: (line) => none.push(line) })
    expect(none).toEqual([])
  })
})
