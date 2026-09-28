const { fs, path, assert, sandbox, fixture, model, call, answer, run, load } = require('./fixtures/verification-runtime.cjs')
async function terminalFailureStillPrepares() {
  const ctx = fixture({ criteria: ['现有检查无失败', '补齐本地独立检查'] })
  ctx.feature.stage = 'blocked'; ctx.feature.verificationPending = true; ctx.feature.repairRound = 3
  fs.writeFileSync(path.join(ctx.root, 'tests/known-failure.cjs'), 'require("node:assert/strict").equal(1,2)')
  let diagnoses = 0, preparations = 0, reviews = 0
  model.complete = async (_connection, system, messages) => {
    const history = messages.filter(m => m.role === 'tool')
    if (system.includes('VERIFICATION_DIAGNOSIS')) {
      diagnoses++
      assert.match(system, /known-failure/, 'diagnosis receives the unresolved failed check')
      return answer({ gaps: ctx.feature.verificationPreparation.gaps.map(g=>({...g, disposition:'automatic',reason:'Missing a local check script; existing failure is separate.',nextStep:'Create tests/independent.cjs and recheck.'})) })
    }
    if (system.includes('VERIFICATION_PREPARATION')) {
      if(!history.length){preparations++; return call('write_file',{path:'tests/independent.cjs',content:'require("node:assert/strict").equal(2+3,5);console.log("NEW_CHECK_RAN")'})}
      return answer({status:'ready',summary:'Created independent check; existing failure remains.',nextStep:'node tests/independent.cjs'})
    }
    assert.ok(system.includes('你是 Coprojer 的验证智能体。'), 'repair budget is not reset')
    if(!history.length){reviews++; return call('run_command',{program:'node',args:['tests/known-failure.cjs'],evidenceKind:'unit'})}
    if(fs.existsSync(path.join(ctx.root,'tests/independent.cjs')) && history.length===1) return call('run_command',{program:'node',args:['tests/independent.cjs'],evidenceKind:'unit'})
    return answer({results:[
      {criterion:ctx.feature.criteria[0],passed:false,status:'failed',evidence:'Actual assertion failed.',commandIds:['check-1'],evidenceKind:'unit'},
      {criterion:ctx.feature.criteria[1],passed:history.length>1,status:history.length>1?'passed':'unverified',evidence:history.length>1?'NEW_CHECK_RAN':'Missing independent check.',commandIds:history.length>1?['check-2']:[],evidenceKind:'unit'}]})
  }
  await run(ctx.service,true)
  assert.equal(diagnoses,1,'terminal repair budget must not bypass independent gap diagnosis')
  assert.equal(preparations,1); assert.equal(reviews,2,'preparation must trigger a fresh reviewer')
  assert.equal(ctx.feature.repairRound,3); assert.equal(ctx.feature.stage,'blocked')
  assert.equal(ctx.feature.results[0].status,'failed');assert.equal(ctx.feature.results[1].status,'passed')
  assert.ok(ctx.feature.verificationChecks.some(c=>c.code!==0))
  assert.match(ctx.feature.verificationChecks.find(c=>c.code===0).output,/NEW_CHECK_RAN/)
  assert.notEqual(ctx.project.executionPlan.status,'waiting-acceptance')
  console.log('PASS: terminal repair failure stays blocked while independent gaps are prepared and freshly checked')
}
function diagnosisAndMeasurements() {
 const {diagnosedGaps,runtimeMeasurements,measurementSummary,nativeEvidenceSupported,commandFailure}=load('src/main/engineering/verification.ts')
 const gap={id:'native',criterion:'系统托盘图标悬停提示及鼠标菜单点击',description:'callback only',disposition:'unknown',reason:'',nextStep:''}
 const answer=[{id:'native',disposition:'external',reason:'No existing native-input script; manual required.',nextStep:'Ask human.'}]
 const available={desktop:{checked:true,available:true,meaning:'Current bounded local probe succeeded; input not tested.',nextStep:'Prepare an isolated native-input probe.'}}
 assert.equal(diagnosedGaps([gap],answer,available)[0].disposition,'automatic')
 assert.equal(diagnosedGaps([gap],answer,{desktop:{checked:true,available:false,reason:'ETIMEDOUT'}})[0].disposition,'unknown')
 assert.equal(diagnosedGaps([gap],answer,available,true)[0].disposition,'external','Do not repeat completed local preparation indefinitely')
 assert.equal(nativeEvidenceSupported(gap.criterion,{evidenceKind:'desktop',evidence:'API_CALLBACK_ONLY'}),false)
 assert.equal(commandFailure('DESKTOP_TECHNICAL_BLOCK: probe unavailable\nAssertionError: actual check failed',1),'check','an explicit failure takes precedence over a condition marker')
 const output=[{event:'started',mode:'foreground',durationMs:5000},{event:'started',mode:'background',durationMs:5000},
  {event:'passed',mode:'foreground',delayMs:179,observedDelayMs:242},{event:'passed',mode:'background',delayMs:303,observedDelayMs:322}].map(JSON.stringify).join('\n')
 const rows=runtimeMeasurements(output)
 assert.deepEqual(rows,[{mode:'foreground',durationSeconds:5,persistedTransitionDelayMs:179,observedTransitionDelayMs:242},
  {mode:'background',durationSeconds:5,persistedTransitionDelayMs:303,observedTransitionDelayMs:322}])
 assert.match(measurementSummary(rows),/foreground：单实例 5 秒；持久化延迟 179 ms；外部观察延迟 242 ms/)
 assert.deepEqual(runtimeMeasurements('{"event":"passed","mode":"old","delayMs":1,"observedDelayMs":2}'),[],'Never import a completion without a current start')
 console.log('PASS: native manual assumptions route to bounded preparation; mode/delay fields preserve raw JSONL semantics')
}
async function changedEnvironmentDoesNotReplay() {
 const verification=load('src/main/engineering/verification.ts'), original=verification.verificationEnvironment
 let environmentVersion=1,finish=false,preparations=0,diagnoses=0
 verification.verificationEnvironment=()=>({platform:process.platform,arch:process.arch,runtime:{available:true},desktop:{checked:true,available:true,session:environmentVersion}})
 const ctx=fixture()
 model.complete=async(_connection,system,messages,_tools,signal)=>{
  const history=messages.filter(m=>m.role==='tool')
  if(system.includes('VERIFICATION_DIAGNOSIS')){
   diagnoses++;return answer({gaps:ctx.feature.verificationPreparation.gaps.map(g=>({...g,disposition:'automatic',reason:'Read current incomplete local check.',nextStep:'Finish supplemental check.'}))})
  }
  if(system.includes('VERIFICATION_PREPARATION')){
   if(!history.length)preparations++
   if(!fs.existsSync(path.join(ctx.root,'tests/prepared.cjs')))return call('write_file',{path:'tests/prepared.cjs',content:'console.log("ACTUAL_FRESH_CHECK")'})
   if(!finish){ctx.service.stop('p');signal.throwIfAborted()}
   assert.equal(history.length,0,'stale environment conversation cannot be replayed')
   if(!fs.existsSync(path.join(ctx.root,'tests/current-environment.cjs')))return call('write_file',{path:'tests/current-environment.cjs',content:'console.log("CURRENT_ENVIRONMENT")'})
  }
  if(system.includes('你是 Coprojer 的开发智能体'))return answer({summary:'Already implemented.'})
  if(finish && !history.length)return call('run_command',{program:'node',args:['tests/prepared.cjs'],evidenceKind:'unit'})
  return answer({results:ctx.feature.criteria.map(criterion=>({criterion,passed:finish,status:finish?'passed':'unverified',evidence:finish?'Fresh independent command.':'Missing check.',commandIds:finish?['check-1']:[],evidenceKind:'unit'}))})
 }
 try{
  await run(ctx.service)
  assert.equal(ctx.feature.verificationPreparation.round,1)
  // Same source/config checkpoint, but a genuinely different desktop session.
  environmentVersion=2;finish=true
  const complete=model.complete
  model.complete=async(...args)=>{
   const history=args[2].filter(m=>m.role==='tool')
   if(args[1].includes('VERIFICATION_PREPARATION')&&history.length)return answer({status:'ready',summary:'Current environment helper added.',nextStep:'node tests/prepared.cjs'})
   return complete(...args)
  }
  await run(ctx.service)
  assert.equal(ctx.feature.stage,'acceptance');assert.equal(ctx.feature.repairRound,0)
  assert.equal(diagnoses,2);assert.equal(preparations,2)
  assert.equal(ctx.feature.verificationPreparation.round,2,'old preparation budget remains consumed')
  assert.equal(ctx.feature.verificationPreparation.attempts[0].status,'interrupted')
  assert.ok(ctx.project.events.some(e=>e.message.includes('当前工具/桌面环境与保存断点不同')))
  assert.equal(ctx.project.events.filter(e=>e.kind==='tool'&&e.message==='write_file tests/prepared.cjs').length,1)
  console.log('PASS: changed desktop session discards stale preparation checkpoint, preserves actions and consumed budget')
 }finally{verification.verificationEnvironment=original}
}
async function parallelDurationIsNotAdded() {
 const ctx=fixture({criteria:['短时测量与延迟字段准确']}), verification=load('src/main/engineering/verification.ts'), original=verification.verificationEnvironment
 verification.verificationEnvironment=()=>({platform:process.platform,desktop:{checked:false},runtime:{available:true}})
 let seconds=10
 fs.writeFileSync(path.join(ctx.root,'tests/measure.cjs'),
  'const emit=r=>console.log(JSON.stringify(r));'+
  'for(const mode of ["foreground","background"])emit({event:"started",mode,durationMs:5000});'+
  'setTimeout(()=>{emit({event:"passed",mode:"foreground",delayMs:179,observedDelayMs:242});emit({event:"passed",mode:"background",delayMs:303,observedDelayMs:322})},5000);'+
  'setTimeout(()=>{},10100)')
 model.complete=async(_c,system,messages)=>{
  if(system.includes('VERIFICATION_DIAGNOSIS'))return answer({gaps:ctx.feature.verificationPreparation.gaps.map(g=>({...g,disposition:'unknown',reason:'Measured modes do not support sum.',nextStep:'Correct report against current command.'}))})
  if(system.includes('你是 Coprojer 的开发智能体'))return answer({summary:'Measurement fixture ready.'})
  if(!messages.some(m=>m.role==='tool'))return call('run_command',{program:'node',args:['tests/measure.cjs'],evidenceKind:'duration'})
  return answer({results:[{criterion:ctx.feature.criteria[0],passed:true,status:'passed',evidence:'Model incorrectly adds parallel modes.',evidenceKind:'duration',measuredDurationSeconds:seconds,commandIds:['check-1']}]})
 }
 try{
  await run(ctx.service);assert.equal(ctx.feature.results[0].status,'unverified')
  assert.equal(ctx.feature.results[0].measuredDurationSeconds,undefined)
  const first=ctx.feature.verificationChecks[0];assert.ok(first.durationMs>=10000)
  seconds=5;await run(ctx.service,true)
  assert.equal(ctx.feature.stage,'acceptance');assert.equal(ctx.feature.results[0].measuredDurationSeconds,5)
  assert.notEqual(ctx.feature.verificationChecks[0].runId,first.runId,'corrected conclusion still requires a new command')
  assert.match(ctx.feature.results[0].evidence,/foreground：单实例 5 秒；持久化延迟 179 ms；外部观察延迟 242 ms/)
  assert.match(ctx.feature.results[0].evidence,/background：单实例 5 秒；持久化延迟 303 ms；外部观察延迟 322 ms/)
  assert.equal(ctx.project.executionPlan.status,'waiting-acceptance')
  console.log('PASS: real parallel short timers reject summed ten-second claim; fresh five-second report preserves all delay fields')
 }finally{verification.verificationEnvironment=original}
}
async function callbackOutputCannotBeRelabeled() {
 const ctx=fixture({criteria:['系统托盘图标悬停与鼠标菜单点击']}),verification=load('src/main/engineering/verification.ts'),original=verification.verificationEnvironment
 verification.verificationEnvironment=()=>({desktop:{checked:false},runtime:{available:true}})
 fs.writeFileSync(path.join(ctx.root,'tests/callback.cjs'),'console.log("API_CALLBACK_ONLY")')
 model.complete=async(_c,system,messages)=>{
  if(system.includes('VERIFICATION_DIAGNOSIS'))return answer({gaps:[]})
  if(system.includes('你是 Coprojer 的开发智能体'))return answer({summary:'Ready.'})
  if(!messages.some(m=>m.role==='tool'))return call('run_command',{program:'node',args:['tests/callback.cjs'],evidenceKind:'desktop'})
  return answer({results:[{criterion:ctx.feature.criteria[0],passed:true,status:'passed',evidence:'Model claims native mouse verification passed.',evidenceKind:'desktop',commandIds:['check-1']}]})
 }
 try{
  await run(ctx.service)
  assert.equal(ctx.feature.verificationChecks[0].code,0)
  assert.equal(ctx.feature.results[0].status,'unverified','actual callback-only output cannot be upgraded by the model summary')
  assert.notEqual(ctx.feature.stage,'acceptance')
  console.log('PASS: successful callback-only command cannot become desktop evidence through model relabeling')
 }finally{verification.verificationEnvironment=original}
}
async function main(){diagnosisAndMeasurements();await terminalFailureStillPrepares();await changedEnvironmentDoesNotReplay();await parallelDurationIsNotAdded();await callbackOutputCannotBeRelabeled()}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:3}))
