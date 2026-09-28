const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), ts = require('typescript')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-aliyun-'))
const originalFetch = global.fetch, cache = new Map(), requests = [], opened = []
let openBrowser, failQuota = false, expired = false, unauthorized = false, shape = 'nested'
const fixtureKey = 'sk-fixture-aliyun-import-only'
const catalog = ['qwen3.7-flash', 'qwen-plus', 'qwen3-coder-plus', 'qwen-expired', 'qwen-empty', 'qwen-stop-off', 'qwen-image', 'text-embedding-v4', 'qwen3.7-flash']
const electron = { app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => true, encryptString: key => Buffer.from('encrypted:' + key), decryptString: data => data.toString().slice(10) }, shell: { openExternal: async url => { opened.push(url); if (openBrowser) await openBrowser(url) } } }
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(exports, name => name === 'electron' ? electron : name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return exports
}
global.fetch = async (url, init = {}) => {
  if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init)
  requests.push({ url: String(url), method: init.method || 'GET' })
  assert.equal(init.redirect, 'error')
  if (String(url).endsWith('/models')) {
    assert.equal(init.headers.Authorization, 'Bearer ' + fixtureKey)
    return unauthorized ? new Response(fixtureKey, { status: 401 }) : Response.json({ data: catalog.map(id => ({ id })) })
  }
  assert.ok(String(url).startsWith('https://bailian-cs.console.aliyun.com/cli/api.json?'))
  assert.equal(init.headers.Authorization, 'Bearer console-fixture-token')
  const params = JSON.parse(new URLSearchParams(init.body).get('params'))
  if (failQuota) return Response.json({ data: { success: false, errorCode: 'NotLogined' } })
  const quota = params.Api.endsWith('queryFreeTierQuota')
  const models = Object.values(params.Data).find(value => Array.isArray(value?.models)).models
  const data = quota ? { freeTierQuotas: models.map(model => ({ model, quotaStatus: 'VALID', quotaInitTotal: 1000000, quotaTotal: model === 'qwen-empty' ? 0 : 800000, quotaValidityPeriod: expired || model === 'qwen-expired' ? Date.now() - 1000 : Date.now() + 86400000 })) }
    : { freeTierOnlyStatuses: models.map(model => ({ model, freeTierOnly: model !== 'qwen-stop-off' })) }
  return Response.json(shape === 'nested' ? { data: { DataV2: { data: { data } } } } : { data: { data } })
}
const { EngineeringStore } = load('src/main/engineering/store.ts')
const { AliyunImport } = load('src/main/engineering/aliyun-import.ts')
const { authorizeAliyunConsole } = load('src/main/engineering/aliyun-console.ts')
const { aliyunBaseUrl, hasUsableFreeQuota } = load('src/shared/aliyun.ts')

async function callback(url) {
  const login = new URL(url)
  assert.equal(login.origin, 'https://bailian.console.aliyun.com')
  assert.equal(login.pathname, '/console-login')
  assert.equal(login.searchParams.has('needapikey'), false)
  const target = 'http://' + login.searchParams.get('notice')
  assert.equal((await originalFetch(target.replace(/state=.*/, 'state=invalid'), { method: 'POST', body: '{}' })).status, 400)
  assert.equal((await originalFetch(target, { method: 'POST', headers: { origin: 'https://other.example' }, body: '{}' })).status, 403)
  const response = await originalFetch(target, { method: 'POST', headers: { origin: login.origin, 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'console-fixture-token', console_region: 'cn-beijing', console_site: 'domestic' }) })
  assert.equal(response.status, 200)
  assert.ok(!(await response.text()).includes('console-fixture-token'))
}
async function main() {
  openBrowser = callback
  const store = new EngineeringStore(), service = new AliyunImport(store)
  const originalAgents = structuredClone(store.data.agents), originalSkills = structuredClone(store.data.skills)
  await assert.rejects(service.scanAliyunModels('bad'), /API Key/)
  await assert.rejects(service.scanAliyunModels('sk-sp-fixture-only'), /订阅套餐/)
  unauthorized = true
  await assert.rejects(service.scanAliyunModels(fixtureKey), error => /拒绝访问/.test(error.message) && !error.message.includes(fixtureKey)); unauthorized = false
  let preview = await service.scanAliyunModels(fixtureKey)
  assert.equal(preview.models.length, 6); assert.equal(preview.excludedCount, 2)
  assert.ok(!JSON.stringify(preview).includes(fixtureKey)); assert.equal(preview.quotaCheckedAt, undefined)
  const input = { previewId: preview.id, models: ['qwen3.7-flash', 'qwen-plus', 'qwen3-coder-plus'], freeOnly: true, sameAccountConfirmed: true, configureUnbound: true }
  await assert.rejects(service.importAliyunModels(input), /先登录/)
  preview = await service.syncAliyunQuota(preview.id)
  assert.deepEqual(preview.models.filter(hasUsableFreeQuota).map(m => m.model), ['qwen-plus', 'qwen3-coder-plus', 'qwen3.7-flash'])
  assert.ok(!JSON.stringify(preview).includes('console-fixture-token'))
  await assert.rejects(service.importAliyunModels({ ...input, sameAccountConfirmed: false }), /同一/)
  await assert.rejects(service.importAliyunModels({ ...input, models: ['qwen-invented'] }), /不在/)
  await assert.rejects(service.importAliyunModels({ ...input, models: ['qwen-stop-off'] }), /用完即停/)
  expired = true; await assert.rejects(service.importAliyunModels(input), /过期/); expired = false
  const before = store.data, save = store.save
  store.save = () => { throw Error('disk failure') }
  await assert.rejects(service.importAliyunModels(input), /disk failure/); assert.equal(store.data, before); store.save = save
  const result = await service.importAliyunModels(input)
  assert.equal(result.imported, 3); assert.equal(result.configuredAgents, 4)
  assert.equal(store.data.models.find(m => m.id === store.data.defaultAssistantModelId).model, 'qwen3.7-flash')
  assert.equal(store.data.models.find(m => m.id === store.data.agents.find(a => a.role === 'developer').modelId).model, 'qwen3-coder-plus')
  assert.deepEqual(store.data.skills, originalSkills)
  assert.deepEqual(store.data.agents.map(({ modelId, ...rest }) => rest), originalAgents.map(({ modelId, ...rest }) => rest))
  assert.ok(!fs.readFileSync(store.path, 'utf8').includes(fixtureKey))
  assert.ok(!fs.readFileSync(store.path, 'utf8').includes('console-fixture-token'))
  const ids = store.data.models.map(m => m.id), agents = structuredClone(store.data.agents), defaultId = store.data.defaultAssistantModelId
  // Other credential on the same endpoint is preserved and never overwritten.
  store.data.models.unshift({ id: 'other-account', name: 'qwen-plus', model: 'qwen-plus', baseUrl: aliyunBaseUrl, protocol: 'chat', hasKey: true, cipher: store.encrypt('another-account') })
  store.data.agents.push({ ...store.data.agents[0], id: 'project-owned', ownerProjectId: 'existing', modelId: '' })
  preview = await service.scanAliyunModels(fixtureKey)
  const reused = await service.importAliyunModels({ ...input, previewId: preview.id, freeOnly: false })
  assert.equal(reused.reused, 3); assert.equal(reused.imported, 0)
  assert.deepEqual(store.data.models.slice(1).map(m => m.id), ids)
  assert.deepEqual(store.data.agents.slice(0, 4), agents)
  assert.equal(store.data.agents.at(-1).modelId, ''); assert.equal(store.data.defaultAssistantModelId, defaultId)
  assert.equal(store.key('other-account'), 'another-account')
  preview = await service.scanAliyunModels(fixtureKey); shape = 'direct'; await service.syncAliyunQuota(preview.id)
  failQuota = true; await assert.rejects(service.syncAliyunQuota(preview.id), /查询被拒绝/); failQuota = false
  await assert.rejects(service.importAliyunModels({ ...input, previewId: preview.id }), /先登录/)
  service.discardAliyunImport(preview.id); await assert.rejects(service.syncAliyunQuota(preview.id), /过期/)
  // Abort closes the listening callback and returns promptly without writing credentials.
  let loginUrl; openBrowser = async url => { loginUrl = url }
  const abort = new AbortController(), pending = authorizeAliyunConsole(abort.signal)
  while (!loginUrl) await new Promise(r => setTimeout(r, 5))
  abort.abort(); await assert.rejects(pending, /取消/)
  assert.equal(requests.filter(r => /chat\/completions|responses|messages/.test(r.url)).length, 0)
  await service.openAliyunPage('quota'); await assert.rejects(service.openAliyunPage('https://other.example'), /无效/)
  service.dispose()
  const restored = new EngineeringStore()
  assert.equal(restored.data.defaultAssistantModelId, defaultId); assert.equal(restored.key(ids[0]), fixtureKey)
  console.log('PASS: Aliyun catalog, auth callback/CSRF/cancel, actual quota schema, free-only checks, stale quota, transaction rollback, encrypted persistence, account isolation, existing bindings and zero inference calls')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { global.fetch = originalFetch })
