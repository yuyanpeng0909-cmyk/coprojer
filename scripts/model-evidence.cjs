const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const { arenaHtml, categories } = require('./fixtures/arena.cjs')
const cache = new Map()
function load(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(exports, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return exports
}
const { parseArenaTable, collectModelEvidence, matchModelEvidence, eligibleModelIds, modelSelectionReason, arenaSources } = load('src/main/engineering/model-evidence.ts')
const { defaultModelCapability } = load('src/shared/model-evidence.ts')
const realFetch = globalThis.fetch
async function main() {
  const rows = [
    { model: 'quality-max', score: 1500, input: 3, output: 9 },
    { model: 'capable-flash', score: 1495, input: 1, output: 2 },
    { model: 'weak-flash', score: 1200, input: 0.01, output: 0.02 },
    { model: 'dominated', score: 1400, input: 5, output: 10 },
    { model: 'unknown-price', score: 1500 },
    { model: 'preliminary', score: 2000, preliminary: true, input: 0, output: 0 },
  ]
  const parsed = parseArenaTable(arenaHtml('frontend', rows), 'frontend')
  assert.equal(parsed.rows.length, rows.length); assert.equal(parsed.rows[0].lower, 1490); assert.equal(parsed.rows[0].upper, 1510)
  assert.equal(parseArenaTable(arenaHtml('coding', [{model:'symmetric',score:1000,ci:'±6'}]), 'coding').rows[0].lower, 994)
  assert.throws(()=>parseArenaTable(arenaHtml('webdev', rows), 'frontend'), /类别不匹配/)
  assert.throws(()=>parseArenaTable(arenaHtml('frontend', rows).replace('6 models','7 models'), 'frontend'), /未完整加载/)
  assert.throws(()=>parseArenaTable(arenaHtml('frontend', rows).replace('<th>Votes</th>','<th>Other</th>'), 'frontend'), /结构已变化/)
  const duplicates = parseArenaTable(arenaHtml('frontend', [rows[0], rows[0]]), 'frontend')
  assert.equal(matchModelEvidence(duplicates.rows, [{ id: 'duplicate', model: rows[0].model }])[0].match, 'ambiguous')
  assert.throws(()=>parseArenaTable(arenaHtml('frontend', [{model:'bad',score:'invalid'}]), 'frontend'), /分数/)
  const models = rows.map(r=>({id:r.model,model:r.model})).concat([{id:'missing',model:'quality'}, {id:'other-version',model:'quality-max-high'}, {id:'vendor-prefix',model:'vendor/quality-max'}])
  const evidence = { category: 'frontend', url: arenaSources.frontend.url, fetchedAt: new Date().toISOString(), updatedAt: parsed.updatedAt, status:'fresh', candidates: matchModelEvidence(parsed.rows,models), note:'' }
  assert.deepEqual(evidence.candidates.filter(c=>c.match==='unmatched').map(c=>c.connectionId), ['missing','other-version','vendor-prefix'])
  assert.deepEqual(eligibleModelIds(evidence,'quality'), ['quality-max','unknown-price'])
  assert.deepEqual(eligibleModelIds(evidence,'pareto'), ['quality-max','capable-flash','unknown-price'])
  assert.equal(evidence.candidates.find(c=>c.connectionId==='weak-flash').pareto,'frontier','cheaper but substantially weaker is on frontier yet not eligible')
  assert.equal(evidence.candidates.find(c=>c.connectionId==='dominated').pareto,'dominated')
  assert.equal(evidence.candidates.find(c=>c.connectionId==='unknown-price').pareto,'unknown')
  assert.equal(evidence.candidates.find(c=>c.connectionId==='preliminary').pareto,'unknown')
  assert.deepEqual(eligibleModelIds({...evidence,status:'stale'},'quality'),[])
  assert.match(modelSelectionReason(evidence,'unknown-price','pareto'),/未宣称 Pareto/)
  const noInterval = {...evidence,candidates:matchModelEvidence(parseArenaTable(arenaHtml('frontend',[{model:'no-interval',score:1500,ci:null,input:1,output:2}]),'frontend').rows,[{id:'no-interval',model:'no-interval'}])}
  assert.match(modelSelectionReason(noInterval,'no-interval','pareto'),/来源未提供分数区间/)
  assert.ok(!modelSelectionReason(noInterval,'no-interval','pareto').includes('与最高分候选的榜单区间重叠'))
  assert.equal(defaultModelCapability({name:'原型设计智能体',role:'developer',instructions:''}),'frontend')
  assert.equal(defaultModelCapability({name:'全栈应用',role:'developer',instructions:''}),'fullstack')
  const requests=[]
  globalThis.fetch = async (url, init) => { requests.push({url,init}); return new Response(arenaHtml(categories[new URL(url).pathname], rows), {headers:{'content-type':'text/html'}}) }
  const collected=await collectModelEvidence(['frontend','frontend','coding'],models)
  assert.equal(requests.length,2);assert.equal(collected[0].status,'fresh');assert.equal(collected[1].category,'coding')
  await collectModelEvidence(['frontend','coding'],models)
  assert.equal(requests.length,4,'every recommendation must fetch sources again, not use a previous snapshot')
  assert.ok(requests.every(r=>r.init.cache==='no-store' && r.init.headers['Cache-Control']==='no-cache'))
  assert.ok(requests.every(r=>new URL(r.url).hostname==='arena.ai' && r.init.redirect==='error' && !r.init.headers.Authorization && !r.init.body))
  globalThis.fetch=async()=>new Response(arenaHtml('frontend',rows,new Date('2020-01-01')), {headers:{'content-type':'text/html'}})
  assert.equal((await collectModelEvidence(['frontend'],models))[0].status,'stale')
  globalThis.fetch=async()=>new Response('blocked',{status:403})
  assert.equal((await collectModelEvidence(['frontend'],models))[0].status,'unavailable')
  globalThis.fetch=async()=>new Response('truncated',{headers:{'content-type':'text/html'}})
  assert.equal((await collectModelEvidence(['frontend'],models))[0].status,'unavailable')
  globalThis.fetch=async()=>{throw Error('fetch failed')}
  assert.equal((await collectModelEvidence(['frontend'],models))[0].status,'unavailable')
  globalThis.fetch=async()=>new Response('x',{headers:{'content-type':'text/html','content-length':'7000000'}})
  assert.match((await collectModelEvidence(['frontend'],models))[0].note,/过大/)
  globalThis.fetch=realFetch
  if (process.argv.includes('--live')) {
    const live=await collectModelEvidence(Object.keys(arenaSources),[{id:'glm',model:'glm-5.3'},{id:'glm-flash',model:'glm-5.3-flash'},{id:'kimi',model:'kimi-k3'},{id:'qwen',model:'qwen3.7-flash'}])
    fs.mkdirSync('.runtime',{recursive:true});fs.writeFileSync('.runtime/model-evidence-live.json',JSON.stringify(live,null,2))
    for(const s of live) { console.log(JSON.stringify({category:s.category,status:s.status,date:s.updatedAt,note:s.note,matched:s.candidates.filter(c=>c.match==='exact').map(c=>c.model)}));assert.equal(s.status,'fresh',s.category+': '+s.note) }
  }
  console.log('PASS: exact versions, category mapping, parser/partial-page checks, score-only selection, Pareto/unknown prices, preliminary exclusion, failed/stale sources, public credential-free requests')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{globalThis.fetch=realFetch})
