const r=require('./fixtures/verification-runtime.cjs'),{fs,path,assert,sandbox,fixture,load,model,answer,call,EngineeringService}=r
const {provider}=require('./fixtures/context-runtime-provider.cjs')
const actual=model.complete,output=path.resolve('.runtime/context-runtime/m4-entry-budgets');fs.mkdirSync(output,{recursive:true})
const tests=[],results=[],test=(name,fn)=>tests.push({name,fn})
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(fn())return;await delay(10)}throw new Error('entry did not settle')}
async function idle(project){await until(()=>!project.activity&&!project.designActivity)}
let count=0
function setup(){count++;const ctx=fixture(),service=ctx.service,pid=service.createProject({name:'Budget project '+count,parent:sandbox,brief:'isolated',modelId:'fixture'}),project=service.store.project(pid)
 const id=service.saveFeature(pid,null,{title:'新功能',module:'核心',description:'isolated',criteria:['检查实际行为'],scope:'current',dependencies:[],developerId:'developer',reviewerId:'reviewer'}),feature=project.features.find(f=>f.id===id)
 service.setDefaultAssistantModel('fixture');const sid=service.createAssistantSession(pid).id,session=service.store.data.assistant.sessions.find(s=>s.id===sid);feature.stage='solution';service.store.save();return {...ctx,project,feature,session,pid,id,sid}
}
test('real creation defaults are durable and preserve existing legacy objects',async()=>{
 const ctx=setup();assert.equal(ctx.feature.runtimePolicy,'receipts-effects-v1')
 for(const owner of [ctx.project,ctx.feature,ctx.session]){assert.equal(owner.runtimeBudget.historical.kind,'exact');assert.equal(owner.runtimeBudget.limits.requests,512);assert.equal(owner.runtimeBudget.used.requests,0)}
 assert.equal(ctx.service.store.project('p').features[0].runtimePolicy,undefined)
 const restored=new EngineeringService();assert.equal(restored.store.project(ctx.pid).features[0].runtimePolicy,'receipts-effects-v1')
 const prior=ctx.service.store.data.assistant.sessions.length,save=ctx.service.store.save;ctx.service.store.save=()=>{throw new Error('creation save failed')}
 assert.throws(()=>ctx.service.createAssistantSession(ctx.pid),/save failed/);assert.equal(ctx.service.store.data.assistant.sessions.length,prior);ctx.service.store.save=save
})
test('new feature executes the durable tool path without injected runtime configuration',async()=>{
 const ctx=setup();ctx.feature.stage='ready';ctx.feature.plan='已确认隔离方案';ctx.feature.tasks=[{id:'t',title:'执行',done:false}]
 const server=await provider((_req,n)=>n===1?call('write_file',{path:'created.txt',content:'actual'}):answer({status:'incomplete',summary:'已执行',nextStep:'人工核对'}))
 try{model.complete=actual;ctx.service.store.data.models[0].baseUrl=server.url;ctx.service.runFeature(ctx.pid,ctx.id);await idle(ctx.project)
  assert.equal(fs.readFileSync(path.join(ctx.project.root,'created.txt'),'utf8'),'actual');assert.equal(ctx.feature.runtimeBudget.used.tools,1);assert.equal(ctx.feature.runtimeBudget.used.requests,2)
  const journal=ctx.service.store.data.receiptJournals[JSON.stringify([ctx.pid,ctx.id])];assert.equal(Object.values(journal.receipts)[0].status,'completed')
 }finally{await server.close()}
})
test('planning continues after service restart without resetting requests or tools',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.project.root,'read.txt'),'read actual');const server=await provider((_req,n)=>n===1?call('read_file',{path:'read.txt'}):answer({plan:'待确认方案',tasks:['确认']}))
 try{model.complete=actual;ctx.service.store.data.models[0].baseUrl=server.url;ctx.service.generatePlan(ctx.pid,ctx.id);await idle(ctx.project)
  assert.equal(ctx.feature.runtimeBudget.used.requests,2);assert.equal(ctx.feature.runtimeBudget.used.tools,1)
  const restored=new EngineeringService(),p=restored.store.project(ctx.pid);restored.generatePlan(ctx.pid,ctx.id);await idle(p)
  assert.equal(p.features[0].runtimeBudget.used.requests,3);assert.equal(p.features[0].runtimeBudget.used.tools,1)
 }finally{await server.close()}
})
test('assistant history clear and restart cannot reset the request allowance',async()=>{
 const ctx=setup(),server=await provider(()=>({text:'实际回复',calls:[]}))
 try{model.complete=actual;ctx.service.store.data.models[0].baseUrl=server.url;ctx.service.adjustRuntimeBudget({sessionId:ctx.sid},{requests:2,tools:0,activeMs:60000},'隔离测试有限额度')
  await ctx.service.sendAssistantMessage('一',undefined,ctx.sid);await ctx.service.sendAssistantMessage('二',undefined,ctx.sid);ctx.service.clearAssistantChat(ctx.sid)
  const restored=new EngineeringService();await restored.sendAssistantMessage('触限',undefined,ctx.sid)
  const session=restored.store.data.assistant.sessions.find(s=>s.id===ctx.sid);assert.equal(session.runtimeBudget.used.requests,2);assert.equal(server.requests.length,2);assert.equal(session.contextRuntime.status,'paused')
  restored.adjustRuntimeBudget({sessionId:ctx.sid},{requests:3,tools:0,activeMs:60000},'明确增加一次');await restored.sendAssistantMessage('三',undefined,ctx.sid);assert.equal(server.requests.length,3);assert.equal(session.runtimeBudget.used.requests,3)
 }finally{await server.close()}
})
for(const mode of ['tool-cap','permission-revoked'])test('planning '+mode+' starts no unauthorized read',async()=>{
 const ctx=setup(),files=load('src/main/engineering/files.ts'),execute=files.executeReadOnly;let reads=0
 files.executeReadOnly=(...args)=>{reads++;return execute(...args)}
 fs.writeFileSync(path.join(ctx.project.root,'private.txt'),'MUST_NOT_READ')
 const server=await provider((_req,n)=>{if(n===1){if(mode==='permission-revoked')ctx.service.store.data.agents.find(a=>a.id===ctx.project.plannerId).tools=[];return call('read_file',{path:'private.txt'})}return answer({plan:'工具受限',tasks:['明确授权']})})
 try{model.complete=actual;ctx.service.store.data.models[0].baseUrl=server.url;if(mode==='tool-cap')ctx.service.adjustRuntimeBudget({projectId:ctx.pid,featureId:ctx.id},{requests:3,tools:0,activeMs:60000},'工具额度为零')
  ctx.service.generatePlan(ctx.pid,ctx.id);await idle(ctx.project);assert.equal(reads,0);assert.equal(ctx.feature.runtimeBudget.used.tools,0);assert.ok(server.requests.every(req=>!JSON.stringify(req.body.messages).includes('MUST_NOT_READ')))
  if(mode==='tool-cap'){assert.equal(server.requests.length,1);assert.equal(ctx.feature.contextRuntime.status,'paused')}else assert.equal(server.requests.length,2)
 }finally{files.executeReadOnly=execute;await server.close()}
})
for(const entry of ['planning','assistant'])for(const limit of [1,2])test(entry+' capacity retry obeys cumulative request limit '+limit,async()=>{
 const ctx=setup(),owner=entry==='assistant'?ctx.session:ctx.feature,target=entry==='assistant'?{sessionId:ctx.sid}:{projectId:ctx.pid,featureId:ctx.id}
 if(entry==='assistant')for(let i=0;i<25;i++)ctx.session.messages.push({id:'u'+i,role:'user',text:'history '+i+'中'.repeat(4000),status:'complete',at:new Date().toISOString()},{id:'a'+i,role:'assistant',text:'answer '+i+'文'.repeat(4000),status:'complete',at:new Date().toISOString()})
 else for(let i=0;i<5;i++)fs.writeFileSync(path.join(ctx.project.root,'retry-'+i+'.txt'),'retry '+i+'X'.repeat(5000))
 const cap=entry==='assistant'?limit:limit+1,server=await provider((_req,n)=>{
  if(entry==='planning'&&n===1)return{text:'',calls:Array.from({length:5},(_,i)=>({id:'r'+i,name:'read_file',arguments:JSON.stringify({path:'retry-'+i+'.txt'})}))}
  if(n===(entry==='assistant'?1:2))return{httpStatus:400,error:{message:'maximum context length exceeded'}}
  return entry==='assistant'?{text:'已回复',calls:[]}:answer({plan:'方案',tasks:['确认']})
 })
 try{model.complete=actual;ctx.service.store.data.models[0].baseUrl=server.url;ctx.service.adjustRuntimeBudget(target,{requests:cap,tools:5,activeMs:60000},'容量重试须计入额度')
  if(entry==='assistant')await ctx.service.sendAssistantMessage('明确提问',undefined,ctx.sid);else{ctx.service.generatePlan(ctx.pid,ctx.id);await idle(ctx.project)}
  assert.equal(server.requests.length,cap,owner.contextRuntime.reason);assert.equal(owner.runtimeBudget.used.requests,cap);assert.equal(owner.contextRuntime.status,limit===1?'paused':'completed',owner.contextRuntime.reason)
 }finally{await server.close()}
})
for(const entry of ['planning','assistant','designer'])test(entry+' request reservation failure sends zero HTTP requests',async()=>{
 const ctx=setup(),owner=entry==='assistant'?ctx.session:entry==='designer'?ctx.project:ctx.feature,write=fs.writeFileSync,server=await provider(()=>{throw new Error('must not send')});let injected=false
 fs.writeFileSync=(target,content,...rest)=>{if(target===ctx.service.store.path+'.tmp'&&owner.runtimeBudget.used.requests>0){injected=true;throw new Error('request reservation unavailable')}return write(target,content,...rest)}
 try{model.complete=actual;ctx.service.store.data.models[0].baseUrl=server.url
  if(entry==='assistant')await ctx.service.sendAssistantMessage('保留问题',undefined,ctx.sid);else if(entry==='designer'){ctx.service.generatePrototype(ctx.pid,'完整原型','fixture');await idle(ctx.project)}else{ctx.service.generatePlan(ctx.pid,ctx.id);await idle(ctx.project)}
  assert.ok(injected,owner.contextRuntime?.reason);assert.equal(server.requests.length,0);assert.equal(owner.runtimeBudget.used.requests,0)
 }finally{fs.writeFileSync=write;await server.close()}
})
test('designer live and stopping lease reject budget changes and preserve cumulative history',async()=>{
 const ctx=setup();let release;const held=new Promise(r=>release=r),server=await provider(async(_req,n)=>{if(n===1)await held;return{text:'<!doctype html><html><body>实际原型</body></html>',calls:[]}})
 try{model.complete=actual;ctx.service.store.data.models[0].baseUrl=server.url;ctx.service.generatePrototype(ctx.pid,'完整原型','fixture');await until(()=>server.requests.length===1)
  const target={projectId:ctx.pid},limits={requests:5,tools:5,activeMs:60000};assert.throws(()=>ctx.service.adjustRuntimeBudget(target,limits,'运行中'),/停止|结束/)
  ctx.service.stopDesign(ctx.pid);assert.throws(()=>ctx.service.adjustRuntimeBudget(target,limits,'停止收尾'),/停止|结算|结束/);release();await until(()=>!ctx.project.runtimeBudget.activeLease)
  ctx.service.adjustRuntimeBudget(target,limits,'停止后明确调整');const restored=new EngineeringService(),project=restored.store.project(ctx.pid);restored.generatePrototype(ctx.pid,'重启后原型','fixture');await idle(project)
  assert.equal(project.runtimeBudget.used.requests,2);assert.equal(project.prototypes.length,1)
 }finally{release();await server.close()}
})
test('legacy explicit allowance retains unknown history and rolls back failed save',async()=>{
 const ctx=fixture(),save=ctx.service.store.save,target={projectId:'p'},limits={requests:1,tools:1,activeMs:60000}
 ctx.service.store.save=()=>{throw new Error('grant save failure')};assert.throws(()=>ctx.service.adjustRuntimeBudget(target,limits,'明确授予'),/grant save/);assert.equal(ctx.project.runtimeBudget,undefined);ctx.service.store.save=save
 ctx.service.adjustRuntimeBudget(target,limits,'明确授予后续有限额度');assert.equal(ctx.project.runtimeBudget.historical.kind,'unknown');assert.equal(ctx.project.runtimeBudget.adjustments[0].source,'local-user');assert.equal(ctx.feature.runtimePolicy,undefined)
})
async function main(){for(const {name,fn} of tests)try{await fn();results.push({name,status:'passed'});console.log('PASS:',name)}catch(error){results.push({name,status:'failed',error:error.stack});console.error('FAIL:',name,error.stack)}fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));assert.ok(results.every(r=>r.status==='passed'))}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{model.complete=actual;fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:3})})
