// Explicit opt-in: actual configured providers, synthetic project, no browser or final acceptance.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto'), { performance } = require('node:perf_hooks')
const hash = value => createHash('sha256').update(value).digest('hex')
if (!process.argv.includes('--authorized')) throw new Error('This script requires explicit authorization for real model calls.')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = require('node:child_process').spawn(require('electron'), [__filename, '--authorized'], { env, windowsHide: true, stdio: 'inherit' })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, safeStorage } = require('electron'), ts = require('typescript')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const output = path.resolve('.runtime/context-runtime/real-acceptance', stamp)
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-real-acceptance-'))
  const profile = path.join(isolated, 'profile'), root = path.join(isolated, 'project')
  const originalProfile = path.join(process.env.APPDATA, 'Coprojer-dev')
  fs.mkdirSync(profile); fs.mkdirSync(root); fs.mkdirSync(output, { recursive: true }); app.setPath('userData', profile)
  const crypt = JSON.parse(fs.readFileSync(path.join(originalProfile, 'Local State'), 'utf8')).os_crypt
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: crypt }))
  const cache = new Map()
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file)
    const api = {}; cache.set(file, api)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    new Function('exports', 'require', code)(api, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
    return api
  }
  const report = { kind: 'real provider end-to-end acceptance', startedAt: new Date().toISOString(), isolated, output,
    scope: 'Synthetic function repair through production service: search, line read, versioned patch, stop, real model switch, independent actual command verification; no final human acceptance.',
    requests: [], modelCalls: [], phases: [], status: 'running', protectedProjectTouched: false }
  let secrets = [], sourcePath, sourceHash, service, model, actualComplete, phase = 'setup'
  const rawFetch = globalThis.fetch, key = JSON.stringify(['p', 'f'])
  const clean = error => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(error?.message ?? error)).replace(/https?:\/\/\S+/g, '[endpoint]')
  function saveReport() {
    const text = JSON.stringify(report, null, 2)
    assert.ok(secrets.every(secret => !secret || !text.includes(secret)), 'no plaintext credentials in evidence')
    fs.writeFileSync(path.join(output, 'results.json'), text)
  }
  const receipts = () => Object.values(service.store.data.receiptJournals?.[key]?.receipts ?? {})
  async function settle() {
    const until = Date.now() + 240000
    while (service.store.project('p').activity && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
    if (service.store.project('p').activity) {
      service.stop('p')
      const cleanup = Date.now() + 15000
      while (service.store.project('p').activity && Date.now() < cleanup) await new Promise(resolve => setTimeout(resolve, 50))
      throw new Error('real phase exceeded its 240 second limit')
    }
  }
  app.whenReady().then(async () => {
    sourcePath = path.join(originalProfile, 'engineering-v1.json')
    const original = fs.readFileSync(sourcePath); sourceHash = hash(original)
    const configured = JSON.parse(original).models
    const ids = ['890593ec-fbd0-4a7f-a191-6e17a84c791a', 'ff400f91-858b-4255-9d20-b18a22dede61']
    const connections = ids.map(id => { const c = configured.find(item => item.id === id); assert.ok(c?.cipher, 'authorized configured connection exists'); assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.baseUrl).hostname), 'real provider endpoint'); return c })
    assert.ok(safeStorage.isEncryptionAvailable())
    const keys = new Map(connections.map(c => [c.id, safeStorage.decryptString(Buffer.from(c.cipher, 'base64'))])); secrets = [...keys.values()]
    report.connections = connections.map(c => ({ id: c.id, model: c.model, protocol: c.protocol }))
    const { EngineeringService } = load('src/main/engineering/service.ts')
    service = new EngineeringService(); model = load('src/main/engineering/model.ts'); actualComplete = model.complete
    service.store.data.models = connections.map(c => ({ ...c, cipher: '' })); service.store.key = id => keys.get(id) ?? ''
    for (const agent of service.store.data.agents) {
      agent.modelId = ids[0]; agent.skillIds = []; agent.readConcurrency = 1
      agent.tools = agent.role === 'developer' ? ['list_files', 'search_files', 'read_file', 'read_file_lines', 'patch_file'] : ['list_files', 'read_file', 'read_file_lines', 'run_command']
      agent.instructions = agent.role === 'developer'
        ? '这是预先建好的纯Node隔离工程，不需要安装依赖或创建网页。只修复value.cjs的sum。请先用search_files在value.cjs中搜索sum，再用read_file_lines读取命中源码，使用实际返回的版本与行范围调用patch_file，把错误运算修成加法。不要修改tests/verify.cjs、package.json或标记注释。所有路径使用项目相对路径。局部修改完成后交独立验证，不需要自行运行命令。如果接续历史已包含完成补丁，不得重复补丁；根据已完成事实返回开发complete JSON，summary说明真实修改，nextStep为独立执行node tests/verify.cjs。不要宣称自己已运行未发生的测试。'
        : '这是纯Node隔离工程。必须独立读取value.cjs与预置tests/verify.cjs，并通过run_command执行node tests/verify.cjs，evidenceKind=unit。脚本检查正数、负数、零、小数与保留标记，无需npm安装、构建或浏览器。不要修改任何文件。成功后按系统格式逐字保留原标准、引用实际evidenceId和输出，提交真实验证JSON。开发报告和历史命令不能代替本轮实跑。'
    }
    const before = "// FACT=real-e2e-7f29\nexports.sum = (a, b) => a - b;\n"
    const verify = "const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {sum}=require('../value.cjs');for(const [a,b,expected] of [[2,3,5],[-2,-3,-5],[0,4,4],[0,0,0],[1.25,2.5,3.75]])assert.equal(sum(a,b),expected);assert.ok(fs.readFileSync(path.join(__dirname,'../value.cjs'),'utf8').includes('FACT=real-e2e-7f29'));console.log('REAL_E2E_BEHAVIOR_PASSED: 5 sums and retained marker');\n"
    fs.mkdirSync(path.join(root, 'tests')); fs.writeFileSync(path.join(root, 'value.cjs'), before); fs.writeFileSync(path.join(root, 'tests/verify.cjs'), verify)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-real-e2e', private: true, scripts: { test: 'node tests/verify.cjs' } }))
    report.material = { beforeHash: hash(before), verificationHash: hash(verify), packageHash: hash(fs.readFileSync(path.join(root, 'package.json'))) }
    const criterion = 'sum(a,b)对正数、负数、零和小数返回正确和值，保留FACT标记，预置tests/verify.cjs原样运行通过。'
    const feature = { id: 'f', title: '真实模型隔离修复与续接验收', description: '修复value.cjs中的sum错误，仅修改该文件。通过已有验证脚本检查，不更改检查条件或脚本。', module: '验收', scope: 'current', stage: 'ready', criteria: [criterion], plan: '搜索并读取源码，按版本局部修改，交另一模型独立读取并运行预置检查，等待人工验收。', tasks: [{ id: 't', title: '修复sum并独立验证', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '', runtimePolicy: 'receipts-effects-v1', runtimeBudget: load('src/main/engineering/runtime-budget.ts').newRuntimeBudget(key) }
    const project = { id: 'p', name: '真实模型端到端隔离验收', root, brief: '仅合成材料；无用户项目', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
    service.store.data.projects = [project]; service.store.data.receiptJournals = {}; service.store.data.executionCheckpoints = {}; service.store.save()
    service.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { requests: 24, tools: 24, activeMs: 360000 }, '用户明确要求真实模型验收；本隔离流程有限额度')
    globalThis.fetch = async (url, init) => {
      const started = performance.now(), body = JSON.parse(init.body), entry = { phase, at: new Date().toISOString(), model: body.model, characters: init.body.length, bytes: Buffer.byteLength(init.body), bodyHash: hash(init.body), body }
      report.requests.push(entry)
      try { const response = await rawFetch(url, init); entry.status = response.status; entry.headersMs = performance.now() - started; return response }
      catch (error) { entry.error = clean(error); throw error }
      finally { saveReport() }
    }
    model.complete = async (...args) => {
      const started = performance.now(), entry = { phase, model: args[0].model, connectionId: args[0].id, role: args[1].includes('你是 Coprojer 的开发智能体') ? 'developer' : args[1].includes('你是 Coprojer 的验证智能体') ? 'reviewer' : 'other', budget: args[6]?.budget }
      report.modelCalls.push(entry)
      try { const reply = await actualComplete(...args); entry.actualUsage = reply.usage; entry.reply = reply; return reply }
      catch (error) { entry.error = clean(error); throw error }
      finally { entry.fullResponseMs = performance.now() - started; console.log('REAL_MODEL', entry.phase, entry.role, entry.model, Math.round(entry.fullResponseMs) + 'ms', entry.reply?.calls?.map(c => c.name).join(',') || 'report'); saveReport() }
    }
    phase = 'source'; let stopped = false
    const save = service.store.save.bind(service.store)
    service.store.save = () => { save(); if (!stopped && receipts().some(r => r.tool === 'patch_file' && r.status === 'completed' && r.applied)) { stopped = true; service.stop('p') } }
    console.log('REAL_ACCEPTANCE_OUTPUT', output)
    service.runFeature('p', 'f'); await settle(); service.store.save = save
    const patch = receipts().find(r => r.tool === 'patch_file' && r.status === 'completed')
    assert.ok(stopped && patch, 'source model actually performed a versioned patch before pause')
    assert.equal(patch.attempts, 1); assert.ok(patch.applied)
    assert.ok(receipts().some(r => r.tool === 'search_files' && r.status === 'completed'))
    const read = receipts().find(r => r.tool === 'read_file_lines' && r.status === 'completed' && r.args.path === 'value.cjs')
    assert.ok(read); assert.equal(JSON.parse(read.result.output).version, patch.args.expectedVersion)
    const afterSource = fs.readFileSync(path.join(root, 'value.cjs'), 'utf8')
    assert.notEqual(afterSource, before); assert.equal(hash(fs.readFileSync(path.join(root, 'tests/verify.cjs'))), report.material.verificationHash)
    report.phases.push({ phase: 'source-patch-and-stop', status: 'passed', patchLogicalId: patch.logicalId, patchAttempts: patch.attempts, beforeHash: hash(before), afterHash: hash(afterSource), stage: feature.stage })
    phase = 'handoff'; const requestsBefore = report.requests.length, used = structuredClone(feature.runtimeBudget.used)
    service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: ids[1] })
    assert.equal(report.requests.length, requestsBefore); assert.deepEqual(feature.runtimeBudget.used, used)
    report.phases.push({ phase: 'model-switch', status: 'passed', newRequests: 0, newTools: 0, originalRef: feature.runtimeHandoff.originalId })
    phase = 'target-and-review'; service.runFeature('p', 'f'); await settle()
    const completedPatches = receipts().filter(r => r.tool === 'patch_file' && r.status === 'completed')
    assert.equal(completedPatches.length, 1); assert.equal(completedPatches[0].logicalId, patch.logicalId); assert.equal(completedPatches[0].attempts, 1)
    assert.equal(fs.readFileSync(path.join(root, 'value.cjs'), 'utf8'), afterSource)
    assert.equal(hash(fs.readFileSync(path.join(root, 'tests/verify.cjs'))), report.material.verificationHash)
    assert.equal(hash(fs.readFileSync(path.join(root, 'package.json'))), report.material.packageHash)
    assert.equal(project.changes.length, 1)
    const reviewer = receipts().filter(r => r.role === 'reviewer' && r.status === 'completed')
    for (const file of ['value.cjs', 'tests/verify.cjs']) assert.ok(reviewer.some(r => ['read_file', 'read_file_lines'].includes(r.tool) && r.args.path === file), 'independent actual read: ' + file)
    const command = reviewer.find(r => r.tool === 'run_command')
    assert.ok(command); assert.equal(command.attempts, 1); assert.match(command.result.output, /REAL_E2E_BEHAVIOR_PASSED/)
    assert.ok(feature.verificationChecks.some(c => c.code === 0 && c.sourceFingerprint && c.output.includes('REAL_E2E_BEHAVIOR_PASSED')))
    assert.ok(report.modelCalls.some(c => c.role === 'developer' && c.connectionId === ids[1]))
    assert.ok(report.modelCalls.some(c => c.role === 'reviewer' && c.connectionId === ids[0]))
    assert.equal(feature.stage, 'acceptance'); assert.ok(feature.results.every(result => result.passed)); assert.notEqual(feature.stage, 'done')
    assert.ok(report.requests.every(request => request.status === 200)); assert.ok(report.modelCalls.every(call => call.actualUsage))
    assert.equal(hash(fs.readFileSync(sourcePath)), sourceHash)
    report.phases.push({ phase: 'continued-development-and-independent-review', status: 'passed', actualPatchCount: 1, oldPatchAttempts: 1, finalStage: feature.stage, humanAccepted: false })
    report.status = 'passed'; console.log('PASS: real search/read/patch, stop, GLM -> Qwen continuation, independent GLM read and actual test, awaiting human acceptance')
  }).catch(async error => {
    report.status = 'failed'; report.error = clean(error); process.exitCode = 1; console.error('REAL_ACCEPTANCE_FAILED', report.error)
    if (service?.store.data.projects?.[0]?.activity) { service.stop('p'); try { await settle() } catch { /* retain original failure */ } }
  }).finally(() => {
    globalThis.fetch = rawFetch; if (model && actualComplete) model.complete = actualComplete
    report.endedAt = new Date().toISOString()
    if (service?.store.data.projects?.[0]) {
      const project = service.store.project('p'), feature = project.features[0]
      report.finalStage = feature.stage; report.feedback = feature.feedback; report.budget = feature.runtimeBudget; report.context = feature.contextRuntime
      report.receipts = receipts(); report.results = feature.results; report.commands = feature.verificationChecks; report.changes = project.changes; report.agentRuns = project.agentRuns; report.events = project.events
      report.persistedCredentialCheck = secrets.every(secret => !secret || !fs.readFileSync(service.store.path, 'utf8').includes(secret))
      if (!report.persistedCredentialCheck) process.exitCode = 1
    }
    if (sourcePath && sourceHash) report.globalConfigurationChanged = hash(fs.readFileSync(sourcePath)) !== sourceHash
    saveReport(); console.log('REAL_ACCEPTANCE_RESULT', report.status, report.finalStage, report.requests.length + ' HTTP requests')
    app.exit(process.exitCode || 0)
  })
}
