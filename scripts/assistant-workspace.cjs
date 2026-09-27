const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-assistant-workspace-'))
const cache = new Map(), calls = []
let respond = async () => ({ text: '已根据当前状态给出建议。', calls: [], model: 'served-model' })
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file)
  if (file.endsWith(path.join('engineering', 'model.ts'))) return { complete: async (...args) => { calls.push(args); return respond(...args) }, parseJson: JSON.parse }
  const exports = {}; cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(exports, name => name === 'electron' ? { app: { getPath: () => root }, safeStorage: {} } : name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return exports
}
const { EngineeringStore } = load('src/main/engineering/store.ts')
const { GeneralAssistant } = load('src/main/engineering/general-assistant.ts')
const { AssistantTeam } = load('src/main/engineering/assistant-team.ts')
const makeProject = id => ({ id, name: id, root: path.join(root, id), brief: id + '-private-goal', createdAt: new Date().toISOString(), plannerId: 'planner', designerId: 'designer', discussionModelId: 'm1', activity: null, previewUrl: null, features: [{ id: id + '-feature', title: '实际功能', description: '当前范围', stage: 'requirements', scope: 'current', developerId: 'developer', reviewerId: 'reviewer', dependencies: [], criteria: ['可验证'], tasks: [], results: [], plan: '', revision: 1, repairRound: 0, feedback: '' }], context: [], events: [], chat: [], changes: [], prototypes: [], targets: [], agentRuns: [] })
async function main() {
  let store = new EngineeringStore()
  store.data.models = ['m1', 'm2'].map(id => ({ id, name: id, model: id, baseUrl: 'https://fixture.invalid/v1', protocol: 'chat', cipher: '' }))
  store.data.agents.forEach(a => { a.modelId = 'm1' })
  store.data.projects = [makeProject('project-a'), makeProject('project-b')]
  store.data.defaultAssistantModelId = 'm1'
  const legacy = [{ id: 'old-u', role: 'user', text: '旧记录', status: 'complete', at: '2026-09-01T00:00:00.000Z' }, { id: 'old-a', role: 'assistant', text: '完整保留', status: 'complete', at: '2026-09-01T00:00:01.000Z' }]
  delete store.data.assistant; store.data.assistantChat = legacy; store.save()
  store = new EngineeringStore()
  assert.equal(store.data.assistant.sessions.length, 1); assert.deepEqual(store.data.assistant.sessions[0].messages, legacy)
  assert.equal(new EngineeringStore().data.assistant.sessions.length, 1)
  const connection = id => ({ ...store.data.models.find(m => m.id === id), apiKey: 'secret-never-in-context' })
  const assistant = new GeneralAssistant(store, connection), team = new AssistantTeam(store, connection)
  const a = assistant.createAssistantSession('project-a'), b = assistant.createAssistantSession('project-b')
  assistant.updateAssistantSession(a.id, { title: '成本讨论', draft: '尚未发送', modelId: 'm2', scrollTop: 140, pinned: true })
  assistant.selectAssistantSession(a.id)
  let restored = new EngineeringStore().data.assistant
  assert.equal(restored.activeSessionId, a.id); assert.equal(restored.sessions.find(s => s.id === a.id).draft, '尚未发送'); assert.equal(restored.sessions.find(s => s.id === a.id).scrollTop, 140)
  assert.throws(() => assistant.updateAssistantSession(a.id, { projectId: 'project-b' }), /不能修改/)
  const globalMemory = assistant.saveAssistantMemory({ text: '成本优先' })
  assistant.saveAssistantMemory({ text: 'B的独有偏好', projectId: 'project-b', sourceSessionId: b.id })
  respond = async (_c, system) => { assert.ok(system.includes('project-a-private-goal')); assert.ok(!system.includes('project-b-private-goal')); assert.ok(!system.includes('B的独有偏好')); assert.ok(system.includes('成本优先')); assert.ok(!system.includes('secret-never')); return { text: '打开配置。' + String.fromCharCode(96).repeat(3) + 'coprojer-actions\n' + JSON.stringify([{ kind: 'navigate', destination: 'models', label: '打开模型' }, { kind: 'execute', command: 'bad', label: '运行' }, { kind: 'remember', text: '先确认再保存', label: '记住偏好' }]) + String.fromCharCode(96).repeat(3), calls: [] } }
  await assistant.sendAssistantMessage('怎么配置？', 'm2', a.id)
  let session = store.data.assistant.sessions.find(s => s.id === a.id)
  assert.equal(session.messages.at(-1).actions.length, 2); assert.equal(store.data.assistant.memories.length, 2); assert.equal(store.data.defaultAssistantModelId, 'm1'); assert.equal(session.draft, '')
  assistant.deleteAssistantMemory(globalMemory.id)
  respond = async (_c, system) => { assert.ok(!system.includes('成本优先')); return { text: '已不再使用删除的偏好。', calls: [] } }
  await assistant.sendAssistantMessage('继续', '', a.id)
  let started, signalReady = new Promise(r => { started = r })
  respond = async (_c, _s, _m, _t, signal, delta) => { delta({ kind: 'text', text: '部分内容' }); started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('停止')), { once: true })) }
  const pending = assistant.sendAssistantMessage('长回复', '', a.id); await signalReady
  assert.throws(() => assistant.deleteAssistantSession(a.id), /停止/); assert.throws(() => assistant.clearAssistantChat(a.id), /等待/)
  assistant.selectAssistantSession(b.id); assistant.stopAssistantMessage(a.id); await pending
  assert.equal(session.messages.at(-1).status, 'stopped'); assert.equal(session.messages.at(-1).text, '部分内容')
  respond = async (_c, _s, messages) => { const input = JSON.parse(messages[0].content); return { text: JSON.stringify({ members: input.agents.filter(a => !a.projectOwned).map((a, i) => ({ key: String(i), role: a.role, name: a.name, sourceAgentId: a.id, modelId: 'm2', reason: '按明确职责分工，型号能力资料不足，需验证。' })) }), calls: [], model: 'served-model' } }
  const baselineB = JSON.stringify(store.data.projects[1]), globalAgents = JSON.stringify(store.data.agents)
  const plan = await team.recommendAssistantTeam(a.id, '均衡配置')
  assert.equal(session.messages.at(-1).requestKind, 'team')
  assert.equal(JSON.stringify(store.data.agents), globalAgents)
  assert.throws(() => team.updateAssistantTeamPlan(plan.id, plan.members.map((m, i) => i ? m : { ...m, modelId: 'external-unconfigured' })), /已接入/)
  assert.throws(() => team.updateAssistantTeamPlan(plan.id, [...plan.members, { ...plan.members.find(m => m.role === 'planner'), key: 'extra-planner', sourceAgentId: undefined }]), /各保留一位/)
  store.data.defaultTeamAgentIds = ['planner']
  assert.throws(() => team.applyAssistantTeamPlan(plan.id), /变化/)
  store.data.defaultTeamAgentIds = undefined
  team.applyAssistantTeamPlan(plan.id)
  assert.equal(JSON.stringify(store.data.projects[1]), baselineB); assert.equal(JSON.stringify(store.data.agents.filter(a => !a.ownerProjectId)), globalAgents)
  assert.equal(store.data.projects[0].teamAgentIds.length, 4); assert.equal(store.data.projects[0].discussionModelId, 'm2')
  assert.ok(store.data.projects[0].teamAgentIds.every(id => store.data.agents.find(a => a.id === id).ownerProjectId === 'project-a'))
  assert.ok(store.data.agents.filter(a => a.ownerProjectId).every(a => a.skillIds.length === 0))
  const afterApply = JSON.stringify(store.data); team.applyAssistantTeamPlan(plan.id); assert.equal(JSON.stringify(store.data), afterApply)
  const rollbackPlan = await team.recommendAssistantTeam(b.id, '验证保存失败'), snapshot = JSON.stringify(store.data)
  const save = store.save.bind(store); store.save = () => { throw Error('disk full') }
  assert.throws(() => team.applyAssistantTeamPlan(rollbackPlan.id), /disk full/)
  assert.equal(JSON.stringify(store.data), snapshot, 'save failure must restore every affected field')
  store.save = save
  store.data.models[0].model = 'changed-model'
  assert.throws(() => team.applyAssistantTeamPlan(rollbackPlan.id), /变化/)
  store.data.models[0].model = 'm1'
  const globalSession = assistant.createAssistantSession()
  const globalPlan = await team.recommendAssistantTeam(globalSession.id, '默认团队')
  team.applyAssistantTeamPlan(globalPlan.id); assert.equal(store.data.defaultTeamAgentIds.length, 4)
  const expired = await team.recommendAssistantTeam(b.id, '待重启方案')
  restored = new EngineeringStore().data.assistant
  assert.equal(restored.plans.find(p => p.id === expired.id).status, 'stale')
  assistant.updateAssistantSession(b.id, { archived: true }); assistant.dismissAssistantHint('fixture:hint')
  assert.equal(new EngineeringStore().data.assistant.sessions.find(s => s.id === b.id).archived, true)
  assert.ok(new EngineeringStore().data.assistant.dismissedHints.includes('fixture:hint'))
  assistant.deleteAssistantSession(globalSession.id); assert.ok(!store.data.assistant.sessions.some(s => s.id === globalSession.id))
  assert.equal(store.data.projects.length, 2)
  console.log('PASS: legacy migration once; scoped sessions/drafts/position; confirmed memories; context isolation; allowlisted actions; stop/partial text; project-only team apply; private skill isolation; model restriction; idempotence; atomic rollback; stale/restart preview; global defaults; archive/delete/hint persistence')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(root, { recursive: true, force: true }))
