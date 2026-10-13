const r = require('./fixtures/verification-runtime.cjs')
const {fs,path,assert,sandbox,fixture,load,model,answer,call,run,EngineeringService}=r
const {provider}=require('./fixtures/context-runtime-provider.cjs')
const output=path.resolve('.runtime/context-runtime/m6-files');fs.mkdirSync(output,{recursive:true})
const actualComplete=model.complete,files=load('src/main/engineering/files.ts'),efficient=load('src/main/engineering/efficient-files.ts')
const tests=[],results=[],test=(name,fn)=>tests.push({name,fn})
const receipts=s=>Object.values(s.store.data.receiptJournals?.[JSON.stringify(['p','f'])]?.receipts??{})
const done=()=>answer({status:'incomplete',summary:'保留实际来源供人工核对',nextStep:'独立检查'})
function setup(){const ctx=fixture();ctx.feature.runtimePolicy='receipts-effects-v1';ctx.feature.runtimeBudget=load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('isolated-efficient');ctx.service.store.data.agents.find(a=>a.id==='developer').tools.push('search_files','read_file_lines','patch_file');return ctx}
const patchArgs=(before,extra={})=>({path:'value.cjs',expectedVersion:efficient.textVersion(before),startLine:1,endLine:1,oldText:'a+b',newText:'a + b',...extra})
async function connect(ctx,handler,protocol='chat') {const server=await provider(handler);model.complete=actualComplete;Object.assign(ctx.service.store.data.models[0],{baseUrl:server.url,protocol});ctx.service.store.save();return server}

for(const protocol of ['chat','responses','anthropic'])test(protocol+' actual service search -> line read -> versioned patch preserves source and effect',async()=>{
 const ctx=setup(),before=fs.readFileSync(path.join(ctx.root,'value.cjs'),'utf8'),version=efficient.textVersion(before)
 const server=await connect(ctx,(_req,n)=>n===1?call('search_files',{scope:'value.cjs',query:'sum',limit:3}):n===2?call('read_file_lines',{path:'value.cjs',startLine:1,endLine:1,version}):n===3?call('patch_file',patchArgs(before)):done(),protocol)
 try{await run(ctx.service);const records=receipts(ctx.service);assert.deepEqual(records.map(x=>x.tool),['search_files','read_file_lines','patch_file']);assert.ok(records.every(x=>x.status==='completed'&&x.attempts===1));
  const hit=JSON.parse(records[0].result.output).matches[0];assert.equal(hit.version,version);assert.equal(hit.line,1);assert.equal(hit.path,'value.cjs');
  assert.equal(JSON.parse(records[1].result.output).content,before);const changed=JSON.parse(records[2].result.output);assert.equal(changed.version,efficient.textVersion(fs.readFileSync(path.join(ctx.root,'value.cjs'))));assert.equal(changed.changed,true)
  assert.equal(ctx.project.changes.length,1);assert.equal(ctx.feature.runtimeBudget.used.tools,3);assert.equal(ctx.feature.stage,'blocked');assert.equal(server.requests.length,4)
  fs.writeFileSync(path.join(output,protocol+'-flow.json'),JSON.stringify({requests:server.requests,records,changes:ctx.project.changes,stage:ctx.feature.stage},null,2))
 }finally{await server.close()}
})
test('zero/truncated search, line bounds, long line pagination, forbidden paths and strict schema are explicit',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'long.txt'),'needle\r\nneedle\r\n'+'x'.repeat(7000))
 const calls=[call('search_files',{scope:'value.cjs',query:'not-present'}).calls[0],call('search_files',{scope:'long.txt',query:'needle',limit:1}).calls[0],call('read_file_lines',{path:'long.txt',startLine:3,endLine:3}).calls[0],call('read_file_lines',{path:'long.txt',startLine:4,endLine:4}).calls[0],call('search_files',{scope:'../private',query:'secret'}).calls[0],call('search_files',{scope:'.coprojer',query:'secret'}).calls[0],call('read_file_lines',{path:'long.txt',startLine:1,endLine:1,offset:4}).calls[0]]
 const server=await connect(ctx,(_req,n)=>n===1?{text:'',calls}:done())
 try{await run(ctx.service);const records=receipts(ctx.service);const zero=JSON.parse(records[0].result.output),trunc=JSON.parse(records[1].result.output),page=JSON.parse(records[2].result.output)
 assert.equal(zero.complete,true);assert.deepEqual(zero.matches,[]);assert.equal(trunc.truncated,true);assert.ok(trunc.skipped.length);assert.equal(page.content.length,6000);assert.equal(page.partial,true);assert.equal(page.nextOffset,6016)
 assert.equal(records[3].status,'failed');assert.match(records[3].result.output,/越界/);assert.ok(records.slice(4).every(x=>x.status==='failed'));assert.equal(records.length,6)
 const tail=JSON.parse(await efficient.executeFileRead(ctx.root,'read_file',{path:'long.txt',offset:page.nextOffset,version:page.version}));assert.equal(tail.content.length,1000)
 assert.ok(server.requests[1].body.messages.at(-1).content.includes('invalid_tool_arguments'))
 }finally{await server.close()}
})
test('search skips binary/oversize and directory changes do not masquerade as complete results',async()=>{
 const ctx=setup();fs.writeFileSync(path.join(ctx.root,'binary.txt'),Buffer.from([0,1,2]));fs.writeFileSync(path.join(ctx.root,'huge.txt'),'x'.repeat(400001));
 const result=JSON.parse(await efficient.searchFiles(ctx.root,{scope:'.',query:'absent'}));assert.equal(result.complete,false);assert.ok(result.skipped.some(x=>x.path==='binary.txt'));assert.ok(result.skipped.some(x=>x.path==='huge.txt'))
 const original=fs.promises.readdir;let changed=false
 fs.promises.readdir=async(...args)=>{const list=await original(...args);if(!changed&&args[0]===ctx.root){changed=true;fs.writeFileSync(path.join(ctx.root,'new.txt'),'absent')}return list}
 try{await assert.rejects(efficient.searchFiles(ctx.root,{scope:'.',query:'sum'}),/目录内容已变化/)}finally{fs.promises.readdir=original}
})
test('file aliases and line/character reads share versioned coverage; search invalidates old coverage',async()=>{
 const ctx=setup(),Registry=load('src/main/engineering/read-registry.ts').ReadRegistry,registry=new Registry()
 const first=await efficient.executeFileRead(ctx.root,'read_file',{path:'./value.cjs',limit:5});registry.observe('read_file',{path:'./value.cjs'},first,'p')
 registry.observe('read_file_lines',{path:'VALUE.CJS'},await efficient.executeFileRead(ctx.root,'read_file_lines',{path:'VALUE.CJS',startLine:1,endLine:1}),'p')
 assert.equal(registry.snapshot().length,1);assert.equal(registry.snapshot()[0].reads,2)
 fs.appendFileSync(path.join(ctx.root,'value.cjs'),';changed');registry.observe('search_files',{scope:'.',query:'changed'},await efficient.searchFiles(ctx.root,{scope:'.',query:'changed'}),'p')
 assert.equal(registry.snapshot()[0].active,false)
})
for(const mode of ['version','ambiguous','range','empty'])test('patch '+mode+' rejects without partial write or overwrite fallback',async()=>{
 const ctx=setup(),target=path.join(ctx.root,'value.cjs'),before=mode==='ambiguous'?'a+b a+b':fs.readFileSync(target,'utf8');fs.writeFileSync(target,before)
 const extra=mode==='version'?{expectedVersion:'stale'}:mode==='range'?{endLine:2}:mode==='empty'?{oldText:''}:{}
 const server=await connect(ctx,(_req,n)=>n===1?call('patch_file',patchArgs(before,extra)):done())
 try{await run(ctx.service);assert.equal(fs.readFileSync(target,'utf8'),before);assert.equal(ctx.project.changes.length,0);assert.equal(ctx.feature.stage,'blocked');assert.equal(server.requests.length,2)}finally{await server.close()}
})
for(const boundary of ['effect','result','projection'])test('patch '+boundary+' failure recovers once using durable file effect',async()=>{
 const ctx=setup(),target=path.join(ctx.root,'value.cjs'),before=fs.readFileSync(target,'utf8');let injected=false,writes=0;const write=fs.writeFileSync
 const server=await connect(ctx,(_req,n)=>n===1?{text:'',calls:[call('patch_file',patchArgs(before)).calls[0],call('list_files',{}).calls[0]]}:done())
 fs.writeFileSync=(file,content,...args)=>{if(file===target){writes++;const result=write(file,content,...args);if(boundary==='effect'&&!injected){injected=true;throw new Error('after actual patch')}return result}
 const record=receipts(ctx.service).find(x=>x.tool==='patch_file');if(!injected&&file===ctx.service.store.path+'.tmp'&&(boundary==='result'?record?.status==='completed':boundary==='projection'&&record?.applied)){injected=true;throw new Error('patch save failed')}return write(file,content,...args)}
 try{await run(ctx.service);assert.ok(injected);assert.equal(writes,1);assert.equal(server.requests.length,1);fs.writeFileSync=write
  const restored=new EngineeringService();await run(restored);const record=receipts(restored).find(x=>x.tool==='patch_file');assert.equal(record.status,'completed');assert.equal(record.attempts,1);assert.equal(restored.store.project('p').changes.length,1);assert.equal(server.requests.length,2);assert.equal(fs.readFileSync(target,'utf8'),before.replace('a+b','a + b'))
  fs.writeFileSync(path.join(output,'patch-'+boundary+'.json'),JSON.stringify({writes,record,project:restored.store.project('p')},null,2))
 }finally{fs.writeFileSync=write;await server.close()}
})
test('new same-argument patch identity can execute, while optional permissions remain off after save',async()=>{
 const ctx=setup(),before=fs.readFileSync(path.join(ctx.root,'value.cjs'),'utf8'),args=patchArgs(before,{newText:'a+b'})
 const server=await connect(ctx,(_req,n)=>n===1?{text:'',calls:[call('patch_file',args).calls[0],call('patch_file',args).calls[0]]}:done())
 try{await run(ctx.service);assert.equal(receipts(ctx.service).length,2);assert.ok(receipts(ctx.service).every(x=>x.attempts===1));assert.equal(ctx.feature.runtimeBudget.used.tools,2)
 const agent=ctx.service.store.data.agents.find(a=>a.id==='developer');ctx.service.saveAgent({...agent,tools:agent.tools.filter(t=>!['search_files','read_file_lines','patch_file'].includes(t))});assert.ok(!ctx.service.store.data.agents.find(a=>a.id==='developer').tools.includes('search_files'))
 const reviewer=ctx.service.store.data.agents.find(a=>a.id==='reviewer');assert.throws(()=>ctx.service.saveAgent({...reviewer,tools:[...reviewer.tools,'patch_file']}),/配置无效/)
 }finally{await server.close()}
})
test('old v2 pending receipts retain original intent hash and completed read is never replayed',async()=>{
 const ctx=setup(),contract=load('src/main/engineering/tool-contract.ts'),original=contract.toolContractVersion,groups=load('src/main/engineering/read-groups.ts'),originalPlan=groups.planReadGroup;ctx.service.store.data.agents.find(a=>a.id==='developer').tools=load('src/shared/engineering.ts').defaultAgentTools('developer');let stopped=false
 const server=await connect(ctx,(_req,n)=>n===1?{text:'',calls:[call('read_file',{path:'value.cjs'}).calls[0],call('read_file',{path:'package.json'}).calls[0]]}:done())
 const save=ctx.service.store.save.bind(ctx.service.store);ctx.service.store.save=()=>{save();if(!stopped&&receipts(ctx.service).some(x=>x.status==='completed')){stopped=true;ctx.service.stop('p')}}
 try{contract.toolContractVersion='engineering-tools-v2';groups.planReadGroup=async()=>undefined;await run(ctx.service);assert.equal(ctx.service.store.data.executionCheckpoints[JSON.stringify(['p','f'])].pending.readPlan,undefined);groups.planReadGroup=originalPlan;const first=receipts(ctx.service)[0];assert.ok(first,JSON.stringify(ctx.project.events.slice(-3)));assert.equal(first.schemaVersion,'engineering-tools-v2');const hash=first.intentHash;contract.toolContractVersion=original
 const restored=new EngineeringService();await run(restored);assert.equal(receipts(restored)[0].intentHash,hash);assert.equal(receipts(restored)[0].attempts,1);assert.equal(restored.store.project('p').features[0].runtimeBudget.used.tools,2);assert.equal(server.requests.length,2)
 fs.writeFileSync(path.join(output,'v2-compatibility.json'),JSON.stringify({hash,records:receipts(restored)},null,2))
 }finally{contract.toolContractVersion=original;groups.planReadGroup=originalPlan;await server.close()}
})
test('external change between patch preparation reads cannot be overwritten',async()=>{
 const ctx=setup(),target=path.join(ctx.root,'value.cjs'),before=fs.readFileSync(target,'utf8'),external=before+';external';const read=fs.readFileSync;let once=false
 fs.readFileSync=(file,...args)=>{const result=read(file,...args);if(file===target&&!once){once=true;fs.writeFileSync(target,external)}return result}
 try{assert.throws(()=>load('src/main/engineering/file-effects.ts').preparePatchEffect(ctx.project,'f','developer',patchArgs(before)),/版本已变化/);assert.equal(fs.readFileSync(target,'utf8'),external);assert.equal(ctx.project.changes.length,0)}finally{fs.readFileSync=read}
})
test('protected original content rejects patch before intent persistence or file mutation',async()=>{
 const ctx=setup(),target=path.join(ctx.root,'value.cjs'),secret='sk-isolatedfixture12345',before=fs.readFileSync(target,'utf8')+'\n// '+secret;fs.writeFileSync(target,before)
 const server=await connect(ctx,(_req,n)=>n===1?call('patch_file',patchArgs(before)):done())
 try{await run(ctx.service);assert.equal(fs.readFileSync(target,'utf8'),before);assert.equal(ctx.project.changes.length,0);assert.equal(receipts(ctx.service).length,0);assert.ok(!fs.readFileSync(ctx.service.store.path,'utf8').includes(secret));assert.ok(server.requests[1].body.messages.some(x=>String(x.content).includes('受保护连接密钥')))}finally{await server.close()}
})
test('patch requires complete pinned prototype coverage, then the new logical call can proceed',async()=>{
 const ctx=setup(),before=fs.readFileSync(path.join(ctx.root,'value.cjs'),'utf8');ctx.feature.prototypeId='prototype';ctx.project.prototypes.push({id:'prototype',title:'完整原型',html:'<main>'+'x'.repeat(8000)+'</main>',at:new Date().toISOString()})
 const server=await connect(ctx,(_req,n)=>{if(n===1)return call('read_context',{id:'prototype:prototype',offset:0});if(n===2)return call('patch_file',patchArgs(before));if(n===3){assert.equal(fs.readFileSync(path.join(ctx.root,'value.cjs'),'utf8'),before);return call('read_context',{id:'prototype:prototype',offset:6000})}return n===4?call('patch_file',patchArgs(before)):done()})
 try{await run(ctx.service);assert.deepEqual(server.errors,[]);assert.equal(server.requests.length,5);assert.equal(fs.readFileSync(path.join(ctx.root,'value.cjs'),'utf8'),before.replace('a+b','a + b'));assert.equal(receipts(ctx.service).filter(r=>r.tool==='patch_file'&&r.status==='completed').length,1);assert.ok(JSON.stringify(server.requests[2].body).includes('请先完整分页读取已验收原型'));fs.writeFileSync(path.join(output,'prototype-patch.json'),JSON.stringify({requests:server.requests,records:receipts(ctx.service)},null,2))}finally{await server.close()}
})

for(const role of ['reviewer','revoked-developer'])test(role+' cannot dispatch patch even when the model returns it',async()=>{
 const ctx=setup(),target=path.join(ctx.root,'value.cjs'),before=fs.readFileSync(target,'utf8')
 let attempted=false
 const server=await connect(ctx,(req,n)=>{if(role==='reviewer'&&req.system.includes('你是 Coprojer 的开发智能体'))return answer({status:'complete',summary:'交独立验证',nextStep:'验证'});if(!attempted){attempted=true;if(role==='revoked-developer')ctx.service.store.data.agents.find(a=>a.id==='developer').tools=ctx.service.store.data.agents.find(a=>a.id==='developer').tools.filter(t=>t!=='patch_file');return call('patch_file',patchArgs(before))}return role==='reviewer'?{httpStatus:503,error:{message:'stop isolated reviewer after denied patch'}}:done()})
 try{await run(ctx.service);assert.equal(fs.readFileSync(target,'utf8'),before);assert.equal(ctx.project.changes.length,0);assert.equal(receipts(ctx.service).length,0);assert.equal(ctx.feature.runtimeBudget.used.tools,0);assert.ok(server.requests.length>=2);assert.ok(JSON.stringify(server.requests.at(-1).body).includes('patch_file'));fs.writeFileSync(path.join(output,role+'-patch.json'),JSON.stringify({requests:server.requests,stage:ctx.feature.stage,budget:ctx.feature.runtimeBudget},null,2))}finally{await server.close()}
})

test('line read and patch cannot cross into another isolated project',async()=>{
 const ctx=setup(),other=path.join(sandbox,'other-project');fs.mkdirSync(other,{recursive:true});const sentinel='other-project-private',target=path.join(other,'value.cjs');fs.writeFileSync(target,sentinel)
 const foreign='../other-project/value.cjs',server=await connect(ctx,(_req,n)=>n===1?{text:'',calls:[call('read_file_lines',{path:foreign,startLine:1,endLine:1}).calls[0],call('patch_file',{path:foreign,expectedVersion:efficient.textVersion(sentinel),startLine:1,endLine:1,oldText:sentinel,newText:'changed'}).calls[0]]}:done())
 try{await run(ctx.service);assert.equal(fs.readFileSync(target,'utf8'),sentinel);assert.equal(ctx.project.changes.length,0);assert.ok(!JSON.stringify(server.requests[1].body.messages.filter(m=>m.role==='tool')).includes(sentinel));assert.ok(receipts(ctx.service).every(r=>r.status==='failed'))}finally{await server.close()}
})

test('preparer patch preserves business and existing tests, modifies its own file, then rejects outside edits',async()=>{
 const ctx=setup(),business=fs.readFileSync(path.join(ctx.root,'value.cjs'),'utf8'),oldTest="console.log('existing')",own="console.log('before')",updated="console.log('after')",outside="console.log('outside')";fs.writeFileSync(path.join(ctx.root,'tests/existing.cjs'),oldTest);let prep=0,reviews=0
 const args=(p,before,oldText,newText)=>({path:p,expectedVersion:efficient.textVersion(before),startLine:1,endLine:1,oldText,newText})
 const server=await connect(ctx,req=>{
  if(req.system.includes('VERIFICATION_DIAGNOSIS'))return answer({gaps:ctx.feature.verificationPreparation.gaps.map(g=>({id:g.id,disposition:'automatic',reason:'需要项目内实际检查脚本',nextStep:'新增补充检查脚本'}))})
  if(req.system.includes('VERIFICATION_PREPARATION')){prep++;if(prep===1)return call('patch_file',patchArgs(business));if(prep===2)return call('patch_file',args('tests/existing.cjs',oldTest,'existing','weaker'));if(prep===3)return call('write_file',{path:'tests/owned.cjs',content:own});if(prep===4)return call('patch_file',args('tests/owned.cjs',own,'before','after'));if(prep===5){fs.writeFileSync(path.join(ctx.root,'tests/owned.cjs'),outside);return call('patch_file',args('tests/owned.cjs',outside,'outside','overwrite'))}return answer({status:'blocked',summary:'保留外部修改',nextStep:'等待独立核对'})}
  if(req.system.includes('你是 Coprojer 的开发智能体'))return answer({status:'complete',summary:'交独立验证',nextStep:'验证'})
  return ++reviews===1?answer({summary:'缺少可执行脚本',results:[{criterion:ctx.feature.criteria[0],passed:false,status:'unverified',evidence:'需要项目内行为检查脚本，尚未实际验证',evidenceKind:'inspection'}]}):{httpStatus:503,error:{message:'stop at independent reviewer after partial preparation'}}
 })
 try{await run(ctx.service);assert.deepEqual(server.errors,[]);assert.equal(prep,6);assert.equal(fs.readFileSync(path.join(ctx.root,'value.cjs'),'utf8'),business);assert.equal(fs.readFileSync(path.join(ctx.root,'tests/existing.cjs'),'utf8'),oldTest);assert.equal(fs.readFileSync(path.join(ctx.root,'tests/owned.cjs'),'utf8'),outside);const patches=receipts(ctx.service).filter(r=>r.tool==='patch_file'&&r.status==='completed');assert.equal(patches.length,1);assert.equal(patches[0].role,'preparer');assert.equal(patches[0].attempts,1);assert.equal(ctx.project.changes.find(c=>c.path==='tests/owned.cjs').after,updated);fs.writeFileSync(path.join(output,'preparer-patch.json'),JSON.stringify({requests:server.requests,records:receipts(ctx.service),preparation:ctx.feature.verificationPreparation},null,2))}finally{await server.close()}
})

for(const mode of ['patch','reliable-write','legacy-write'])test(mode+' rejects a project file hard-linked to an outside sentinel',async()=>{
 const ctx=setup(),outside=path.join(sandbox,'outside-'+mode+'.txt'),target=path.join(ctx.root,'linked.txt'),before='outside sentinel';fs.writeFileSync(outside,before);fs.linkSync(outside,target);if(mode==='legacy-write')delete ctx.feature.runtimePolicy
 const args=mode==='patch'?{path:'linked.txt',expectedVersion:efficient.textVersion(before),startLine:1,endLine:1,oldText:before,newText:'changed'}:{path:'linked.txt',content:'changed'}
 const server=await connect(ctx,(_req,n)=>n===1?call(mode==='patch'?'patch_file':'write_file',args):done());const write=fs.writeFileSync;let writes=0
 fs.writeFileSync=(file,...args)=>{if(file===target)writes++;return write(file,...args)}
 try{await run(ctx.service);assert.equal(fs.readFileSync(outside,'utf8'),before);assert.equal(fs.readFileSync(target,'utf8'),before);assert.equal(writes,0);assert.equal(ctx.project.changes.length,0);assert.ok(!receipts(ctx.service).some(r=>r.status==='completed'));fs.writeFileSync(path.join(output,mode+'-hardlink.json'),JSON.stringify({writes,records:receipts(ctx.service),stage:ctx.feature.stage},null,2))}finally{fs.writeFileSync=write;await server.close()}
})

test('a hard link created after effect preparation is rejected by the final write guard',async()=>{
 const ctx=setup(),target=path.join(ctx.root,'value.cjs'),before=fs.readFileSync(target,'utf8'),outside=path.join(sandbox,'late-link.txt'),effects=load('src/main/engineering/file-effects.ts'),apply=effects.applyFileEffect;let linked=false
 effects.applyFileEffect=(...args)=>{if(!linked){linked=true;fs.linkSync(target,outside)}return apply(...args)}
 const server=await connect(ctx,(_req,n)=>n===1?call('patch_file',patchArgs(before)):done())
 try{await run(ctx.service);assert.ok(linked);assert.equal(fs.readFileSync(target,'utf8'),before);assert.equal(fs.readFileSync(outside,'utf8'),before);assert.equal(ctx.project.changes.length,0);assert.ok(!receipts(ctx.service).some(r=>r.status==='completed'))}finally{effects.applyFileEffect=apply;await server.close()}
})

async function main(){const filter=process.argv[2];for(const {name,fn} of tests.filter(t=>!filter||t.name.includes(filter)))try{await fn();results.push({name,status:'passed'});console.log('PASS:',name)}catch(error){results.push({name,status:'failed',error:error.stack});console.error('FAIL:',name,error.stack)}fs.writeFileSync(path.join(output,filter?'focused-results.json':'results.json'),JSON.stringify(results,null,2));assert.ok(results.length&&results.every(x=>x.status==='passed'))}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{model.complete=actualComplete;fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:3})})
