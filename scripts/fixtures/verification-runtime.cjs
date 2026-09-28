const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const ts = require('typescript')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-preparation-'))
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
function fixture(options = {}) {
  profile = path.join(sandbox, 'profile-' + ++serial)
  const root = path.join(sandbox, 'project-' + serial)
  fs.mkdirSync(path.join(root, 'tests/fixtures/helper'), { recursive: true })
  fs.writeFileSync(path.join(root, 'value.cjs'), options.defect ? 'exports.sum = (a,b) => a-b' : 'exports.sum = (a,b) => a+b')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-verification-fixture', version: '1.0.0', private: true, scripts: {} }))
  fs.writeFileSync(path.join(root, 'tests/fixtures/helper/package.json'), JSON.stringify({ name: 'local-test-helper', version: '1.0.0', main: 'index.cjs' }))
  fs.writeFileSync(path.join(root, 'tests/fixtures/helper/index.cjs'), "exports.check = value => require('node:assert/strict').equal(value, 5)")
  const service = new EngineeringService()
  service.store.data.models.push({ id: 'fixture', name: 'Fixture', protocol: 'chat', baseUrl: 'http://localhost:1', model: 'fixture', cipher: '' })
  for (const a of service.store.data.agents) a.modelId = 'fixture'
  const feature = { id: 'f', title: '补齐验证条件', description: '只用本机短时检查', module: '核心', scope: 'current', stage: 'ready',
    criteria: options.criteria || ['计算行为正确'], plan: '检查实际相加行为', tasks: [{ id: 't', title: '实现并检查', done: false }], dependencies: [],
    developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '' }
  const project = { id: 'p', name: '验证准备隔离项目', root, brief: '验证条件可自动补齐', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null,
    executionPlan: { id: 'plan', featureIds: ['f'], orderedFeatureIds: ['f'], currentIndex: 0, status: 'running', rationale: 'isolated fixture', at: new Date().toISOString() } }
  service.store.data.projects.push(project); service.store.save()
  return { service, project, feature, profile, root }
}
function testScript(dependency = false) {
  return "const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');" +
    "const value=require('../value.cjs').sum(2,3);" + (dependency ? "require('local-test-helper').check(value);" : 'assert.equal(value,5);') +
    "assert.ok(process.env.COPROJER_TEST_USER_DATA);assert.ok(process.env.COPROJER_EVIDENCE_DIR);" +
    "fs.mkdirSync(process.env.COPROJER_EVIDENCE_DIR,{recursive:true});" +
    "fs.writeFileSync(path.join(process.env.COPROJER_EVIDENCE_DIR,'result.json'),JSON.stringify({kind:'unit',value,pid:process.pid,at:new Date().toISOString()}));" +
    "console.log('ACTUAL_ASSERTION_PASSED value='+value);"
}
const answer = value => ({ text: JSON.stringify(value), calls: [] })
const call = (name, args) => ({ text: '', calls: [{ id: 'call-' + Math.random(), name, arguments: JSON.stringify(args) }] })
async function run(service, reviewOnly = false) {
  service.runFeature('p', 'f', reviewOnly)
  const deadline = Date.now() + 90000
  while (service.store.project('p').activity && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  const unfinished = service.store.project('p').activity
  if (unfinished) {
    service.stop('p')
    const cleanupDeadline = Date.now() + 15000
    while (service.store.project('p').activity && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(unfinished, null, 'service settles within bounded time')
}
module.exports = { fs, path, assert, sandbox, load, model, EngineeringService, fixture, testScript, answer, call, run }
