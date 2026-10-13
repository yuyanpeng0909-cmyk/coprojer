const { assert, load, fs, path } = require('./fixtures/verification-runtime.cjs')
const { requestWithContext } = load('src/main/engineering/context-request.ts')
const model = load('src/main/engineering/model.ts')
const { observeInputUsage } = load('src/main/engineering/context-budget.ts')
const { newContinuity } = load('src/main/engineering/context-continuity.ts')
const output = path.resolve('.runtime/context-window/replay.json')
async function replay(category,pattern,mode) {
  const c={id:`${category}-${pattern}-${mode}`,name:'replay',baseUrl:'http://127.0.0.1:1/v1',model:'fixture',protocol:'chat',apiKey:'fixture',capabilities:{contextWindowTokens:256000,maxOutputTokens:16000,outputParameter:'max_tokens',windowAccounting:'input-plus-output',reasoningAccounting:'included-in-output',contextPolicy:{version:2,mode,triggerScope:'total',compactor:'portable',horizonRounds:6}}}
  const messages=[{role:'user',content:'CURRENT_GOAL: preserve accepted scope and continue only unfinished work',sequence:1}], continuity=newContinuity(c.id,'baseline')
  let compactions=0,inputTokens=0,sequence=1,lastCompact=0,intervals=[],hashes=new Set(), sent=0
  const started=performance.now()
  for(let round=0;round<36;round++) {
    const base={prototype:7000,code:11000,logs:17000}[category],size=Math.floor(base*(pattern===0?1:pattern===1?(round%3===0?1.8:.6):(.7+(round%7)/10)))
    messages.push({role:'assistant',content:`STEP_${round} verified fixture fact `+'ABC_0123456789_'.repeat(Math.ceil(size/15)).slice(0,size),sequence:++sequence})
    await requestWithContext(messages,{prepare:h=>model.prepareModelRequest(c,'Stable host facts',h,[],false),assertCurrent(){},commit(){},archive:()=> 'artifact:00000000-0000-0000-0000-000000000000',event(){},
      compaction:r=>{compactions++;intervals.push(round-lastCompact);lastCompact=round;assert.ok(!hashes.has(r.epoch));hashes.add(r.epoch)},
      send:async p=>{assert.ok(p.payload.includes('CURRENT_GOAL')); const tokens=Math.ceil(p.budget.requestBytes/3);inputTokens+=tokens;observeInputUsage(p.budget,tokens);sent++;return{text:'done',calls:[],usage:{inputTokens:tokens,outputTokens:1}}}
    },new AbortController().signal,{continuity})
  }
  return {category,pattern,mode,compactions,effectiveRounds:sent,intervals,inputTokens,outputTokens:sent,duplicateReads:0,extraCountRequests:0,elapsedMs:Math.round(performance.now()-started),completed:sent===36}
}
async function main(){ const rows=[];for(const category of ['prototype','code','logs'])for(let pattern=0;pattern<3;pattern++)for(const mode of ['legacy','adaptive'])rows.push(await replay(category,pattern,mode))
const comparisons=['prototype','code','logs'].map(category=>{const sum=(mode,key)=>rows.filter(r=>r.category===category&&r.mode===mode).reduce((n,r)=>n+r[key],0); const legacy=sum('legacy','compactions'),adaptive=sum('adaptive','compactions');return{category,legacy,adaptive,reduction:legacy?1-adaptive/legacy:null,tokenRatio:sum('adaptive','inputTokens')/sum('legacy','inputTokens')}})
assert.ok(rows.every(r=>r.completed));assert.ok(comparisons.every(c=>c.adaptive<=c.legacy));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({level:'deterministic replay; usage is fixture arithmetic, not provider evidence; elapsed time is local orchestration only',rows,comparisons,rollout:'directional opt-in; cost increase over 20% blocks default rollout'},null,2));console.log(JSON.stringify(comparisons));console.log('PASS paired replay: all 18 workloads completed; no category compression regression') }
main().catch(e=>{console.error(e);process.exitCode=1})
