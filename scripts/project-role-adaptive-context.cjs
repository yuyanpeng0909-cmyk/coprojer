// Explicit maintenance operation: stage a paused project's adaptive connection,
// validate its next full request, then optionally commit only the staged migration.
// No provider tools are executed. Never included in the default test suite.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict'), { createHash } = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const hash = value => createHash('sha256').update(value).digest('hex')
const diskValue = value => JSON.parse(JSON.stringify(value))
const option = key => process.argv.find(arg => arg.startsWith('--' + key + '='))?.slice(key.length + 3)
const projectId = option('project-id'), featureId = option('feature-id')
if (!projectId || !featureId || !process.argv.includes('--authorized')) throw new Error('Provide --authorized --project-id=... --feature-id=...; --apply commits only after validation.')
const apply = process.argv.includes('--apply'), live = process.argv.includes('--live')
if (apply && !live) throw new Error('--apply requires --live validation in the same run.')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, safeStorage } = require('electron'), ts = require('typescript')
  const originalProfile = path.join(process.env.APPDATA, 'Coprojer-dev'), source = path.join(originalProfile, 'engineering-v1.json')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-adaptive-activation-'))
  const output = path.resolve('.runtime/reviewer-adaptive', new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', temporary)
  fs.writeFileSync(path.join(temporary, 'Local State'), JSON.stringify({ os_crypt: JSON.parse(fs.readFileSync(path.join(originalProfile, 'Local State'), 'utf8')).os_crypt }))
  const cache = new Map()
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file)
    const api = {}; cache.set(file, api)
    new Function('exports', 'require', ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(api, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
    return api
  }
  const report = { status: 'running', startedAt: new Date().toISOString(), projectId, featureId, apply, live,
    scope: 'Atomic four-role connection migration; preserve paused checkpoint; no provider tools or automatic business resume.' }
  let secret = '', originalBytes, service, staged, stateCommitted = false
  const sanitize = error => (error?.code === 'ERR_ASSERTION' && error.generatedMessage
    ? 'Assertion failed (' + error.operator + '); object values omitted.' : String(error?.message ?? error))
    .split(secret || '\u0000').join('[redacted]').replace(/https?:\/\/\S+/g, '[endpoint]')
  const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  function otherCoprojerProcesses() {
    const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"name = 'electron.exe'\" | Where-Object { $_.ProcessId -ne " + process.pid + " -and $_.CommandLine -notmatch '--type=' -and $_.ExecutablePath -like '*coprojer*' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"
    const result = execFileSync('pwsh.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim()
    const parsed = result ? JSON.parse(result) : []; return Array.isArray(parsed) ? parsed : [parsed]
  }
  function validatePreservation(before, after, key, pBefore, pAfter, fBefore, fAfter, checkpoint) {
    assert.equal(after.models.length, before.models.length + 1)
    assert.deepEqual(after.models.slice(0, -1), before.models, 'existing connections remain unchanged')
    assert.deepEqual(after.agents, before.agents, 'agent bindings remain unchanged')
    assert.deepEqual(after.projects.filter(p => p.id !== projectId), before.projects.filter(p => p.id !== projectId))
    const without = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)))
    assert.deepEqual(without(pAfter, ['features']), without(pBefore, ['features']))
    assert.deepEqual(pAfter.features.filter(f => f.id !== featureId), pBefore.features.filter(f => f.id !== featureId))
    assert.deepEqual(without(fAfter, ['contextPolicy', 'executionModels', 'runtimeHandoff', 'runtimeHandoffs', 'contextRuntime']), without(fBefore, ['contextPolicy', 'executionModels', 'runtimeHandoff', 'runtimeHandoffs', 'contextRuntime']))
    assert.deepEqual(after.receiptJournals, before.receiptJournals, 'receipts are not replayed or reset')
    assert.deepEqual(after.executionCheckpoints[key].progress, checkpoint.progress)
    assert.deepEqual(after.executionCheckpoints[key].reads, checkpoint.reads)
    assert.deepEqual(after.executionCheckpoints[key].commands, checkpoint.commands)
    assert.equal(after.executionCheckpoints[key].steps, checkpoint.steps)
    assert.equal(after.executionCheckpoints[key].role, checkpoint.role)
    assert.deepEqual(fAfter.runtimeBudget, fBefore.runtimeBudget)
    assert.deepEqual(fAfter.contextRuntime.compactions, fBefore.contextRuntime.compactions)
    assert.deepEqual(fAfter.contextRuntime.requests, fBefore.contextRuntime.requests)
    assert.equal(after.executionCheckpoints[key].prototypeReadUntil, checkpoint.prototypeReadUntil)
    assert.deepEqual(after.runtimeOriginals[fAfter.runtimeHandoff.originalId].checkpoint, checkpoint)
    assert.deepEqual(without(after, ['models', 'projects', 'executionCheckpoints', 'runtimeOriginals']), without(before, ['models', 'projects', 'executionCheckpoints', 'runtimeOriginals']))
    assert.deepEqual(without(after.executionCheckpoints, [key]), without(before.executionCheckpoints, [key]))
    assert.deepEqual(without(after.runtimeOriginals, [fAfter.runtimeHandoff.originalId]), before.runtimeOriginals ?? {})
  }
  app.whenReady().then(async () => {
    assert.equal(otherCoprojerProcesses().length, 0, 'Close Coprojer before maintenance; no concurrent state writer is allowed.')
    originalBytes = fs.readFileSync(source)
    const original = JSON.parse(originalBytes), key = JSON.stringify([projectId, featureId])
    const pBefore = original.projects.find(p => p.id === projectId), fBefore = pBefore?.features.find(f => f.id === featureId)
    assert.ok(fBefore && fBefore.stage === 'blocked' && !pBefore.activity && !pBefore.designActivity)
    assert.ok(original.projects.every(p => !p.activity && !p.designActivity))
    const checkpoint = original.executionCheckpoints[key]
    assert.ok(checkpoint?.version === 4 && ['developer', 'reviewer', 'diagnoser', 'preparer'].includes(checkpoint.role) && !checkpoint.pending)
    assert.equal(fBefore.contextPolicy?.mode, 'adaptive')
    assert.ok(!fBefore.executionModels?.reviewer && !fBefore.executionModels?.diagnoser && !fBefore.executionModels?.preparer, 'Already migrated; inspect existing result, never create duplicates.')
    const agent = original.agents.find(a => a.id === fBefore.reviewerId)
    const connection = original.models.find(m => m.id === agent.modelId)
    const developerConnection = original.models.find(m => m.id === fBefore.executionModels?.developer)
    assert.equal(developerConnection?.model, 'glm-5.3')
    assert.equal(connection.model, 'glm-5.3-flash'); assert.equal(connection.protocol, 'chat')
    assert.equal(connection.baseUrl.replace(/\/$/, ''), 'https://open.bigmodel.cn/api/coding/paas/v4')
    assert.ok(safeStorage.isEncryptionAvailable()); secret = safeStorage.decryptString(Buffer.from(connection.cipher, 'base64'))
    const { EngineeringService } = load('src/main/engineering/service.ts'), model = load('src/main/engineering/model.ts')
    service = new EngineeringService(); service.store.data = structuredClone(original)
    const p = service.store.project(projectId), f = p.features.find(f => f.id === featureId)
    report.before = { stateHash: hash(originalBytes), sourceFingerprint: service.sourceFingerprint(p), modelId: connection.id,
      prototypeReadUntil: checkpoint.prototypeReadUntil, repeated: checkpoint.progress.repeated, used: structuredClone(f.runtimeBudget.used) }
    assert.equal(checkpoint.fingerprint, service.executionFingerprint(p, f)); assert.equal(checkpoint.sourceFingerprint, report.before.sourceFingerprint)
    const archiveScope = hash(key), archiveSource = path.join(originalProfile, 'engineering-artifacts', archiveScope)
    if (fs.existsSync(archiveSource)) fs.cpSync(archiveSource, path.join(temporary, 'engineering-artifacts', archiveScope), { recursive: true })
    // 256K is this connection's conservative operating ceiling, not a claim
    // that the supplier's advertised maximum is 256K. Keep shared defaults legacy.
    const policy = { version: 2, mode: 'adaptive', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 }
    const capabilities = { contextWindowTokens: 256000, maxOutputTokens: 32768, outputParameter: 'max_tokens',
      windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output',
      contextPolicy: { ...policy, mode: 'legacy' } }
    const created = service.saveModel({ id: '', model: connection.model, protocol: connection.protocol, baseUrl: connection.baseUrl, apiKey: secret, capabilities })
    const executionModels = { developer: developerConnection.id, reviewer: created.id, diagnoser: created.id, preparer: developerConnection.id }
    service.prepareRuntimeHandoff(projectId, featureId, { action: 'switch', modelId: executionModels[checkpoint.role], executionModels })
    staged = diskValue(service.store.data)
    validatePreservation(original, staged, key, pBefore, p, fBefore, f, checkpoint)
    assert.equal(staged.executionCheckpoints[key].fingerprint, service.executionFingerprint(p, f))
    report.migration = { newConnectionId: created.id, oldConnectionId: connection.id, originalId: f.runtimeHandoff.originalId,
      capabilities, featurePolicy: policy, executionModels, role: checkpoint.role, checkpointCompatible: true, originalCheckpointPreserved: true,
      prototypeReadUntil: staged.executionCheckpoints[key].prototypeReadUntil, repeated: staged.executionCheckpoints[key].progress.repeated }
    // Let the real service assemble precisely the next request in the temporary
    // profile. Intercept at model.complete, before any returned tool can execute.
    const complete = model.complete, stop = new Error('ACTIVATION_REQUEST_INSPECTED')
    const capturedRoles = {}, nextRequests = {}
    for (const role of ['developer', 'reviewer', 'diagnoser', 'preparer']) {
      service.store.data = structuredClone(staged)
      const probeProject = service.store.project(projectId), probeFeature = probeProject.features.find(f => f.id === featureId)
      const probeAgent = service.executionAgent(probeFeature, role === 'developer' || role === 'preparer' ? 'developer' : 'reviewer', projectId)
      let requestCount = 0
      model.complete = async (...args) => {
        assert.equal(++requestCount, 1); assert.equal(args[0].id, executionModels[role])
        capturedRoles[role] = args
        const budget = args[6].budget
        assert.equal(budget.adaptive, true); assert.equal(budget.contextWindowTokens, 256000)
        assert.equal(budget.inputLimit, 197632); assert.equal(budget.requiresProviderCount, false)
        model.assertPreparedCapacity(args[6])
        nextRequests[role] = { model: args[0].model, budget, historyMessages: args[2].length, resumed: role === checkpoint.role }
        throw stop
      }
      try { await service.agentLoop(probeProject, probeFeature, probeAgent, probeFeature.feedback, AbortSignal.timeout(30000), { role,
        ...(role === checkpoint.role ? { resume: structuredClone(staged.executionCheckpoints[key]) } : {}) }) }
      catch (error) { if (error !== stop) throw error }
      finally { model.complete = complete }
      assert.equal(requestCount, 1); assert.ok(capturedRoles[role])
    }
    report.nextRequests = nextRequests
    report.nextRequest = nextRequests[checkpoint.role]
    assert.equal(service.sourceFingerprint(p), report.before.sourceFingerprint)
    report.providerToolsDispatched = 0; save()
    if (live) {
      report.liveVerifications = {}
      for (const role of [...new Set([checkpoint.role, 'reviewer'])]) {
      const captured = capturedRoles[role]
      const controller = AbortSignal.timeout(240000), counts = { text: 0, reasoning: 0, tool: 0 }, start = Date.now()
      const c = { ...captured[0], onRequest: undefined, onResponse: update => {
        report.liveVerification ??= {}; if (update.httpStatus) report.liveVerification.httpStatus = update.httpStatus
      }, traffic: undefined }
      report.liveVerification = { status: 'running', attempts: 1 }; save()
      let lastSave = 0
      try {
        const reply = await complete(c, captured[1], captured[2], captured[3], controller, update => {
          counts[update.kind] = (counts[update.kind] ?? 0) + update.text.length
          if (Date.now() - lastSave > 5000) { report.liveVerification.streamCharacters = counts; report.liveVerification.elapsedMs = Date.now() - start; save(); lastSave = Date.now() }
        }, captured[6])
        assert.ok(reply.usage?.inputTokens > 0)
        assert.ok(!reply.usage.reasoningTokens || reply.usage.outputTokens >= reply.usage.reasoningTokens)
        report.liveVerification = { ...report.liveVerification, status: 'passed', elapsedMs: Date.now() - start, usage: reply.usage,
          returnedTools: reply.calls.map(c => c.name), toolCount: reply.calls.length, toolsExecuted: 0 }
      } catch (error) {
        report.liveVerification = { ...report.liveVerification, status: 'failed', elapsedMs: Date.now() - start, error: sanitize(error), toolsExecuted: 0 }
        throw error
      } finally { report.liveVerifications[role] = { ...report.liveVerification }; save() }
      }
    }
    if (apply) {
      assert.equal(otherCoprojerProcesses().length, 0)
      assert.equal(hash(fs.readFileSync(source)), hash(originalBytes), 'State changed during validation; do not overwrite it.')
      assert.equal(service.sourceFingerprint(p), report.before.sourceFingerprint, 'Source changed during validation.')
      const backupDir = path.join(originalProfile, 'maintenance-backups'); fs.mkdirSync(backupDir, { recursive: true })
      const backup = path.join(backupDir, 'role-adaptive-' + path.basename(output) + '.json')
      fs.writeFileSync(backup, originalBytes, { mode: 0o600, flag: 'wx' })
      assert.equal(hash(fs.readFileSync(backup)), report.before.stateHash)
      // Use the existing fsync + atomic-rename writer, without running the
      // store constructor against the live profile or persisting the probe.
      service.store.data = staged; service.store.path = source
      service.store.save(); stateCommitted = true
      const readBack = JSON.parse(fs.readFileSync(source, 'utf8'))
      assert.deepEqual(readBack, diskValue(staged))
      const pAfter = readBack.projects.find(p => p.id === projectId), fAfter = pAfter.features.find(f => f.id === featureId)
      validatePreservation(original, readBack, key, pBefore, pAfter, fBefore, fAfter, checkpoint)
      fs.writeFileSync(path.join(temporary, 'engineering-v1.json'), JSON.stringify(readBack))
      const reloaded = new EngineeringService(), reloadedProject = reloaded.store.project(projectId), reloadedFeature = reloadedProject.features.find(f => f.id === featureId)
      assert.equal(reloaded.executionFingerprint(reloadedProject, reloadedFeature), readBack.executionCheckpoints[key].fingerprint)
      assert.equal(reloaded.sourceFingerprint(reloadedProject), report.before.sourceFingerprint)
      report.commit = { status: 'saved-and-read-back', stateHash: hash(fs.readFileSync(source)), backup, sourceUnchanged: true,
        otherProjectsUnchanged: true, existingConnectionsUnchanged: true, originalUsagePreserved: true, checkpointCompatibleAfterReload: true, stage: fAfter.stage }
    } else assert.equal(hash(fs.readFileSync(source)), hash(originalBytes))
    report.status = apply ? 'applied' : 'validated'
  }).catch(error => { report.status = stateCommitted ? 'committed-verification-failed' : 'failed'; report.error = sanitize(error) }).finally(() => {
    if (!stateCommitted && originalBytes) report.originalStateUnchanged = hash(fs.readFileSync(source)) === hash(originalBytes)
    report.endedAt = new Date().toISOString(); save()
    fs.rmSync(temporary, { recursive: true, force: true })
    console.log(JSON.stringify({ status: report.status, migration: report.migration, nextRequest: report.nextRequest?.budget,
      liveVerifications: report.liveVerifications, commit: report.commit, error: report.error, evidence: path.join(output, 'results.json') }))
    app.exit(['applied', 'validated'].includes(report.status) ? 0 : 1)
  })
}
