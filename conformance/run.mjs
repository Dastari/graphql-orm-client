// All runtime output goes to an external scratch directory. No build runs in the worktree.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const scratch = process.env.CONFORMANCE_SCRATCH ?? await mkdtemp(`${tmpdir()}/graphql-orm-conformance-`)
await mkdir(scratch, { recursive: true })
const env = { ...process.env, CONFORMANCE_SCRATCH: scratch, CARGO_TARGET_DIR: `${scratch}/target`, CARGO_PROFILE_DEV_DEBUG: '0' }
const version = process.env.GRAPHQL_ORM_TAG ?? (await readFile('conformance/service/Cargo.toml','utf8')).match(/tag = "([^"]+)"/)[1]
// Generate variant manifests outside the repository; the committed lock pins the default.
const manifest = await readFile('conformance/service/Cargo.toml','utf8')
env.GRAPHQL_ORM_TAG = version
const pinned = manifest.match(/tag = "([^"]+)"/)[1]
await cp('conformance/service', `${scratch}/service`, {recursive:true,filter:path=>!path.split('/').includes('target')})
await writeFile(`${scratch}/service/Cargo.toml`,manifest.replaceAll(`tag = "${pinned}"`,`tag = "${version}"`))

function run(cmd, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(Error(`${cmd} exited ${code}`)))
  })
}
console.log(`Conformance ${version}; scratch ${scratch}`)
const start = Date.now()
if(version!==pinned) await run('cargo',['generate-lockfile','--manifest-path',`${scratch}/service/Cargo.toml`])
await run('cargo', ['build', '--locked', '--manifest-path', `${scratch}/service/Cargo.toml`])
await run('cargo', ['install', '--git', 'https://github.com/Dastari/graphql-orm', '--tag', version, 'graphql-orm-router', '--locked', '--debug', '--root', `${scratch}/router`, '--force'])
console.log(`Rust build/install: ${((Date.now() - start) / 1000).toFixed(1)}s`)
const runtime = await mkdtemp(`${scratch}/run-`)
await run(process.execPath, ['conformance/orm.mjs'], { CONFORMANCE_SCRATCH: runtime, SERVICE_BIN: `${scratch}/target/debug/client-conformance-service`, ROUTER_BIN: `${scratch}/router/bin/graphql-orm-router` })

console.log(`Conformance total: ${((Date.now() - start) / 1000).toFixed(1)}s`)
