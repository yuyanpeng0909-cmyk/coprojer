const {fork}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
const {provider}=require('./fixtures/context-runtime-provider.cjs')
const output=path.resolve('.runtime/context-runtime/m4-command-crashes');fs.mkdirSync(output,{recursive:true})
function child(mode,boundary,role,env){return new Promise((resolve,reject)=>{
 const task=fork(path.resolve('scripts/fixtures/context-runtime-command-host.cjs'),[mode,boundary,role],{env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});const messages=[];let logs=''
 task.on('message',m=>messages.push(m));task.stdout.on('data',s=>logs+=s);task.stderr.on('data',s=>logs+=s);task.on('error',reject)
 const timer=setTimeout(()=>{task.kill();reject(new Error('child timeout '+logs))},45000)
 task.on('exit',code=>{clearTimeout(timer);resolve({code,messages,logs})})
})}
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('proof timeout')}
async function main(){const results=[]
 for(const role of ['developer','reviewer'])for(const boundary of ['running','receipt','projection']){
  const owned=new Set(),server=await provider((_req,n)=>n===1?{text:'',calls:[{id:'command',name:'run_command',arguments:JSON.stringify({program:'node',args:['tests/check.cjs'],timeoutSeconds:15,evidenceKind:'unit'})},{id:'queued',name:'list_files',arguments:'{}'}]}:{httpStatus:503,error:{message:'isolated stop after recovered complete group'}})
  try{
   const first=await child('start',boundary,role,{COPROJER_CRASH_PROVIDER:server.url}),info=first.messages.find(m=>m.type==='ready');assert.ok(info,first.logs);owned.add(info.sandbox);assert.equal(first.code,73,first.logs)
   const disk=JSON.parse(fs.readFileSync(path.join(info.profile,'engineering-v1.json'))),receipt=Object.values(disk.receiptJournals[JSON.stringify(['p','f'])].receipts).find(r=>r.tool==='run_command')
   const folder=path.join(info.profile,'engineering-commands',createHash('sha256').update(JSON.stringify(['p','f'])).digest('hex'),receipt.command.runId)
   try { await until(()=>fs.existsSync(path.join(folder,'result.json'))) } catch(error) {
    const files=Object.fromEntries(fs.readdirSync(folder).filter(n=>/\.(json|proof|log)$/.test(n)).map(n=>[n,fs.readFileSync(path.join(folder,n),'utf8')]))
    fs.writeFileSync(path.join(output,'missing-proof.json'),JSON.stringify({info,first,receipt,files},null,2));throw error
   }
   const raw=JSON.parse(fs.readFileSync(path.join(folder,'result.json')));assert.ok(raw.stoppedConfirmed,JSON.stringify(raw));assert.match(raw.output,/CRASH_PARTIAL_OUTPUT/)
   await until(()=>{try{process.kill(raw.supervisorPid,0);return false}catch{return true}})
   if(boundary==='running'){const pid=JSON.parse(fs.readFileSync(path.join(info.root,'.runtime/descendant.json'))).pid;assert.throws(()=>process.kill(pid,0));assert.equal(raw.status,'cancelled')}
   if(role==='developer'&&boundary==='running') {
    const audit=await child('audit',boundary,role,{COPROJER_CRASH_PROFILE:info.profile});owned.add(audit.messages.find(m=>m.type==='ready')?.sandbox);assert.equal(audit.code,0,audit.logs)
    const audited=audit.messages.find(m=>m.type==='complete').state.projects[0].features[0];assert.match(audited.contextRuntime.reason,/未结算/);assert.equal(server.requests.length,1);assert.equal(audited.runtimeBudget.used.tools,1)
    fs.writeFileSync(path.join(output,'ungranted-audit.json'),JSON.stringify(audit,null,2))
   }
   const resumed=await child('resume',boundary,role,{COPROJER_CRASH_PROFILE:info.profile});owned.add(resumed.messages.find(m=>m.type==='ready')?.sandbox);assert.equal(resumed.code,0,resumed.logs)
   const complete=resumed.messages.find(m=>m.type==='complete'),project=complete.state.projects[0],records=Object.values(complete.disk.receiptJournals[JSON.stringify(['p','f'])].receipts)
   assert.equal(fs.readFileSync(path.join(info.root,'.runtime/executions.txt'),'utf8'),'once\n');assert.equal(records.find(r=>r.tool==='run_command').attempts,1);assert.equal(records.find(r=>r.tool==='run_command').role,role)
   assert.equal(project.changes.filter(c=>c.path==='partial.txt').length,1);assert.equal(project.features[0].stage,'blocked');assert.equal(server.requests.length,2)
   if(boundary==='running')assert.equal(records.find(r=>r.providerCallId==='queued').attempts,0)
   assert.ok(project.features[0].runtimeBudget.unsettledActivity.length)
   fs.writeFileSync(path.join(output,role+'-'+boundary+'.json'),JSON.stringify({first,raw,resumed,requests:server.requests},null,2));results.push({role,boundary,status:'passed'});console.log('PASS:',role,boundary,'actual owner exit, tree stop, exactly one command, one projection')
  } finally{await server.close();for(const item of owned)if(item){const absolute=path.resolve(item);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'coprojer-preparation-'));fs.rmSync(absolute,{recursive:true,force:true,maxRetries:3})}}
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2))
}
main().catch(error=>{console.error(error);process.exitCode=1})
