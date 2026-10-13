const { fixture, EngineeringService, load, assert } = require('./fixtures/verification-runtime.cjs')
const { defaultAgentInstructions, agentInstructionsVersion } = load('src/shared/agent-instructions.ts')
const { executionKey } = load('src/main/engineering/execution.ts')

const { service, project } = fixture()
project.executionPlan.status = 'stopped'
const old = {
  planner: '整理需求与任务依赖，准备可执行方案，保留人工确认。',
  designer: '根据需求制作可交互原型，保留页面与状态的交接依据。',
  developer: '实现已确认需求，复用项目公共内容，修改后运行必要检查。',
  reviewer: '独立检查实际代码，运行测试并逐项核对验收标准。不要仅复述开发者的完成声明。',
}
const copyId = service.createProject({ name: 'requirements-copy', parent: require('node:path').dirname(project.root), brief: 'Independent instructions', modelId: 'fixture' })
for (const agent of service.store.data.agents) {
  assert.equal(agent.instructions, defaultAgentInstructions[agent.role], 'new members inherit the full role requirements')
  agent.instructions = old[agent.role]
  delete agent.instructionsVersion
}
const custom = { ...service.store.data.agents.find(a => a.role === 'developer'), id: 'custom', name: '界面开发', instructions: '负责前端设计，原型开发等UI设计。\n保留业务组件；后端由其他成员负责。', skillIds: [] }
const long = { ...custom, id: 'long', instructions: '自定义要求'.repeat(1960) }
service.store.data.agents.push(custom, long)
const bindings = service.store.data.agents.map(({ instructions, instructionsVersion, ...agent }) => agent)
service.store.save()

let restored = new EngineeringService()
assert.deepEqual(restored.store.data.agents.map(({ instructions, instructionsVersion, ...agent }) => agent), bindings, 'model, tools, skill ownership and project bindings stay intact')
for (const agent of restored.store.data.agents.filter(a => !['custom', 'long'].includes(a.id))) {
  assert.equal(agent.instructions, defaultAgentInstructions[agent.role], 'legacy shared and project instances are upgraded')
  assert.equal(agent.instructionsVersion, agentInstructionsVersion)
}
const expanded = restored.store.data.agents.find(a => a.id === 'custom').instructions
assert.ok(expanded.includes(custom.instructions), 'member-specific requirements survive verbatim')
assert.ok(expanded.includes(defaultAgentInstructions.developer), 'custom member receives the role workflow and delivery requirements')
assert.equal(restored.store.data.agents.find(a => a.id === 'long').instructions, long.instructions, 'do not truncate a near-limit custom prompt')
const once = JSON.stringify(restored.store.data.agents)
restored = new EngineeringService()
assert.equal(JSON.stringify(restored.store.data.agents), once, 'restart does not append the requirements twice')

const owner = restored.store.data.agents.find(a => a.ownerProjectId === copyId && a.role === 'developer')
restored.saveAgent({ ...owner, instructions: '仅修改项目的导出模块。' })
restored = new EngineeringService()
assert.equal(restored.store.data.agents.find(a => a.id === owner.id).instructions, '仅修改项目的导出模块。', 'later user edits survive restart without automatic rewriting')
assert.equal(restored.store.data.agents.find(a => a.id === 'developer').instructions, defaultAgentInstructions.developer, 'project-specific edits do not change the shared template')
assert.ok(restored.agentInstructions(restored.store.project(copyId), 'developer', 'fixture', undefined, restored.store.data.agents.find(a => a.id === owner.id)).startsWith('仅修改项目的导出模块。'), 'runtime consumes the saved member requirements')

const paused = fixture()
paused.project.executionPlan.status = 'stopped'
for (const agent of paused.service.store.data.agents) { agent.instructions = old[agent.role]; delete agent.instructionsVersion }
const pausedAgents = paused.service.store.data.agents.filter(a => ['developer', 'reviewer'].includes(a.role)).map(a => structuredClone(a))
const key = executionKey(paused.project.id, paused.feature.id)
paused.service.store.data.executionCheckpoints = { [key]: { version: 2, role: 'developer', fingerprint: 'preserved', messages: [], commands: [] } }
paused.service.store.save()
let resumed = new EngineeringService()
assert.deepEqual(resumed.store.data.agents.filter(a => ['developer', 'reviewer'].includes(a.role)), pausedAgents, 'paused execution agent configuration remains byte-for-byte stable')
assert.equal(resumed.store.data.agents.find(a => a.role === 'planner').instructions, defaultAgentInstructions.planner, 'unrelated roles can still upgrade')
delete resumed.store.data.executionCheckpoints[key]
resumed.store.save()
resumed = new EngineeringService()
assert.equal(resumed.store.data.agents.find(a => a.role === 'developer').instructions, defaultAgentInstructions.developer, 'deferred migration happens after the checkpoint is cleared')
console.log('PASS legacy and custom requirements, independent project copies, manual edits, restart idempotence, runtime consumption, paused checkpoint protection')
