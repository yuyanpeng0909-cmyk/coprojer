// Read-only verification after an activation; never repeats a migration/request.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict'), ts = require('typescript'), { createHash } = require('node:crypto')
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.parse(JSON.stringify(value))
const without = (obj, keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !keys.includes(k)))
const equal = (a, b, label) => assert.equal(JSON.stringify(a), JSON.stringify(b), label)
const evidence = process.argv[2]
assert.ok(evidence, 'Pass the activation results.json path.')
const report = JSON.parse(fs.readFileSync(evidence, 'utf8'))
const profile = path.join(process.env.APPDATA, 'Coprojer-dev'), source = path.join(profile, 'engineering-v1.json')
const backup = path.join(profile, 'maintenance-backups', 'adaptive-' + path.basename(path.dirname(evidence)) + '.json')
const originalBytes = fs.readFileSync(backup), original = JSON.parse(originalBytes), currentBytes = fs.readFileSync(source), current = JSON.parse(currentBytes)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-adaptive-readback-')), cache = new Map()
function load(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file)
  const api = {}; cache.set(file, api)
  new Function('exports', 'require', ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(api, name => name === 'electron'
    ? { app: { getPath: () => temp }, safeStorage: { isEncryptionAvailable: () => false, decryptString: () => '' } }
    : name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return api
}
const result = { status: 'running', checkedAt: new Date().toISOString(), activationEvidence: path.resolve(evidence) }
try {
  const { projectId, featureId } = report, key = JSON.stringify([projectId, featureId])
  assert.equal(hash(originalBytes), report.before.stateHash)
  assert.equal(report.liveVerification.status, 'passed'); assert.equal(report.liveVerification.httpStatus, 200)
  const oldP = original.projects.find(p => p.id === projectId), p = current.projects.find(p => p.id === projectId)
  const oldF = oldP.features.find(f => f.id === featureId), f = p.features.find(f => f.id === featureId)
  const oldCheckpoint = original.executionCheckpoints[key], checkpoint = current.executionCheckpoints[key]
  const modelId = report.migration.newConnectionId, model = current.models.find(m => m.id === modelId)
  assert.equal(current.models.length, original.models.length + 1)
  equal(current.models.slice(0, -1), original.models, 'existing models unchanged')
  equal(model.capabilities, report.migration.capabilities, 'capacity declaration retained')
  equal(current.agents, original.agents, 'agents unchanged')
  equal(current.projects.filter(p => p.id !== projectId), original.projects.filter(p => p.id !== projectId), 'other projects unchanged')
  equal(without(p, ['features']), without(oldP, ['features']), 'other project fields unchanged')
  equal(p.features.filter(f => f.id !== featureId), oldP.features.filter(f => f.id !== featureId), 'other features unchanged')
  const allowed = ['contextPolicy', 'executionModels', 'runtimeHandoff', 'runtimeHandoffs', 'contextRuntime']
  equal(without(f, allowed), without(oldF, allowed), 'business state and budget unchanged')
  equal(f.contextPolicy, report.migration.featurePolicy, 'adaptive scope saved')
  assert.equal(f.executionModels.developer, modelId)
  equal(current.receiptJournals, original.receiptJournals, 'receipts unchanged')
  equal(without(current.executionCheckpoints, [key]), without(original.executionCheckpoints, [key]), 'other checkpoints unchanged')
  equal(without(current, ['models', 'projects', 'executionCheckpoints', 'runtimeOriginals']), without(original, ['models', 'projects', 'executionCheckpoints', 'runtimeOriginals']), 'other global fields unchanged')
  equal(without(current.runtimeOriginals, [f.runtimeHandoff.originalId]), original.runtimeOriginals ?? {}, 'other originals unchanged')
  equal(current.runtimeOriginals[f.runtimeHandoff.originalId].checkpoint, oldCheckpoint, 'complete original checkpoint retained')
  equal(without(checkpoint, ['manifest', 'messages', 'fingerprint', 'continuity']), without(oldCheckpoint, ['manifest', 'messages', 'fingerprint', 'continuity']), 'cursor, progress, receipts and checkpoint fields preserved')
  equal(without(checkpoint.continuity, ['growth', 'calibration', 'nativeWindow']), without(oldCheckpoint.continuity, ['growth', 'calibration', 'nativeWindow']), 'continuation references preserved')
  assert.equal(checkpoint.continuity.nativeWindow, undefined)
  const { modelProfile } = load('src/main/engineering/model-profile.ts'), { portableHistory } = load('src/main/engineering/runtime-handoff.ts')
  equal(checkpoint.messages, canonical(portableHistory(oldCheckpoint.messages, modelProfile(model))), 'portable history exactly matches migration rules')
  fs.writeFileSync(path.join(temp, 'engineering-v1.json'), currentBytes)
  const { EngineeringService } = load('src/main/engineering/service.ts'), service = new EngineeringService()
  const reloadedP = service.store.project(projectId), reloadedF = reloadedP.features.find(f => f.id === featureId)
  assert.equal(service.executionFingerprint(reloadedP, reloadedF), checkpoint.fingerprint, 'checkpoint stays compatible after real store reload')
  assert.equal(service.sourceFingerprint(reloadedP), report.before.sourceFingerprint, 'source unchanged')
  const resolved = load('src/main/engineering/context-policy.ts').contextConnection({ ...model, apiKey: '' }, reloadedP.contextPolicy, reloadedF.contextPolicy)
  const budget = load('src/main/engineering/model.ts').prepareModelRequest(resolved, 'capacity readback', [{ role: 'user', content: 'read only' }], []).budget
  assert.equal(budget.adaptive, true); assert.equal(budget.contextWindowTokens, 256000); assert.equal(budget.inputLimit, 197632)
  assert.equal(hash(fs.readFileSync(source)), hash(currentBytes), 'verification made no live state writes')
  Object.assign(result, { status: 'passed', stateHash: hash(currentBytes), backup, newConnectionId: modelId,
    scope: 'existing feature developer continuation', adaptive: true, contextWindowTokens: budget.contextWindowTokens, inputLimit: budget.inputLimit,
    sourceUnchanged: true, otherProjectsUnchanged: true, existingConnectionsUnchanged: true, originalCheckpointPreserved: true,
    checkpointCompatibleAfterReload: true, usagePreserved: true, prototypeReadUntil: checkpoint.prototypeReadUntil, repeated: checkpoint.progress.repeated,
    liveRequest: report.liveVerification, toolsExecuted: 0, stage: reloadedF.stage })
} catch (error) {
  result.status = 'failed'; result.error = error.code === 'ERR_ASSERTION' && error.generatedMessage ? 'Assertion failed; values omitted.' : error.message
  process.exitCode = 1
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
  fs.writeFileSync(path.join(path.dirname(evidence), 'applied-verification.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}
