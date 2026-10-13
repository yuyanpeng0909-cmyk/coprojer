// Explicit real-provider diagnostic; never part of the default test suite.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const hash = value => createHash('sha256').update(value).digest('hex')
if (!process.argv.includes('--authorized')) throw new Error('真实模型验证需要显式 --authorized；使用实际项目的隔离副本。')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  child.on('exit', code => process.exitCode = code ?? 1)
} else {
  const { app, safeStorage } = require('electron'), ts = require('typescript')
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-prototype-real-')), profile = path.join(isolated, 'profile'), root = path.join(isolated, 'project')
  const originalProfile = path.join(process.env.APPDATA, 'Coprojer-dev'), sourcePath = path.join(originalProfile, 'engineering-v1.json')
  const output = path.resolve('.runtime/prototype-read-loop/real-' + new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(profile); fs.mkdirSync(output, { recursive: true }); app.setPath('userData', profile)
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: JSON.parse(fs.readFileSync(path.join(originalProfile, 'Local State'), 'utf8')).os_crypt }))
  const cache = new Map()
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file)
    const api = {}; cache.set(file, api)
    new Function('exports', 'require', ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(api, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
    return api
  }
  const report = { status: 'running', startedAt: new Date().toISOString(), isolated, requests: [], tools: [], scope: 'Real paused project checkpoint and source copy; same configured developer model; stop after first durable file effect or bounded request limit; no business acceptance.' }
  let secrets = [], service, original, originalRoot, originalSource, settled = false
  const clean = error => secrets.reduce((value, secret) => secret ? value.split(secret).join('[redacted]') : value, String(error?.message ?? error)).replace(/https?:\/\/\S+/g, '[endpoint]')
  function save() {
    const text = JSON.stringify(report, null, 2); assert.ok(secrets.every(secret => !secret || !text.includes(secret)))
    fs.writeFileSync(path.join(output, 'results.json'), text)
  }
  app.whenReady().then(async () => {
    original = fs.readFileSync(sourcePath)
    const data = JSON.parse(original), matches = data.projects.filter(p => p.name === '今日三件事')
    assert.equal(matches.length, 1); const p = matches[0], f = p.features.find(f => f.title === '工程化与自动化测试')
    assert.ok(f); assert.equal(p.activity, null)
    const key = JSON.stringify([p.id, f.id]), checkpoint = data.executionCheckpoints[key]
    assert.ok(checkpoint && checkpoint.role === 'developer' && !checkpoint.pending && !checkpoint.commands.length)
    const developer = data.agents.find(a => a.id === f.developerId), originalConnectionId = f.executionModels?.developer ?? developer.modelId
    const requestedModel = process.argv.find(arg => arg.startsWith('--model='))?.slice(8)
    const connectionId = requestedModel ? data.models.find(m => m.model === requestedModel)?.id : originalConnectionId
    const connection = data.models.find(m => m.id === connectionId); assert.ok(connection?.cipher)
    assert.ok(safeStorage.isEncryptionAvailable()); const secret = safeStorage.decryptString(Buffer.from(connection.cipher, 'base64')); secrets = [secret]
    const { EngineeringService } = load('src/main/engineering/service.ts'), model = load('src/main/engineering/model.ts')
    service = new EngineeringService(); service.store.data = structuredClone(data)
    service.store.data.projects = [p]; service.store.key = id => id === connectionId ? secret : ''
    for (const config of service.store.data.models) config.cipher = ''
    originalRoot = p.root; originalSource = service.sourceFingerprint(p)
    report.originalCheckpointCompatible = checkpoint.fingerprint === service.executionFingerprint(p, f) && checkpoint.sourceFingerprint === originalSource
    assert.ok(report.originalCheckpointCompatible, 'real checkpoint must be compatible before isolation')
    if (requestedModel) {
      report.isolatedModelOverride = { from: data.models.find(m => m.id === originalConnectionId).model, to: requestedModel }
      delete developer.reasoning
      const isolatedAgent = service.store.data.agents.find(a => a.id === developer.id)
      delete isolatedAgent.reasoning
      report.isolatedReasoning = 'target model default; source-model budget not carried across models'
      f.executionModels = { ...f.executionModels, developer: connectionId }
      checkpoint.messages = load('src/main/engineering/context-continuity.ts').portableMessages(checkpoint.messages)
      delete checkpoint.continuity.nativeWindow
    }
    fs.cpSync(originalRoot, root, { recursive: true, filter: file => !path.relative(originalRoot, file).split(path.sep).some(part => ['node_modules', '.git', '.coprojer', '.runtime', 'dist'].includes(part)) })
    const artifactScope = hash(key), archiveSource = path.join(originalProfile, 'engineering-artifacts', artifactScope)
    if (fs.existsSync(archiveSource)) fs.cpSync(archiveSource, path.join(profile, 'engineering-artifacts', artifactScope), { recursive: true })
    p.root = root; p.executionPlan = undefined
    assert.equal(service.sourceFingerprint(p), originalSource, 'isolation preserves source content')
    checkpoint.fingerprint = service.executionFingerprint(p, f)
    checkpoint.sourceFingerprint = service.sourceFingerprint(p)
    // Keep original usage and progress; grant only a bounded allowance in this copy.
    const used = f.runtimeBudget.used
    f.runtimeBudget.limits = { requests: used.requests + 8, tools: used.tools + 40, activeMs: used.activeMs + 300000 }
    service.store.data.executionCheckpoints = { [key]: checkpoint }
    service.store.data.receiptJournals = { [key]: data.receiptJournals[key] }
    service.store.save()
    report.model = connection.model; report.projectId = p.id; report.featureId = f.id
    report.before = { prototypeReadUntil: checkpoint.prototypeReadUntil, repeated: checkpoint.progress.repeated, sourceFingerprint: originalSource, usage: structuredClone(used) }
    const complete = model.complete, writeBefore = p.changes.length, controller = AbortSignal.timeout(300000)
    model.complete = async (...args) => {
      assert.equal(args[0].id, connectionId, 'only the authorized developer sends provider requests')
      if (p.changes.length > writeBefore) { settled = true; throw new Error('DIAGNOSTIC_FORWARD_PROGRESS_REACHED') }
      assert.ok(report.requests.length < 8, 'bounded provider request count')
      const line = args[1].split('\n').find(line => line.startsWith('必读资料进度：'))
      const entry = { at: new Date().toISOString(), prototypeProgress: line ? JSON.parse(line.slice('必读资料进度：'.length)) : undefined, workingPrototypeIncluded: args[1].includes('已读原型工作资料：'), inputCharacters: args[6]?.budget.requestCharacters }
      report.requests.push(entry); save()
      const started = Date.now()
      const delta = args[5]; let lastSaved = 0
      args[5] = update => {
        const counts = entry.streamCharacters ??= { text: 0, reasoning: 0, tool: 0 }
        counts[update.kind] = (counts[update.kind] ?? 0) + update.text.length
        entry.lastDeltaMs = Date.now() - started
        if (Date.now() - lastSaved > 5000) { lastSaved = Date.now(); save() }
        delta?.(update)
      }
      try {
        const reply = await complete(...args)
        entry.elapsedMs = Date.now() - started; entry.usage = reply.usage; entry.reply = reply.text.slice(0,1000)
        entry.calls = reply.calls.map(call => { const a = JSON.parse(call.arguments); return { name: call.name, id: a.id, offset: a.offset, path: a.path, program: a.program, args: a.args, reviewReason: a.reviewReason } })
        report.tools.push(...entry.calls); console.log('REAL', report.requests.length, connection.model, entry.elapsedMs + 'ms', entry.calls.map(c => c.name).join(',') || 'report')
        return reply
      } catch (error) { entry.error = clean(error); throw error }
      finally { save() }
    }
    const targeted = process.argv.includes('--targeted-write')
    if (targeted) report.targetedDiagnostic = 'Only create the missing apps/web/index.html entry matching the existing Vite/React configuration; no dependency installation; original task remains incomplete.'
    const feedback = targeted ? (f.feedback || '') + '\n本轮为隔离副本的恢复诊断，只执行一个下一步：已有 Vite/React 工程缺少 apps/web/index.html，请根据已确认原型标题和现有配置补齐这个标准入口文件（root 挂载点、/src/main.tsx 入口）。本轮不安装依赖，不运行命令，不实现其他文件；写入后返回 incomplete，明确其余应用代码和测试尚未完成。此前已读的原型无需重复读取。' : f.feedback
    try { await service.agentLoop(p, f, developer, feedback, controller, { resume: checkpoint }) }
    catch (error) { report.stopReason = clean(error) }
    finally { model.complete = complete }
    report.newChanges = p.changes.slice(writeBefore).map(c => ({ path: c.path, kind: c.before === null ? 'created' : 'modified' }))
    report.after = { prototypeReadUntil: service.store.data.executionCheckpoints[key]?.prototypeReadUntil, repeated: service.store.data.executionCheckpoints[key]?.progress?.repeated, sourceFingerprint: service.sourceFingerprint(p), usage: f.runtimeBudget.used }
    report.fullPrototypeReread = report.tools.filter(t => t.name === 'read_context' && t.id === 'prototype:' + f.prototypeId && t.offset === 0 && !t.reviewReason).length
    report.status = report.newChanges.length > 0 && report.after.sourceFingerprint !== originalSource && report.fullPrototypeReread === 0 ? 'passed' : 'failed'
    report.stoppedAfterProgress = settled
  }).catch(error => { report.status = 'failed'; report.error = clean(error) }).finally(() => {
    report.originalStateUnchanged = original && hash(original) === hash(fs.readFileSync(sourcePath))
    report.originalSourceUnchanged = originalRoot && service && originalSource === service.sourceFingerprint({ root: originalRoot })
    if (!report.originalStateUnchanged || !report.originalSourceUnchanged) report.status = 'failed'
    report.endedAt = new Date().toISOString(); save()
    console.log(JSON.stringify({ status: report.status, requests: report.requests.length, changes: report.newChanges, error: report.error, stopReason: report.stopReason, originalStateUnchanged: report.originalStateUnchanged, originalSourceUnchanged: report.originalSourceUnchanged, evidence: path.join(output, 'results.json') }))
    app.exit(report.status === 'passed' ? 0 : 1)
  })
}
