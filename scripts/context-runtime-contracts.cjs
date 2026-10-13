const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, fixture, model, call, answer, run, load, EngineeringService } = r
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const { classifyEvidence } = load('src/shared/current-evidence.ts')
const { verificationContract, digest } = load('src/main/engineering/verification.ts')
const { sourceFingerprint } = load('src/main/engineering/files.ts')
const actualComplete = model.complete
const output = path.resolve('.runtime/context-runtime/m1'), cases = []
fs.mkdirSync(output, { recursive: true })
const test = (name, fn) => cases.push({ name, fn })
function reviewed(ctx) {
  ctx.feature.stage = 'blocked'; ctx.feature.verificationPending = true; ctx.feature.repairRound = 3
  fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), 'console.log("ACTUAL_CHECK")')
  ctx.service.store.save(); return ctx
}
function report(ctx, ids = ['check-1'], extra = {}) {
  return answer({ results: [{ criterion: ctx.feature.criteria[0], passed: true, status: 'passed', evidence: 'Model explanation.', evidenceKind: 'unit', commandIds: ids, ...extra }] })
}
const projection = system => JSON.parse(system.split('宿主当前任务事实（每次请求重新装载）：\n')[1].split('\n')[0])
async function wire(ctx, protocol, handler) {
  const server = await provider(handler)
  const config = ctx.service.store.data.models[0]; config.protocol = protocol; config.baseUrl = server.url
  model.complete = actualComplete
  try { await run(ctx.service, ctx.feature.verificationPending); assert.deepEqual(server.errors, []) }
  finally { await server.close(); model.complete = actualComplete }
  return server.requests
}
for (const protocol of ['chat', 'responses', 'anthropic']) {
  test(`${protocol}: schema, chunked multi-call, duplicate event, live permissions and task projection`, async () => {
    const ctx = reviewed(fixture())
    const invalid = [
      call('run_command', { program: 'node', args: ['tests/verify.cjs'], timeoutMs: 5000 }),
      call('run_command', { program: 'node', args: ['tests/verify.cjs'], timeoutSeconds: '5' }),
      call('run_command', { program: 'node', args: ['tests/verify.cjs'], timeoutSeconds: 301 }),
      call('run_command', { program: 'powershell', args: [] }),
      call('run_command', { program: 'node' }),
      call('write_file', { path: 'forbidden.txt', content: 'no' }),
    ].flatMap(reply => reply.calls)
    const requests = await wire(ctx, protocol, (request, n) => {
      const view = projection(request.system)
      assert.equal(view.goal.title, ctx.feature.title); assert.deepEqual(view.criteria, ctx.feature.criteria)
      assert.equal(view.authorization.finalAcceptance, 'user-only')
      if (n === 1) return { reply: { text: '', calls: invalid }, mode: 'duplicate' }
      if (n === 2) {
        assert.match(JSON.stringify(request.body), /invalid_tool_arguments/)
        assert.ok(!fs.existsSync(path.join(ctx.root, 'forbidden.txt')))
        return { reply: call('run_command', { program: 'node', args: ['tests/verify.cjs'], timeoutSeconds: 5, evidenceKind: 'unit' }), mode: 'duplicate' }
      }
      assert.equal(view.evidence.records.filter(c => c.disposition === 'current').length, 1)
      return report(ctx)
    })
    assert.equal(requests.length, 3); assert.equal(ctx.feature.stage, 'acceptance')
    assert.equal(ctx.feature.verificationChecks.length, 1)
    assert.equal(ctx.project.events.filter(e => e.kind === 'tool' && e.message.startsWith('run_command')).length, 1)
    assert.equal(ctx.feature.results[0].taskRevision, 1)
    fs.writeFileSync(path.join(output, `wire-${protocol}.json`), JSON.stringify({ requests, feature: ctx.feature }, null, 2))
  })
  for (const mode of ['truncate', 'disconnect']) test(`${protocol}: ${mode} never executes partial response`, async () => {
    const ctx = reviewed(fixture())
    await wire(ctx, protocol, () => ({ reply: call('run_command', { program: 'node', args: ['tests/verify.cjs'] }), mode }))
    assert.equal(ctx.project.events.filter(e => e.kind === 'tool').length, 0)
    assert.equal(ctx.feature.stage, 'blocked')
  })
}
test('same-source retry supersedes only equal evidence and retains durable history', async () => {
  const ctx = reviewed(fixture())
  fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), 'const fs=require("node:fs");fs.mkdirSync(".runtime",{recursive:true});const p=".runtime/count";let n=fs.existsSync(p)?+fs.readFileSync(p):0;fs.writeFileSync(p,String(++n));console.log("ATTEMPT_"+n);process.exit(n===1?1:0)')
  let request = 0
  model.complete = async (_c, system) => {
    if (++request <= 2) return call('run_command', { program:'node', args:['tests/verify.cjs'], evidenceKind:'unit' })
    const view = projection(system)
    assert.deepEqual(view.evidence.records.map(c => c.disposition), ['superseded', 'current'])
    return report(ctx, ['check-2'], { evidence: 'OLD FAILURE IS CURRENT: deliberately unsupported model narrative' })
  }
  await run(ctx.service, true)
  assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(ctx.feature.repairRound, 3)
  assert.equal(ctx.feature.verificationChecks.length, 2)
  assert.ok(!ctx.feature.results[0].evidence.includes('OLD FAILURE'))
  const firstFailure = structuredClone(ctx.feature.verificationChecks[0])
  ctx.feature.stage='blocked';ctx.feature.verificationPending=true
  request=0; model.complete=async()=>++request===1?call('run_command',{program:'node',args:['tests/verify.cjs'],evidenceKind:'unit'}):report(ctx)
  await run(ctx.service,true)
  const restored=new EngineeringService(), saved=restored.store.project('p').features[0]
  assert.ok(saved.verificationHistory.some(c=>c.at===firstFailure.at&&c.code===1&&c.runId===firstFailure.runId))
  assert.equal(fs.readFileSync(path.join(ctx.root,'.runtime/count'),'utf8'),'3')
  fs.writeFileSync(path.join(output,'retry-history.json'),JSON.stringify(saved,null,2))
})
test('a previously superseded failure cannot revive on an unrelated later recheck',async()=>{
  const ctx=reviewed(fixture())
  fs.writeFileSync(path.join(ctx.root,'tests/verify.cjs'),'const fs=require("node:fs");fs.mkdirSync(".runtime",{recursive:true});const p=".runtime/once";const first=!fs.existsSync(p);fs.writeFileSync(p,"ran");process.exit(first?1:0)')
  fs.writeFileSync(path.join(ctx.root,'tests/other.cjs'),'console.log("OTHER_VALID_CHECK")')
  let n=0;model.complete=async()=>++n<=2?call('run_command',{program:'node',args:['tests/verify.cjs'],evidenceKind:'unit'}):report(ctx,['check-2'])
  await run(ctx.service,true);assert.equal(ctx.feature.stage,'acceptance')
  ctx.feature.stage='blocked';ctx.feature.verificationPending=true;n=0
  model.complete=async()=>++n===1?call('run_command',{program:'node',args:['tests/other.cjs'],evidenceKind:'unit'}):report(ctx)
  await run(ctx.service,true);assert.equal(ctx.feature.stage,'acceptance')
  assert.equal(ctx.feature.verificationChecks.length,1)
  assert.ok(ctx.feature.verificationHistory.some(c=>c.code===1))
})
test('scope and evidence strength cannot be replaced by unrelated success', () => {
  const failed={id:'a',command:'node tests/a.cjs',code:1,sourceFingerprint:'s',taskRevision:1,contractFingerprint:'c',environmentFingerprint:'e',evidenceKind:'desktop'}
  for(const change of [{sourceFingerprint:'s2'},{taskRevision:2},{contractFingerprint:'c2'},{environmentFingerprint:'e2'},{command:'other'},{evidenceKind:'mock'}]) {
    const rows=classifyEvidence([failed,{...failed,...change,id:'b',code:0}])
    assert.equal(rows[0].disposition,'current')
  }
})
for (const field of ['taskRevision','contractFingerprint','environmentFingerprint']) test(`old ${field} failure never blocks a new task scope`, async()=>{
  const ctx=reviewed(fixture()), source=sourceFingerprint(ctx.root)
  const scope={taskRevision:1,contractFingerprint:verificationContract(ctx.project,ctx.feature),environmentFingerprint:digest({platform:process.platform,arch:process.arch,node:process.version,root:ctx.root})}
  ctx.feature.verificationChecks=[{id:'previous',command:'node tests/verify.cjs',code:1,output:'OLD_FAILURE',sourceFingerprint:source,at:new Date().toISOString(),durationMs:1,evidenceKind:'unit',...scope,[field]:field==='taskRevision'?0:'old'}]
  ctx.feature.results=[{criterion:ctx.feature.criteria[0],status:'failed',passed:false,evidence:'OLD_FAILURE',commandIds:['previous'],sourceFingerprint:source}]
  let n=0;model.complete=async(_c,system)=>{
    if(++n===1)return call('run_command',{program:'node',args:['tests/verify.cjs'],evidenceKind:'unit'})
    assert.ok(projection(system).evidence.records.some(c=>c.id==='previous'&&c.disposition==='stale'))
    return report(ctx)
  }
  await run(ctx.service,true)
  assert.equal(ctx.feature.stage,'acceptance')
})
for(const role of ['developer','reviewer'])test(`${role} malformed report receives one tool-free correction then pauses`,async()=>{
  const ctx=role==='reviewer'?reviewed(fixture()):fixture();let n=0
  model.complete=async(_c,_s,_m,tools)=>{if(++n===2)assert.equal(tools.length,0);return answer({summary:'missing required fields'})}
  await run(ctx.service,role==='reviewer')
  assert.equal(n,2);assert.equal(ctx.feature.stage,'blocked');assert.equal(ctx.feature.repairRound,role==='reviewer'?3:0)
  assert.equal(ctx.project.events.filter(e=>e.kind==='repair'||e.kind==='tool').length,0)
  assert.ok(ctx.project.events.some(e=>e.message.includes('报告格式整理一次后仍无效')))
})
for(const defect of ['duplicate-criterion','unknown-evidence'])test(`budget conclusion rejects ${defect}`,async()=>{
  const ctx=reviewed(fixture());let n=0
  fs.writeFileSync(path.join(ctx.root,'large.txt'),'x'.repeat(300000))
  model.complete=async(_c,_s,_m,tools)=>{
    if(tools.length){n++;return n===1?call('run_command',{program:'node',args:['tests/verify.cjs'],evidenceKind:'unit'}):call('read_file',{path:'large.txt',offset:(n-2)*100,limit:100})}
    const result=JSON.parse(report(ctx).text)
    if(defect==='duplicate-criterion')result.results.push({...result.results[0]});else result.results[0].evidenceKind='imagined'
    return answer(result)
  }
  await run(ctx.service,true)
  assert.equal(n,36);assert.equal(ctx.feature.stage,'blocked');assert.equal(ctx.feature.results.length,0)
  assert.equal(ctx.project.events.filter(e=>e.kind==='repair').length,0)
})
test('revoked runtime tool permission prevents actual execution',async()=>{
  const ctx=reviewed(fixture());let n=0
  model.complete=async()=>{
    if(++n===1){const a=ctx.service.store.data.agents.find(a=>a.id===ctx.feature.reviewerId);a.tools=a.tools.filter(t=>t!=='run_command');a.skillIds=[];ctx.service.store.save();return call('run_command',{program:'node',args:['tests/verify.cjs']})}
    throw Error('end controlled permission test')
  }
  await run(ctx.service,true)
  assert.equal(ctx.project.events.filter(e=>e.kind==='tool').length,0)
  assert.ok(ctx.project.events.some(e=>e.message.includes('当前角色不可使用')))
})
test('late model result preserves new revision and does not start effects',async()=>{
  const ctx=fixture()
  model.complete=async()=>{ctx.feature.revision++;ctx.feature.title='NEW_GOAL';ctx.feature.stage='ready';ctx.service.store.save();return call('write_file',{path:'late.txt',content:'no'})}
  await run(ctx.service)
  assert.equal(ctx.feature.title,'NEW_GOAL');assert.equal(ctx.feature.stage,'ready');assert.ok(!fs.existsSync(path.join(ctx.root,'late.txt')))
  assert.ok(ctx.project.events.some(e=>e.kind==='historical-result'))
})
for(const scenario of ['weak','missing-measurement','different-measurement','no-source']) test(`report cannot promote ${scenario} evidence`,async()=>{
  const ctx=reviewed(fixture());let n=0
  const evidenceKind=scenario==='weak'?'mock':scenario==='no-source'?'unit':'duration'
  if(scenario==='different-measurement')fs.writeFileSync(path.join(ctx.root,'tests/verify.cjs'),'console.log(JSON.stringify({event:"started",mode:"only",durationMs:50}));setTimeout(()=>console.log(JSON.stringify({event:"passed",mode:"only",delayMs:0,observedDelayMs:0})),50)')
  model.complete=async(_c,system)=>{
    if(system.includes('VERIFICATION_DIAGNOSIS'))return answer({gaps:ctx.feature.verificationPreparation.gaps.map(g=>({...g,disposition:'unknown',reason:'Known controlled missing evidence',nextStep:'Leave unverified'}))})
    if(system.includes('VERIFICATION_PREPARATION'))return answer({status:'blocked',summary:'No new controlled conditions',nextStep:'Leave unverified'})
    if(++n===1&&scenario!=='no-source')return call('run_command',{program:'node',args:['tests/verify.cjs'],evidenceKind})
    return report(ctx,scenario==='no-source'?['invented']:['check-1'],scenario==='weak'?{evidenceKind:'unit'}:scenario==='no-source'?{}:{evidenceKind:'duration',measuredDurationSeconds:0.03})
  }
  await run(ctx.service,true)
  assert.notEqual(ctx.feature.stage,'acceptance');assert.equal(ctx.feature.results[0].status,'unverified')
  assert.equal(ctx.project.events.filter(e=>e.kind==='repair').length,0)
})
async function main(){const results=[];for(const {name,fn} of cases){try{await fn();results.push({name,status:'passed'});console.log('PASS:',name)}catch(error){results.push({name,status:'failed',error:error.stack});console.error('FAIL:',name,error.stack)}}fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({at:new Date().toISOString(),evidenceLevel:'service fixture plus real HTTP/SSE adapter',results},null,2));assert.equal(results.filter(r=>r.status==='failed').length,0)}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{model.complete=actualComplete;fs.rmSync(r.sandbox,{recursive:true,force:true,maxRetries:3})})
