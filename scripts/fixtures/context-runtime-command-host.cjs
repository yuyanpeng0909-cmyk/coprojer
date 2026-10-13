const r = require('./verification-runtime.cjs')
const { fs, path, fixture, load, run } = r
const [mode, boundary, role] = process.argv.slice(2)
async function main() {
 let service, root, profile
 if(mode==='start') {
  const ctx=fixture();({service,root,profile}=ctx);ctx.feature.runtimePolicy='receipts-effects-v1'
  ctx.feature.runtimeBudget=load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('real-command-crash')
  if(role==='reviewer'){ctx.feature.stage='blocked';ctx.feature.verificationPending=true}
  service.store.data.models[0].baseUrl=process.env.COPROJER_CRASH_PROVIDER
  fs.writeFileSync(path.join(profile,'crash-fixture.json'),JSON.stringify({kind:'isolated-context-crash-test'}))
  fs.writeFileSync(path.join(root,'tests/child.cjs'),"const fs=require('node:fs');fs.writeFileSync('.runtime/descendant.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)")
  fs.writeFileSync(path.join(root,'tests/check.cjs'),"const fs=require('node:fs');fs.appendFileSync('.runtime/executions.txt','once\\n');fs.writeFileSync('partial.txt','actual effect');console.log('CRASH_PARTIAL_OUTPUT');"+(boundary==='running'?"require('node:child_process').spawn(process.execPath,['tests/child.cjs'],{stdio:'ignore',detached:true,windowsHide:true}).unref();setInterval(()=>console.log('running'),100)":""))
  service.store.save()
 } else {profile=process.env.COPROJER_CRASH_PROFILE;service=r.restoreIsolated(profile);root=service.store.project('p').root}
 process.send({type:'ready',profile,root,sandbox:r.sandbox})
 const save=service.store.save.bind(service.store)
 service.store.save=()=>{save();const receipt=Object.values(service.store.data.receiptJournals?.[JSON.stringify(['p','f'])]?.receipts??{}).find(r=>r.tool==='run_command')
  if(mode==='start'&&receipt?.status==='completed'&&(boundary==='receipt'?!receipt.applied:boundary==='projection'&&receipt.applied))process.exit(73)
 }
 let timer
 if(mode==='start'&&boundary==='running')timer=setInterval(()=>{if(fs.existsSync(path.join(root,'.runtime/descendant.json')))process.exit(73)},10)
 if(mode==='resume' || mode==='audit') {
  service.reconcileRuntime('p','f')
  const budget=service.store.project('p').features[0].runtimeBudget
  if(mode==='resume')service.adjustRuntimeBudget({projectId:'p',featureId:'f'},{...budget.limits,activeMs:Math.max(budget.limits.activeMs,budget.used.activeMs+60000)},'隔离崩溃测试明确授予后续有限时间，保留原累计')
 }
 await run(service,role==='reviewer'&&mode==='start');clearInterval(timer)
 service.reconcileRuntime('p','f');service.reconcileRuntime('p','f')
 process.send({type:'complete',state:service.state(),disk:JSON.parse(fs.readFileSync(service.store.path))})
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1)})
