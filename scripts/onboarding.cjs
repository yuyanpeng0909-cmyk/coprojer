const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(exports, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return exports
}
async function main() {
  const { ModelCheckRegistry } = load('src/main/engineering/model-checks.ts')
  const { onboardingProgress } = load('src/renderer/src/engineering/onboarding-progress.ts')
  const { defaultAgents } = load('src/shared/agents.ts')
  const { requirementsFingerprint } = load('src/shared/engineering.ts')
  const connection = { id: '', model: 'fixture-model', protocol: 'chat', baseUrl: 'http://localhost/v1', apiKey: 'fixture-secret' }
  let failSave = false, saves = 0
  const store = { data: { models: [] }, save() { if (failSave) throw Error('disk failure'); saves++ } }
  const registry = new ModelCheckRegistry(store, input => ({ ...input, apiKey: input.apiKey || 'fixture-secret' }))
  await registry.run(connection, 'capabilities', async () => 'passed')
  const checks = registry.forSave(connection)
  assert.equal(checks.connection.status, 'passed'); assert.equal(checks.capabilities.status, 'passed')
  assert.ok(!JSON.stringify(checks).includes(connection.apiKey))
  const saved = { ...connection, id: 'm', checks }; store.data.models.push(saved)
  assert.deepEqual(registry.forSave(saved), checks)
  assert.equal(registry.forSave({ ...saved, apiKey: 'changed-key' }), undefined)
  assert.equal(registry.forSave({ ...saved, model: 'changed-model' }), undefined)
  assert.equal(registry.forSave({ ...saved, baseUrl: 'http://localhost/other' }), undefined)
  const restarted = new ModelCheckRegistry(store, input => ({ ...input }))
  assert.deepEqual(restarted.forSave(saved), checks, 'saved checks survive process restart')
  const unreadable = new ModelCheckRegistry(store, () => { throw Error('old key cannot decrypt') })
  assert.equal(unreadable.forSave({ ...saved, apiKey: 'replacement-key' }), undefined, 'unreadable old key must not prevent saving a replacement')
  let release
  const stale = registry.run({ ...saved }, 'connection', () => new Promise(resolve => { release = resolve }))
  saved.apiKey = 'different-key'; saved.checks = undefined
  release('old reply'); await stale
  assert.equal(saved.checks, undefined, 'late response must not validate edited key')
  saved.apiKey = connection.apiKey
  await registry.run(saved, 'capabilities', async () => 'passed')
  await assert.rejects(registry.run(saved, 'connection', async () => { throw Error('offline') }), /offline/)
  assert.equal(saved.checks.connection.status, 'failed'); assert.equal(saved.checks.capabilities, undefined)
  await registry.run(saved, 'capabilities', async () => 'passed')
  const before = structuredClone(saved.checks); failSave = true
  await assert.rejects(registry.run(saved, 'connection', async () => 'passed'), /disk failure/)
  assert.deepEqual(saved.checks, before); failSave = false
  let late
  const first = registry.run(saved, 'connection', () => new Promise(resolve => { late = resolve }))
  await assert.rejects(registry.run(saved, 'connection', async () => { throw Error('newer failed') }), /newer failed/)
  late('old success'); await first
  assert.equal(saved.checks.connection.status, 'failed', 'newer test result wins')
  await registry.run(saved, 'capabilities', async () => 'passed')
  const state = { models: [saved], agents: defaultAgents('m'), projects: [], defaultAssistantModelId: 'm' }
  assert.equal(onboardingProgress(state).completed, 3)
  const feature = { id: 'f', title: '真实功能', module: '核心', scope: 'current', stage: 'acceptance', criteria: ['实际结果正确'], results: [{ criterion: '实际结果正确', passed: true, evidence: '实际命令记录' }], plan: '实现方案', tasks: [{ id: 'task', title: '开发', done: true }], developerId: 'developer', reviewerId: 'reviewer', dependencies: [] }
  const project = { id: 'p', name: '我的项目', brief: '真实目标', features: [feature], chat: [], events: [], targets: [], prototypes: [{ id: 'prototype' }], prototypeBriefs: { '': { status: 'accepted', acceptedAt: '2026-09-28', prototypeId: 'prototype' } }, requirementsBaseline: { fingerprint: 'baseline' }, prd: { status: 'confirmed' } }
  state.projects.push(project); state.onboarding = { version: 1, projectId: 'p', featureId: 'f' }
  project.requirementsBaseline = { fingerprint: requirementsFingerprint(project), messageCount: 0 }
  let progress = onboardingProgress(state)
  assert.equal(progress.steps.find(s => s.id === 'verification').done, true)
  assert.equal(progress.complete, false, 'verification is not human acceptance')
  feature.stage = 'done'; assert.equal(onboardingProgress(state).complete, true)
  project.brief += '变更'; assert.equal(onboardingProgress(state).steps.find(s => s.id === 'specification').done, false); project.brief = '真实目标'
  feature.results[0].status = 'unverified'; assert.equal(onboardingProgress(state).complete, false)
  feature.results[0].status = 'passed'; feature.verificationPending = true; assert.equal(onboardingProgress(state).complete, false)
  feature.verificationPending = false; project.prd.status = 'stale'; assert.equal(onboardingProgress(state).steps.find(s => s.id === 'specification').done, false)
  project.prd.status = 'confirmed'; feature.scope = 'later'; assert.equal(onboardingProgress(state).feature, undefined)
  feature.scope = 'current'; state.onboarding.featureId = 'deleted'; assert.equal(onboardingProgress(state).feature, undefined)
  state.onboarding.featureId = 'f'; project.archivedAt = '2026-09-28'; assert.equal(onboardingProgress(state).project, undefined)
  project.archivedAt = undefined; saved.checks = undefined; assert.equal(onboardingProgress(state).steps.find(s => s.id === 'team').done, false)
  state.projects.push({ ...project, id: 'another', features: [{ ...feature, id: 'other-feature', stage: 'done' }] })
  state.onboarding.projectId = 'missing'; assert.equal(onboardingProgress(state).complete, false)
  console.log('Onboarding checks passed: persistent receipts, credential invalidation, stale replies, save rollback, project isolation and human acceptance. Saves: ' + saves)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
