const r=require('./fixtures/verification-runtime.cjs'),{fs,path,assert,sandbox,fixture,load,model,answer,call,run,EngineeringService}=r
const {provider}=require('./fixtures/context-runtime-provider.cjs'),files=load('src/main/engineering/files.ts'),actualTool=files.executeTool,actualComplete=model.complete
const output=path.resolve('.runtime/context-runtime/m6-groups');fs.mkdirSync(output,{recursive:true})
const tests=[],results=[],test=(name,fn)=>tests.push({name,fn}),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const receipts=s=>Object.values(s.store.data.receiptJournals?.[JSON.stringify(['p','f'])]?.receipts??{})
const key=JSON.stringify(['p','f']),done=()=>answer({status:'incomplete',summary:'实际读取保留，等待核对',nextStep:'人工核对'})
function setup(concurrency=2){const ctx=fixture();ctx.feature.runtimePolicy='receipts-effects-v1';ctx.feature.runtimeBudget=load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('isolated-read-group');const agent=ctx.service.store.data.agents.find(a=>a.id==='developer');agent.readConcurrency=concurrency;agent.tools.push('search_files','read_file_lines','patch_file');for(const name of ['a','b','c','d'])fs.writeFileSync(path.join(ctx.root,name+'.txt'),name.repeat(50));return ctx}
async function connect(ctx,calls){const server=await provider((_req,n)=>n===1?{text:'',calls:calls.map(([name,args])=>call(name,args).calls[0])}:done());ctx.service.store.data.models[0].baseUrl=server.url;ctx.service.store.save();model.complete=actualComplete;return server}
const reads=(...paths)=>paths.map(path=>['read_file',{path}])
test('B finishes first with real asynchronous reads; history and receipts remain A/B paired',async()=>{
 const ctx=setup(),server=await connect(ctx,reads('a.txt','b.txt'));let active=0,maxActive=0;const order=[]
 files.executeTool=async(...args)=>{active++;maxActive=Math.max(maxActive,active);try{if(args[5].path==='a.txt')await pause(50);const result=await actualTool(...args);order.push(args[5].path);return result}finally{active--}}
 try{await run(ctx.service);assert.equal(maxActive,2);assert.deepEqual(order,['b.txt','a.txt']);assert.equal(receipts(ctx.service).length,2);const wire=server.requests[1].body.messages,reply=wire.filter(m=>m.role==='tool'),calls=wire.flatMap(m=>m.tool_calls??[]);assert.deepEqual(reply.map(m=>m.tool_call_id),calls.map(c=>c.id));assert.deepEqual(reply.map(m=>JSON.parse(m.content).path),['a.txt','b.txt']);assert.ok(receipts(ctx.service).every(x=>x.attempts===1));fs.writeFileSync(path.join(output,'out-of-order.json'),JSON.stringify({order,maxActive,wire,records:receipts(ctx.service)},null,2))}finally{files.executeTool=actualTool;await server.close()}
})
test('ordinary B failure preserves completed A and stable complete protocol group',async()=>{
 const ctx=setup(),server=await connect(ctx,reads('a.txt','b.txt'))
 files.executeTool=async(...args)=>{if(args[5].path==='b.txt')throw new Error('controlled ordinary read failure');return actualTool(...args)}
 try{await run(ctx.service);assert.equal(server.requests.length,2);assert.equal(receipts(ctx.service).filter(r=>r.status==='completed').length,1);assert.equal(receipts(ctx.service).filter(r=>r.status==='failed').length,1);assert.equal(server.requests[1].body.messages.filter(m=>m.role==='tool').length,2)}finally{files.executeTool=actualTool;await server.close()}
})
test('A durable completion survives B result-save failure and restart without reread or extra charge',async()=>{
 const ctx=setup(),server=await connect(ctx,reads('a.txt','b.txt'));let injected=false;const counts={};const save=ctx.service.store.save.bind(ctx.service.store)
 files.executeTool=async(...args)=>{counts[args[5].path]=(counts[args[5].path]??0)+1;if(args[5].path==='b.txt')await pause(50);return actualTool(...args)}
 ctx.service.store.save=()=>{if(!injected&&receipts(ctx.service).some(x=>x.args.path==='b.txt'&&x.status==='completed')){injected=true;throw new Error('B result durable save failed')}save()}
 try{await run(ctx.service);assert.ok(injected);assert.ok(ctx.service.store.data.executionCheckpoints[key].pending.readPlan);assert.equal(counts['a.txt'],1);assert.equal(server.requests.length,1)
 const restored=new EngineeringService();await run(restored);assert.equal(counts['a.txt'],1);assert.equal(counts['b.txt'],2);assert.equal(receipts(restored).find(x=>x.args.path==='a.txt').attempts,1);assert.equal(restored.store.project('p').features[0].runtimeBudget.used.tools,3);assert.equal(server.requests.length,2);fs.writeFileSync(path.join(output,'partial-restart.json'),JSON.stringify({counts,records:receipts(restored)},null,2))}finally{files.executeTool=actualTool;await server.close()}
})
test('one remaining tool allowance starts only one actual read under two workers',async()=>{
 const ctx=setup(),server=await connect(ctx,reads('a.txt','b.txt'));ctx.feature.runtimeBudget.limits.tools=1;let started=0,active=0
 files.executeTool=async(...args)=>{started++;active++;try{await pause(30);return await actualTool(...args)}finally{active--}}
 try{await run(ctx.service);assert.equal(started,1);assert.equal(active,0);assert.equal(ctx.feature.runtimeBudget.used.tools,1);assert.equal(server.requests.length,1);assert.equal(ctx.feature.contextRuntime.status,'paused');assert.equal(receipts(ctx.service).filter(x=>x.status==='completed').length,1)
 const restored=new EngineeringService();restored.adjustRuntimeBudget({projectId:'p',featureId:'f'},{requests:10,tools:2,activeMs:60000},'测试用户明确授予第二次读取额度');await run(restored);assert.equal(started,2);assert.ok(receipts(restored).every(x=>x.status==='completed'&&x.attempts===1));assert.equal(server.requests.length,2)}finally{files.executeTool=actualTool;await server.close()}
})
for(const mode of ['cancel','permission','revision'])test(mode+' after first completion never starts queued C and drains running B',async()=>{
 const ctx=setup(),server=await connect(ctx,reads('a.txt','b.txt','c.txt'));const started=[];let active=0,triggered=false;const save=ctx.service.store.save.bind(ctx.service.store)
 files.executeTool=async(...args)=>{started.push(args[5].path);active++;try{if(args[5].path==='b.txt')await pause(60);return await actualTool(...args)}finally{active--}}
 ctx.service.store.save=()=>{save();if(!triggered&&receipts(ctx.service).some(x=>x.status==='completed')){triggered=true;if(mode==='cancel')ctx.service.stop('p');else if(mode==='permission')ctx.service.store.data.agents.find(a=>a.id==='developer').tools=[];else{ctx.feature.revision++;ctx.feature.stage='ready'}}}
 try{await run(ctx.service);assert.ok(triggered);assert.ok(!started.includes('c.txt'),JSON.stringify(started));assert.equal(active,0);if(mode==='revision')assert.equal(ctx.feature.stage,'ready');assert.ok(receipts(ctx.service).length>=1);fs.writeFileSync(path.join(output,mode+'.json'),JSON.stringify({started,records:receipts(ctx.service),reason:ctx.feature.contextRuntime?.reason},null,2))}finally{files.executeTool=actualTool;await server.close()}
})
for(const scenario of ['alias','overlap-search','write','command','patch'])test(scenario+' group remains sequential',async()=>{
 const ctx=setup();let calls=reads('a.txt','A.TXT')
 if(scenario==='overlap-search')calls=[['search_files',{scope:'.',query:'aaaa'}],['read_file',{path:'a.txt'}]]
 if(scenario==='write')calls=[['write_file',{path:'new.txt',content:'new'}],...reads('a.txt')]
 if(scenario==='command')calls=[['run_command',{program:'node',args:['tests/check.cjs'],timeoutSeconds:5}],...reads('a.txt')]
 if(scenario==='patch')calls=[['patch_file',{path:'a.txt',expectedVersion:load('src/main/engineering/efficient-files.ts').textVersion('a'.repeat(50)),startLine:1,endLine:1,oldText:'a'.repeat(50),newText:'patched'}],...reads('b.txt')]
 fs.writeFileSync(path.join(ctx.root,'tests/check.cjs'),"console.log('actual serial command')");const server=await connect(ctx,calls);let maxActive=0,active=0,plan
 const save=ctx.service.store.save.bind(ctx.service.store);ctx.service.store.save=()=>{plan??=ctx.service.store.data.executionCheckpoints?.[key]?.pending;save()}
 files.executeTool=async(...args)=>{active++;maxActive=Math.max(active,maxActive);try{await pause(5);return await actualTool(...args)}finally{active--}}
 try{await run(ctx.service);assert.ok(plan);assert.equal(plan.readPlan,undefined);assert.ok(maxActive<=1);assert.equal(server.requests.length,2)}finally{files.executeTool=actualTool;await server.close()}
})
test('A changes after completion while B runs; saved receipts cannot be spliced into current snapshot on restart',async()=>{
 const ctx=setup(),server=await connect(ctx,reads('a.txt','b.txt'));const started=[];let changed=false;const save=ctx.service.store.save.bind(ctx.service.store)
 files.executeTool=async(...args)=>{started.push(args[5].path);if(args[5].path==='b.txt')await pause(60);return actualTool(...args)}
 ctx.service.store.save=()=>{save();if(!changed&&receipts(ctx.service).some(x=>x.args.path==='a.txt'&&x.status==='completed')){changed=true;fs.appendFileSync(path.join(ctx.root,'a.txt'),'external')}}
 try{await run(ctx.service);assert.equal(server.requests.length,1);assert.match(ctx.feature.contextRuntime.reason,/版本已变化/);const restored=new EngineeringService();assert.throws(()=>restored.runFeature('p','f'),/修改|版本/);assert.equal(started.filter(p=>p==='a.txt').length,1);assert.ok(restored.store.data.executionCheckpoints[key].pending.readPlan)}finally{files.executeTool=actualTool;await server.close()}
})
for(const failArchive of [false,true])test('large group has fixed bounded JSON results; archive failure='+failArchive,async()=>{
 const ctx=setup(4);for(const name of ['a','b','c','d'])fs.writeFileSync(path.join(ctx.root,name+'.txt'),'x'.repeat(6000));const server=await connect(ctx,reads('a.txt','b.txt','c.txt','d.txt'))
 const artifacts=load('src/main/engineering/execution-artifacts.ts').ExecutionArtifacts,write=artifacts.prototype.write
 if(failArchive)artifacts.prototype.write=function(content,label){if(label.startsWith('只读工具组结果'))throw new Error('controlled archive failure');return write.call(this,content,label)}
 try{await run(ctx.service);assert.equal(server.requests.length,2);const outputs=server.requests[1].body.messages.filter(m=>m.role==='tool').map(m=>m.content);assert.ok(outputs.reduce((a,b)=>a+b.length,0)<=24000);for(const output of outputs){const page=JSON.parse(output);assert.ok(page.partial);assert.ok(page.version);assert.ok(page.nextOffset>0);assert.equal(!!page.archiveError,failArchive)}assert.ok(receipts(ctx.service).every(r=>JSON.parse(r.result.output).content.length===6000));fs.writeFileSync(path.join(output,'group-output-'+failArchive+'.json'),JSON.stringify({outputs,records:receipts(ctx.service)},null,2))}finally{artifacts.prototype.write=write;await server.close()}
})
for(const concurrency of [1,2])test('independent searches preserve stable paired results with concurrency '+concurrency,async()=>{
 const ctx=setup(concurrency);for(const name of ['left','right']){fs.mkdirSync(path.join(ctx.root,name));fs.writeFileSync(path.join(ctx.root,name,'hit.txt'),'needle')}
 const server=await connect(ctx,[['search_files',{scope:'left',query:'needle'}],['search_files',{scope:'right',query:'needle'}]]);let active=0,max=0,plan
 const save=ctx.service.store.save.bind(ctx.service.store);ctx.service.store.save=()=>{plan??=ctx.service.store.data.executionCheckpoints?.[key]?.pending?.readPlan;save()}
 files.executeTool=async(...args)=>{active++;max=Math.max(max,active);try{return await actualTool(...args)}finally{active--}}
 try{await run(ctx.service);assert.equal(max,concurrency);assert.equal(!!plan,concurrency>1);assert.ok(receipts(ctx.service).every(r=>JSON.parse(r.result.output).matches.length===1));assert.equal(server.requests.length,2);assert.deepEqual(server.requests[1].body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content).scope),['left','right']);assert.equal(load('src/shared/engineering.ts').defaultAgentTools('developer').includes('search_files'),false)}finally{files.executeTool=actualTool;await server.close()}
})

test('hard-linked file aliases and disjoint search directories fall back to serial',async()=>{
 const ctx=setup(),groups=load('src/main/engineering/read-groups.ts'),signal=new AbortController().signal
 fs.linkSync(path.join(ctx.root,'a.txt'),path.join(ctx.root,'alias.txt'))
 const calls=reads('a.txt','alias.txt').map(([name,args])=>call(name,args).calls[0]);assert.equal(await groups.planReadGroup(ctx.root,calls,2,signal),undefined)
 for(const dir of ['left','right'])fs.mkdirSync(path.join(ctx.root,dir))
 fs.linkSync(path.join(ctx.root,'a.txt'),path.join(ctx.root,'left','a.txt'));fs.linkSync(path.join(ctx.root,'a.txt'),path.join(ctx.root,'right','a.txt'))
 assert.equal(await groups.planReadGroup(ctx.root,['left','right'].map(scope=>call('search_files',{scope,query:'a'}).calls[0]),2,signal),undefined)
})
test('group planning and metadata validation do not read file bodies; second observation detects mid-check changes',async()=>{
 const ctx=setup(),groups=load('src/main/engineering/read-groups.ts'),calls=reads('a.txt','b.txt').map(([name,args])=>call(name,args).calls[0]),signal=new AbortController().signal
 const rawRead=fs.readFileSync,asyncRead=fs.promises.readFile;let bodyReads=0
 fs.readFileSync=(file,...args)=>{if([path.join(ctx.root,'a.txt'),path.join(ctx.root,'b.txt')].includes(file))bodyReads++;return rawRead(file,...args)}
 fs.promises.readFile=async(file,...args)=>{if([path.join(ctx.root,'a.txt'),path.join(ctx.root,'b.txt')].includes(file))bodyReads++;return asyncRead(file,...args)}
 let plan
 try{plan=await groups.planReadGroup(ctx.root,calls,2,signal);assert.ok(plan);await groups.checkReadGroup(ctx.root,calls,plan,signal);assert.equal(bodyReads,0)}finally{fs.readFileSync=rawRead;fs.promises.readFile=asyncRead}
 const stat=fs.lstatSync;let changed=false
 fs.lstatSync=(file,...args)=>{const result=stat(file,...args);if(file===path.join(ctx.root,'b.txt')&&args[0]?.bigint&&!changed){changed=true;fs.appendFileSync(path.join(ctx.root,'a.txt'),'outside')}return result}
 try{await assert.rejects(groups.checkReadGroup(ctx.root,calls,plan,signal),/版本已变化/);assert.ok(changed)}finally{fs.lstatSync=stat}
})
test('a worker awaiting resource validation cannot dispatch after another worker durable failure',async()=>{
 const ctx=setup(),server=await connect(ctx,reads('a.txt','b.txt')),groups=load('src/main/engineering/read-groups.ts'),check=groups.checkReadGroup;let checks=0,injected=false;const started=[]
 groups.checkReadGroup=async(...args)=>{if(++checks===3)await pause(100);return check(...args)}
 files.executeTool=async(...args)=>{started.push(args[5].path);return actualTool(...args)}
 const save=ctx.service.store.save.bind(ctx.service.store);ctx.service.store.save=()=>{if(!injected&&receipts(ctx.service).some(x=>x.status==='completed')){injected=true;throw new Error('first result storage failed')}save()}
 try{await run(ctx.service);assert.ok(injected);assert.deepEqual(started,['a.txt']);assert.equal(ctx.feature.runtimeBudget.used.tools,1);assert.equal(receipts(ctx.service).some(r=>r.args.path==='b.txt'),false);assert.equal(server.requests.length,1)}finally{groups.checkReadGroup=check;files.executeTool=actualTool;await server.close()}
})
async function main(){for(const {name,fn} of tests)try{await fn();results.push({name,status:'passed'});console.log('PASS:',name)}catch(error){results.push({name,status:'failed',error:error.stack});console.error('FAIL:',name,error.stack)}fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));assert.ok(results.every(x=>x.status==='passed'))}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{files.executeTool=actualTool;model.complete=actualComplete;fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:3})})
