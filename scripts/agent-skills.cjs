const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-owned-skills-'))
let modelReply = () => { throw Error('Unexpected model call') }
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file)
  if (file.endsWith(path.join('engineering', 'model.ts'))) return { complete: async (...args) => modelReply(...args), parseJson: JSON.parse }
  const exports = {}; cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(exports, name => name === 'electron' ? { app: { getPath: () => root }, safeStorage: {} } : name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return exports
}
const { defaultAgents, migrateAgentSkills, ownSkill, builtinSkills } = load('src/shared/agents.ts')
const { loadLocalSkill, copySkillPackage, skillReader, agentSkills, skillResourcePath } = load('src/main/engineering/skills.ts')
const { AgentConfiguration } = load('src/main/engineering/agent-configuration.ts')
const { EngineeringStore } = load('src/main/engineering/store.ts')
const { parseGithubSource } = load('src/main/engineering/skill-catalog.ts')
const skillText = (description = '完整描述') => '---\nname: local-design\ndescription: >\n  ' + description + '\n  含多行 YAML 描述\ncompatibility: Node.js 22\n---\n\nUse references/guide.md when needed.\n'

async function run() {
  const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'references'), { recursive: true })
  fs.writeFileSync(path.join(source, 'SKILL.md'), skillText())
  fs.writeFileSync(path.join(source, 'references', 'guide.md'), 'IMMUTABLE_RESOURCE')
  const parsed = loadLocalSkill(source, 'designer')
  assert.equal(parsed.name, 'local-design'); assert.match(parsed.description, /完整描述 含多行/)
  assert.equal(parsed.compatibility, 'Node.js 22')
  for (const name of ['../SKILL.md', '/outside', 'references/../../outside', 'C:/secret', 'references\\..\\secret', 'references/nul.txt']) assert.throws(() => skillResourcePath(source, name), /路径/)
  assert.throws(() => parseGithubSource('http://127.0.0.1/private'), /GitHub/)
  assert.throws(() => parseGithubSource('https://github.com@evil.test/repo'), /GitHub/)
  assert.equal(parseGithubSource('https://github.com/example/skills/tree/main/skills/design/SKILL.md').directory, 'skills/design')

  const legacyAgents = [{ ...defaultAgents()[2], id: 'dev-a', skillIds: ['delivery', 'shared-legacy'] }, { ...defaultAgents()[2], id: 'dev-b', skillIds: ['shared-legacy'] }]
  const shared = { ...parsed, id: 'shared-legacy', sourceId: undefined, roles: ['developer'] }
  const migrated = migrateAgentSkills(legacyAgents, [shared])
  assert.notEqual(legacyAgents[0].skillIds[1], legacyAgents[1].skillIds[0])
  assert.deepEqual(migrateAgentSkills(legacyAgents, migrated), migrated)
  assert.throws(() => agentSkills({ ...legacyAgents[0], skillIds: legacyAgents[1].skillIds }, migrated), /其他智能体/)
  const own = ownSkill(parsed, 'owner'), owner = { ...defaultAgents()[1], id: 'owner', skillIds: [own.id] }
  assert.ok(!agentSkills(owner, [own]).text.includes('Use references'))
  assert.match(skillReader(owner, [own])({ id: own.id }), /Use references/)
  assert.throws(() => skillReader({ ...owner, skillIds: [] }, [own])({ id: own.id }), /未启用/)

  const store = new EngineeringStore()
  store.data.models = [{ id: 'model-a', name: 'Reasoning', model: 'reasoning-model', protocol: 'chat', baseUrl: 'https://example.invalid', cipher: '' }, { id: 'model-b', name: 'Coding', model: 'coding-model', protocol: 'chat', baseUrl: 'https://example.invalid', cipher: '' }]
  store.data.agents.forEach(a => { a.modelId = 'model-a' })
  const config = new AgentConfiguration(store, id => { const m=store.data.models.find(m=>m.id===id); if(!m) throw Error('unknown model'); return {...m,apiKey:''} })
  const before = JSON.stringify(store.data)
  const preview = await config.previewSkill('designer', { kind: 'local', location: source })
  assert.equal(JSON.stringify(store.data), before, 'preview must not install or enable')
  assert.equal(preview.fileCount, 2)
  assert.throws(() => config.installSkill('developer', preview.id), /不属于/)
  fs.writeFileSync(path.join(source, 'references', 'guide.md'), 'SOURCE_CHANGED_AFTER_PREVIEW')
  const installed = config.installSkill('designer', preview.id)
  assert.equal(installed.ownerAgentId, 'designer')
  assert.ok(store.data.agents.find(a=>a.id==='designer').skillIds.includes(installed.id))
  const reader = skillReader(store.data.agents.find(a=>a.id==='designer'), store.skills())
  assert.match(reader({ id: installed.id, path: 'references/guide.md' }), /IMMUTABLE_RESOURCE/)
  assert.throws(() => reader({ id: 'developer::delivery' }), /不属于/)
  assert.throws(() => config.installSkill('designer', preview.id), /不存在/)
  const other = await config.previewSkill('developer', { kind:'local', location: source })
  const otherInstalled = config.installSkill('developer', other.id)
  assert.notEqual(installed.id, otherInstalled.id)
  assert.notEqual(installed.packageRoot, otherInstalled.packageRoot)
  assert.throws(() => config.removeSkill('developer', installed.id), /其他智能体/)
  const cancelled = await config.previewSkill('designer', {kind:'local',location:source})
  config.discardSkillPreview('designer',cancelled.id)
  assert.throws(()=>config.installSkill('designer',cancelled.id),/不存在/)
  const reloaded = new EngineeringStore()
  assert.equal(reloaded.skills().find(s=>s.id===installed.id).ownerAgentId,'designer')
  assert.ok(reloaded.data.agents.find(a=>a.id==='designer').skillIds.includes(installed.id))

  modelReply = async (_connection, system, messages) => {
    assert.match(system,/AGENT_MODEL_ALLOCATION/)
    const input = JSON.parse(messages[0].content)
    assert.ok(!JSON.stringify(input).includes('cipher'))
    return {text: JSON.stringify({choices: input.agents.map(a=>({agentId:a.id,modelId:a.role==='developer'?'model-b':'model-a',reason:'根据职责选择，能力待验证。'}))}),calls:[]}
  }
  const previous = store.data.agents.map(a=>a.modelId)
  const plan = await config.recommendAgentModels('model-a','质量优先')
  assert.deepEqual(store.data.agents.map(a=>a.modelId), previous, 'recommendation must not mutate assignment')
  assert.equal(plan.choices.length, store.data.agents.length)
  config.applyAgentModels(plan.id)
  assert.equal(store.data.agents.find(a=>a.role==='developer').modelId,'model-b')
  assert.throws(()=>config.applyAgentModels(plan.id),/过期/)
  const stale = await config.recommendAgentModels('model-a','质量优先')
  store.data.agents[0].instructions += 'changed'
  assert.throws(()=>config.applyAgentModels(stale.id),/变化/)
  modelReply = async () => ({ text: JSON.stringify({choices:store.data.agents.map(a=>({agentId:a.id,modelId:'hallucinated-model',reason:'bad'}))}),calls:[] })
  await assert.rejects(config.recommendAgentModels('model-a',''),/不存在/)
  console.log('PASS: standard SKILL.md, YAML, package snapshot, legacy migration, instance isolation, on-demand reads, confirmed install, cancellation, restart persistence, model allocation, stale/hallucinated plan rejection')
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}))
