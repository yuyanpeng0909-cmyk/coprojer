const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict'), { spawn } = require('node:child_process')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const output = path.resolve('.runtime/context-runtime/m2-node')
fs.mkdirSync(output, { recursive: true })
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-core-node-'))
const bundle = path.join(output, 'core.cjs')
const meta = require('esbuild').buildSync({ stdin: { contents: `export * from './src/main/engineering/runtime'; export * from './src/main/engineering/model'; export * from './src/main/engineering/files'; export * from './src/main/engineering/context'; export * from './src/main/engineering/execution-artifacts';`, resolveDir: path.resolve('.') }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, metafile: true })
assert.ok(Object.keys(meta.metafile.inputs).every(file => !/(?:^|[\\/])(?:store|service)\.ts$|electron/.test(file)), 'Node path has no desktop or business-store dependency')
fs.writeFileSync(path.join(output, 'dependencies.json'), JSON.stringify(meta.metafile, null, 2))
async function child(config) {
  const input = path.join(config.directory, 'input.json'); fs.writeFileSync(input, JSON.stringify(config))
  const process = spawn(global.process.execPath, ['scripts/fixtures/context-runtime-node-host.cjs', input], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; process.stdout.on('data', data => log += data); process.stderr.on('data', data => log += data)
  const code = await new Promise(resolve => process.on('exit', resolve))
  assert.equal(code, 0, log)
  return JSON.parse(fs.readFileSync(config.output))
}
async function main() {
  const results = []
  for (const protocol of ['chat', 'responses', 'anthropic']) {
    const directory = path.join(sandbox, protocol), root = path.join(directory, 'project')
    fs.mkdirSync(root, { recursive: true })
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, 'source-' + i + '.txt'), 'SOURCE_' + i + ' 中文' + 'x'.repeat(5980))
    const server = await provider((request, number) => {
      assert.match(request.system, /NODE_GOAL/); assert.match(request.system, /CURRENT_FACT/)
      if (number === 1) return { calls: Array.from({ length: 10 }, (_, i) => ({ id: 'read-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'source-' + i + '.txt' }) })) }
      if (number === 2) {
        const id = JSON.stringify(request.body).match(/artifact:[a-f0-9-]{36}/)?.[0]
        assert.ok(id, 'compaction supplies an actual archive reference')
        return { calls: [{ id: 'archive-read', name: 'read_context', arguments: JSON.stringify({ id }) }] }
      }
      return { text: 'READY', calls: [] }
    })
    try {
      const result = await child({ bundle, directory, root, url: server.url, protocol, output: path.join(output, protocol + '.json') })
      assert.equal(result.outcome.status, 'completed'); assert.equal(result.requests, 3); assert.equal(result.effects.length, 11)
      assert.ok(result.archives.length); assert.match(result.archives[0].content, /SOURCE_0/)
      assert.ok(result.snapshot.messages.some(m => m.role === 'tool' && m.callId === 'archive-read'))
      assert.deepEqual(server.errors, []); assert.equal(result.electronLoaded, false)
      results.push({ protocol, status: 'passed', pid: result.pid, requests: 3, reads: 11 })
      console.log('PASS: real Node core prepares, calls ' + protocol + ' HTTP/SSE, reads, archives, re-reads and completes without Electron')
    } finally { await server.close() }
  }
  for (const mode of ['replacement', 'storage-failure', 'network-failure', 'cancel']) {
    const directory = path.join(sandbox, mode); fs.mkdirSync(directory)
    const server = await provider(async () => {
      if (mode === 'network-failure') throw new Error('controlled transport failure')
      await new Promise(resolve => setTimeout(resolve, 100)); return { text: 'READY' }
    })
    try {
      const result = await child({ bundle, directory, root: directory, url: server.url, protocol: 'chat', mode, output: path.join(output, mode + '.json') })
      assert.equal(result.outcome.status, mode === 'replacement' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed')
      assert.equal(result.effects.length, 0)
      if (mode === 'storage-failure') assert.equal(result.requests, 0)
      if (mode === 'replacement') assert.equal(server.requests.length, 0)
      results.push({ mode, status: 'passed', outcome: result.outcome.status })
      console.log('PASS: same Node core ' + mode + ' through injected ports')
    } finally { await server.close() }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }))
