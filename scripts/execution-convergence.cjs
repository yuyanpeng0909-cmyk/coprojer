const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-convergence-'))
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
const { assertCompleteToolRounds } = load('src/main/engineering/context.ts')
function fixture() {
  profile = path.join(sandbox, 'profile-' + ++serial)
  const root = path.join(sandbox, 'project-' + serial)
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tests/behavior.cjs'), "require('node:assert/strict').equal(2 + 3, 5); console.log('behavior verified')")
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, 'context-' + i + '.txt'), 'Distinct project information ' + i)
  const service = new EngineeringService()
  service.store.data.models.push({ id: 'fixture', name: 'Fixture', protocol: 'chat', baseUrl: 'http://localhost:1', model: 'fixture', cipher: '' })
  for (const agent of service.store.data.agents) agent.modelId = 'fixture'
  const feature = { id: 'f', title: '计算功能', description: '真实行为检查', module: '核心', scope: 'current', stage: 'ready', criteria: ['相加正确'], plan: '运行行为测试', tasks: [{ id: 't', title: '实现并验证', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '' }
  const project = { id: 'p', name: '收敛回归', root, brief: '隔离回归', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
  service.store.data.projects.push(project); service.store.save()
  return { service, project, feature }
}
const call = (name, args, id) => ({ text: '', calls: [{ id: String(id), name, arguments: JSON.stringify(args) }] })
const complete = { text: JSON.stringify({ status: 'complete', summary: '实现与自测已完成。', nextStep: '交独立验证。' }), calls: [] }
const incomplete = { text: JSON.stringify({ status: 'incomplete', summary: '工具链已搭建，但原生交互仍未完成。', nextStep: '修复图标定位并重跑。' }), calls: [] }
function review(messages) {
  if (!messages.some(m => m.role === 'tool')) return call('run_command', { program: 'node', args: ['tests/behavior.cjs'] }, 'review-test')
  return { text: JSON.stringify({ summary: '实际检查通过', results: [{ criterion: '相加正确', passed: true, evidence: 'tests/behavior.cjs 断言通过', commandIds: ['check-1'] }] }), calls: [] }
}
async function run(service) {
  service.runFeature('p', 'f')
  const until = Date.now() + 18000
  while (service.store.project('p').activity && Date.now() < until) await new Promise(r => setTimeout(r, 5))
  assert.equal(service.store.project('p').activity, null, 'execution must settle')
}
const saved = service => service.store.data.executionCheckpoints?.['["p","f"]']
function paused(ctx) {
  assert.equal(ctx.feature.stage, 'blocked')
  assert.equal(ctx.feature.repairRound, 0)
  assert.ok(!ctx.project.events.some(e => e.kind === 'verification'), 'incomplete work must not start verification')
  assert.equal(saved(ctx.service)?.role, 'developer')
  assertCompleteToolRounds(saved(ctx.service).messages)
}
const cases = []
cases.push(['budget summary cannot submit incomplete development; resume keeps progress', async () => {
  let ctx = fixture(), requests = 0, resume = false, resumedHistory
  model.complete = async (connection, system, messages, tools) => {
    if (!system.includes('开发智能体')) return review(messages)
    if (resume) { resumedHistory = structuredClone(messages); return complete }
    if (!tools.length) return { text: '本轮只完成了验证工具链，仍需修复图标定位；下次继续。', calls: [] }
    return call('read_file', { path: 'context-' + requests++ + '.txt' }, requests)
  }
  await run(ctx.service); paused(ctx)
  assert.equal(requests, 36)
  assert.ok(saved(ctx.service).messages.some(m => m.content.includes('仍需修复图标定位')), 'handoff summary must survive')
  resume = true
  const service = new EngineeringService(); await run(service)
  assert.equal(service.store.project('p').features[0].stage, 'acceptance')
  assert.ok(resumedHistory.some(m => m.content.includes('仍需修复图标定位')))
}])
cases.push(['explicit incomplete development pauses before budget exhaustion', async () => {
  const ctx = fixture()
  model.complete = async (connection, system, messages) => system.includes('开发智能体') ? incomplete : review(messages)
  await run(ctx.service); paused(ctx)
  assert.ok(ctx.project.events.some(e => e.kind === 'stopped' && /未完成/.test(e.message)))
}])
cases.push(['explicit incomplete status cannot become completion when report fields are missing', async () => {
  const ctx = fixture()
  model.complete = async (connection, system, messages) => system.includes('开发智能体')
    ? { text: JSON.stringify({ status: 'incomplete', summary: '仍需修改，尚未完成。' }), calls: [] } : review(messages)
  await run(ctx.service); paused(ctx)
  assert.ok(saved(ctx.service).messages.some(m => m.content.includes('尚未完成')))
}])
cases.push(['repeated read cycle pauses with a complete native tool round', async () => {
  const ctx = fixture(); let calls = 0
  model.complete = async (connection, system, messages, tools) => {
    if (!system.includes('开发智能体')) return review(messages)
    if (!tools.length) return incomplete
    const reply = call('read_file', { path: 'context-' + calls++ % 2 + '.txt' }, calls)
    reply.reasoning = 'reasoning-marker'; reply.anthropicBlocks = [{ type: 'thinking', thinking: 'work', signature: 'native-signature' }]
    return reply
  }
  await run(ctx.service); paused(ctx)
  assert.ok(calls <= 10, 'an unchanged read cycle must stop before spending 36 steps')
  assert.ok(ctx.project.events.some(e => e.kind === 'stopped' && /无进展|重复/.test(e.message)))
  assert.ok(saved(ctx.service).messages.some(m => m.anthropicBlocks?.[0]?.signature === 'native-signature'))
}])
cases.push(['three identical failed commands pause; completed commands are preserved', async () => {
  const ctx = fixture(); let calls = 0
  model.complete = async (connection, system, messages, tools) => {
    if (!system.includes('开发智能体')) return review(messages)
    if (!tools.length) return incomplete
    return call('run_command', { program: 'node', args: ['missing-script.cjs'] }, ++calls)
  }
  await run(ctx.service); paused(ctx)
  assert.equal(calls, 3)
  assert.equal(saved(ctx.service).commands.length, 3)
  assert.ok(saved(ctx.service).commands.every(c => c.code !== 0))
}])
cases.push(['novel reads and real writes prevent false no-progress pauses', async () => {
  const ctx = fixture(); let n = 0
  model.complete = async (connection, system, messages) => {
    if (!system.includes('开发智能体')) return review(messages)
    if (n === 15) return complete
    const i = n++
    return i % 3 === 0 ? call('write_file', { path: 'progress.txt', content: 'Actual progress ' + i }, i)
      : call('read_file', { path: 'context-0.txt' }, i)
  }
  await run(ctx.service)
  assert.equal(ctx.feature.stage, 'acceptance')
  assert.equal(ctx.project.events.filter(e => e.kind === 'tool' && e.message.startsWith('write_file')).length, 5)
}])
cases.push(['a changed read version is new evidence', async () => {
  const ctx = fixture(); let n = 0
  model.complete = async (connection, system, messages) => {
    if (!system.includes('开发智能体')) return review(messages)
    if (n === 9) return complete
    fs.writeFileSync(path.join(ctx.project.root, 'context-0.txt'), 'External version ' + n)
    return call('read_file', { path: 'context-0.txt' }, ++n)
  }
  await run(ctx.service); assert.equal(ctx.feature.stage, 'acceptance')
}])
cases.push(['explicit complete budget report can proceed to real verification', async () => {
  const ctx = fixture(); let n = 0
  model.complete = async (connection, system, messages, tools) => {
    if (!system.includes('开发智能体')) return review(messages)
    return tools.length ? call('read_file', { path: 'context-' + n++ + '.txt' }, n) : complete
  }
  await run(ctx.service); assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(n, 36)
}])
cases.push(['no-progress counters survive restart without replaying earlier commands', async () => {
  let ctx = fixture(), n = 0, interrupted = false
  model.complete = async (connection, system, messages) => {
    if (!system.includes('开发智能体')) return review(messages)
    if (++n === 3 && !interrupted) { interrupted = true; throw new Error('simulated connection interruption') }
    return call('run_command', { program: 'node', args: ['missing-script.cjs'] }, n)
  }
  await run(ctx.service); paused(ctx)
  assert.equal(saved(ctx.service).commands.length, 2)
  const service = new EngineeringService(); await run(service)
  ctx = { service, project: service.store.project('p'), feature: service.store.project('p').features[0] }
  paused(ctx)
  assert.equal(n, 4, 'resume executes only the new request before pausing the third repeated failure')
  assert.equal(saved(service).commands.length, 3)
}])
cases.push(['multi-call batches remain balanced when no-progress pauses execution', async () => {
  const ctx = fixture()
  model.complete = async (connection, system, messages, tools) => {
    if (!system.includes('开发智能体')) return review(messages)
    if (!tools.length) return incomplete
    return { text: '', calls: Array.from({ length: 8 }, (_, i) => call('read_file', { path: 'context-0.txt' }, 'batch-' + i).calls[0]) }
  }
  await run(ctx.service); paused(ctx)
  assert.equal(saved(ctx.service).messages.filter(m => m.role === 'tool').length, 8)
  assert.equal(ctx.project.events.filter(e => e.kind === 'model').length, 1)
}])
async function main() {
  let failed = 0
  for (const [name, test] of cases) {
    try { await test(); console.log('PASS:', name) }
    catch (error) { failed++; console.error('FAIL:', name, '\n' + error.stack) }
  }
  console.log(JSON.stringify({ total: cases.length, failed }))
  if (failed) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true }))
