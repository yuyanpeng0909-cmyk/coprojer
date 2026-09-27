const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-general-assistant-'))
const cache = new Map(), calls = []
let respond, candidates = [{name:'verified-skill',description:'真实候选测试',url:'https://github.com/fixture/skills/tree/main/verified'}]
function load(file) {
  file = path.resolve(file)
  if(cache.has(file)) return cache.get(file)
  if(file.endsWith(path.join('engineering','model.ts'))) return {complete:async(...args)=>{calls.push(args);return respond(...args)},parseJson:JSON.parse}
  if(file.endsWith(path.join('engineering','skill-catalog.ts'))) return {searchPublicSkills:async()=>candidates}
  const exports = {}; cache.set(file,exports)
  const code = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('exports','require',code)(exports,name=>name==='electron'?{app:{getPath:()=>root},safeStorage:{}}:name.startsWith('.')?load(path.resolve(path.dirname(file),name+'.ts')):require(name))
  return exports
}
const {EngineeringStore} = load('src/main/engineering/store.ts')
const {GeneralAssistant} = load('src/main/engineering/general-assistant.ts')
const {AgentConfiguration} = load('src/main/engineering/agent-configuration.ts')
async function main(){
  const store=new EngineeringStore()
  store.data.models=[{id:'dashscope-connection',name:'Qwen Flash',model:'qwen3.7-flash-existing-id',protocol:'chat',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',cipher:'opaque-existing-cipher'}, {id:'alternate',name:'另一个助手',model:'alternate-id',protocol:'chat',baseUrl:'https://example.invalid/v1',cipher:''}, {id:'execution',name:'工程执行',model:'execution-id',protocol:'chat',baseUrl:'https://example.invalid/v1',cipher:''}]
  store.data.agents.forEach(a=>{a.modelId='execution'})
  const originalAgents=JSON.stringify(store.data.agents), originalSkills=JSON.stringify(store.data.skills), originalModels=JSON.stringify(store.data.models)
  const connection=id=>{const {cipher,...model}=store.data.models.find(m=>m.id===id)||{};if(!model.id)throw Error('missing');return {...model,apiKey:'secret-marker'}}
  const assistant=new GeneralAssistant(store,connection), configuration=new AgentConfiguration(store,connection)
  await assert.rejects(assistant.sendAssistantMessage('你好'),/默认通用助手/)
  await assert.rejects(configuration.recommendSkills('planner','技能'),/默认通用助手/)
  assert.throws(()=>assistant.setDefaultAssistantModel('invented'),/已保存/)
  assistant.setDefaultAssistantModel('dashscope-connection')
  let release, started
  const waiting=new Promise(r=>{started=r})
  respond=async(c,system,messages,tools)=>{assert.equal(c.model,'qwen3.7-flash-existing-id');assert.match(system,/GENERAL_ASSISTANT/);assert.deepEqual(tools,[]);started();await new Promise(r=>{release=r});return {text:'你好。可以在智能体的技能入口导入。',calls:[],model:'qwen3.7-flash-provider-snapshot'}}
  const request=assistant.sendAssistantMessage('如何导入技能？')
  await waiting
  await assert.rejects(assistant.sendAssistantMessage('重复'),/正在回复/)
  assert.throws(()=>assistant.clearAssistantChat(),/等待/)
  assistant.setDefaultAssistantModel('alternate');release();await request
  assert.equal(store.data.assistantChat.at(-1).usage.connectionId,'dashscope-connection')
  assert.deepEqual(store.data.assistantChat.at(-1).usage.reportedModels,['qwen3.7-flash-provider-snapshot'])
  respond=async(c)=>({text:'OK',calls:[],model:c.model})
  await assistant.sendAssistantMessage('单次覆盖','dashscope-connection')
  assert.equal(store.data.defaultAssistantModelId,'alternate')
  await assistant.sendAssistantMessage('恢复默认')
  assert.equal(store.data.assistantChat.at(-1).usage.connectionId,'alternate')
  const count=calls.length;await assert.rejects(assistant.sendAssistantMessage('错误','invented'),/不存在/);assert.equal(calls.length,count)
  respond=async()=>{throw Error('provider unavailable')}
  await assistant.sendAssistantMessage('失败请求');assert.equal(store.data.assistantChat.at(-1).status,'error')
  respond=async(c,system,messages)=>{assert.ok(!messages.some(m=>m.content==='失败请求'));return {text:'继续',calls:[]}}
  await assistant.sendAssistantMessage('继续')
  assert.deepEqual(store.data.assistantChat.at(-1).usage.reportedModels,[])
  const restored=new EngineeringStore()
  assert.equal(restored.data.defaultAssistantModelId,'alternate')
  assert.equal(restored.data.assistantChat.length,store.data.assistantChat.length)
  assert.equal(JSON.stringify(restored.data.models),originalModels)
  const choose=async(c,system,messages)=>{
    assert.ok(!JSON.stringify(messages).includes('secret-marker')); assert.ok(!JSON.stringify(messages).includes('opaque-existing-cipher'))
    if(system.includes('SKILL_SEARCH_QUERY'))return{text:'{"query":"verified"}',calls:[],model:c.model+'-query'}
    if(system.includes('SKILL_RECOMMENDATIONS'))return{text:'{"recommendations":[{"index":0,"reason":"适用于当前职责"}]}',calls:[],model:c.model+'-ranking'}
    const input=JSON.parse(messages[0].content)
    return{text:JSON.stringify({choices:input.agents.map(a=>({agentId:a.id,modelId:'execution',reason:'沿用独立工程模型'}))}),calls:[],model:c.model}
  }
  respond=choose
  const result=await configuration.recommendSkills('planner','规划技能','dashscope-connection')
  assert.equal(result.usage.connectionId,'dashscope-connection');assert.equal(result.usage.reportedModels.length,2)
  assert.equal(store.data.defaultAssistantModelId,'alternate')
  assert.deepEqual(new EngineeringStore().data.skillSearches.planner,result)
  await configuration.recommendSkills('designer','设计技能')
  assert.equal(store.data.skillSearches.designer.usage.connectionId,'alternate')
  assert.equal(store.data.skillSearches.planner.query,'规划技能')
  respond=async()=>{throw Error('failed search')}
  await assert.rejects(configuration.recommendSkills('planner','失败搜索'),/failed search/)
  assert.deepEqual(store.data.skillSearches.planner,result);assert.deepEqual(configuration.searchActivity,{})
  respond=choose;candidates=[]
  const empty=await configuration.recommendSkills('designer','无匹配技能');assert.deepEqual(empty.recommendations,[])
  assert.deepEqual(new EngineeringStore().data.skillSearches.designer,empty)
  configuration.clearSkillSearch('designer');assert.deepEqual(store.data.skillSearches.planner,result)
  const plan=await configuration.recommendAgentModels('','质量优先');assert.equal(plan.usage.connectionId,'alternate')
  assert.equal(JSON.stringify(store.data.agents),originalAgents)
  assert.equal(JSON.stringify(store.data.skills),originalSkills)
  const saved=store.data.defaultAssistantModelId,save=store.save.bind(store);store.save=()=>{throw Error('disk full')}
  assert.throws(()=>assistant.setDefaultAssistantModel('execution'),/disk full/);assert.equal(store.data.defaultAssistantModelId,saved)
  store.save=save
  assistant.clearAssistantChat();assert.deepEqual(new EngineeringStore().data.assistantChat,[])
  console.log('PASS: independent default/one-shot routing, frozen requests, provider model receipts, history/restart, saved per-agent recommendations, failed-search preservation, empty results, explicit clear, unchanged agent models/skills/credentials')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}))
