const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
// Real service, persistence and commands; isolated model and Electron host.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-verification-'))
let profile, serial = 0
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
function fixture() {
  profile = path.join(sandbox, 'profile-' + ++serial)
  const root = path.join(sandbox, 'project-' + serial)
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(root, 'value.cjs'), 'exports.sum = (a, b) => a + b')
  fs.writeFileSync(path.join(root, 'tests/behavior.cjs'), "require('node:assert/strict').equal(require('../value.cjs').sum(2, 3), 5)")
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'verification-fixture', scripts: { test: 'node tests/behavior.cjs' } }))
  const service = new EngineeringService()
  service.store.data.models.push({ id: 'fixture', name: 'Fixture', protocol: 'chat', baseUrl: 'http://localhost:1', model: 'fixture', cipher: '' })
  for (const agent of service.store.data.agents) agent.modelId = 'fixture'
  const feature = { id: 'f', title: '验证证据回归', description: '区分失败和缺少环境', module: '核心', scope: 'current', stage: 'ready', criteria: ['相加正确', 'macOS 托盘实测'], plan: '运行检查并报告缺口', tasks: [{ id: 't', title: '实现并验证', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '' }
  const project = { id: 'p', name: '验证证据', root, brief: '隔离回归', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null, executionPlan: { id: 'plan', featureIds: ['f'], orderedFeatureIds: ['f'], currentIndex: 0, status: 'running', rationale: 'fixture', at: new Date().toISOString() } }
  service.store.data.projects.push(project); service.store.save()
  return { service, project, feature }
}
function provider(options = {}) {
  const seen = { developers: 0, tests: 0, verified: false }
  model.complete = async (_connection, system, messages) => {
    if (system.includes('VERIFICATION_DIAGNOSIS')) return { text: JSON.stringify({ gaps: [{ criterion: 'macOS 托盘实测', disposition: 'external', reason: '本回归运行在当前主机，无目标 macOS 设备。', nextStep: '提供对应源码版本的 macOS 实机记录。' }] }), calls: [] }
    if (system.includes('你是 Coprojer 的开发智能体')) { seen.developers++; return { text: '实现已完成', calls: [] } }
    if (!options.noTest && !messages.some(message => message.role === 'tool')) {
      seen.tests++
      return { text: '', calls: [{ id: 'check-' + seen.tests, name: 'run_command', arguments: JSON.stringify({ program: 'node', args: ['tests/behavior.cjs'] }) }] }
    }
    if (options.changeSource) fs.appendFileSync(options.changeSource, '\n// unexpected reviewer change')
    return { text: JSON.stringify({ summary: '自动检查完成，平台证据单独报告', results: [
      { criterion: '相加正确', passed: true, evidence: '实际运行 tests/behavior.cjs' },
      { criterion: 'macOS 托盘实测', passed: seen.verified || !!options.contradictory, status: seen.verified ? 'passed' : options.failed ? 'failed' : 'unverified', evidence: seen.verified ? '隔离测试中的已验证回复' : options.failed ? '已复现菜单调用错误' : '缺少 macOS，需要 macOS 实机托盘检查记录' },
    ] }), calls: [] }
  }
  return seen
}
async function run(service, reviewOnly = false) {
  service.runFeature('p', 'f', reviewOnly)
  const end = Date.now() + 15000
  while (service.store.project('p').activity) {
    if (Date.now() > end) throw Error('execution did not settle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function main() {
  let { service, project, feature } = fixture()
  const pending = provider()
  await run(service)
  assert.equal(pending.developers, 1, 'missing platform evidence must not trigger repeated development')
  assert.equal(feature.stage, 'blocked'); assert.equal(feature.verificationPending, true)
  assert.equal(feature.repairRound, 0); assert.equal(feature.tasks[0].done, false)
  assert.equal(feature.results[0].passed, true); assert.equal(feature.results[1].status, 'unverified')
  assert.equal(project.executionPlan.status, 'stopped'); assert.equal(project.executionPlan.currentIndex, 0)
  assert.ok(!project.events.some(event => event.kind === 'repair'))
  assert.match(feature.feedback, /macOS/); assert.throws(() => service.accept('p', 'f'), /尚未通过独立验证/)
  service = new EngineeringService()
  await run(service)
  assert.equal(pending.developers, 1, 'restart resumes review without repeating development')
  assert.equal(pending.tests, 2, 'fresh review reruns real checks')
  pending.verified = true
  await run(service)
  feature = service.store.project('p').features[0]
  assert.equal(feature.stage, 'acceptance'); assert.equal(feature.verificationPending, false)
  assert.equal(pending.developers, 1); assert.equal(feature.repairRound, 0)
  console.log('PASS: evidence gaps pause once, preserve results and tasks, survive restart and resume review')
  ;({ service, project, feature } = fixture())
  feature.stage = 'blocked'; feature.repairRound = 3
  feature.results = [{ criterion: 'macOS 托盘实测', passed: false, evidence: '旧记录缺少实机证据' }]
  const legacy = provider()
  await run(service, true)
  assert.equal(legacy.developers, 0)
  assert.equal(feature.verificationPending, true); assert.equal(feature.repairRound, 3)
  assert.throws(() => service.accept('p', 'f'), /尚未通过独立验证/)
  console.log('PASS: old paused tasks can explicitly recheck without redevelopment or bypassing acceptance')
  for (const kind of ['failed', 'command', 'noTest', 'changeSource', 'contradictory']) {
    ;({ service, project, feature } = fixture())
    if (kind === 'command') fs.writeFileSync(path.join(project.root, 'value.cjs'), 'exports.sum = (a, b) => a - b')
    const seen = provider({ failed: kind === 'failed', noTest: kind === 'noTest', contradictory: kind === 'contradictory', changeSource: kind === 'changeSource' ? path.join(project.root, 'value.cjs') : undefined })
    await run(service)
    if (['noTest', 'changeSource', 'contradictory'].includes(kind)) {
      assert.equal(feature.stage, 'blocked', kind); assert.equal(feature.verificationPending, true, kind)
      assert.equal(feature.repairRound, 0, kind); assert.equal(seen.developers, 1, kind)
      assert.ok(feature.results.some(result => result.status === 'unverified'), kind)
      continue
    }
    assert.equal(feature.stage, 'blocked', kind); assert.notEqual(feature.verificationPending, true, kind)
    assert.equal(feature.repairRound, 3, kind); assert.equal(seen.developers, 4, kind)
    assert.ok(feature.results.some(result => !result.passed && result.status !== 'unverified'), kind)
  }
  console.log('PASS: real failures still repair; missing tests, changed source and contradictory claims stay unverified and cannot bypass gates')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true }))
