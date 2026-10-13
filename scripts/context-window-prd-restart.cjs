const {assert,fixture,model,EngineeringService}=require('./fixtures/verification-runtime.cjs')
const {provider}=require('./fixtures/context-runtime-provider.cjs')
async function main(){
 const ctx=fixture();ctx.feature.stage='requirements';ctx.project.prototypes=[{id:'approved',title:'长原型',html:'<html>'+ '长原型事实'.repeat(33000)+'</html>',at:new Date().toISOString()}];ctx.service.selectPrototype('p','approved')
 const offsets=[],server=await provider(req=>{
  const prompt=req.body.messages[0].content,line=prompt.split('\n').find(s=>s.startsWith('必读资料进度：')),page=JSON.parse(line.slice('必读资料进度：'.length))[0]
  if(page.complete)return{text:JSON.stringify({document:'# 已确认原型 PRD',features:[{id:'f',title:ctx.feature.title,module:'核心',description:'原型所见事实',criteria:ctx.feature.criteria}]}),calls:[]}
  const calls=[];for(let i=0;i<3;i++){const offset=(page.nextOffset??0)+i*6000;if(page.totalCharacters!==null&&offset>=page.totalCharacters)break;offsets.push(offset);calls.push({id:'read-'+offset,name:'read_context',arguments:JSON.stringify({id:'prototype:approved',offset,...(page.version?{version:page.version}:{})})})}return{text:'',calls}
 })
 try{
  ctx.service.store.data.models[0].baseUrl=server.url;let stopped=false;const save=ctx.service.store.save.bind(ctx.service.store)
  ctx.service.store.save=()=>{save();if(!stopped&&Object.values(ctx.service.store.data.contextSnapshots??{}).some(s=>(s.continuity?.growth?.epoch??0)>=2)){stopped=true;ctx.service.stop('p')}}
  await assert.rejects(()=>ctx.service.preparePrd('p'));assert.ok(stopped);const before=Math.max(...offsets),operation=ctx.project.prd.operationId
  const restarted=new EngineeringService();let completionStopped=false;const save2=restarted.store.save.bind(restarted.store)
  restarted.store.save=()=>{save2();if(!completionStopped&&Object.values(restarted.store.data.contextSnapshots??{}).some(s=>s.continuity?.completedReply)){completionStopped=true;restarted.stop('p')}}
  await assert.rejects(()=>restarted.preparePrd('p'));assert.ok(completionStopped);assert.equal(restarted.store.project('p').prd.operationId,operation);assert.ok(Math.max(...offsets)>before);assert.equal(new Set(offsets).size,offsets.length)
  const requests=server.requests.length,again=new EngineeringService();await again.preparePrd('p');assert.equal(server.requests.length,requests);assert.equal(again.store.project('p').prd.status,'review');assert.equal(again.store.project('p').requirementsDocument,'# 已确认原型 PRD');assert.deepEqual(server.errors,[])
  console.log('PASS PRD: two compactions + restart resumes unique offsets; completed-but-unapplied reply reuses same operation without another request')
 }finally{await server.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
