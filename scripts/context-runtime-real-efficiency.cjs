// Explicit opt-in real-connection samples; synthetic files, no visible windows.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{performance}=require('node:perf_hooks')
const output=path.resolve('.runtime/context-runtime/m6-real-efficiency'),hash=x=>createHash('sha256').update(x).digest('hex')
if(process.argv.includes('--verify-existing')){
 const report=JSON.parse(fs.readFileSync(path.join(output,'results.json'),'utf8'));assert.equal(report.results.length,6);assert.equal(report.globalConfigurationChanged,false)
 const disk=JSON.parse(fs.readFileSync(path.join(report.isolated,'profile','engineering-v1.json'),'utf8')),key=JSON.stringify(['p','f']),last=report.results.at(-1)
 const durable=Object.values(disk.receiptJournals[key].receipts);assert.equal(durable.filter(r=>r.status==='completed').length,1);assert.equal(durable.filter(r=>r.status==='failed').length,1);assert.ok(durable.every(r=>r.attempts===1));assert.equal(disk.projects[0].features[0].stage,'blocked');assert.equal(disk.projects[0].changes.length,0);assert.equal(hash(fs.readFileSync(path.join(report.isolated,last.arm+'-'+last.repetition,'note.txt'))),report.materialHash)
 assert.ok(durable.find(r=>r.status==='completed').result.output.includes('FACT=paired-real-7f29'))
 for(const sample of report.results){assert.equal(sample.receipts.filter(r=>r.status==='completed').length,1);assert.ok(sample.receipts.every(r=>r.attempts===1));assert.equal(sample.quality.automaticAcceptance,false);assert.equal(sample.finalStage,'blocked');assert.ok(sample.modelCalls.every(r=>r.actualUsage))}
 const verification={status:'observations-verified',source:'saved real HTTP run; no new provider requests',originalHarnessExit:1,explanation:'The last sample correctly rejected an absolute path then completed one relative-path read. Two receipts are not two successful reads. Answer quality and tool adoption remain measured outcomes.',sampleCount:6,qualityComplete:report.results.filter(s=>s.quality.completedTaskReport).length,factInAnswer:report.results.filter(s=>s.quality.factInAnswer).length,structuredIncomplete:report.results.filter(s=>s.quality.structuredIncomplete).length,optimizedToolAdoption:report.results.filter(s=>s.arm==='optimized'&&s.quality.optimizedToolChosen).length,absolutePathRejectedThenCorrected:1,automaticAcceptance:0,actualUsage:report.results.map(s=>({arm:s.arm,repetition:s.repetition,usage:s.modelCalls.map(m=>m.actualUsage)}))}
 verification.correctFactValue=report.results.filter(s=>s.answer.includes('paired-real-7f29')).length
 verification.rawPureJson=report.results.filter(s=>{try{return JSON.parse(s.answer).status==='incomplete'}catch{return false}}).length
 verification.exactFactLabel='factInAnswer/qualityComplete require the literal FACT= prefix; correctFactValue accepts the same value expressed in prose'
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(verification,null,2));console.log('VERIFIED saved observations:',JSON.stringify(verification))
}else if(!process.versions.electron){
 if(!process.argv.includes('--authorized'))throw new Error('Only run for the explicitly authorized existing connection and synthetic project')
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
 const child=require('node:child_process').spawn(require('electron'),[__filename,'--authorized'],{env,windowsHide:true,stdio:'inherit'});child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('exit',code=>process.exitCode=code??1)
}else{
 const {app,safeStorage}=require('electron'),ts=require('typescript'),isolated=fs.mkdtempSync(path.join(os.tmpdir(),'coprojer-real-efficiency-')),profile=path.join(isolated,'profile')
 fs.mkdirSync(profile);app.setPath('userData',profile)
 const originalProfile=path.join(process.env.APPDATA,'Coprojer-dev');const crypt=JSON.parse(fs.readFileSync(path.join(originalProfile,'Local State'),'utf8')).os_crypt
 fs.writeFileSync(path.join(profile,'Local State'),JSON.stringify({os_crypt:crypt}))
 const cache=new Map();function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const api={};cache.set(file,api);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('exports','require',code)(api,name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name+'.ts')):require(name));return api}
 let secret='',sourcePath,sourceHash,rawFetch=globalThis.fetch
 const report={kind:'authorized repeated real connection paired samples',isolated,startedAt:new Date().toISOString(),results:[],globalConfigurationChanged:false,protectedProjectTouched:false}
 const clean=e=>String(e?.message??e).split(secret||'unmatchable-placeholder').join('[redacted]').replace(/https?:\/\/\S+/g,'[endpoint]')
 function save(){const text=JSON.stringify(report,null,2);assert.ok(!secret||!text.includes(secret));fs.writeFileSync(path.join(output,'results.json'),text)}
 app.whenReady().then(async()=>{
  fs.mkdirSync(output,{recursive:true});sourcePath=path.join(originalProfile,'engineering-v1.json');const original=fs.readFileSync(sourcePath);sourceHash=hash(original)
  const connection=JSON.parse(original).models.find(m=>m.id==='ff400f91-858b-4255-9d20-b18a22dede61');assert.ok(connection?.cipher);assert.ok(safeStorage.isEncryptionAvailable());secret=safeStorage.decryptString(Buffer.from(connection.cipher,'base64'))
  report.connection={id:connection.id,model:connection.model,protocol:connection.protocol,capabilities:connection.capabilities}
  const {EngineeringService}=load('src/main/engineering/service.ts'),model=load('src/main/engineering/model.ts'),actualComplete=model.complete
  const content='FACT=paired-real-7f29\n'+'synthetic filler; no user material\n'.repeat(140)
  report.materialHash=hash(content);report.scope='One configured model, 3 samples per arm, read first-line fact; not a general production benchmark'
  for(let repetition=1;repetition<=3;repetition++)for(const arm of repetition%2?['baseline','optimized']:['optimized','baseline']){
   const service=new EngineeringService(),root=path.join(isolated,arm+'-'+repetition);fs.mkdirSync(root);fs.writeFileSync(path.join(root,'note.txt'),content);fs.writeFileSync(path.join(root,'package.json'),'{}')
   service.store.data.models=[{...connection,cipher:''}];service.store.key=()=>secret
   for(const agent of service.store.data.agents){agent.modelId=connection.id;agent.skillIds=[];agent.readConcurrency=1;agent.tools=agent.role==='developer'?['read_file','write_file',...(arm==='optimized'?['read_file_lines']:[])]:['read_file','run_command'];agent.instructions='只处理当前隔离项目。先用可用文件读取工具读取 note.txt 第一行事实；如果有按行读取工具，只读第1行，否则正常读取文件。只读取一次，不写文件、不执行命令、不报告complete。随后用纯JSON结束：status=incomplete，summary包含文件第一行的完整FACT，nextStep=等待人工核对。'}
   const feature={id:'f',title:'配对真实读取',description:'读取note.txt第一行FACT并等待人工核对。只用合成材料，不完成业务验收。',module:'验收',scope:'current',stage:'ready',criteria:['实际读取后保留正确FACT'],plan:'读取并报告',tasks:[{id:'t',title:'读取并等待',done:false}],dependencies:[],developerId:'developer',reviewerId:'reviewer',revision:1,repairRound:0,results:[],feedback:'',runtimePolicy:'receipts-effects-v1',runtimeBudget:load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('real-pair')}
   const project={id:'p',name:'真实读取配对隔离',root,brief:'合成材料',createdAt:new Date().toISOString(),features:[feature],context:[],chat:[],events:[],changes:[],prototypes:[],agentRuns:[],activity:null,previewUrl:null}
   service.store.data.projects=[project];service.store.data.receiptJournals={};service.store.data.executionCheckpoints={};service.store.save();service.adjustRuntimeBudget({projectId:'p',featureId:'f'},{requests:4,tools:3,activeMs:180000},'已授权真实连接配对评价有限额度')
   const sample={arm,repetition,requests:[],modelCalls:[],status:'running'},started=performance.now();report.results.push(sample)
   globalThis.fetch=async(url,init)=>{const started=performance.now(),body=init.body,item={characters:body.length,bytes:Buffer.byteLength(body),hash:hash(body)};sample.requests.push(item);try{const response=await rawFetch(url,init);item.status=response.status;item.headersMs=performance.now()-started;return response}catch(e){item.error=clean(e);throw e}}
   model.complete=async(...args)=>{const started=performance.now(),item={budget:args[6]?.budget};sample.modelCalls.push(item);try{const reply=await actualComplete(...args);item.actualUsage=reply.usage??{};return reply}finally{item.fullResponseMs=performance.now()-started}}
   try{
    service.runFeature('p','f');const deadline=Date.now()+120000;while(project.activity&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));if(project.activity){service.stop('p');while(project.activity&&Date.now()<deadline+15000)await new Promise(r=>setTimeout(r,30));throw new Error('sample exceeded 120 seconds')}
    sample.elapsedMs=performance.now()-started;const key=JSON.stringify(['p','f']),records=Object.values(service.store.data.receiptJournals[key]?.receipts??{}),cp=service.store.data.executionCheckpoints[key]
    const text=cp?.messages.filter(m=>m.role==='assistant'&&!m.calls?.length).at(-1)?.content??'';let reply;try{reply=JSON.parse(text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''))}catch{}
    sample.answer=text;sample.receipts=records.map(r=>({tool:r.tool,args:r.args,attempts:r.attempts,status:r.status,resultCharacters:r.result?.output.length??0,resultHash:r.result?hash(r.result.output):null}));sample.budget=feature.runtimeBudget;sample.finalStage=feature.stage;sample.wireBytes=sample.requests.reduce((n,r)=>n+r.bytes,0);sample.wireCharacters=sample.requests.reduce((n,r)=>n+r.characters,0);sample.reason=feature.feedback
    sample.quality={factInAnswer:text.includes('FACT=paired-real-7f29'),structuredIncomplete:reply?.status==='incomplete',optimizedToolChosen:records.some(r=>r.tool==='read_file_lines'),completedTaskReport:reply?.status==='incomplete'&&String(reply.summary).includes('FACT=paired-real-7f29'),automaticAcceptance:feature.stage==='done'||feature.stage==='acceptance'}
    // A model may choose the still-available legacy reader or fail the requested answer format.
    // Preserve these as measured quality/adoption outcomes, never discard slower or weaker samples.
    const completed=records.filter(r=>r.status==='completed');assert.equal(completed.length,1);assert.ok(records.every(r=>r.attempts===1));assert.ok(['read_file','read_file_lines'].includes(completed[0].tool));assert.ok(completed[0].result.output.includes('FACT=paired-real-7f29'));assert.ok(JSON.stringify(cp.messages).includes('FACT=paired-real-7f29'));assert.equal(feature.stage,'blocked');assert.equal(project.changes.length,0);assert.equal(fs.readFileSync(path.join(root,'note.txt'),'utf8'),content)
    sample.status='passed';sample.repeatedReads=0
    console.log('PASS: real paired',arm,repetition,'requests='+sample.requests.length,'ms='+Math.round(sample.elapsedMs))
   }catch(e){sample.status='failed';sample.elapsedMs=performance.now()-started;sample.error=clean(e);sample.reason=feature.feedback;console.error('FAILED real sample',arm,repetition,sample.error)}
   finally{globalThis.fetch=rawFetch;model.complete=actualComplete;sample.requestLedger=feature.contextRuntime?.requests;sample.finalStage=feature.stage;sample.budget=feature.runtimeBudget;assert.equal(hash(fs.readFileSync(sourcePath)),sourceHash,'original model configuration unchanged');assert.ok(!fs.readFileSync(service.store.path,'utf8').includes(secret));save()}
   if(project.activity)throw new Error('previous sample is still active; do not start another sample')
  }
  assert.ok(report.results.every(s=>s.status==='passed'),'all actual quality checks must pass');report.status='passed'
 }).catch(e=>{report.status='failed';report.error=clean(e);process.exitCode=1;console.error('REAL EFFICIENCY:',report.error)}).finally(()=>{globalThis.fetch=rawFetch;report.endedAt=new Date().toISOString();if(sourcePath&&sourceHash)report.globalConfigurationChanged=hash(fs.readFileSync(sourcePath))!==sourceHash;save();app.exit(process.exitCode||0)})
}
