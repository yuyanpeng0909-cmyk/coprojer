const { fixture, EngineeringService, fs, path, assert } = require('./fixtures/verification-runtime.cjs')
const ctx = fixture(), { service, profile, root } = ctx
ctx.project.executionPlan.status = 'stopped'
const data = () => service.store.data
const second = service.saveModel({ id: 'replacement', name: 'fixture', model: 'fixture', protocol: 'chat', baseUrl: 'http://localhost:1', apiKey: '' })
const source = data().agents.find(a => a.id === 'developer')
const packageRoot = path.join(profile, 'fixture-skill')
fs.mkdirSync(path.join(packageRoot, 'references'), { recursive: true })
fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), '---\nname: sample\ndescription: sample\n---\nRead references/value.txt')
fs.writeFileSync(path.join(packageRoot, 'references/value.txt'), 'original')
data().skills.push({ id: 'developer::sample', sourceId: 'sample', ownerAgentId: 'developer', name: 'sample', version: '1', description: 'sample', roles: ['developer'], requiredTools: [], origin: 'local', content: 'sample', packageRoot, resources: [{ path: 'references/value.txt', size: 8 }] })
source.skillIds.push('developer::sample')
const a = service.createProject({ name: 'team-a', parent: path.dirname(root), brief: 'A', modelId: 'fixture' })
const b = service.createProject({ name: 'team-b', parent: path.dirname(root), brief: 'B', modelId: 'fixture' })
const projectA = () => service.store.project(a), projectB = () => service.store.project(b)
assert.equal(projectA().teamAgentIds.length, 4)
assert.ok(projectA().teamAgentIds.every(id => data().agents.find(a => a.id === id).ownerProjectId === a))
assert.ok(projectA().teamAgentIds.every(id => !projectB().teamAgentIds.includes(id)))
const ownDeveloper = data().agents.find(a => a.ownerProjectId === projectA().id && a.role === 'developer')
const copiedSkill = data().skills.find(s => s.ownerAgentId === ownDeveloper.id && s.sourceId === 'sample')
assert.notEqual(copiedSkill.packageRoot, packageRoot)
fs.writeFileSync(path.join(packageRoot, 'references/value.txt'), 'changed template')
assert.equal(fs.readFileSync(path.join(copiedSkill.packageRoot, 'references/value.txt'), 'utf8'), 'original')
service.saveAgent({ ...source, modelId: second.id })
assert.equal(data().agents.find(a => a.id === ownDeveloper.id).modelId, 'fixture')
service.isolateProjectTeam('p')
assert.notEqual(service.store.project('p').features[0].developerId, 'developer')
const isolated = JSON.stringify(data())
service.isolateProjectTeam('p')
assert.equal(JSON.stringify(data()), isolated, 'isolating twice does not duplicate members')
const beforeFailure = JSON.stringify(data()), save = service.store.save.bind(service.store)
service.store.save = () => { throw Error('disk full') }
assert.throws(() => service.addProjectAgent(a, 'developer'), /disk full/)
assert.equal(JSON.stringify(data()), beforeFailure)
service.store.save = save
projectA().activity = 'working'
assert.throws(() => service.addProjectAgent(a, 'developer'), /正在执行/)
projectA().activity = null
service.setDefaultAssistantModel('fixture')
const session = service.createAssistantSession(a)
service.updateAssistantSession(session.id, { modelId: 'fixture', draft: 'keep draft' })
projectA().designModelId = 'fixture'
projectA().roundtable = { status: 'confirmed', participants: [{ modelId: 'fixture', responsibility: 'planner' }] }
projectA().chat.push({ id: 'history', role: 'assistant', text: 'history unchanged', modelId: 'fixture', at: new Date().toISOString() })
service.store.project('p').features[0].executionModels = { developer: 'fixture' }
const preview = service.previewModelRemoval('fixture')
assert.equal(preview.suggestedReplacementId, 'replacement')
assert.ok(preview.references.some(s => s.includes('默认通用助手')))
assert.ok(preview.references.some(s => s.includes('助手会话')))
assert.ok(preview.references.some(s => s.includes('圆桌')))
assert.throws(() => service.deleteModel('fixture'), /替代连接/)
for (const field of ['activity', 'designActivity']) {
  projectA()[field] = 'running'
  assert.throws(() => service.deleteModel('fixture', 'replacement'), /正在执行/)
  projectA()[field] = null
}
data().executionCheckpoints = { '["p","f"]': { role: 'developer' } }
assert.throws(() => service.deleteModel('fixture', 'replacement'), /检查点/)
delete data().executionCheckpoints
const pending = { id: 'pending', role: 'assistant', text: '', at: new Date().toISOString(), status: 'pending', usage: { connectionId: 'fixture' } }
data().assistant.sessions.find(s => s.id === session.id).messages.push(pending)
assert.throws(() => service.deleteModel('fixture', 'replacement'), /助手正在回复/)
pending.status = 'complete'
const beforeRemove = JSON.stringify(data())
service.store.save = () => { throw Error('disk full') }
assert.throws(() => service.deleteModel('fixture', 'replacement'), /disk full/)
assert.equal(JSON.stringify(data()), beforeRemove, 'deletion and every binding roll back together')
service.store.save = save
service.deleteModel('fixture', 'replacement')
assert.equal(data().models.length, 1)
assert.equal(data().defaultAssistantModelId, 'replacement')
assert.ok(data().agents.every(a => a.modelId === 'replacement'))
assert.equal(projectA().roundtable.participants[0].modelId, 'replacement')
assert.equal(projectA().chat[0].modelId, 'fixture', 'historical attribution is unchanged')
assert.equal(data().assistant.sessions.find(s => s.id === session.id).modelId, 'replacement')
assert.equal(data().assistant.sessions.find(s => s.id === session.id).draft, 'keep draft')
assert.equal(service.store.project('p').features[0].executionModels.developer, 'replacement')
const restored = new EngineeringService()
assert.equal(restored.store.data.models.length, 1)
assert.equal(restored.store.data.defaultAssistantModelId, 'replacement')
assert.equal(restored.store.project(a).teamAgentIds.length, 4)
console.log('PASS team isolation, skill package copies, idempotence, model reference migration, active guards, atomic rollback, restart persistence')
