// Executed by a real, separate Node process. No Electron loader or substitutes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const core = require(config.bundle)
assert.equal(process.versions.electron, undefined)
const controller = new AbortController(), events = [], archives = [], effects = []
const artifact = new core.ExecutionArtifacts({ path: path.join(config.directory, 'records.json'), redact: s => s, secrets: () => [] }, 'node-project', 'node-task')
const connection = { id: 'node', name: 'Node', baseUrl: config.url, model: 'fixture', apiKey: 'isolated', protocol: config.protocol }
const tools = core.engineeringTools.filter(t => ['read_file', 'read_context', 'list_files'].includes(t.name))
let snapshot, requests = 0
const input = {
  instructions: 'NODE_GOAL 保留目标与授权；只读。', messages: [{ role: 'user', content: 'Read the isolated sources and return READY.' }],
  tools, stepLimit: 5, startStep: 0, savedSteps: 0, replyKind: 'reply', stepPrompt: () => '', stepLabel: n => 'step ' + n,
  conclusionLabel: 'conclusion', contract: { inspect: text => text === 'READY' ? 'complete' : 'invalid', repairInstruction: 'Return READY.', conclusionInstruction: 'Return READY.', canFinish: () => true },
}
const ports = {
  model: {
    prepare: (prompt, messages, offered) => core.prepareModelRequest(connection, prompt, messages, offered),
    send: async ({ prepared, prompt, messages, tools: offered, onUsage }, signal) => {
      requests++
      if (config.mode === 'replacement') return { text: 'READY', calls: [] }
      if (config.mode === 'cancel') setTimeout(() => controller.abort(new Error('node cancellation')), 20)
      return core.complete({ ...connection, onResponse: update => { if (update.usage) onUsage(update.usage) } }, prompt, messages, offered, signal, () => {}, prepared)
    },
  },
  workspace: { assertCurrent() {}, preparePrompt: s => s + '\nCURRENT_FACT revision=1 criteria=read-only', receivedReply() {} },
  tools: {
    execute: async (call, args) => {
      effects.push(call.name)
      return { output: core.executeReadOnly(config.root, call.name, args, { context: () => core.readPage('NODE_SCOPE'), artifact: args => artifact.read(args) }) }
    },
    isFatal: () => false, visible: (_name, output) => output, redact: s => s, received() {},
  },
  records: {
    save: value => {
      if (config.mode === 'storage-failure') throw new Error('durable storage unavailable')
      snapshot = structuredClone(value)
      if (config.mode !== 'replacement') {
        const file = path.join(config.directory, 'snapshot.json')
        fs.writeFileSync(file + '.tmp', JSON.stringify(snapshot)); fs.renameSync(file + '.tmp', file)
      }
    },
    invalidate() {}, event: (kind, message) => events.push({ kind, message }),
  },
  artifacts: { write: (content, label) => { const id = artifact.write(content, label); archives.push({ id, content }); return id } },
}
core.runRuntime(input, ports, controller.signal).then(outcome => {
  assert.ok(!Object.keys(require.cache).some(file => /node_modules[\\/]electron[\\/]/.test(file)))
  fs.writeFileSync(config.output, JSON.stringify({ outcome: { ...outcome, ...(outcome.error ? { error: String(outcome.error) } : {}) },
    requests, effects, archives, snapshot, events, electronLoaded: false, pid: process.pid }, null, 2))
}).catch(error => { console.error(error); process.exitCode = 1 })
