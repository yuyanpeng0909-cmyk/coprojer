// Replay of a saved failure. Reads the project; writes only a fixture profile
// and evidence. Offline by default. --live --authorized probes one provider
// request without dispatching any tools returned by that provider.
const live = process.argv.includes('--live')
if (live && !process.argv.includes('--authorized')) throw new Error('--live requires --authorized')
if (live && !process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, fixture, model, load, sandbox } = r
const { createHash } = require('node:crypto')
const hash = x => createHash('sha256').update(x).digest('hex')
const source = path.join(process.env.APPDATA, 'Coprojer-dev', 'engineering-v1.json')
const original = fs.readFileSync(source), data = JSON.parse(original)
const project = data.projects.find(p => p.id === 'd0e2b872-82e4-4ebb-ad67-1993dc23ee5e')
const feature = project.features.find(f => f.id === 'a05dcf1a-0af0-495f-81b1-065a9b6b8b75')
const key = JSON.stringify([project.id, feature.id]), scope = hash(key)
const archiveId = '383447be-bef9-4876-9c18-1220bbcfe8fe'
const archiveDirectory = path.join(path.dirname(source), 'engineering-artifacts', scope)
const archiveText = fs.readFileSync(path.join(archiveDirectory, archiveId + '.txt'), 'utf8')
const archiveMeta = JSON.parse(fs.readFileSync(path.join(archiveDirectory, archiveId + '.json'), 'utf8'))
assert.equal(hash(archiveText), archiveMeta.version)
const archived = JSON.parse(archiveText), scopeId = archived.find(m => m.origin?.nativeScope).origin.nativeScope
const first = data.executionCheckpoints[key].messages.find(m => m.sequence === 1)
const output = path.resolve('.runtime/context-window-growth'); fs.mkdirSync(output, { recursive: true })
const results = [], stop = new Error('REPLAY_REQUEST_READY')
const electron = live ? require('electron') : undefined
if (electron) {
  const profile = path.join(sandbox, 'live-profile'); fs.mkdirSync(profile)
  electron.app.setPath('userData', profile)
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: JSON.parse(fs.readFileSync(path.join(path.dirname(source), 'Local State'), 'utf8')).os_crypt }))
}
async function replay(sameScope) {
  const ctx = fixture(), service = ctx.service
  service.store.data = structuredClone(data); service.store.key = () => ''
  const p = service.store.project(project.id), f = p.features.find(f => f.id === feature.id)
  const c = structuredClone(data.executionCheckpoints[key])
  c.messages = [structuredClone(first), ...structuredClone(archived)]
  c.steps = 4; c.lastSequence = 130
  c.continuity.growth = { identity: c.continuity.growth.identity, samples: [28213, 77867, 18466],
    throughSequence: 113, prefixThroughSequence: 107, epoch: 1 }
  const agent = service.store.data.agents.find(a => a.id === f.developerId)
  const previousPrepare = model.prepareModelRequest, previousComplete = model.complete
  let initial, smallest = Infinity, sent = false, lastBudget, candidateSizes = new Set(), liveResult
  const before = service.sourceFingerprint(p)
  model.prepareModelRequest = (...args) => {
    args[0] = { ...args[0], nativeScope: sameScope ? scopeId : 'restart-replay' }
    const result = previousPrepare(...args)
    if (!initial && args[2].some(m => m.sequence === 114)) {
      initial = result.budget
      const added = args[2].filter(m => (m.sequence ?? 0) > 113)
      const bytes = previousPrepare(args[0], args[1], added, args[3], args[4]).budget.requestBytes
      const emptyBytes = previousPrepare(args[0], args[1], [], args[3], args[4]).budget.requestBytes
      initial = { ...initial, newRoundGrowth: Math.ceil((bytes - emptyBytes) * result.budget.estimatedInputTokens / result.budget.requestBytes) }
    }
    if (args[2].length && !args[2].some(m => m.sequence === 114)) {
      smallest = Math.min(smallest, result.budget.estimatedInputTokens)
      candidateSizes.add(result.budget.estimatedInputTokens)
    }
    return result
  }
  model.complete = async (...args) => {
    sent = true; lastBudget = args[6].budget
    if (live && sameScope) {
      const stored = data.models.find(m => m.id === args[0].id)
      const secret = electron.safeStorage.decryptString(Buffer.from(stored.cipher, 'base64'))
      const start = Date.now()
      liveResult = { status: 'running', toolsDispatched: 0 }
      const save = () => fs.writeFileSync(path.join(output, 'live-probe.json'), JSON.stringify(liveResult, null, 2))
      save()
      try {
        const reply = await previousComplete({ ...args[0], apiKey: secret, onRequest: undefined, traffic: undefined,
          onResponse: update => { if (update.httpStatus) liveResult.httpStatus = update.httpStatus } },
          args[1], args[2], args[3], AbortSignal.timeout(240000), () => {}, args[6])
        assert(reply.usage?.inputTokens > 0)
        Object.assign(liveResult, { status: 'passed', elapsedMs: Date.now() - start, usage: reply.usage,
          returnedTools: reply.calls.map(c => c.name), inputBudget: lastBudget })
      } catch (e) {
        Object.assign(liveResult, { status: 'failed', elapsedMs: Date.now() - start, error: String(e.message).split(secret).join('[redacted]') })
      } finally { save() }
    }
    throw stop
  }
  let error
  try { await service.agentLoop(p, f, agent, f.feedback, AbortSignal.timeout(30000), { resume: c }) }
  catch (e) { if (e !== stop) error = e.message }
  finally { model.prepareModelRequest = previousPrepare; model.complete = previousComplete }
  assert.equal(service.sourceFingerprint(p), before)
  const result = { sameScope, ready: sent, error, initial, smallestCandidate: smallest,
    candidateSizes: [...candidateSizes].sort((a,b) => a-b).slice(0,12), finalBudget: lastBudget, liveResult, compactions: f.contextRuntime.compactions.slice(-1) }
  results.push(result)
  console.log(JSON.stringify(result))
}
async function main() {
  if (electron) await electron.app.whenReady()
  await replay(true); await replay(false)
  assert.equal(hash(fs.readFileSync(source)), hash(original), 'Original state unchanged')
  fs.writeFileSync(path.join(output, 'project-replay-' + (live ? 'live' : process.argv.includes('--expect-fixed') ? 'after' : 'before') + '.json'), JSON.stringify(results, null, 2))
  if (process.argv.includes('--expect-fixed')) assert(results.every(r => r.ready), 'Both same-session and restarted histories must reach the provider boundary')
  if (live) assert.equal(results[0].liveResult?.status, 'passed', 'Real request completed without tool dispatch')
}
main().catch(e => { console.error(e.message); process.exitCode = 1 }).finally(() => {
  fs.rmSync(sandbox, { recursive: true, force: true }); if (electron) electron.app.exit(process.exitCode ?? 0)
})
}
