const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript')
const {aaHtml,rows}=require('./fixtures/aa.cjs'),{allocationFixture}=require('./fixtures/arena.cjs')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'coprojer-reasoning-')),cache=new Map(),realFetch=global.fetch
function load(file) {
  file=path.resolve(file);if(cache.has(file))return cache.get(file)
  const out={};cache.set(file,out)
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('exports','require',code)(out,name=>name==='electron'?{app:{getPath:()=>root},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},shell:{}}:name.startsWith('.')?load(path.resolve(path.dirname(file),name+'.ts')):require(name));return out
}
const R=load('src/shared/reasoning.ts'),M=load('src/main/engineering/model.ts'),AA=load('src/main/engineering/aa-evidence.ts'),E=load('src/main/engineering/model-evidence.ts')
const {isAgentModelPlan}=load('src/renderer/src/engineering/model-plan.ts')
const glm={id:'glm',model:'glm-5.3',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4',protocol:'chat',hasKey:true,apiKey:'fixture-only-key',name:'glm-5.3'}
const kimi={...glm,id:'kimi',model:'kimi-k3',baseUrl:'https://unit.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}
const qwen={...kimi,id:'qwen',model:'qwen3.7-flash'},flash={...glm,id:'flash',model:'glm-5.3-flash'}
const low={enabled:true,effort:'low'},max={enabled:true,effort:'max'}
async function main(){
  assert.deepEqual(R.defaultReasoning(glm),max);assert.deepEqual(R.defaultReasoning(kimi),max)
  assert.deepEqual(R.defaultReasoning(qwen),{enabled:true});assert.equal(R.reasoningLabel(qwen),'推理 · 最大预算')
  assert.deepEqual(R.defaultReasoning(flash),max)
  assert.throws(()=>R.resolveReasoning(glm,{enabled:false}),/不能关闭/)
  assert.throws(()=>R.resolveReasoning(glm,{enabled:true,effort:'medium'}),/不支持/)
  assert.throws(()=>R.resolveReasoning(qwen,{enabled:true,budget:262145}),/预算/)
  assert.throws(()=>R.resolveReasoning(qwen,{enabled:true,effort:'max'}),/预算/)
  assert.equal(R.defaultReasoning({...glm,baseUrl:'https://open.bigmodel.cn.evil.example'}),undefined)
  assert.equal(R.defaultReasoning({...glm,protocol:'anthropic'}),undefined)
  assert.equal(R.defaultReasoning({...glm,model:'glm-5.3-preview'}),undefined)
  assert.equal(R.defaultReasoning({...glm,baseUrl:'https://dashscope.aliyuncs.com.evil.example'}),undefined)
  const sent=[]
  global.fetch=async(url,init)=>{const body=JSON.parse(init.body);sent.push(body);return new Response(JSON.stringify(body.input?{model:body.model,output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}:{model:body.model,choices:[{message:{content:'ok'}}]}),{headers:{'content-type':'application/json'}})}
  for(const [model,reasoning,expected] of [[glm,max,{reasoning_effort:'max'}],[glm,low,{reasoning_effort:'low'}],[kimi,max,{reasoning_effort:'max'}],[qwen,{enabled:false},{enable_thinking:false}],[qwen,{enabled:true,budget:4096},{enable_thinking:true,thinking_budget:4096}],[qwen,{enabled:true},{enable_thinking:true}]]){
    await M.complete({...model,reasoning},'test',[{role:'user',content:'test'}]);const body=sent.at(-1)
    assert.equal(body.model,model.model,'display suffix must never change API model ID')
    for(const [k,v]of Object.entries(expected))assert.deepEqual(body[k],v)
    if(model===qwen)assert.equal(body.reasoning_effort,undefined)
  }
  const responseModel={...kimi,model:'qwen3.8-flash',protocol:'responses'}
  for(const reasoning of [R.defaultReasoning(responseModel),{enabled:false}]){await M.complete({...responseModel,reasoning},'test',[{role:'user',content:'test'}]);assert.deepEqual(sent.at(-1).reasoning,{effort:reasoning.enabled?'xhigh':'none'});assert.equal(sent.at(-1).reasoning_effort,undefined)}
  const page=AA.parseAAPage(aaHtml());assert.equal(page.rows.length,5)
  assert.throws(()=>AA.parseAAPage('<title>Artificial Analysis</title><script>throw Error()</script>'),/结构/)
  const candidates=AA.matchAAEvidence(page.rows,[glm,kimi,qwen,flash],{},'aa-intelligence')
  assert.equal(candidates[0].score.score,60);assert.equal(candidates[3].score.score,40,'Flash effort is verified from metadata even when name has no suffix')
  assert.equal(candidates[2].score,undefined,'maximum budget is not an AA max effort')
  const lower=AA.matchAAEvidence(page.rows,[glm,kimi],{reasoning:low},'aa-intelligence')
  assert.equal(lower[0].score.score,20);assert.equal(lower[1].score.score,30)
  assert.equal(AA.matchAAEvidence(page.rows,[glm],{reasoning:{enabled:true,effort:'high'}},'aa-intelligence')[0].score,undefined)
  assert.equal(AA.matchAAEvidence([...page.rows,{...page.rows[0],intelligence:90}],[glm],{},'aa-intelligence')[0].match,'ambiguous')
  const fetched=[];let phase=0
  global.fetch=async(url,init)=>{
    fetched.push(String(url));assert.equal(init.cache,'no-store');assert.equal(init.headers.authorization,undefined)
    const urlObj=new URL(url)
    const html=urlObj.hostname==='arena.ai'?allocationFixture(String(url)):urlObj.pathname==='/models'?aaHtml(rows.filter(r=>!r.slug.endsWith('-low')).map(r=>({...r,intelligenceIndex:r.intelligenceIndex+phase}))):aaHtml(rows.filter(r=>'/models/'+r.slug===urlObj.pathname))
    return new Response(html,{headers:{'content-type':'text/html'}})
  }
  const agents=[{id:'a',reasoning:max},{id:'b',reasoning:low}]
  const evidence=await AA.collectAgentModelEvidence(agents,['aa-intelligence','aa-intelligence'],[glm,kimi])
  assert.deepEqual(E.eligibleModelIds(evidence[0],'quality'),['glm']);assert.deepEqual(E.eligibleModelIds(evidence[1],'quality'),['kimi'])
  assert.equal(fetched.filter(u=>u===AA.aaSource).length,1);assert.ok(fetched.some(u=>u.endsWith('/glm-5-3-low')))
  phase=1;const again=await AA.collectAgentModelEvidence(agents,['aa-intelligence','aa-intelligence'],[glm,kimi]);assert.equal(fetched.filter(u=>u===AA.aaSource).length,2);assert.equal(again[0].candidates[0].score.score,61)
  assert.ok(!fetched.some(u=>u.includes('fixture-only-key')||u.includes('unit.cn-beijing')))
  const plan={id:'p',policy:'quality',caveat:'test',choices:[{agentId:'a',previousModelId:'glm',modelId:'glm',reason:'test',category:'aa-intelligence',supported:true,reasoning:max}],evidence}
  assert.ok(isAgentModelPlan(plan),'AA score without fabricated votes must render safely')
  const broken=structuredClone(plan);broken.evidence[0].candidates[0].score.url='javascript:alert(1)';assert.ok(!isAgentModelPlan(broken))
  const {EngineeringService}=load('src/main/engineering/service.ts'),service=new EngineeringService()
  for(const model of [glm,kimi,qwen])service.saveModel(model)
  let state=service.state(),dev=state.agents.find(a=>a.role==='developer'),review=state.agents.find(a=>a.role==='reviewer')
  service.saveAgent({...dev,reasoning:low});state=service.state()
  assert.deepEqual(state.agents.find(a=>a.id===dev.id).reasoning,low)
  assert.equal(state.agents.find(a=>a.id===review.id).reasoning,undefined,'legacy peer data is not rewritten')
  assert.deepEqual(service.agentModel(state.agents.find(a=>a.id===review.id)).reasoning,max)
  assert.deepEqual(service.agentModel(state.agents.find(a=>a.id===dev.id)).reasoning,low)
  assert.deepEqual(service.research.deps.model('glm',state.agents.find(a=>a.id===dev.id)).reasoning,low)
  assert.equal(service.research.deps.model('qwen',state.agents.find(a=>a.id===dev.id)).reasoning,undefined,'explicit per-project model overrides do not inherit incompatible settings from another binding')
  assert.throws(()=>service.saveAgent({...dev,reasoning:{enabled:false}}),/不能关闭/)
  const saved=fs.readFileSync(service.store.path,'utf8'),restarted=new EngineeringService()
  assert.deepEqual(restarted.state().agents.find(a=>a.id===dev.id).reasoning,low)
  assert.equal(fs.readFileSync(service.store.path,'utf8'),saved,'loading does not rewrite user configuration')
  const config=service.configuration
  global.fetch=async(url,init)=>{
    if(new URL(url).hostname==='artificialanalysis.ai')return new Response(aaHtml(),{headers:{'content-type':'text/html'}})
    if(new URL(url).hostname==='arena.ai')return new Response(allocationFixture(String(url)),{headers:{'content-type':'text/html'}})
    const body=JSON.parse(init.body),input=JSON.parse(body.messages.at(-1).content)
    const choices=input.agents.map(a=>({agentId:a.id,modelId:input.constraints.find(c=>c.agentId===a.id).allowedModelIds[0]}))
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({choices})}}]}),{headers:{'content-type':'application/json'}})
  }
  const allocation=await config.recommendAgentModels('glm','')
  assert.equal(allocation.choices.find(c=>c.agentId===dev.id).modelId,'kimi')
  assert.deepEqual(allocation.choices.find(c=>c.agentId===dev.id).reasoning,low)
  service.saveAgent({...service.state().agents.find(a=>a.id===dev.id),reasoning:max})
  assert.throws(()=>config.applyAgentModels(allocation.id),/配置已变化/)
  const projectId=service.createProject({name:'reasoning-checkpoint',parent:root,brief:'controlled fixture',modelId:'glm'}),project=service.store.project(projectId)
  const feature={id:'f',developerId:dev.id,reviewerId:review.id,revision:1,title:'fixture',description:'fixture',criteria:[],plan:'fixture',tasks:[],dependencies:[],feedback:''}
  const fingerprint=service.executionFingerprint(project,feature)
  service.saveAgent({...service.state().agents.find(a=>a.id===dev.id),reasoning:low})
  assert.notEqual(service.executionFingerprint(project,feature),fingerprint,'reasoning changes invalidate execution checkpoints')
  global.fetch=async()=>{throw Error('offline')}
  const offline=await config.recommendAgentModels('glm','');assert.ok(offline.choices.every(c=>!c.supported&&c.modelId===c.previousModelId))
  console.log('PASS reasoning: provider payloads, max defaults, independent instances, persisted settings, AA effort-specific scores, fresh fetches, missing data, stale-plan rejection and safe IPC')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{global.fetch=realFetch;fs.rmSync(root,{recursive:true,force:true})})
