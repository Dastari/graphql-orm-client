import { buildSchema } from "graphql"
import { describe, expect, it, vi } from "vitest"
import { compile, CompileError, generate } from "../src/compiler/index.js"
import { createClient } from "../src/client.js"
const schema = buildSchema(`type Query { Notes: [Note!]! } type Note { Id: ID! Body: String } type Subscription { Tick: Int }`)
const row = 'fragment Row on Note @live { Body }'
const query = 'query Page { Notes { ...Row } }'
describe('build policies', () => {
  it('aggregates stream, poll and ownership problems with names, files and fixes', () => {
    const empty = 'query Empty @poll(reason: " ") { Notes { Id } }'
    const raw = 'subscription Raw { Tick }'
    try {
      compile(schema, [row, query, empty, raw], { documentPaths: { [row]: ['src/row.ts'], [query]: ['src/page.ts'] }, queryOwners: ['src/owners/**'], subscriptionPaths: [] })
      expect.fail('must reject')
    } catch (error) {
      expect(error).toBeInstanceOf(CompileError)
      const problems = (error as CompileError).problems.join('\n')
      expect(problems).toContain('Row (src/row.ts)')
      expect(problems).toContain('Page (src/page.ts)')
      expect(problems).toContain('Empty')
      expect(problems).toContain('Raw')
      expect(problems).toContain('add its file path')
      expect(problems).toContain('@poll(reason:')
    }
  })
  it('supports warn/off for every policy and keeps unavailable metadata', () => {
    for (const level of ['warn', 'off'] as const) {
      const warning = vi.fn()
      const result = compile(schema, [row, 'query Page @poll(reason: " ") { Notes { ...Row } }', 'subscription Raw { Tick }'], {
        queryOwners: [], subscriptionPaths: [], onWarning: warning,
        strict: { liveWithoutStream: level, pollWithoutReason: level, queryOwnership: level, rawSubscriptions: level },
      })
      expect(result.liveUnavailable).toEqual(['Note'])
      expect(warning).toHaveBeenCalledTimes(level === 'warn' ? 4 : 0)
    }
  })
  it('accepts declared polls and allowed owners and strips client directives', () => {
    const r = row.replace('@live', '@live @poll(reason: "No stream")')
    const q = query.replace('Page {', 'Page @poll(reason: "No stream") {')
    const result = compile(schema, [r, q, 'subscription Raw { Tick }'], {
      documentPaths: { [q]: ['src/dialogs/page.ts'], 'subscription Raw { Tick }': ['src/events/raw.ts'] },
      queryOwners: ['src/dialogs/**'], subscriptionPaths: ['src/events/*.ts'],
    })
    expect(result.fragments.Row?.pollReason).toBe('No stream')
    expect(result.operations.Page?.pollReason).toBe('No stream')
    expect(result.operations.Page?.text).not.toContain('@poll')
    expect(generate(schema, [r, q])).toContain('pollReason')
    expect(() => compile(schema, [row.replace(' @live', ''), query])).not.toThrow()
  })
  it('enforces dynamic intervals at runtime with migration escapes', () => {
    const artifact = compile(schema, ['query Page { Notes { Id } }']).operations.Page!
    const network = { execute: vi.fn() }
    expect(() => createClient({ network }).watchQuery(artifact, {}, { pollMs: 100 })).toThrow('@poll')
    for (const undeclared of ['warn', 'off'] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const client = createClient({ network, polling: { undeclared } })
      expect(() => client.watchQuery(artifact, {}, { pollMs: 100 })).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(undeclared === 'warn' ? 1 : 0)
      client.dispose(); warn.mockRestore()
    }
    const declared = compile(schema, ['query Page @poll(reason: "External writes") { Notes { Id } }']).operations.Page!
    expect(() => createClient({ network }).watchQuery(declared, {}, { pollMs: 100 })).not.toThrow()
    // A module generated before this rule, and production, warn and still poll: a working page mustn't crash on upgrade.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { lists: _lists, ...earlier } = artifact
    expect(() => createClient({ network }).watchQuery(earlier, {}, { pollMs: 100 })).not.toThrow()
    const environment = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => createClient({ network }).watchQuery(artifact, {}, { pollMs: 100 })).not.toThrow()
    } finally { process.env.NODE_ENV = environment }
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
