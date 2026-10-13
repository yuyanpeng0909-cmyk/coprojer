const { fork } = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const output = path.resolve('.runtime/context-runtime/m4-crashes'); fs.mkdirSync(output, { recursive: true })
function child(mode, boundary, env) {
  return new Promise((resolve, reject) => {
    const process = fork(path.resolve('scripts/fixtures/context-runtime-crash-host.cjs'), [mode, boundary], { env: { ...global.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    const messages = []; let logs = ''; process.stdout.on('data', data => { logs += data }); process.stderr.on('data', data => { logs += data })
    process.on('message', message => messages.push(message)); process.on('error', reject)
    const timer = setTimeout(() => { process.kill(); reject(new Error('bounded child timeout: ' + logs)) }, 30000)
    process.on('exit', code => { clearTimeout(timer); resolve({ code, messages, logs }) })
  })
}
async function main() {
  const results = []
  for (const boundary of ['effect', 'receipt', 'projection']) {
    const owned = new Set(), replacement = 'exports.sum = (a,b) => a+b; // crash proof'
    const server = await provider((_req, n) => n === 1 ? { text: '', calls: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'value.cjs', content: replacement }) }, { id: 'read', name: 'list_files', arguments: '{}' }] }
      : { text: JSON.stringify({ status: 'incomplete', summary: '恢复结果已核对', nextStep: '保留人工确认' }), calls: [] })
    try {
      const first = await child('start', boundary, { COPROJER_CRASH_PROVIDER: server.url }), info = first.messages.find(m => m.type === 'ready')
      assert.ok(info, first.logs); owned.add(info.sandbox); assert.equal(first.code, 73, first.logs); assert.equal(server.requests.length, 1)
      assert.equal(fs.readFileSync(path.join(info.root, 'value.cjs'), 'utf8'), replacement)
      const crashed = JSON.parse(fs.readFileSync(path.join(info.profile, 'engineering-v1.json')))
      assert.ok(crashed.executionCheckpoints[JSON.stringify(['p', 'f'])].pending)
      const resumed = await child('resume', boundary, { COPROJER_CRASH_PROFILE: info.profile }); owned.add(resumed.messages.find(m => m.type === 'ready')?.sandbox)
      assert.equal(resumed.code, 0, resumed.logs); assert.equal(server.requests.length, 2)
      const complete = resumed.messages.find(m => m.type === 'complete'), project = complete.state.projects[0]
      const writes = fs.readFileSync(path.join(info.profile, 'actual-writes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(writes.length, 1); assert.equal(project.changes.length, 1); assert.equal(project.changes[0].after, replacement); assert.equal(project.features[0].stage, 'blocked')
      assert.ok(project.features[0].runtimeBudget.unsettledActivity.length); assert.equal(project.features[0].runtimeBudget.used.tools, 2)
      fs.writeFileSync(path.join(output, boundary + '.json'), JSON.stringify({ firstExit: first.code, resumeExit: resumed.code, writes, crashed, complete, requests: server.requests }, null, 2))
      results.push({ boundary, status: 'passed', firstExit: 73, resumeExit: 0, actualWrites: writes.length }); console.log('PASS: actual process exit after file ' + boundary + ', restart reconciles without rewrite and retains explicit time grant')
    } finally {
      await server.close()
      for (const candidate of owned) if (candidate) { const absolute = path.resolve(candidate); assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep + 'coprojer-preparation-')); fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 3 }) }
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
}
main().catch(e => { console.error(e); process.exitCode = 1 })
