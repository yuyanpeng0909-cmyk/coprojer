// Offline model fixtures; real production orchestration, writes and commands.
const { fs,path,assert,sandbox,fixture,model,call,answer,load }=require('./fixtures/verification-runtime.cjs')
const {spawnSync}=require('node:child_process'),crypto=require('node:crypto')
const repo=path.resolve(__dirname,'..')
const source=path.resolve(process.env.COPROJER_POMODORO_SOURCE||path.join(repo,'examples/pomodoro'))
const parent=path.join(repo,'.runtime/native-preparation-audit')
const runDir=fs.mkdtempSync(path.join(parent,'isolated-')),root=path.join(runDir,'project')
fs.mkdirSync(root)
const copy=spawnSync('robocopy',[source,root,'/E','/XJ','/R:0','/W:0','/NFL','/NDL','/NJH','/NJS','/NP'],{windowsHide:true,encoding:'utf8'})
assert.ok(copy.status<8,'Copy the entire original project and dependencies')
const baseline=JSON.parse(fs.readFileSync(path.join(parent,'original-before.json'),'utf8'))
const sha=data=>crypto.createHash('sha256').update(data).digest('hex')
const copyDifferences=Object.entries(baseline.hashes).filter(([relative,hash])=>{
 const file=path.join(root,relative)
 if(!fs.existsSync(file))return true
 return (hash.startsWith('symlink:')?'symlink:'+fs.readlinkSync(file):sha(fs.readFileSync(file)))!==hash
}).map(([relative])=>relative)
fs.writeFileSync(path.join(runDir,'copy-verification.json'),JSON.stringify({fileCount:baseline.fileCount,differences:copyDifferences},null,2))
assert.deepEqual(copyDifferences,[],'Every original file and dependency must match the isolated copy before testing')
const origin=JSON.parse(fs.readFileSync(path.join(parent,'original-latest-report.json'),'utf8'))
const ctx=fixture({criteria:origin.feature.criteria})
ctx.project.root=root;ctx.project.name='番茄钟助手（隔离实测）'
ctx.project.requirementsBaseline=origin.project.requirementsBaseline
ctx.project.targets=origin.project.targets
Object.assign(ctx.feature,{title:origin.feature.title,description:origin.feature.description,plan:origin.feature.plan,
  stage:'blocked',verificationPending:true,repairRound:origin.feature.repairRound,results:origin.feature.results,
  verificationChecks:origin.feature.verificationChecks,verificationPreparation:origin.feature.verificationPreparation})
// The reviewer must regenerate current evidence in this new isolated run.
// Existing failure rows stay available to the real service's retention policy.
ctx.service.store.save()
const assets={
 'tests/coprojer-desktop-check.cjs':fs.readFileSync(path.join(__dirname,'fixtures/pomodoro-desktop-check.cjs'),'utf8'),
 'tests/windows-desktop.ps1':fs.readFileSync(path.join(__dirname,'fixtures/windows-desktop.ps1'),'utf8'),
 'tests/electron-test-bootstrap.cjs':fs.readFileSync(path.join(__dirname,'fixtures/electron-test-bootstrap.cjs'),'utf8'),
 'tests/test-display-launch.cjs':fs.readFileSync(path.join(__dirname,'fixtures/test-display-launch.cjs'),'utf8'),
 'tests/coprojer-smoke-check.cjs':[
   "const path=require('node:path'),{spawnSync}=require('node:child_process');",
   "const r=spawnSync(process.execPath,['--require',path.join(__dirname,'test-display-launch.cjs'),path.join(process.cwd(),'scripts/tray-runtime.cjs')],{cwd:process.cwd(),env:process.env,stdio:'inherit',windowsHide:true,timeout:90000});",
   "process.exitCode=r.status===null?1:r.status;"
 ].join('\n')
}
let prepared=false,reviewRound=0
// Retain the exact supplementary sources used by this run even if someone
// later debugs in its isolated project directory.
const preparedAssets={}
for(const [relative,content] of Object.entries(assets)){
 const archive=path.join(runDir,'prepared-assets',relative);fs.mkdirSync(path.dirname(archive),{recursive:true})
 fs.writeFileSync(archive,content);preparedAssets[relative]=sha(content)
}
const phases=[],executions=[]
model.complete=async(_connection,system,messages,tools)=>{
 const history=messages.filter(m=>m.role==='tool')
 if(system.includes('VERIFICATION_DIAGNOSIS')){
   phases.push('diagnoser')
   if(!prepared)return answer({gaps:ctx.feature.verificationPreparation.gaps.map(g=>({...g,disposition:'external',reason:'Only application callbacks are available; no desktop script exists.',nextStep:'Manual tray check requested by the original model.'}))})
   const failed=ctx.feature.verificationChecks.find(c=>c.command.includes('coprojer-desktop-check')&&c.code!==0)
   const cause=failed?.output.split(/\r?\n/).find(line=>/DESKTOP_TECHNICAL_BLOCK:|AssertionError/.test(line))||'The supplemental check did not provide complete native evidence.'
   return answer({gaps:ctx.feature.verificationPreparation.gaps.map(g=>({...g,disposition:'unknown',reason:cause,
     nextStep:/Input ownership changed/.test(cause)?'需要本次隔离应用独占短时指针输入；当前观测到鼠标被移走，未继续点击，不涉及新授权。保留动作记录后再次独立验证。':'检查本次 UIAutomation/MSAA 目标归属及可见性记录；恢复可可靠识别的本应用图标后独立重测。不能盲点坐标或以回调代替。'}))})
 }
 if(system.includes('VERIFICATION_PREPARATION')){
   phases.push('preparer')
   const pending=Object.entries(assets).filter(([p])=>!fs.existsSync(path.join(root,p)))
   if(pending.length)return {text:'Prepare auditable supplementary checks without touching existing files.',calls:pending.map(([p,content],i)=>({id:'prepare-'+i,name:'write_file',arguments:JSON.stringify({path:p,content})}))}
   prepared=true
   return answer({status:'ready',summary:'Created five supplemental verification files. No application source, existing tests or package scripts changed.',nextStep:'Run node tests/coprojer-smoke-check.cjs and node tests/coprojer-desktop-check.cjs independently; inspect JSON/screenshots and preserve failures.'})
 }
 assert.ok(system.includes('你是 Coprojer 的验证智能体。'),'Never enter target business development')
 if(!history.length){reviewRound++;phases.push('reviewer-'+reviewRound)}
 const plan=prepared?
  [{program:'node',args:['tests/coprojer-smoke-check.cjs'],evidenceKinds:['application','duration'],timeoutSeconds:100},
   {program:'node',args:['tests/coprojer-desktop-check.cjs'],evidenceKind:'desktop',timeoutSeconds:180}]:
  [{program:'npm',args:['run','typecheck'],evidenceKind:'inspection'},
   {program:'npm',args:['test'],evidenceKind:'unit'},
   {program:'npm',args:['run','build'],evidenceKind:'inspection'}]
 if(history.length<plan.length)return call('run_command',plan[history.length])
 const commands=history.map(m=>{try{return JSON.parse(m.content)}catch{return {output:m.content,code:-1}}})
 executions.push({reviewRound,commands})
 const smoke=prepared?commands[0]:null,native=prepared?commands[1]:null
 const appPassed=smoke?.code===0,nativePassed=native?.code===0&&native.output.includes('NATIVE_DESKTOP_INPUT_PASSED')
 return answer({results:ctx.feature.criteria.map((criterion,i)=>{
   const passed=i===0||i===3?appPassed:nativePassed
   return {criterion,passed:!!passed,status:passed?'passed':'unverified',evidence:passed?
     i===0?'Fresh foreground/background app execution and hidden-window assertions passed.':i===3?'Fresh JSONL short measurement; structured metrics are authoritative.':'Actual Win32 mouse movement/right-click/left-click and UIAutomation observations, with screenshots, owned PID and source/build fingerprints.':
     'Missing independent runtime or native-input evidence. '+(i===1||i===2?native?.output||'Only prior application callbacks.':smoke?.output||'No new runtime yet.'),
     commandIds:prepared?[i===0||i===3?smoke.evidenceId:native.evidenceId]:[],evidenceKind:i===3?'duration':i===0?'application':'desktop',...(i===3?{measuredDurationSeconds:5}:{})}
 })})
}
async function main(){
 console.log('ISOLATED_RUN '+runDir)
 ctx.service.runFeature('p','f',true)
 let cursor=0
 const deadline=Date.now()+360000
 while(ctx.project.activity&&Date.now()<deadline){
  await new Promise(r=>setTimeout(r,1000))
  for(const e of ctx.project.events.slice(cursor))if(['verification-diagnosis','verification-preparation','verification-recheck','tool','error','stopped','repair'].includes(e.kind))console.log(e.kind+': '+e.message.slice(0,160))
  cursor=ctx.project.events.length
 }
 if(ctx.project.activity){ctx.service.stop('p');throw Error('Bounded live run expired')}
 assert.equal(ctx.feature.repairRound,origin.feature.repairRound)
 assert.notEqual(ctx.feature.stage,'done','Final human acceptance must remain untouched')
 assert.ok(prepared,'Automatic preparation must run before requesting manual desktop evidence')
 const result={at:new Date().toISOString(),origin:{projectId:origin.project.id,featureId:origin.feature.id},runDir,root,phases,executions,
  feature:ctx.feature,events:ctx.project.events,preparedAssets,sourceFingerprint:load('src/main/engineering/files.ts').sourceFingerprint(root),model:'deterministic local fixture; zero paid requests'}
 fs.writeFileSync(path.join(runDir,'result.json'),JSON.stringify(result,null,2))
 fs.writeFileSync(path.join(parent,'latest-isolated.json'),JSON.stringify({runDir,result:path.join(runDir,'result.json')}))
 console.log(JSON.stringify({runDir,stage:ctx.feature.stage,results:ctx.feature.results.map(r=>({criterion:r.criterion,status:r.status})),checks:ctx.feature.verificationChecks.map(c=>({id:c.id,command:c.command,code:c.code,runId:c.runId}))}))
}
main().catch(e=>{fs.writeFileSync(path.join(runDir,'error.json'),JSON.stringify({error:String(e.stack||e),feature:ctx.feature,events:ctx.project.events},null,2));console.error(e);process.exitCode=1})
