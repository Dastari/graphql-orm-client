import { buildSchema } from "graphql"
import { describe, expect, it, vi } from "vitest"
import { compile } from "../src/compiler/index.js"
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
    expect(compile(schema, [row], { live: { default: ['src/area/**'] } }).fragments.Row?.live).toBe(false)
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
