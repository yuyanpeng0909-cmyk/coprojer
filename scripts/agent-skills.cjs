const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const { allocationFixture } = require('./fixtures/arena.cjs')
const { aaHtml } = require('./fixtures/aa.cjs')
const realFetch = globalThis.fetch
globalThis.fetch = async url => new Response(new URL(url).hostname === 'artificialanalysis.ai' ? aaHtml() : allocationFixture(String(url)), { headers: { 'content-type': 'text/html' } })
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
    return {text: JSON.stringify({choices: input.agents.map(a=>({agentId:a.id,modelId:input.constraints.find(c=>c.agentId===a.id).allowedModelIds[0]}))}),calls:[]}
  }
  const previous = store.data.agents.map(a=>a.modelId)
  // Keep this regression on its original Arena metrics; AA has dedicated reasoning coverage.
  const recommend = config.recommendAgentModels
  config.recommendAgentModels = (id, preference, options = {}) => recommend(id, preference, { ...options, categories: options.categories || Object.fromEntries(store.data.agents.filter(a => !a.ownerProjectId).map(a => [a.id, a.role === 'planner' ? 'text' : a.role === 'designer' ? 'frontend' : 'coding'])) })
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
  // The language model cannot bypass measured candidates or make up the displayed evidence.
  modelReply = async (_c,_s,messages) => {const input=JSON.parse(messages[0].content);return {text:JSON.stringify({choices:input.agents.map(a=>({agentId:a.id,modelId:'model-a',reason:'Flash 更快，所有任务都选它。'}))}),calls:[]}}
  await assert.rejects(config.recommendAgentModels('model-a','速度优先'),/能力证据/)
  modelReply = async (_c,_s,messages) => {const input=JSON.parse(messages[0].content);return {text:JSON.stringify({choices:input.agents.map(a=>({agentId:a.id,modelId:input.constraints.find(c=>c.agentId===a.id).allowedModelIds[0],reason:'虚构排名与速度'}))}),calls:[]}}
  const verified = await config.recommendAgentModels('model-a','')
  assert.ok(verified.choices.every(c=>!c.reason.includes('虚构')))
  assert.ok(verified.evidence.every(e=>e.status==='fresh'))
  await assert.rejects(config.recommendAgentModels('model-a','',{categories:{developer:'invented-category'}}),/分类/)
  await assert.rejects(config.recommendAgentModels('model-a','',{policy:'speed'}),/策略/)
  const projectAgent = {...store.data.agents[0],id:'project-agent',ownerProjectId:'project-fixture',modelId:'model-b',skillIds:[]}
  store.data.agents.push(projectAgent)
  const scoped = await config.recommendAgentModels('model-a','')
  assert.ok(!scoped.choices.some(c=>c.agentId==='project-agent'))
  const previousAgents = store.data.agents, originalSave=store.save.bind(store)
  store.save=()=>{throw Error('disk full')}
  assert.throws(()=>config.applyAgentModels(scoped.id),/disk full/);assert.equal(store.data.agents,previousAgents)
  store.save=originalSave;config.applyAgentModels(scoped.id)
  assert.equal(store.data.agents.find(a=>a.id==='project-agent').modelId,'model-b')
  const beforeFailure=JSON.stringify(store.data.agents)
  globalThis.fetch=async()=>{throw Error('fetch failed')}
  modelReply=()=>{throw Error('No advisor call expected without evidence')}
  const unavailable=await config.recommendAgentModels('model-a','')
  assert.equal(unavailable.usage,undefined);assert.ok(unavailable.choices.every(c=>c.modelId===c.previousModelId&&!c.supported))
  assert.ok(unavailable.evidence.every(e=>e.status==='unavailable'))
  assert.equal(JSON.stringify(store.data.agents),beforeFailure)
  globalThis.fetch=async url=>new Response(allocationFixture(String(url),'model-with-unmatched-suffix','coding-model'),{headers:{'content-type':'text/html'}})
  modelReply = async (_c,_s,messages) => {const input=JSON.parse(messages[0].content);return {text:JSON.stringify({choices:input.agents.map(a=>({agentId:a.id,modelId:input.constraints.find(c=>c.agentId===a.id).allowedModelIds[0]}))}),calls:[]}}
  const incomplete = await config.recommendAgentModels('model-a','')
  assert.ok(incomplete.choices.filter(c=>c.previousModelId==='model-a').every(c=>!c.supported&&c.modelId==='model-a'),'unranked current model is not assumed worse')
  assert.ok(incomplete.choices.filter(c=>c.previousModelId==='model-a').every(c=>c.reason.includes('未上榜不代表能力差')))
  console.log('PASS: standard SKILL.md, YAML, package snapshot, legacy migration, instance isolation, on-demand reads, confirmed install, cancellation, restart persistence, model allocation, stale/hallucinated plan rejection')
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{globalThis.fetch=realFetch;fs.rmSync(root,{recursive:true,force:true})})
