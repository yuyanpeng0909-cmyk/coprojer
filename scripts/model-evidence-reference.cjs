const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), ts = require('typescript')
const { aaHtml, rows: aaRows } = require('./fixtures/aa.cjs'), { arenaHtml, categories } = require('./fixtures/arena.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-evidence-reference-')), cache = new Map(), realFetch = global.fetch, opened = []
function load(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file)
  const out = {}; cache.set(file, out)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(out, name => name === 'electron' ? { app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() }, shell: { openExternal: async url => opened.push(url) } } : name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return out
}
const E = load('src/main/engineering/model-evidence.ts'), AA = load('src/main/engineering/aa-evidence.ts')
const { isAgentModelPlan } = load('src/renderer/src/engineering/model-plan.ts'), { isModelEvidenceUrl } = load('src/shared/model-evidence.ts')
const glm = { id: 'glm', model: 'glm-5.3', name: 'glm-5.3', protocol: 'chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hasKey: true }
const qwen = { ...glm, id: 'qwen', model: 'qwen3.7-flash', baseUrl: 'https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }
const score = (model, value = 1000) => ({ model, score: value, rank: 1, votes: 1000, preliminary: false, inputPrice: 1, outputPrice: 2 })
async function main() {
  const url = E.arenaSources.frontend.url
  const rows = [score('glm-5.3-max', 100), score('glm-5.3-high', 9999), score('glm-5.3-low'), score('glm-5.2'), score('glm-5.3-flash'), score('unrelated-model', 99999)]
  const candidate = E.matchModelEvidence(rows, [glm], url)[0]
  assert.equal(candidate.match, 'unmatched'); assert.equal(candidate.score, undefined); assert.equal(candidate.pareto, 'unknown')
  assert.equal(candidate.similar.length, 3); assert.ok(candidate.similar.some(r => r.score.model === 'glm-5.3-max'))
  assert.ok(candidate.similar.every(r => r.url === url && r.note && !r.score.model.includes('unrelated')))
  assert.equal(E.matchModelEvidence([score('glm-5.3')], [glm], url)[0].match, 'exact')
  assert.equal(E.matchModelEvidence([score('glm-5.3'), score('GLM-5.3')], [glm], url)[0].match, 'ambiguous')
  assert.equal(E.matchModelEvidence(rows, [{ id: 'missing', model: 'completely-unrelated' }], url)[0].similar.length, 0)
  assert.match(E.matchModelEvidence([score('glm-5.2')], [glm], url)[0].similar[0].note, /版本或规格数字不同/)
  assert.match(E.matchModelEvidence([score('glm-5.3-flash')], [{ id: 'prefix', model: 'ZHIPU/GLM-5.3-Flash' }], url)[0].similar[0].note, /供应商前缀/)
  assert.equal(E.matchModelEvidence([score('glm-5.3-max'), score('glm-5.3-max')], [glm], url)[0].similar.length, 0, 'conflicting rows are not references')
  const evidence = { agentId: 'a', category: 'frontend', source: 'arena', status: 'fresh', url, fetchedAt: new Date().toISOString(), note: 'fixture', candidates: [candidate] }
  assert.deepEqual(E.eligibleModelIds(evidence, 'quality'), []); assert.deepEqual(E.eligibleModelIds(evidence, 'pareto'), [])
  assert.deepEqual(E.eligibleModelIds({ ...evidence, candidates: [{ ...candidate, score: rows[0] }] }, 'quality'), [], 'a non-exact score cannot leak into allocation')
  assert.equal(E.markPareto([{ ...candidate, score: rows[0] }])[0].pareto, 'unknown')
  const aa = AA.parseAAPage(aaHtml()).rows
  const high = AA.matchAAEvidence(aa, [glm], { reasoning: { enabled: true, effort: 'high' } }, 'aa-coding')[0]
  assert.equal(high.score, undefined); assert.equal(high.similar.length, 2); assert.ok(high.similar.every(r => r.score.metric === 'aa-coding'))
  assert.equal(AA.matchAAEvidence(aa, [glm], {}, 'aa-coding')[0].similar, undefined)
  const budgetRaw = { ...aaRows[0], slug: 'qwen3-7-flash-reasoning', name: 'Qwen3.7 Flash (Reasoning)', release: { slug: 'qwen3-7-flash' }, effort: null }
  const budgetRows = AA.parseAAPage(aaHtml([budgetRaw])).rows
  const budget = AA.matchAAEvidence(budgetRows, [qwen], { reasoning: { enabled: true, budget: 4096 } }, 'aa-intelligence')[0]
  assert.equal(budget.score, undefined); assert.equal(budget.similar.length, 1); assert.match(budget.similar[0].note, /预算/)
  const fetched = []
  global.fetch = async (url, init) => {
    fetched.push(String(url)); assert.equal(init.cache, 'no-store'); assert.equal(init.body, undefined); assert.equal(init.headers.Authorization, undefined)
    const u = new URL(url)
    const html = u.hostname === 'arena.ai' ? arenaHtml(categories[u.pathname], rows.map(r => ({ ...r, input: 1, output: 2 }))) : u.pathname === '/models' ? aaHtml(aaRows, [{ slug: budgetRaw.slug, name: budgetRaw.name, releaseSlug: budgetRaw.release.slug }]) : aaHtml([budgetRaw], [])
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  }
  const collected = await AA.collectAgentModelEvidence([{ id: 'a' }], ['frontend'], [glm, qwen])
  assert.equal(collected[0].candidates[0].similar[0].score.model, 'glm-5.3-max', 'the closest requested effort ranks before a higher score')
  assert.equal(collected[0].candidates[0].score, undefined); assert.deepEqual(E.eligibleModelIds(collected[0], 'quality'), [])
  assert.ok(collected[1].candidates[1].similar.some(r => r.score.model.includes('Qwen3.7')))
  assert.ok(fetched.some(u => u.endsWith('/qwen3-7-flash-reasoning')), 'budget fallback must fetch the observed public catalog URL')
  await AA.collectAgentModelEvidence([{ id: 'a' }], ['frontend'], [glm, qwen])
  assert.equal(fetched.filter(u => u === AA.aaSource).length, 2)
  assert.equal(fetched.filter(u => u === url).length, 2)
  const plan = { id: 'fixture', policy: 'quality', caveat: 'fixture', choices: [{ agentId: 'a', modelId: 'glm', previousModelId: 'glm', reason: 'preserve', category: 'frontend', supported: false }], evidence: collected }
  assert.ok(isAgentModelPlan(plan), 'AA and Arena references must pass the renderer contract')
  for (const mutation of [r => { r.score = null }, r => { r.score.score = 'wrong' }, r => { r.note = null }, r => { r.url = 'javascript:alert(1)' }, r => { r.url = 'https://artificialanalysis.ai/models' }]) {
    const invalid = structuredClone(plan); mutation(invalid.evidence[0].candidates[0].similar[0]); assert.equal(isAgentModelPlan(invalid), false)
  }
  const { EngineeringService } = load('src/main/engineering/service.ts'), service = new EngineeringService()
  await service.openModelEvidenceSource(url); await service.openModelEvidenceSource(AA.aaSource + '/glm-5-3-low')
  for (const invalid of ['javascript:alert(1)', 'file:///C:/secret', 'https://arena.ai.evil.example/leaderboard/code', 'https://arena.ai@evil.example/leaderboard/code', 'http://arena.ai/leaderboard/code', url + '?secret=x', url + '#x', 'https://arena.ai:1234/leaderboard/code', 'https://arena.ai/leaderboard/../admin']) {
    assert.equal(isModelEvidenceUrl(invalid), false); await assert.rejects(service.openModelEvidenceSource(invalid), /已核实/)
  }
  assert.deepEqual(opened, [url, AA.aaSource + '/glm-5-3-low']); service.dispose()
  if (process.argv.includes('--live')) {
    global.fetch = realFetch
    const live = await AA.collectAgentModelEvidence([{ id: 'designer' }], ['frontend'], [glm, { ...glm, id: 'flash', model: 'glm-5.3-flash' }, qwen])
    fs.mkdirSync('.runtime', { recursive: true }); fs.writeFileSync('.runtime/model-evidence-reference-live.json', JSON.stringify(live, null, 2))
    assert.equal(live[0].status, 'fresh'); assert.ok(live[0].candidates.every(c => c.similar?.length), 'current public Arena names must produce references')
    console.log(JSON.stringify(live.map(source => ({ source: source.source, status: source.status, date: source.updatedAt, candidates: source.candidates.map(c => ({ model: c.model, match: c.match, references: c.similar?.map(r => r.score.model) })) }))))
  }
  console.log('PASS: bounded fuzzy names, version/prefix/effort/budget warnings, no automatic allocation, fresh public fetches, safe contracts and external source opening')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { global.fetch = realFetch; fs.rmSync(root, { recursive: true, force: true }) })
