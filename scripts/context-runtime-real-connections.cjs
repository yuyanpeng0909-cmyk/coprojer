// Opt-in only: reads existing authorized connection configuration, never its projects.
// No BrowserWindow, global configuration changes, plaintext credentials or automatic acceptance.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const output = path.resolve('.runtime/context-runtime/m5-real-connections')
function verifySaved(report) {
  assert.ok(path.resolve(report.isolated).startsWith(path.resolve(os.tmpdir()) + path.sep + 'coprojer-real-handoff-'))
  const disk = JSON.parse(fs.readFileSync(path.join(report.isolated, 'profile', 'engineering-v1.json'), 'utf8'))
  const key = JSON.stringify(['p', 'f']), cp = disk.executionCheckpoints[key]
  const text = cp.messages.filter(m => m.role === 'assistant' && !m.calls?.length).at(-1).content
  const reply = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
  assert.equal(reply.status, 'incomplete'); assert.match(reply.summary, /FACT=handoff-7f29/)
  const receipts = Object.values(disk.receiptJournals[key].receipts)
  assert.equal(receipts.length, 1); assert.equal(receipts[0].tool, 'read_file'); assert.equal(receipts[0].attempts, 1)
  assert.equal(disk.projects[0].features[0].stage, 'blocked'); assert.equal(report.globalConfigurationChanged, false)
  return { at: new Date().toISOString(), status: 'passed', source: 'saved actual real-connection run; no additional HTTP', targetReply: reply, completedReadCount: 1, attempts: 1, requests: report.requests, actualUsage: report.context.requests.map(r => r.usage), finalStage: 'blocked' }
}
if (process.argv.includes('--verify-existing')) {
  const result = verifySaved(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')))
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2)); console.log('PASS: saved target answer preserves actual FACT and no extra read or effects')
} else if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const task = require('node:child_process').spawn(require('electron'), [__filename], { windowsHide: true, stdio: 'inherit', env })
  task.on('error', error => { console.error(error.message); process.exitCode = 1 })
  task.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, safeStorage } = require('electron'), ts = require('typescript')
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-real-handoff-'))
  const profile = path.join(isolated, 'profile'), root = path.join(isolated, 'project')
  app.setPath('userData', profile)
  // Windows safeStorage is bound to the profile's OS-protected Chromium key.
  // Copy only that still-encrypted key; no user projects, sessions or API-key ciphers.
  fs.mkdirSync(profile, { recursive: true })
  const crypt = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Coprojer-dev', 'Local State'), 'utf8')).os_crypt
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: crypt }))
  const cache = new Map()
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file)
    const api = {}; cache.set(file, api)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    new Function('exports', 'require', code)(api, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
    return api
  }
  const report = { kind: 'authorized-real-connections', startedAt: new Date().toISOString(), isolated, requests: [], results: [], protectedProjectTouched: false, globalConfigurationChanged: false }
  const digest = value => createHash('sha256').update(value).digest('hex')
  let secrets = [], service, sourcePath, sourceHash, rawFetch = globalThis.fetch
  const safeError = error => secrets.reduce((text, key) => key ? text.split(key).join('[redacted]') : text, String(error?.message ?? error)).replace(/https?:\/\/\S+/g, '[endpoint]')
  async function settle() {
    const deadline = Date.now() + 90000
    while (service.store.project('p').activity && Date.now() < deadline) await new Promise(r => setTimeout(r, 30))
    if (service.store.project('p').activity) {
      service.stop('p')
      const end = Date.now() + 15000
      while (service.store.project('p').activity && Date.now() < end) await new Promise(r => setTimeout(r, 30))
      throw new Error('real connection did not settle inside 90 second bound')
    }
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(root, { recursive: true })
    sourcePath = path.join(process.env.APPDATA, 'Coprojer-dev', 'engineering-v1.json')
    const original = fs.readFileSync(sourcePath); sourceHash = digest(original)
    const configured = JSON.parse(original).models
    const ids = ['890593ec-fbd0-4a7f-a191-6e17a84c791a', 'ff400f91-858b-4255-9d20-b18a22dede61']
    const connections = ids.map(id => { const c = configured.find(m => m.id === id); assert.ok(c?.cipher, 'previously authorized connection exists'); return c })
    assert.ok(safeStorage.isEncryptionAvailable(), 'OS credential decryption is available')
    const keys = new Map(connections.map(c => [c.id, safeStorage.decryptString(Buffer.from(c.cipher, 'base64'))])); secrets = [...keys.values()]
    report.connections = connections.map(c => ({ id: c.id, model: c.model, protocol: c.protocol }))
    const { EngineeringService } = load('src/main/engineering/service.ts')
    service = new EngineeringService()
    // Key material exists only in this process. Persisted isolated models have an empty cipher.
    service.store.data.models = connections.map(({ cipher, ...c }) => ({ ...c, cipher: '' }))
    service.store.key = id => keys.get(id) ?? ''
    for (const agent of service.store.data.agents) {
      agent.modelId = ids[0]; agent.skillIds = []; agent.tools = agent.role === 'developer' ? ['read_file', 'write_file'] : ['read_file', 'run_command']
      agent.instructions = '只处理当前隔离项目。必须先用 read_file 读取 isolated-note.txt。读取成功后，不重复读取；以 JSON status=incomplete、summary包含文件中FACT、nextStep=等待人工继续结束本轮。不要报告complete，不执行业务验收。'
    }
    fs.writeFileSync(path.join(root, 'isolated-note.txt'), 'FACT=handoff-7f29; 这是没有用户资料的只读连接验收文件。\n')
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-real-connection', private: true }))
    const feature = { id: 'f', title: '隔离真实连接续接检查', description: '读取 isolated-note.txt，以 incomplete JSON报告FACT。已完成读取不得重复，等待人工下一步。', module: '验收', scope: 'current', stage: 'ready', criteria: ['保留已完成读取事实'], plan: '只读文件后等待', tasks: [{ id: 't', title: '读取并等待人工继续', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '', runtimePolicy: 'receipts-effects-v1', runtimeBudget: load('src/main/engineering/runtime-budget.ts').newRuntimeBudget(JSON.stringify(['p', 'f'])) }
    const project = { id: 'p', name: '授权连接隔离检查', root, brief: '仅合成材料', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
    service.store.data.projects = [project]; service.store.save()
    service.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { requests: 4, tools: 3, activeMs: 180000 }, '隔离真实连接检查的有限请求与工具额度')
    let stage = 'source', stopped = false
    globalThis.fetch = async (url, init) => {
      const started = Date.now(), body = JSON.parse(init.body), entry = { stage, model: body.model, startedAt: new Date().toISOString(), inputBytes: Buffer.byteLength(init.body), hasRetainedFact: init.body.includes('handoff-7f29') }
      report.requests.push(entry)
      try { const response = await rawFetch(url, init); entry.status = response.status; entry.headersMs = Date.now() - started; return response }
      catch (error) { entry.error = safeError(error); entry.headersMs = Date.now() - started; throw error }
    }
    const records = () => Object.values(service.store.data.receiptJournals?.[JSON.stringify(['p', 'f'])]?.receipts ?? {})
    const save = service.store.save.bind(service.store)
    service.store.save = () => { save(); if (stage === 'source' && !stopped && records().some(r => r.tool === 'read_file' && r.status === 'completed')) { stopped = true; service.stop('p') } }
    service.runFeature('p', 'f'); await settle()
    const completed = records().filter(r => r.status === 'completed')
    assert.equal(completed.length, 1, 'source model actually completes one read')
    assert.equal(completed[0].tool, 'read_file'); assert.equal(completed[0].attempts, 1)
    report.results.push({ phase: 'source-read', status: 'passed', logicalId: completed[0].logicalId })
    stage = 'handoff'; const before = report.requests.length, used = structuredClone(feature.runtimeBudget.used)
    service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: ids[1] })
    assert.equal(report.requests.length, before); assert.deepEqual(feature.runtimeBudget.used, used)
    report.results.push({ phase: 'explicit-handoff', status: 'passed', originalRef: feature.runtimeHandoff.originalId })
    stage = 'target'; service.runFeature('p', 'f'); await settle()
    assert.ok(report.requests.some(r => r.stage === 'target' && r.hasRetainedFact && r.status === 200), 'target accepts canonical tool history')
    assert.equal(records().find(r => r.logicalId === completed[0].logicalId).attempts, 1)
    assert.equal(feature.stage, 'blocked'); assert.ok(feature.contextRuntime?.requests?.some(r => r.profile?.identity?.model === connections[1].model) || project.agentRuns.some(r => r.modelId === ids[1]))
    report.results.push({ phase: 'target-continued', status: 'passed', oldReadAttempts: 1, finalStage: feature.stage })
    report.budget = feature.runtimeBudget; report.context = feature.contextRuntime; report.traffic = service.store.data.traffic; report.feedback = feature.feedback
    assert.equal(digest(fs.readFileSync(sourcePath)), sourceHash, 'real profile remains unchanged')
    report.savedVerification = verifySaved(report)
    const disk = fs.readFileSync(service.store.path, 'utf8'); assert.ok(secrets.every(key => !disk.includes(key))); assert.ok(!disk.includes(connections[0].cipher))
    report.status = 'passed'; console.log('PASS: authorized real source read -> explicit model switch -> target continuation; original attempts stay one')
  }).catch(error => { report.status = 'failed'; report.error = safeError(error); console.error('REAL CONNECTION CHECK:', report.error); process.exitCode = 1 })
    .finally(() => {
      globalThis.fetch = rawFetch; report.endedAt = new Date().toISOString()
      if (service) { report.finalStage = service.store.project('p').features[0].stage; report.budget = service.store.project('p').features[0].runtimeBudget; report.diagnostics = service.store.project('p').features[0].feedback }
      if (sourcePath && sourceHash) report.globalConfigurationChanged = digest(fs.readFileSync(sourcePath)) !== sourceHash
      const serialized = JSON.stringify(report, null, 2)
      assert.ok(secrets.every(key => !serialized.includes(key)), 'report contains no credentials')
      fs.writeFileSync(path.join(output, 'results.json'), serialized); app.exit(process.exitCode || 0)
    })
}
