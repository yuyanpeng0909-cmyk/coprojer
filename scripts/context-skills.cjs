const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file)
  const api = {}; cache.set(file, api)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(api, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return api
}
const { readPage, readContext, assembleContext, boundMessages, discussionHistory } = load('src/main/engineering/context.ts')
const { defaultAgents, builtinSkills, migrateAgentSkills, ownSkill } = load('src/shared/agents.ts')
const { agentSkills, loadLocalSkill } = load('src/main/engineering/skills.ts')
const { syncPrototypeBriefs, requirePrototypeReview, requirePrd, activePrototypeBriefs, designFingerprint, rawDesignFingerprint } = load('src/shared/prototype-workflow.ts')
const entry = (id, content, extra = {}) => ({ id, title: id, content, source: '用户编辑', at: '2026-09-27', ...extra })
const feature = (id, dependencies = [], targetId = 'web') => ({ id, title: id, targetId, stage: 'ready', scope: 'current', description: '实现目标', criteria: ['原始验收条件'], plan: '实现并验证', tasks: [], dependencies })
const current = feature('current', ['dep']), dep = feature('dep', [], 'api'), other = feature('other', [], 'mobile')
const project = { name: 'Fixture', brief: '必须保留目标', context: [], chat: [], features: [current, dep, other], targets: [{ id: 'web', directory: 'apps/web' }, { id: 'api', directory: 'apps/api' }, { id: 'mobile', directory: 'apps/mobile' }], prototypes: [] }
const original = '头部' + 'x'.repeat(15000) + '中间不可丢失' + '\n"\\'.repeat(9000) + '尾部'
let restored = '', offset = 0, version
do { const page = JSON.parse(readPage(original, { offset, version })); restored += page.content; version = page.version; offset = page.nextOffset } while (offset !== null)
assert.equal(restored, original)
assert.throws(() => readPage(original + 'changed', { version }), /版本已变化/)
assert.throws(() => readPage(original, { offset: -1 }), /分页参数/)
assert.throws(() => readPage(original, { limit: 10000 }), /分页参数/)
project.context = Array.from({ length: 1000 }, (_, i) => entry('entry-' + i, 'x'.repeat(2000)))
project.context.push(entry('foreign', 'FOREIGN_MARKER', { featureId: 'other', targetId: 'mobile' }), entry('dep-fact', 'DEPENDENCY_MARKER', { featureId: 'dep', targetId: 'api' }))
const result = assembleContext(project, current, 12000)
assert.ok(result.characters <= 12000)
assert.match(result.text, /apps\/web/); assert.match(result.text, /apps\/api/)
assert.ok(!result.text.includes('apps/mobile') && !result.text.includes('FOREIGN_MARKER'))
assert.ok(result.omittedCount > 900)
assert.match(result.text, /原始验收条件/)
assert.match(result.text, /DEPENDENCY_MARKER/)
assert.throws(() => assembleContext({ ...project, brief: 'x'.repeat(20000) }, current, 8000), /必需约束/)
assert.equal(JSON.parse(readContext(project, { id: 'feature:current' })).nextOffset, null)
current.baselineId = 'old-baseline'
project.context = [entry('old-baseline', 'PINNED_OLD_BASELINE', { baselineId: 'old-baseline', kind: 'requirements', status: 'superseded' }), entry('archived', 'ARCHIVED_MARKER', { status: 'archived' })]
assert.match(assembleContext(project, current).text, /PINNED_OLD_BASELINE/)
assert.ok(!assembleContext(project, current).text.includes('ARCHIVED_MARKER'))
project.requirementsBaseline = { id: 'new-baseline', prototypeIds: ['new-prototype'] }
project.context.push(entry('new-baseline', 'NEW_BASELINE_MARKER', { baselineId: 'new-baseline', kind: 'requirements', status: 'active' }))
const pinned = assembleContext(project, current).text
assert.ok(!pinned.includes('new-prototype') && !pinned.includes('NEW_BASELINE_MARKER'))
project.chat = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', status: 'complete', text: 'turn-' + i + 'x'.repeat(1000) }))
assert.ok(JSON.stringify(discussionHistory(project)).length < 24000)
assert.match(JSON.stringify(discussionHistory(project)), /turn-99/)
const messages = [{ role: 'user', content: 'goal' }]
for (let i = 0; i < 20; i++) messages.push({ role: 'assistant', content: '', calls: [{ id: 'call-' + i, name: 'read_file', arguments: '{}' }] }, { role: 'tool', callId: 'call-' + i, content: 'x'.repeat(4000) })
boundMessages(messages)
assert.ok(JSON.stringify(messages).length < 46000)
assert.equal(messages.at(-1).callId, messages.at(-2).calls[0].id)
const agents = defaultAgents('model')
const ownedSkills = migrateAgentSkills(agents, [])
assert.deepEqual(agents.map(a => a.role).sort(), ['designer', 'developer', 'planner', 'reviewer'])
for (const agent of agents) assert.equal(agentSkills(agent, ownedSkills).snapshots.length, 1)
assert.ok(!agents.find(a => a.role === 'designer').tools.includes('write_file'))
assert.ok(!agents.find(a => a.role === 'planner').tools.includes('run_command'))
assert.throws(() => agentSkills({ ...agents[0], skillIds: ['developer::delivery'] }, ownedSkills), /其他智能体/)
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-skill-'))
try {
  fs.writeFileSync(path.join(directory, 'skill.json'), JSON.stringify({ id: 'local-check', name: '本地检查', version: '1.0', description: '测试导入', roles: ['reviewer'], requiredTools: ['run_command'] }))
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '检查实际行为，不修改验收标准。')
  const reviewer = agents.find(a => a.role === 'reviewer')
  const skill = ownSkill(loadLocalSkill(directory), reviewer.id)
  assert.equal(agentSkills({ ...reviewer, skillIds: [skill.id] }, [skill]).snapshots[0].version, '1.0')
  fs.writeFileSync(path.join(directory, 'skill.json'), JSON.stringify({ ...skill, id: skill.sourceId, requiredTools: ['unknown_browser'] }))
  assert.throws(() => loadLocalSkill(directory), /尚未提供/)
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
console.log('PASS: lossless paging, version checks, bounded scoped context, pinned baselines, history compaction, four roles and local skill validation')
const designProject = { ...project, targets: [], context: [], requirementsBaseline: undefined, features: [{ ...feature('ui'), targetId: undefined, stage: 'requirements' }] }
syncPrototypeBriefs(designProject)
assert.equal(designProject.prototypeBriefs[''].status, 'preferences')
assert.throws(() => requirePrototypeReview(designProject), /验收原型/)
designProject.prototypeBriefs[''].status = 'accepted'
requirePrototypeReview(designProject)
designProject.features[0].criteria = ['更新后的验收条件']
syncPrototypeBriefs(designProject)
assert.equal(designProject.prototypeBriefs[''].status, 'preferences')
assert.throws(() => requirePrototypeReview(designProject), /验收原型/)
console.log('PASS: proactive design-opinion readiness, human prototype review gate and requirement-change invalidation')
const initial = { ...project, brief: '只有初步想法', targets: [], features: [], prototypes: [], prototypeBriefs: undefined }
syncPrototypeBriefs(initial)
assert.equal(initial.prototypeBriefs[''].status, 'preferences')
const fingerprint = designFingerprint(initial)
initial.prototypeBriefs[''] = { status: 'accepted', fingerprint, prototypeId: 'approved' }
initial.prd = { status: 'review', sources: [{ prototypeId: 'approved', fingerprint }] }
initial.requirementsDocument = '从已确认原型提取的 PRD'
initial.features = [{ ...feature('new'), targetId: undefined, stage: 'requirements' }]
initial.prd.sources[0].derivedFingerprint = rawDesignFingerprint(initial)
syncPrototypeBriefs(initial)
assert.equal(initial.prototypeBriefs[''].status, 'accepted')
requirePrd(initial)
initial.prd.status = 'generating'
syncPrototypeBriefs(initial)
assert.equal(initial.prototypeBriefs[''].status, 'accepted')
assert.throws(() => requirePrd(initial), /PRD/)
initial.prd.status = 'review'
initial.prd.sources[0].prototypeId = 'different'
assert.throws(() => requirePrd(initial), /PRD/)
initial.prd.sources[0].prototypeId = 'approved'
initial.requirementsDocument += '\n人工修改界面与业务'
syncPrototypeBriefs(initial)
assert.equal(initial.prototypeBriefs[''].status, 'preferences')
assert.equal(initial.prd.status, 'stale')
assert.throws(() => requirePrototypeReview(initial), /验收原型/)
initial.targets = [{ id: 'api', kind: 'backend', directory: 'api' }]
assert.deepEqual(activePrototypeBriefs(initial), [])
requirePrototypeReview(initial)
requirePrd(initial)
console.log('PASS: prototype-first PRD mapping, retry stability, stale-source rejection and backend-only exemption')
