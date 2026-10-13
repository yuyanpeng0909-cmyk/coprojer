// Paired controlled replay. Timing is measured, never manufactured by sleeps.
const r=require('./fixtures/verification-runtime.cjs'),{fs,path,assert,sandbox,fixture,load,model,answer,call,run,EngineeringService}=r
const {provider}=require('./fixtures/context-runtime-provider.cjs'),{createHash}=require('node:crypto'),{performance}=require('node:perf_hooks')
const files=load('src/main/engineering/files.ts'),actualTool=files.executeTool,actualComplete=model.complete
const output=path.resolve('.runtime/context-runtime',process.argv.includes('--receipt-cost')?'m6-efficiency-receipt-cost':process.argv.includes('--patch-guard')?'m6-efficiency-patch-guard':'m6-efficiency');fs.mkdirSync(output,{recursive:true})
const hash=x=>createHash('sha256').update(x).digest('hex'),key=JSON.stringify(['p','f']),records=s=>Object.values(s.store.data.receiptJournals?.[key]?.receipts??{})
const results=[],cases=['short','longread','patch','parallel','compactions','recovery','handoff']
const tool=(name,args,id)=>({...call(name,args).calls[0],id}),group=calls=>({text:'',calls})
function measures(values){const s=[...values].sort((a,b)=>a-b);return {n:s.length,min:s[0],median:s[Math.floor(s.length/2)],max:s.at(-1)}}
function save(){const summary=cases.map(caseId=>({caseId,arms:['baseline','optimized'].map(arm=>{const rows=results.filter(x=>x.caseId===caseId&&x.arm===arm&&x.status==='passed');return {arm,samples:rows.length,elapsedMs:measures(rows.map(x=>x.elapsedMs)),wireBytes:measures(rows.map(x=>x.wireBytes)),diskBytes:measures(rows.map(x=>x.io.bytes)),returnedCharacters:measures(rows.map(x=>x.returnedCharacters))}})}));fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({kind:'controlled HTTP replay, no real supplier token usage',sourceHashes:Object.fromEntries(['runtime','service','efficient-files','read-groups'].map(n=>[n,hash(fs.readFileSync('src/main/engineering/'+n+'.ts'))])),results,summary},null,2))}
async function sample(caseId,arm,repetition){
 const ctx=fixture(),optimized=arm==='optimized',agent=ctx.service.store.data.agents.find(a=>a.id==='developer')
 ctx.feature.runtimePolicy='receipts-effects-v1';ctx.feature.runtimeBudget=load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('paired-'+caseId)
 ctx.feature.title='固定配对 '+caseId;ctx.feature.description='只用隔离合成材料核对固定事实，最后保持 incomplete 等待独立核对';ctx.feature.criteria=['固定事实、来源和最终文件一致，不自动接受'];ctx.feature.plan='按固定合同读取并保留证据'
 if(optimized)agent.tools.push(...({short:['read_file_lines'],longread:['search_files','read_file_lines'],patch:['patch_file'],compactions:['search_files','read_file_lines','patch_file']}[caseId]??[]))
 agent.readConcurrency=optimized&&['parallel','recovery','handoff'].includes(caseId)?2:1
 const material={};const put=(name,text)=>{material[name]=text;fs.writeFileSync(path.join(ctx.root,name),text)}
 put('a.txt','FACT=paired-A\n'+'a'.repeat(3500));put('b.txt','FACT=paired-B\n'+'b'.repeat(3500))
 const long=Array.from({length:500},(_,i)=>i===372?'FACT=needle-372':`line ${String(i).padStart(3,'0')} `+'filler '.repeat(10)).join('\n')
 if(caseId==='longread')put('long.txt',long)
 if(caseId==='patch')put('edit.txt',Array.from({length:80},(_,i)=>`line ${i} `+'value '.repeat(8)).join('\n')+'\n')
 if(caseId==='compactions')for(let i=0;i<210;i++){const prefix='SOURCE_'+i+'_';put('material-'+i+'.txt',prefix+'中'.repeat(6000-prefix.length))}
 let injected=false,stopped=false,phase='source',service=ctx.service
 const facts=caseId==='longread'?['FACT=needle-372']:caseId==='compactions'?['SOURCE_209_']:caseId==='patch'?['LINE 40']:['FACT=paired-A']
 const finish=()=>answer({status:'incomplete',summary:facts.join(';'),nextStep:'等待独立核对'})
 const server=await provider((req,n)=>{
  const projection=JSON.parse(req.system.split('宿主当前任务事实（每次请求重新装载）：\n').at(-1).split('\n')[0])
  assert.equal(projection.goal.title,ctx.feature.title);assert.deepEqual(projection.criteria,ctx.feature.criteria);assert.equal(projection.taskRevision,1);assert.equal(projection.authorization.finalAcceptance,'user-only');assert.equal(projection.authorization.root,ctx.root);assert.deepEqual([...projection.authorization.tools].sort(),[...agent.tools].sort())
  if(phase==='target'){assert.equal(req.body.model,'fixture-target');assert.ok(JSON.stringify(req.body).includes('FACT=paired-A'));return finish()}
  if(caseId==='short')return n===1?group([tool(optimized?'read_file_lines':'read_file',optimized?{path:'a.txt',startLine:1,endLine:1}:{path:'a.txt'},'short')]):finish()
  if(caseId==='longread'){
   if(!optimized)return n===1?group(Array.from({length:Math.ceil(long.length/6000)},(_,i)=>tool('read_file',{path:'long.txt',offset:i*6000,limit:6000},'page-'+i))):finish()
   return n===1?group([tool('search_files',{scope:'long.txt',query:'FACT=',limit:5},'find')]):n===2?group([tool('read_file_lines',{path:'long.txt',startLine:372,endLine:374,version:hash(long)},'context')]):finish()
  }
  if(caseId==='patch')return n===1?group([tool('read_file',{path:'edit.txt'},'read')]):n===2?group([tool(optimized?'patch_file':'write_file',optimized?{path:'edit.txt',expectedVersion:hash(material['edit.txt']),startLine:41,endLine:41,oldText:'line 40',newText:'LINE 40'}:{path:'edit.txt',content:material['edit.txt'].replace('line 40','LINE 40')},'modify')]):finish()
  if(caseId==='compactions')return n<=21?group(Array.from({length:10},(_,i)=>tool('read_file',{path:'material-'+((n-1)*10+i)+'.txt'},'group-'+n+'-'+i))):finish()
  return n===1?group(['a.txt','b.txt'].map((p,i)=>tool('read_file',{path:p},'read-'+i))):finish()
 })
 const declaration={contextWindowTokens:32000,maxOutputTokens:1000,outputParameter:'max_tokens',windowAccounting:'input-plus-output'}
 Object.assign(service.store.data.models[0],{baseUrl:server.url,capabilities:declaration});if(caseId==='compactions')delete service.store.data.models[0].capabilities
 if(caseId==='handoff')service.store.data.models.push({...service.store.data.models[0],id:'target',model:'fixture-target',protocol:'responses',capabilities:{...declaration,outputParameter:'max_output_tokens'}})
 service.store.save();model.complete=actualComplete
 const io={calls:0,bytes:0,sumReadMs:0},executions=[],wire=[],modelCalls=[],rawRead=fs.readFileSync,asyncRead=fs.promises.readFile,rawFetch=globalThis.fetch
 model.complete=async(...args)=>{const start=performance.now(),entry={budget:args[6]?.budget};modelCalls.push(entry);try{const reply=await actualComplete(...args);entry.usage=reply.usage??{};return reply}finally{entry.elapsedMs=performance.now()-start}}
 const under=file=>typeof file==='string'&&path.resolve(file).startsWith(ctx.root+path.sep)
 const observe=(file,data,start)=>{if(under(file)){io.calls++;io.bytes+=Buffer.isBuffer(data)?data.length:Buffer.byteLength(data);io.sumReadMs+=performance.now()-start}}
 fs.readFileSync=(file,...args)=>{const start=performance.now(),data=rawRead(file,...args);observe(file,data,start);return data}
 fs.promises.readFile=async(file,...args)=>{const start=performance.now(),data=await asyncRead(file,...args);observe(file,data,start);return data}
 globalThis.fetch=async(url,init)=>{const body=init.body,entry={characters:body.length,bytes:Buffer.byteLength(body),hash:hash(body),phase,protocol:String(url).endsWith('/responses')?'responses':'chat',started:performance.now()};wire.push(entry);try{const response=await rawFetch(url,init);entry.headersMs=performance.now()-entry.started;entry.status=response.status;return response}catch(error){entry.error=error.message;throw error}}
 let finishA;const aComplete=new Promise(resolve=>{finishA=resolve})
 files.executeTool=async(...args)=>{const start=performance.now(),item={tool:args[4],args:args[5]};executions.push(item);try{const value=await actualTool(...args);if(caseId==='recovery'&&item.args.path==='b.txt'&&!injected)await aComplete;item.output=value;return value}finally{item.ms=performance.now()-start}}
 const rawSave=service.store.save.bind(service.store)
 service.store.save=()=>{
  const current=records(service)
  if(caseId==='recovery'&&!injected&&current.some(x=>x.args.path==='b.txt'&&x.status==='completed')){injected=true;throw new Error('paired B result save failure')}
  rawSave();if(current.some(x=>x.args.path==='a.txt'&&x.status==='completed'))finishA()
  if(caseId==='handoff'&&!stopped&&current.filter(x=>x.status==='completed').length===2){stopped=true;service.stop('p')}
 }
 const started=performance.now();let row
 try{
  if(caseId==='compactions'){
   service.runFeature('p','f');const deadline=Date.now()+300000
   while(service.store.project('p').activity&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20))
   const unfinished=service.store.project('p').activity
   if(unfinished){service.stop('p');const cleanup=Date.now()+15000;while(service.store.project('p').activity&&Date.now()<cleanup)await new Promise(resolve=>setTimeout(resolve,20))}
   assert.equal(unfinished,null,'210 durable receipts and twenty compactions settle within five minutes')
  }else await run(service)
  if(caseId==='recovery'){assert.ok(injected);assert.equal(server.requests.length,1);service=new EngineeringService();await run(service)}
  if(caseId==='handoff'){assert.ok(stopped);const used=structuredClone(service.store.project('p').features[0].runtimeBudget.used);service.prepareRuntimeHandoff('p','f',{action:'switch',modelId:'target'});assert.deepEqual(service.store.project('p').features[0].runtimeBudget.used,used);phase='target';await run(service)}
  const elapsedMs=performance.now()-started,project=service.store.project('p'),feature=project.features[0],receipts=records(service),compactions=project.events.filter(e=>e.kind==='context-compaction').length
  assert.deepEqual(server.errors,[]);assert.equal(feature.stage,'blocked');assert.ok(receipts.every(x=>x.status==='completed'))
  if(caseId==='compactions'){assert.ok(compactions>=20,'twenty actual compactions: '+compactions);assert.equal(receipts.length,210);for(const rec of receipts)assert.equal(JSON.parse(rec.result.output).content,material[rec.args.path])}
  if(caseId==='recovery'){assert.equal(executions.filter(x=>x.args.path==='a.txt').length,1);assert.equal(executions.filter(x=>x.args.path==='b.txt').length,2);assert.equal(feature.runtimeBudget.used.tools,3)}
  if(caseId==='handoff'){assert.equal(executions.length,2);assert.ok(receipts.every(x=>x.attempts===1));assert.ok(wire.some(x=>x.phase==='target'&&x.protocol==='responses'))}
  const expectedFile=caseId==='patch'?material['edit.txt'].replace('line 40','LINE 40'):null
  if(expectedFile!==null){assert.equal(rawRead(path.join(ctx.root,'edit.txt'),'utf8'),expectedFile);assert.equal(project.changes.length,1);assert.equal(receipts.filter(r=>['write_file','patch_file'].includes(r.tool)).length,1);assert.ok(receipts.filter(r=>['write_file','patch_file'].includes(r.tool)).every(r=>r.attempts===1));assert.ok(expectedFile.includes(facts[0]))}
  if(['short','longread','parallel'].includes(caseId))assert.ok(receipts.some(x=>x.result.output.includes(facts[0])),'fixed fact is backed by actual tool output')
  const final=service.store.data.executionCheckpoints[key];load('src/main/engineering/protocol-history.ts').assertCompleteToolRounds(final.messages)
  const finalReply=JSON.parse(final.messages.filter(m=>m.role==='assistant'&&!m.calls?.length).at(-1).content);assert.equal(finalReply.status,'incomplete');assert.ok(facts.every(f=>finalReply.summary.includes(f)))
  const ranges=new Map();let repeatedRanges=0,returnedCharacters=0
  for(const ex of executions){if(!ex.output)continue;returnedCharacters+=ex.output.length;let page;try{page=JSON.parse(ex.output)}catch{continue}if(typeof page.content!=='string'||!Number.isInteger(page.offset))continue;const k=JSON.stringify([ex.args.path,page.version,page.offset,page.offset+page.content.length]);if(ranges.has(k)&&!ex.args.reviewReason)repeatedRanges++;ranges.set(k,true)}
  row={caseId,arm,repetition,status:'passed',materialHash:hash(JSON.stringify(material)),effectiveConfiguration:{tools:agent.tools,readConcurrency:agent.readConcurrency,model:'fixture',protocolSequence:caseId==='handoff'?['chat','responses']:['chat'],capabilities:caseId==='compactions'?'unknown':declaration},elapsedMs,io,wireBytes:wire.reduce((s,x)=>s+x.bytes,0),wireCharacters:wire.reduce((s,x)=>s+x.characters,0),wire,modelCalls,toolAttempts:executions.length,returnedCharacters,repeatedRanges,unnecessaryRepeatedRanges:caseId==='recovery'?0:repeatedRanges,recoveryRepeatReason:caseId==='recovery'?'B read actually ran but its result was not durably saved; A is reused':undefined,compactions,usage:'unknown - controlled provider supplies no usage',budget:feature.runtimeBudget,quality:{facts,finalFileHash:expectedFile===null?null:hash(expectedFile),stage:feature.stage,falseAcceptance:0,duplicateCompletedEffects:0,reason:feature.feedback},executions:executions.map(x=>({...x,output:undefined,outputHash:x.output?hash(x.output):null,outputCharacters:x.output?.length??0})),receiptAttempts:receipts.map(x=>({logicalId:x.logicalId,tool:x.tool,attempts:x.attempts,status:x.status}))}
 }catch(error){row={caseId,arm,repetition,status:'failed',error:error.stack,events:service.store.project('p').events.slice(-6).map(e=>({...e,message:e.message.slice(0,300)})),requests:server.requests.length,wire,modelCalls,io,elapsedMs:performance.now()-started};throw error}
 finally{if(row){row.requestLedger=service.store.project('p').features[0].contextRuntime?.requests;row.finalStage=service.store.project('p').features[0].stage;row.receiptResults=records(service).map(r=>({logicalId:r.logicalId,tool:r.tool,status:r.status,attempts:r.attempts,characters:r.result?.output.length??0,bytes:r.result?Buffer.byteLength(r.result.output):0,hash:r.result?hash(r.result.output):null}));row.totalPersistedResultCharacters=row.receiptResults.reduce((n,r)=>n+r.characters,0);row.totalPersistedResultBytes=row.receiptResults.reduce((n,r)=>n+r.bytes,0);row.measuredEffects={legacyExecutorWriteDispatches:executions.filter(e=>['write_file','patch_file'].includes(e.tool)).length,completedEffectAttempts:records(service).filter(r=>r.strategy==='file-v1'&&r.status==='completed').map(r=>r.attempts),automaticAcceptance:service.store.project('p').features[0].stage==='done'};}fs.readFileSync=rawRead;fs.promises.readFile=asyncRead;files.executeTool=actualTool;globalThis.fetch=rawFetch;await server.close();results.push(row);save()}
 console.log('PASS:',caseId,arm,repetition,'ms='+Math.round(row.elapsedMs),'wire='+row.wireBytes,'compactions='+row.compactions)
}
async function main(){const selected=process.argv.slice(2);for(const caseId of cases.filter(x=>!selected.length||selected.includes(x)))for(let repetition=1;repetition<=3;repetition++)for(const arm of repetition%2?['baseline','optimized']:['optimized','baseline'])await sample(caseId,arm,repetition);assert.ok(results.every(x=>x.status==='passed'))}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{model.complete=actualComplete;fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:3})})
