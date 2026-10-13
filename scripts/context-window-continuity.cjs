const {assert,fs,path,fixture,model,EngineeringService}=require('./fixtures/verification-runtime.cjs')
const reply = calls => ({text:'',calls})
async function main(){
 // Stop after the first of two effects is durably committed; reload the real store.
 const ctx=fixture();ctx.feature.stage='requirements';ctx.project.chat.push({id:'human-start',role:'user',text:'整理需求',purpose:'discussion',at:new Date().toISOString()})
 const controller=new AbortController(),save=ctx.service.store.save.bind(ctx.service.store)
 ctx.service.store.save=()=>{save();if(ctx.project.chat.some(e=>e.tools?.some(t=>t.id==='first'&&t.committed)))controller.abort(new Error('controlled stop after committed effect'))}
 model.complete=async()=>reply([{id:'first',name:'update_requirements',arguments:JSON.stringify({content:'FIRST_REQUIREMENTS'})},{id:'second',name:'update_project_targets',arguments:JSON.stringify({targets:[{id:'web',name:'网页',kind:'web',directory:'web',responsibility:'入口',contracts:'本地'}]})}])
 await assert.rejects(()=>ctx.service.research.discuss(ctx.project,ctx.service.agentModel(ctx.service.store.data.agents.find(a=>a.role==='planner')),controller.signal))
 let disk=JSON.parse(fs.readFileSync(ctx.service.store.path));assert.equal(disk.projects[0].requirementsDocument,'FIRST_REQUIREMENTS');assert.ok(Object.values(disk.contextSnapshots).some(s=>s.continuity.discussion.pending))
 const restarted=new EngineeringService(),p=restarted.store.project('p');let requests=0
 model.complete=async(_c,_s,m)=>{requests++;assert.equal(m.filter(x=>x.role==='tool'&&x.callId==='first').length,1);assert.equal(m.filter(x=>x.role==='tool'&&x.callId==='second').length,1);return{text:'已保存草稿，待人工确认',calls:[]}}
 await restarted.research.discuss(p,restarted.agentModel(restarted.store.data.agents.find(a=>a.role==='planner')),new AbortController().signal)
 assert.equal(requests,1);assert.equal(p.targets.length,1);assert.equal(p.requirementsDocument,'FIRST_REQUIREMENTS');assert.equal(p.chat.filter(e=>e.tools?.some(t=>t.id==='first')).length,1)
 // An already completed turn never starts a second model call when the round cursor has not moved.
 await restarted.research.discuss(p,restarted.agentModel(restarted.store.data.agents.find(a=>a.role==='planner')),new AbortController().signal);assert.equal(requests,1)
 const snapshot=Object.values(restarted.store.data.contextSnapshots).find(s=>s.continuity.discussion)
 assert.ok(snapshot.continuity.discussion.completed);assert.ok(snapshot.continuity.continuationArtifactId);assert.ok(snapshot.continuity.indexArtifactId)
 console.log('PASS discussion restart: committed effect reused, remaining call completes once, final turn idempotent, durable docs/index')
}
main().catch(e=>{console.error(e);process.exitCode=1})
