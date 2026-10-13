// Read the current saved checkpoint. Run only the next model request in a
// fixture profile; never dispatch returned tools or modify the real project.
const live = process.argv.includes('--live')
if (live && !process.argv.includes('--authorized')) throw new Error('--live requires --authorized')
if (live && !process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
const { fs, path, assert, fixture, model, sandbox } = require('./fixtures/verification-runtime.cjs')
const { createHash } = require('node:crypto')
const hash = value => createHash('sha256').update(value).digest('hex')
const source = path.join(process.env.APPDATA, 'Coprojer-dev', 'engineering-v1.json')
const original = fs.readFileSync(source), data = JSON.parse(original)
const project = data.projects.find(p => p.id === 'd0e2b872-82e4-4ebb-ad67-1993dc23ee5e')
const feature = project.features.find(f => f.id === 'a05dcf1a-0af0-495f-81b1-065a9b6b8b75')
const key = JSON.stringify([project.id, feature.id]), checkpoint = data.executionCheckpoints[key]
const output = path.resolve('.runtime/execution-network-resume'); fs.mkdirSync(output, { recursive: true })
const electron = live ? require('electron') : undefined
if (electron) {
  const profile = path.join(sandbox, 'live-profile'); fs.mkdirSync(profile)
  electron.app.setPath('userData', profile)
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: JSON.parse(fs.readFileSync(path.join(path.dirname(source), 'Local State'), 'utf8')).os_crypt }))
}
async function main() {
  if (electron) await electron.app.whenReady()
  const { service } = fixture(); service.store.data = structuredClone(data); service.store.key = () => ''
  const p = service.store.project(project.id), f = p.features.find(f => f.id === feature.id)
  const before = service.sourceFingerprint(p), actualComplete = model.complete, stop = new Error('PROBE_COMPLETE')
  const eventsBefore = p.events.length
  const result = { live, toolsDispatched: 0, savedSteps: checkpoint.steps, lastSequence: checkpoint.lastSequence, attempts: [] }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('PROBE_TIMEOUT')), 120000)
  model.complete = async (...args) => {
    result.requestReady = true
    result.inputBudget = args[6].budget
    result.historyMessages = args[2].length
    const attempt = { hash: args[6].hash }; result.attempts.push(attempt)
    if (!live) throw stop
    const stored = data.models.find(m => m.id === args[0].id)
    const secret = electron.safeStorage.decryptString(Buffer.from(stored.cipher, 'base64'))
    const started = Date.now()
    try {
      const reply = await actualComplete({ ...args[0], apiKey: secret, traffic: undefined,
        onResponse(update) { if (update.httpStatus) attempt.httpStatus = update.httpStatus; args[0].onResponse?.(update) } },
        args[1], args[2], args[3], args[4], () => {}, args[6])
      attempt.elapsedMs = Date.now() - started; attempt.usage = reply.usage
      result.returnedTools = reply.calls.map(call => call.name)
      result.status = 'passed'
    } catch (error) {
      attempt.elapsedMs = Date.now() - started
      attempt.error = String(error.message).split(secret).join('[redacted]')
      throw error
    }
    throw stop
  }
  try {
    const agent = service.store.data.agents.find(a => a.id === f.developerId)
    await service.agentLoop(p, f, agent, f.feedback, controller.signal, { resume: structuredClone(checkpoint) })
  } catch (error) {
    if (error !== stop) { result.status = 'failed'; result.error = service.store.redact(String(error.message)) }
  } finally { clearTimeout(timer); model.complete = actualComplete }
  result.events = p.events.slice(eventsBefore).filter(e => ['model', 'model-retry', 'model-retry-exhausted'].includes(e.kind)).map(e => ({ kind: e.kind, message: e.message }))
  result.sourceUnchanged = service.sourceFingerprint(p) === before
  result.stateUnchanged = hash(fs.readFileSync(source)) === hash(original)
  fs.writeFileSync(path.join(output, live ? 'project-live-probe.json' : 'project-offline-probe.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  assert(result.requestReady); assert(result.sourceUnchanged); assert(result.stateUnchanged)
  assert(result.events[0].message.includes('接续第 ' + (checkpoint.steps + 1) + ' 步'))
  if (live) assert.equal(result.status, 'passed')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => {
  fs.rmSync(sandbox, { recursive: true, force: true }); if (electron) electron.app.exit(process.exitCode ?? 0)
})
}
