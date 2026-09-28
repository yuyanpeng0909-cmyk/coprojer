const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')

// Exercise the actual service, persisted store and file/command tools. Only the
// Electron host and model reply are replaced; no user's profile/model is used.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-budget-'))
let profile = path.join(sandbox, 'profile')
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file)
  const api = {}; cache.set(file, api)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(api, name => name === 'electron'
    ? { app: { getPath: () => profile }, safeStorage: { isEncryptionAvailable: () => false }, shell: {} }
    : name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return api
}
const model = load('src/main/engineering/model.ts')
const { EngineeringService } = load('src/main/engineering/service.ts')
const { listFiles } = load('src/main/engineering/files.ts')
let serial = 0
function fixture() {
  profile = path.join(sandbox, `profile-${++serial}`)
  const root = path.join(sandbox, `project-${serial}`)
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(root, 'value.cjs'), 'exports.sum = (a, b) => a + b')
  // Budget tests make distinct reads; repeated reads have a separate, earlier
  // no-progress pause covered by execution-convergence.cjs.
  for (let i = 1; i <= 40; i++) fs.writeFileSync(path.join(root, 'budget-context-' + i + '.txt'), 'Distinct context ' + i)
  fs.writeFileSync(path.join(root, 'tests/behavior.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('../value.cjs').sum(2, 3), 5); console.log('behavior verified')")
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-budget-fixture', scripts: { test: 'node tests/behavior.cjs' } }))
  const service = new EngineeringService()
  service.store.data.models.push({ id: 'fixture', name: 'Fixture', protocol: 'chat', baseUrl: 'http://localhost:1', model: 'fixture', cipher: '' })
  for (const a of service.store.data.agents) a.modelId = 'fixture'
  const feature = { id: 'f', title: '计算功能', description: '检查实际相加行为', module: '核心', scope: 'current', stage: 'ready', criteria: ['相加正确'], plan: '运行行为测试', tasks: [{ id: 't', title: '实现并验证', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '' }
  const project = { id: 'p', name: '预算回归', root, brief: '隔离回归', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
  service.store.data.projects.push(project)
  service.store.save()
  return { service, project, feature }
}
const result = () => ({ text: JSON.stringify({ summary: '实际检查完成', results: [{ criterion: '相加正确', passed: true, evidence: 'tests/behavior.cjs 的断言通过' }] }), calls: [] })
function freshReview(seen) {
  model.complete = async (connection, system, messages) => {
    if (system.includes('你是 Coprojer 的开发智能体')) { seen.developers++; return { text: '开发完成', calls: [] } }
    seen.reviewers.push(structuredClone(messages))
    if (messages.some(m => m.role === 'tool')) return result()
    return { text: '', calls: [{ id: 'fresh-test', name: 'run_command', arguments: JSON.stringify({ program: 'node', args: ['tests/behavior.cjs'] }) }] }
  }
}
function provider({ finishAtLimit = false, test = true } = {}) {
  const seen = { developers: 0, reviewers: [], finals: 0, finish: false }
  model.complete = async (connection, system, messages, tools) => {
    if (system.includes('VERIFICATION_DIAGNOSIS')) return { text: JSON.stringify({ gaps: [{ criterion: '相加正确', disposition: 'unknown', reason: '回归夹具没有准备能力。', nextStep: '补充实际检查。' }] }), calls: [] }
    if (system.includes('你是 Coprojer 的开发智能体')) { seen.developers++; return { text: '开发完成', calls: [] } }
    seen.reviewers.push(structuredClone(messages))
    if (seen.finish || finishAtLimit && !tools.length) return result()
    const n = seen.reviewers.length
    const call = { id: `call-${n}`, name: test && n === 1 ? 'run_command' : 'read_file', arguments: JSON.stringify(test && n === 1 ? { program: 'node', args: ['tests/behavior.cjs'] } : { path: 'budget-context-' + n + '.txt' }) }
    if (!tools.length) seen.finals++
    return { text: '', calls: [call], reasoning: 'reasoning-marker', responseItems: [{ type: 'reasoning', id: `r-${n}`, encrypted_content: 'opaque-marker' }], anthropicBlocks: [{ type: 'thinking', thinking: 'thinking-marker', signature: 'signature-marker' }] }
  }
  return seen
}
async function run(service) {
  service.runFeature('p', 'f')
  const deadline = Date.now() + 15000
  while (service.store.project('p').activity && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(service.store.project('p').activity, null, 'service must settle')
}
async function main() {
  let { service, project, feature } = fixture()
  const seen = provider()
  await run(service)
  assert.equal(feature.stage, 'blocked')
  console.log('REPRO: reviewer consumed 36 work steps; stage =', feature.stage)
  assert.ok(project.events.some(e => e.kind === 'stopped' && /36/.test(e.message)), 'budget exhaustion should pause with a resumable checkpoint')
  assert.equal(project.events.filter(e => e.kind === 'tool').length, 36, 'summary-only tool calls must never execute')
  assert.ok(Object.keys(service.store.data.executionCheckpoints || {}).length, 'review history and actual command evidence must persist')
  assert.equal('executionCheckpoints' in service.state(), false, 'internal history must not leak into renderer snapshots')
  seen.finish = true
  service = new EngineeringService()
  await run(service)
  feature = service.store.project('p').features[0]
  assert.equal(seen.developers, 1, 'resume/restart must not rerun development after review paused')
  assert.equal(feature.stage, 'acceptance', JSON.stringify(service.store.project('p').events.slice(-4)))
  const history = seen.reviewers.at(-1)
  assert.ok(history.some(m => m.role === 'tool' && m.content.includes('behavior verified')), 'completed test evidence must survive resume')
  assert.ok(history.some(m => m.anthropicBlocks?.[0]?.signature === 'signature-marker'), 'provider-specific history must survive resume')
  assert.equal(Object.keys(service.store.data.executionCheckpoints || {}).length, 0)
  assert.equal(seen.finals, 1, 'only one bounded summary-only request is allowed')
  console.log('PASS: budget pause, durable restart, exact reviewer continuation and actual evidence gate')

  ;({ service, project, feature } = fixture())
  const concluding = provider({ finishAtLimit: true })
  await run(service)
  assert.equal(feature.stage, 'acceptance')
  assert.equal(concluding.developers, 1)
  assert.equal(concluding.reviewers.length, 37)
  console.log('PASS: final summary can conclude at the boundary without more tool work')

  for (const change of ['source', 'contract', 'model']) {
    ;({ service, project, feature } = fixture())
    const stale = provider()
    await run(service)
    if (change === 'source') fs.appendFileSync(path.join(project.root, 'value.cjs'), '\n// changed by user')
    if (change === 'contract') feature.plan += '；补充检查'
    if (change === 'model') service.store.data.models[0].model = 'different-model'
    freshReview(stale)
    const before = stale.reviewers.length
    await run(service)
    assert.equal(stale.reviewers[before].length, 1, `${change}: stale history must not be reused`)
    assert.equal(stale.developers, 1, `${change}: recheck actual source without repeating development`)
    assert.equal(feature.stage, 'acceptance')
    assert.equal(project.events.filter(e => e.kind === 'tool' && e.message.includes('run_command')).length, 2)
  }
  console.log('PASS: source, contract and model changes discard old history and rerun real checks')

  ;({ service, project, feature } = fixture())
  const missingTest = provider({ test: false })
  await run(service)
  missingTest.finish = true
  await run(service)
  assert.equal(feature.stage, 'blocked', 'model claims cannot replace missing test evidence after resuming')
  assert.equal(feature.repairRound, 0)
  assert.equal(missingTest.developers, 1, 'missing evidence does not spend code repair budget')
  assert.equal(feature.verificationPending, true)
  assert.match(feature.results[0].evidence, /缺少实际执行/)
  console.log('PASS: resumed model claims cannot bypass actual tests or spend repair budget without a defect')

  ;({ service, project, feature } = fixture())
  fs.writeFileSync(path.join(project.root, 'value.cjs'), 'exports.sum = (a, b) => a - b')
  const failedTest = provider()
  await run(service)
  failedTest.finish = true
  await run(service)
  assert.equal(feature.stage, 'blocked')
  assert.ok(feature.verificationChecks.some(c => c.code !== 0), 'failed actual command must survive checkpoint')
  assert.ok(feature.results.some(r => r.status === 'failed'), 'restored failing evidence must remain a failure')
  assert.ok(project.events.some(e => e.kind === 'repair'), 'restored failures must route to the original repair loop')
  console.log('PASS: failed commands remain failures across checkpoint recovery')

  ;({ service, project, feature } = fixture())
  feature.stage = 'blocked'; feature.repairRound = 2
  project.events.push(...[
    ['start', '实现功能'], ['developer', '已提交实现'], ['verification', '开发已提交，开始独立验证。'],
    ['error', '达到本次执行的 36 步上限，现场已保留。可调整任务或继续执行。'],
  ].map(([kind, message], i) => ({ id: String(i), kind, message, featureId: feature.id, at: new Date().toISOString() })))
  const legacy = provider({ test: false })
  await run(service)
  assert.equal(legacy.developers, 0, 'legacy reviewer budget failure must restart review, not development')
  assert.equal(feature.repairRound, 2)
  legacy.finish = true
  await run(service)
  assert.equal(feature.stage, 'blocked')
  assert.equal(feature.repairRound, 2)
  assert.equal(legacy.developers, 0, 'legacy recovery preserves repair budget when only evidence is missing')
  console.log('PASS: existing 36-step failures recover directly into review without resetting repair rounds')

  ;({ service, project, feature } = fixture())
  let developerResume = false, developerCalls = 0
  let resumedDevelopmentHistory
  model.complete = async (connection, system, messages) => {
    if (system.includes('你是 Coprojer 的开发智能体')) {
      developerCalls++
      if (developerResume) { resumedDevelopmentHistory = messages; return { text: '继续完成开发', calls: [] } }
      return { text: '', calls: [{ id: `dev-${developerCalls}`, name: developerCalls === 1 ? 'write_file' : 'read_file', arguments: JSON.stringify(developerCalls === 1 ? { path: 'implemented.txt', content: 'write once' } : { path: 'value.cjs' }) }] }
    }
    if (messages.some(m => m.role === 'tool')) return result()
    return { text: '', calls: [{ id: 'dev-resume-test', name: 'run_command', arguments: JSON.stringify({ program: 'node', args: ['tests/behavior.cjs'] }) }] }
  }
  await run(service)
  assert.equal(feature.stage, 'blocked')
  developerResume = true
  service = new EngineeringService()
  await run(service)
  assert.equal(service.store.project('p').features[0].stage, 'acceptance')
  assert.ok(resumedDevelopmentHistory.some(m => m.role === 'tool' && m.content.includes('implemented.txt')))
  assert.equal(service.store.project('p').events.filter(e => e.kind === 'tool' && e.message.startsWith('write_file')).length, 1)
  console.log('PASS: developer checkpoint resumes without replaying completed writes')

  ;({ service, project, feature } = fixture())
  const interrupted = provider()
  const normalReply = model.complete
  model.complete = async (...args) => { if (!args[3].length) throw new Error('summary connection failed'); return normalReply(...args) }
  await run(service)
  assert.ok(project.events.some(e => e.kind === 'error' && e.message === 'summary connection failed'))
  assert.ok(Object.keys(service.store.data.executionCheckpoints).length)
  interrupted.finish = true; model.complete = normalReply
  await run(service)
  assert.equal(feature.stage, 'acceptance')
  assert.equal(interrupted.developers, 1)
  console.log('PASS: final-summary network failure is reported while completed progress stays recoverable')

  const runtime = path.join(project.root, '.runtime')
  fs.mkdirSync(runtime, { recursive: true })
  for (let i = 0; i < 650; i++) fs.writeFileSync(path.join(runtime, `${i}.json`), '{}')
  const discovered = listFiles(project.root)
  assert.ok(discovered.includes('value.cjs') && discovered.includes('tests/behavior.cjs'))
  assert.ok(!discovered.some(p => p.startsWith('.runtime/')))
  console.log('PASS: runtime cache does not consume the source discovery budget')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true }))
