const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, sandbox, fixture, load, model, answer, call, run, EngineeringService } = r
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const output = path.resolve('.runtime/context-runtime/m4-commands'); fs.mkdirSync(output, {recursive:true})
const actualComplete = model.complete, tests = [], results = [], test=(name,fn)=>tests.push({name,fn})
const receipts=s=>Object.values(s.store.data.receiptJournals?.[JSON.stringify(['p','f'])]?.receipts??{})
function setup(){ const ctx=fixture();ctx.feature.runtimePolicy='receipts-effects-v1';ctx.feature.runtimeBudget=load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('isolated-command');return ctx }
const command = {program:'node',args:['tests/check.cjs'],timeoutSeconds:5,evidenceKind:'unit'}
test('controlled provider survives synchronous durable-save delay without idle connection reset', async () => {
 const server=await provider(()=>({text:'ok',calls:[]}))
 try {
  for(let i=0;i<3;i++) {
   if(i===2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6200)
   const response=await fetch(server.url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:'isolated durable-save delay'}]})})
   assert.equal(response.status,200);assert.match(await response.text(),/ok/)
  }
  assert.equal(server.requests.length,3)
 } finally { await server.close() }
})
for (const boundary of ['none','result','projection']) test('command '+boundary+' preserves execution and evidence exactly once',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'), "const fs=require('node:fs');fs.appendFileSync('.runtime/actual.txt','once\\n');fs.writeFileSync('value.cjs','exports.sum=(a,b)=>a+b;//command');console.log('ACTUAL_COMMAND');")
 let injected=false;const write=fs.writeFileSync
 fs.writeFileSync=(target,content,...rest)=>{const receipt=receipts(ctx.service).find(r=>r.tool==='run_command');if(!injected&&target===ctx.service.store.path+'.tmp'&&receipt&&(boundary==='result'?receipt.status==='completed':boundary==='projection'&&receipt.applied)){injected=true;throw new Error('injected '+boundary)}return write(target,content,...rest)}
 const server=await provider((_req,n)=>n===1?{text:'',calls:[call('run_command',command).calls[0],call('list_files',{}).calls[0]]}:answer({status:'incomplete',summary:'保留人工验收',nextStep:'核对'}))
 try{model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service)
  assert.ok(receipts(ctx.service).length,ctx.feature.contextRuntime.reason);if(boundary!=='none')assert.ok(injected,ctx.feature.contextRuntime.reason)
  const restored=boundary==='none'?ctx.service:new EngineeringService();if(boundary!=='none')await run(restored)
  restored.reconcileRuntime('p','f');restored.reconcileRuntime('p','f')
  const record=receipts(restored).find(r=>r.tool==='run_command');assert.equal(record.status,'completed',JSON.stringify(record));assert.equal(record.attempts,1);assert.ok(record.applied)
  assert.equal(fs.readFileSync(path.join(ctx.root,'.runtime/actual.txt'),'utf8'),'once\n');assert.equal(server.requests.length,2)
  assert.equal(restored.store.project('p').changes.filter(c=>c.path==='value.cjs').length,1)
  const checkpoint=Object.values(restored.store.data.executionCheckpoints)[0];assert.equal(checkpoint.commands.length,1);assert.equal(checkpoint.commands[0].logicalCallId,record.logicalId);assert.equal(record.result.command.evidence.runId,record.command.runId)
  assert.equal(record.result.command.stoppedConfirmed,true);assert.match(record.result.output,/ACTUAL_COMMAND/)
  fs.writeFileSync(path.join(output,boundary+'.json'),JSON.stringify({record,checkpoint,requests:server.requests},null,2))
 }finally{fs.writeFileSync=write;await server.close()}
})
for(const mode of ['cancel','timeout','active-time']) test('actual command '+mode+' stops owned child tree and queued write, retaining output and file effects',async()=>{
 const ctx=setup();if(mode==='active-time')ctx.feature.runtimeBudget.limits.activeMs=2500
 fs.writeFileSync(path.join(ctx.root,'tests/child.cjs'),"require('node:fs').writeFileSync('.runtime/child.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)")
 fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['tests/child.cjs'],{stdio:'inherit',windowsHide:true});fs.writeFileSync('partial.txt','effect before stop');console.log('PARTIAL_OUTPUT');setInterval(()=>console.log('alive'),200)")
 const server=await provider((_req,n)=>n===1?({text:'',calls:[call('run_command',command).calls[0],call('write_file',{path:'queued.txt',content:'must not run'}).calls[0]]}):answer({status:'incomplete',summary:'取消组已核对',nextStep:'人工检查'}));let timer
 try{model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url
 if(mode==='cancel')timer=setInterval(()=>{if(fs.existsSync(path.join(ctx.root,'.runtime/child.json')))ctx.service.stop('p')},25)
 await run(ctx.service);clearInterval(timer)
 const record=receipts(ctx.service).find(r=>r.tool==='run_command');assert.equal(record.status,'cancelled',JSON.stringify(record));assert.ok(record.result.command.stoppedConfirmed)
 assert.match(record.result.output,/PARTIAL_OUTPUT/);assert.equal(fs.existsSync(path.join(ctx.root,'queued.txt')),false);assert.equal(server.requests.length,1)
 const pid=JSON.parse(fs.readFileSync(path.join(ctx.root,'.runtime/child.json'))).pid;assert.throws(()=>process.kill(pid,0));assert.ok(ctx.project.changes.some(c=>c.path==='partial.txt'&&c.after==='effect before stop'))
 if(mode!=='active-time') {
   const restored=new EngineeringService(); restored.reconcileRuntime('p','f'); await run(restored)
   assert.equal(server.requests.length,2,restored.store.project('p').features[0].contextRuntime.reason)
   assert.equal(fs.existsSync(path.join(ctx.root,'queued.txt')),false)
   const completed=receipts(restored);assert.equal(completed.find(r=>r.tool==='run_command').attempts,1)
   assert.equal(completed.find(r=>r.tool==='write_file').attempts,0);assert.equal(completed.find(r=>r.tool==='write_file').status,'cancelled')
 }
 fs.writeFileSync(path.join(output,mode+'.json'),JSON.stringify({record,budget:ctx.feature.runtimeBudget,changes:ctx.project.changes},null,2))
 }finally{clearInterval(timer);await server.close()}
})
test('normal parent exit drains detached ignored-stdio descendants before returning success',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'tests/child.cjs'),"const fs=require('node:fs');fs.writeFileSync('.runtime/orphan.json',JSON.stringify({pid:process.pid}));setInterval(()=>fs.appendFileSync('.runtime/ticks.txt','x'),25)")
 fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['tests/child.cjs'],{detached:true,stdio:'ignore',windowsHide:true}).unref();const timer=setInterval(()=>{if(fs.existsSync('.runtime/orphan.json')){clearInterval(timer);console.log('PARENT_DONE')}},10)")
 const server=await provider((_req,n)=>n===1?call('run_command',command):answer({status:'incomplete',summary:'已核对树',nextStep:'等待'}))
 try { model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service)
  const record=receipts(ctx.service).find(r=>r.tool==='run_command');assert.equal(record.status,'completed',record.reason)
  const pid=JSON.parse(fs.readFileSync(path.join(ctx.root,'.runtime/orphan.json'))).pid;assert.throws(()=>process.kill(pid,0));assert.match(record.result.output,/PARENT_DONE/)
  fs.writeFileSync(path.join(output,'orphan.json'),JSON.stringify({record,pid},null,2))
 }finally{await server.close()}
})
test('tail output persistence failure remains uncertain and stops queued effects',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"console.log('short tail');require('node:fs').writeFileSync('partial.txt','kept')")
 const write=fs.writeFileSync;let injected=false
 fs.writeFileSync=(target,content,...rest)=>{if(String(target).endsWith('supervisor.cjs')){injected=true;content="const fs=require('node:fs'),open=fs.openSync;fs.openSync=(p,f,...rest)=>{if(String(p).endsWith('output.log')&&f==='a')throw new Error('tail durable failure');return open(p,f,...rest)};"+content}return write(target,content,...rest)}
 const server=await provider(()=>({text:'',calls:[call('run_command',command).calls[0],call('write_file',{path:'queued.txt',content:'no'}).calls[0]]}))
 try {model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service);assert.ok(injected)
  const record=receipts(ctx.service).find(r=>r.tool==='run_command');assert.equal(record.status,'uncertain');assert.ok(record.partialCommand.artifact);assert.equal(fs.existsSync(path.join(ctx.root,'queued.txt')),false);assert.equal(server.requests.length,1)
 }finally{fs.writeFileSync=write;await server.close()}
})
test('cancelled group reliably skips unknown tools and invalid arguments before explicit continue',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"require('node:fs').writeFileSync('.runtime/started','yes');setInterval(()=>{},1000)")
 const server=await provider((_req,n)=>n===1?{text:'',calls:[call('run_command',command).calls[0],{id:'unknown',name:'unknown_tool',arguments:'{}'},{id:'broken',name:'write_file',arguments:'{"path":57}'}]}:answer({status:'incomplete',summary:'完整取消',nextStep:'人工核对'}))
 let timer
 try {model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;timer=setInterval(()=>{if(fs.existsSync(path.join(ctx.root,'.runtime/started')))ctx.service.stop('p')},10);await run(ctx.service);clearInterval(timer)
  const restored=new EngineeringService();await run(restored);assert.equal(server.requests.length,2)
  for(const id of ['unknown','broken']){const record=receipts(restored).find(r=>r.providerCallId===id);assert.equal(record.attempts,0);assert.equal(record.status,'cancelled')}
 }finally{clearInterval(timer);await server.close()}
})
for(const corruption of ['output','envelope','receipt','missing-result','missing-launch'])test('corrupt '+corruption+' cannot project completed command evidence',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"require('node:fs').writeFileSync('changed.txt','actual');console.log('ORIGINAL_OUTPUT')")
 let injected=false;const write=fs.writeFileSync;fs.writeFileSync=(target,content,...rest)=>{const receipt=receipts(ctx.service).find(r=>r.tool==='run_command');if(!injected&&target===ctx.service.store.path+'.tmp'&&receipt&&(corruption==='receipt'?receipt.applied:receipt.status==='completed')){injected=true;throw new Error('stop before projection')}return write(target,content,...rest)}
 const server=await provider(()=>call('run_command',command))
 try {model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service);fs.writeFileSync=write;assert.ok(injected,ctx.feature.contextRuntime.reason)
  const record=receipts(ctx.service).find(r=>r.tool==='run_command');const folder=path.join(path.dirname(ctx.service.store.path),'engineering-commands',require('node:crypto').createHash('sha256').update(JSON.stringify(['p','f'])).digest('hex'),record.command.runId)
  if(corruption==='output')fs.writeFileSync(path.join(folder,'output.log'),fs.readFileSync(path.join(folder,'output.log'),'utf8').replace('ORIGINAL','TAMPERED'))
  if(corruption==='envelope'){const file=path.join(folder,'result.json'),data=JSON.parse(fs.readFileSync(file));data.code=57;fs.writeFileSync(file,JSON.stringify(data))}
  if(corruption==='missing-result'||corruption==='missing-launch')fs.unlinkSync(path.join(folder,corruption==='missing-result'?'result.json':'launch.json'))
  if(corruption==='receipt'){const file=ctx.service.store.path,data=JSON.parse(fs.readFileSync(file));const receipt=Object.values(data.receiptJournals[JSON.stringify(['p','f'])].receipts).find(r=>r.tool==='run_command');receipt.result.command.changes[0].after='fabricated';fs.writeFileSync(file,JSON.stringify(data))}
  const restored=new EngineeringService();assert.throws(()=>restored.reconcileRuntime('p','f'));assert.equal(restored.store.project('p').changes.length,0);assert.equal(server.requests.length,1)
  const damaged=receipts(restored).find(r=>r.tool==='run_command')
  if(corruption!=='receipt'){assert.equal(damaged.status,'uncertain');assert.ok(damaged.partialCommand.artifact);const page=JSON.parse(restored.readRuntimeArtifact({projectId:'p',featureId:'f',id:damaged.partialCommand.artifact.id}));assert.equal(page.complete,false);assert.ok(page.content.includes('OUTPUT'));assert.ok(damaged.effects.some(e=>e.includes('changed.txt')))}
  fs.writeFileSync(path.join(output,'corruption-'+corruption+'.json'),JSON.stringify({damaged,changes:restored.store.project('p').changes},null,2))
 } finally {fs.writeFileSync=write;await server.close()}
})
test('old revision command completion remains history and cannot advance a new revision',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"require('node:fs').writeFileSync('old-effect.txt','kept');console.log('OLD_EFFECT')")
 const write=fs.writeFileSync;let injected=false;fs.writeFileSync=(target,content,...rest)=>{const record=receipts(ctx.service).find(r=>r.tool==='run_command');if(!injected&&target===ctx.service.store.path+'.tmp'&&record?.applied){injected=true;throw new Error('projection save failed')}return write(target,content,...rest)}
 const server=await provider(()=>call('run_command',command))
 try{model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service);fs.writeFileSync=write;assert.ok(injected)
  const restored=new EngineeringService(),project=restored.store.project('p');project.features[0].revision++;restored.store.save();restored.reconcileRuntime('p','f');restored.reconcileRuntime('p','f')
  const record=receipts(restored).find(r=>r.tool==='run_command');assert.equal(record.attempts,1);assert.match(record.reason,/旧修订/);assert.equal(project.changes.length,0);assert.equal(Object.values(restored.store.data.executionCheckpoints)[0].commands.length,0)
  assert.throws(()=>restored.runFeature('p','f'),/显式迁移/);assert.equal(server.requests.length,1);assert.equal(fs.readFileSync(path.join(ctx.root,'old-effect.txt'),'utf8'),'kept');assert.equal(project.features[0].stage,'blocked')
 }finally{fs.writeFileSync=write;await server.close()}
})
for(const mode of ['result-save','boundary'])test('preparer command '+mode+' preserves effect evidence and role boundary',async()=>{
 const ctx=setup();let active=ctx.service,reviews=0,injected=false;const write=fs.writeFileSync
 fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"const fs=require('node:fs');fs.appendFileSync('.runtime/preparer-count','once\\n');console.log('PREPARER_ACTUAL');"+(mode==='boundary'?"fs.writeFileSync('value.cjs','unapproved production change')":""))
 const server=await provider(req=>{
  if(req.system.includes('VERIFICATION_DIAGNOSIS'))return answer({gaps:active.store.project('p').features[0].verificationPreparation.gaps.map(g=>({id:g.id,disposition:'automatic',reason:'项目内检查资料待准备',nextStep:'运行准备检查脚本'}))})
  if(req.system.includes('VERIFICATION_PREPARATION'))return req.body.messages.some(m=>m.role==='tool')?answer({status:'ready',summary:'已保存准备记录',nextStep:'独立验证'}):{text:'',calls:[call('run_command',command).calls[0],call('write_file',{path:'tests/queued.cjs',content:'must not run on boundary'}).calls[0]]}
  if(req.system.includes('你是 Coprojer 的开发智能体'))return answer({status:'complete',summary:'原实现已交付',nextStep:'独立验证'})
  reviews++;return reviews===1?answer({summary:'缺少检查资料',results:[{criterion:ctx.feature.criteria[0],passed:false,status:'unverified',evidence:'需要项目内可执行检查资料，尚未验证',evidenceKind:'inspection'}]}):{httpStatus:503,error:{message:'isolated independent reviewer stop'}}
 })
 fs.writeFileSync=(target,content,...rest)=>{const receipt=receipts(ctx.service).find(r=>r.tool==='run_command');if(mode==='result-save'&&!injected&&target===ctx.service.store.path+'.tmp'&&receipt?.status==='completed'){injected=true;throw new Error('preparer result save failure')}return write(target,content,...rest)}
 try{model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service);fs.writeFileSync=write
  if(mode==='result-save'){assert.ok(injected,ctx.feature.contextRuntime.reason);active=new EngineeringService();await run(active);assert.equal(reviews,2)}
  const record=receipts(active).find(r=>r.tool==='run_command');assert.equal(record.role,'preparer');assert.equal(record.attempts,1);assert.equal(fs.readFileSync(path.join(ctx.root,'.runtime/preparer-count'),'utf8'),'once\n')
  if(mode==='boundary'){assert.equal(record.status,'failed');assert.ok(record.result.command.boundaryError);assert.equal(fs.existsSync(path.join(ctx.root,'tests/queued.cjs')),false)}
  else {const f=active.store.project('p').features[0];assert.equal(f.verificationPreparation.attempts[0].actions.filter(a=>a.startsWith('run_command:')).length,1);assert.ok(active.store.project('p').changes.some(c=>c.path==='tests/queued.cjs'))}
  fs.writeFileSync(path.join(output,'preparer-'+mode+'.json'),JSON.stringify({record,reviews},null,2))
 }finally{fs.writeFileSync=write;fs.writeFileSync(path.join(output,'preparer-'+mode+'-transport.json'),JSON.stringify({transport:server.transport,errors:server.errors,reason:active.store.project('p').features[0].contextRuntime?.reason,events:active.store.project('p').events},null,2));await server.close()}
})
test('command permission revoked before execution starts no process or queued effect',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"require('node:fs').writeFileSync('forbidden.txt','no')")
 const server=await provider((_req,n)=>{if(n===1){ctx.service.store.data.agents.find(a=>a.id==='developer').tools=[];return{text:'',calls:[call('run_command',command).calls[0],call('write_file',{path:'forbidden.txt',content:'no'}).calls[0]]}}return answer({status:'incomplete',summary:'无执行权限',nextStep:'用户决定'})})
 try{model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service);assert.equal(fs.existsSync(path.join(ctx.root,'forbidden.txt')),false);assert.equal(ctx.feature.runtimeBudget.used.tools,0);assert.equal(receipts(ctx.service).length,0);assert.ok(server.requests.length<=2)}finally{await server.close()}
})
test('isolated command lease save failure starts no actual process',async()=>{
 const ctx=setup();ctx.feature.stage='blocked';ctx.feature.verificationPending=true;fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"require('node:fs').writeFileSync('must-not-exist.txt','bad')")
 const write=fs.writeFileSync;let injected=false;fs.writeFileSync=(target,content,...rest)=>{if(String(target).endsWith('lease.json')){injected=true;throw new Error('lease save unavailable')}return write(target,content,...rest)}
 const server=await provider(()=>call('run_command',command))
 try{model.complete=actualComplete;ctx.service.store.data.models[0].baseUrl=server.url;await run(ctx.service,true);assert.ok(injected);assert.equal(server.requests.length,1);assert.equal(fs.existsSync(path.join(ctx.root,'must-not-exist.txt')),false)}
 finally{fs.writeFileSync=write;await server.close()}
})
async function main(){for(const {name,fn} of tests)try{await fn();results.push({name,status:'passed'});console.log('PASS:',name)}catch(error){results.push({name,status:'failed',error:error.stack});console.error('FAIL:',name,error.stack)}fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));assert.ok(results.every(r=>r.status==='passed'))}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{model.complete=actualComplete;fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:3})})
