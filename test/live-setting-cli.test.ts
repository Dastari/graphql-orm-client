import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
beforeAll(() => { execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']) }, 120000)
it('threads fragment file paths through generation and checks every duplicate declaration path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-setting-'))
  try {
    mkdirSync(join(dir, 'src/area'), { recursive: true })
    mkdirSync(join(dir, 'src/owners'), { recursive: true })
    writeFileSync(join(dir, 'schema.graphql'), 'type Query { Widget: Widget } type Widget { Id: ID! Name: String } type Subscription { WidgetChanged: Event } type Event { Action: String Widget: Widget }')
    writeFileSync(join(dir, 'src/area/row.ts'), 'graphql(`fragment Row on Widget { Name }`)')
    const query = 'graphql(`query Page { Widget { ...Row } }`)'
    writeFileSync(join(dir, 'src/owners/page.ts'), query)
    const config = { schema: 'schema.graphql', documents: ['src'], out: 'src/generated.ts', live: { default: ['src/area/**'] }, queryOwners: ['src/owners/**'] }
    writeFileSync(join(dir, 'graphql-orm-client.config.json'), JSON.stringify(config))
    const bin = resolve('bin/graphql-orm-client.mjs')
    execFileSync(process.execPath, [bin, 'generate'], { cwd: dir })
    expect(readFileSync(join(dir, 'src/generated.ts'), 'utf8')).toContain('LiveWidget')
    writeFileSync(join(dir, 'src/area/duplicate.ts'), query)
    const result = spawnSync(process.execPath, [bin, 'generate'], { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Page')
    expect(result.stderr).toContain('src/area/duplicate.ts')
    expect(result.stderr).toContain('queryOwners')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 120000)
