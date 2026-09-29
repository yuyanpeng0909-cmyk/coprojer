const { fs, path, assert, sandbox, load, fixture, model, call, answer, run, EngineeringService } = require('./fixtures/verification-runtime.cjs')
const { sourceFingerprint, executeTool } = load('src/main/engineering/files.ts')
const { pendingGaps, nativeEvidenceSupported } = load('src/main/engineering/verification.ts')
const { commandEvidenceKinds } = load('src/main/engineering/execution.ts')

async function main() {
  const ctx = fixture()
  const gaps = pendingGaps({ ...ctx.feature, results: [], verificationPending: true })
  assert.equal(gaps.length, ctx.feature.criteria.length, 'legacy empty verification results must reconstruct missing criteria')
  console.log('PASS: old empty diagnostic state retains explicit gaps')

  const signal = new AbortController().signal
  fs.writeFileSync(path.join(ctx.root, 'package.json'), JSON.stringify({ name: 'verification-regression', private: true, scripts: { 'test:native:smoke': 'node tests/verify.cjs' } }))
  fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), 'require("node:assert/strict").equal(2+3,5);console.log("NESTED_TEST_EXECUTED")')
  const result = JSON.parse(await executeTool(ctx.service.store, ctx.project, 'f', 'reviewer', 'run_command', { program: 'npm', args: ['run', 'test:native:smoke'] }, signal))
  assert.equal(result.code, 0); assert.match(result.output, /NESTED_TEST_EXECUTED/)
  console.log('PASS: independent reviewer really runs nested test:* commands')

  fs.writeFileSync(path.join(ctx.root, 'tests/powershell-cache.cjs'), [
    'const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path")',
    'const cache=process.env.PSModuleAnalysisCachePath',
    'assert.ok(cache,"child PowerShell module cache must have an explicit runtime path")',
    'const runtime=path.resolve(".runtime")+path.sep',
    'assert.ok(path.resolve(cache).startsWith(runtime),"cache must stay in this project runtime")',
    'fs.writeFileSync(cache,"controlled generated module metadata")',
    'console.log("MODULE_CACHE_ISOLATED")',
  ].join(';'))
  const beforeModuleCache = sourceFingerprint(ctx.root)
  const moduleCache = JSON.parse(await executeTool(ctx.service.store, ctx.project, 'f', 'reviewer', 'run_command', { program:'node', args:['tests/powershell-cache.cjs'] }, signal))
  assert.equal(moduleCache.code, 0, moduleCache.output)
  assert.match(moduleCache.output, /MODULE_CACHE_ISOLATED/)
  assert.equal(sourceFingerprint(ctx.root), beforeModuleCache, 'module discovery cannot invalidate an unchanged review')
  console.log('PASS: child module cache stays outside source fingerprint without ignoring application files')

  fs.mkdirSync(path.join(ctx.root, 'verification/native'), { recursive: true })
  fs.writeFileSync(path.join(ctx.root, 'verification/README.md'), 'Approved scope stays an input.')
  fs.writeFileSync(path.join(ctx.root, 'verification/native/settings.json'), '{"threshold":2}')
  const before = sourceFingerprint(ctx.root)
  fs.writeFileSync(path.join(ctx.root, 'verification/native/run.json'), JSON.stringify({ sourceAndBuild: { 'value.cjs': 'a'.repeat(64) }, startedAt: new Date().toISOString(), status: 'passed', samples: [] }))
  fs.writeFileSync(path.join(ctx.root, 'verification/native/window.png'), Buffer.from([137,80,78,71]))
  assert.equal(sourceFingerprint(ctx.root), before, 'generated runtime records and screenshots are not source changes')
  fs.writeFileSync(path.join(ctx.root, 'verification/native/settings.json'), '{"threshold":200}')
  assert.notEqual(sourceFingerprint(ctx.root), before, 'verification configuration remains a source input')
  const configured = sourceFingerprint(ctx.root)
  fs.appendFileSync(path.join(ctx.root, 'verification/README.md'), '\nChanged approval')
  assert.notEqual(sourceFingerprint(ctx.root), configured, 'scope documents remain fingerprinted')
  console.log('PASS: runtime evidence is separated from source, config and confirmed scope')

  const recovery = fixture()
  recovery.feature.stage = 'blocked'; recovery.feature.verificationPending = true; recovery.feature.repairRound = 3
  fs.writeFileSync(path.join(recovery.root, 'tests/verify.cjs'), 'require("node:assert/strict").equal(2+3,5);console.log("CURRENT_CHECK_PASSED")')
  let requests = 0
  model.complete = async (_connection, system, messages, tools) => {
    assert.ok(system.includes('你是 Coprojer 的验证智能体。'), 'recovered empty results restart independent verification')
    requests++
    if (requests === 1) {
      assert.ok(tools.some(t => t.name === 'run_command'))
      return call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKind: 'unit' })
    }
    if (requests === 2) return { text: '实际检查成功，但这是未结构化的报告。', calls: [] }
    assert.equal(tools.length, 0, 'format recovery cannot execute additional tools')
    return answer({ summary: '实际检查通过', results: [{ criterion: recovery.feature.criteria[0], status: 'passed', passed: true, evidence: 'CURRENT_CHECK_PASSED', evidenceKind: 'unit', commandIds: ['check-1'] }] })
  }
  await run(recovery.service, true)
  assert.equal(recovery.feature.stage, 'acceptance'); assert.equal(recovery.feature.repairRound, 3); assert.equal(requests, 3)
  assert.match(recovery.feature.verificationChecks[0].output, /CURRENT_CHECK_PASSED/)
  console.log('PASS: legacy empty state rechecks with real commands; one report-format repair preserves acceptance and repair gates')

  const interrupted = fixture()
  interrupted.feature.stage = 'blocked'; interrupted.feature.verificationPending = true; interrupted.feature.repairRound = 3
  fs.writeFileSync(path.join(interrupted.root, 'tests/verify.cjs'), 'console.log("SAVED_CURRENT_CHECK")')
  let turn = 0
  model.complete = async (_connection, system) => {
    turn++
    if (turn === 1) return call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKind: 'unit' })
    if (turn === 2) throw Error('controlled transport interruption')
    assert.match(system, /SAVED_CURRENT_CHECK/, 'durable command ledger survives context/restart')
    return answer({ results: [{ criterion: interrupted.feature.criteria[0], status: 'passed', passed: true, evidence: 'SAVED_CURRENT_CHECK', evidenceKind: 'unit', commandIds: ['check-1'] }] })
  }
  await run(interrupted.service, true)
  assert.equal(interrupted.service.store.data.executionCheckpoints['["p","f"]'].commands.length, 1)
  const restored = new EngineeringService(); await run(restored, true)
  const restoredFeature = restored.store.project('p').features[0]
  assert.equal(restoredFeature.stage, 'acceptance'); assert.equal(restoredFeature.repairRound, 3)
  assert.equal(restored.store.project('p').events.filter(e => e.kind === 'tool' && e.message.startsWith('run_command')).length, 1)
  console.log('PASS: completed reviewer commands survive a transport failure and restart without replay')

  const handoff = fixture()
  handoff.feature.stage = 'blocked'; handoff.feature.verificationPending = true; handoff.feature.repairRound = 3
  fs.writeFileSync(path.join(handoff.root, 'tests/history.cjs'), 'console.log("HISTORY_ONLY")')
  let reviewPass = 0, diagnosed = false, prepared = false
  model.complete = async (_connection, system, messages) => {
    assert.match(system, /直接触发菜单回调只能证明 application/, 'all verification roles receive the same evidence boundary')
    const history = messages.filter(m => m.role === 'tool')
    if (system.includes('VERIFICATION_DIAGNOSIS')) {
      assert.match(system, /HISTORY_ONLY/); assert.match(system, /history/)
      assert.match(handoff.feature.feedback, /独立验证尚未通过/)
      assert.ok(!handoff.feature.feedback.includes('全部通过'), 'model summary cannot override gated verdict in user feedback')
      assert.ok(!handoff.feature.feedback.includes('"commandIds"'), 'public feedback is readable, not internal JSON')
      diagnosed = true
      return answer({ gaps: handoff.feature.verificationPreparation.gaps.map(g => ({ id: g.id, disposition: 'automatic', reason: 'Only history ran; current check is missing', nextStep: 'Create tests/fresh.cjs and execute it independently' })) })
    }
    if (system.includes('VERIFICATION_PREPARATION')) {
      prepared = true
      if (!history.length) return call('write_file', { path: 'tests/fresh.cjs', content: 'require("node:assert/strict").equal(require("../value.cjs").sum(2,3),5);console.log("FRESH_EXECUTION")' })
      return answer({ status: 'ready', summary: 'Created tests/fresh.cjs with real assertions', nextStep: 'node tests/fresh.cjs; independently execute it' })
    }
    if (!history.length) reviewPass++
    if (reviewPass === 1) {
      if (!history.length) return call('run_command', { program: 'node', args: ['tests/history.cjs'], evidenceKind: 'history' })
      return answer({ summary: '全部通过', results: [{ criterion: handoff.feature.criteria[0], passed: false, status: 'unverified', evidence: 'HISTORY_ONLY does not test current behavior', evidenceKind: 'history', commandIds: ['check-1'] }] })
    }
    assert.match(system, /Created tests\/fresh.cjs/); assert.match(system, /node tests\/fresh.cjs; independently execute it/)
    if (!history.length) return call('run_command', { program: 'node', args: ['tests/fresh.cjs'], evidenceKind: 'unit' })
    return answer({ results: [{ criterion: handoff.feature.criteria[0], passed: true, status: 'passed', evidence: 'FRESH_EXECUTION', evidenceKind: 'unit', commandIds: ['check-1'] }] })
  }
  await run(handoff.service, true)
  assert.equal(handoff.feature.stage, 'acceptance'); assert.equal(handoff.feature.repairRound, 3)
  assert.ok(diagnosed && prepared); assert.equal(reviewPass, 2)
  assert.match(handoff.feature.verificationChecks[0].output, /FRESH_EXECUTION/)
  console.log('PASS: diagnostic command ledger and preparation handoff lead to fresh independent execution, never history promotion')

  assert.deepEqual(commandEvidenceKinds({ evidenceKind: 'history', evidenceKinds: ['application', 'duration'] }), ['history'])
  assert.deepEqual(commandEvidenceKinds({ evidenceKind: 'mock' }), ['mock'])
  const combined = fixture({ criteria: ['实际行为', '短时测量'] })
  combined.feature.stage = 'blocked'; combined.feature.verificationPending = true
  fs.writeFileSync(path.join(combined.root, 'tests/verify.cjs'), 'require("node:assert/strict").equal(require("../value.cjs").sum(2,3),5);setTimeout(()=>console.log("MEASURED_RUN"),30)')
  model.complete = async (_connection, system, messages) => {
    if (!messages.some(m => m.role === 'tool')) return call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKinds: ['application', 'duration'] })
    return answer({ results: combined.feature.criteria.map((criterion, i) => ({ criterion, passed: true, status: 'passed', evidence: 'MEASURED_RUN', commandIds: ['check-1'], evidenceKind: i ? 'duration' : 'application', ...(i ? { measuredDurationSeconds: 0.03 } : {}) })) })
  }
  await run(combined.service, true)
  assert.equal(combined.feature.stage, 'acceptance')
  assert.deepEqual(combined.feature.verificationChecks[0].evidenceKinds, ['application', 'duration'])
  assert.equal(combined.project.events.filter(e => e.kind === 'tool' && e.message.startsWith('run_command')).length, 1)
  console.log('PASS: one actual execution may provide explicitly declared application and duration evidence; history never promotes')

  const nativeCriterion = '系统托盘菜单可点击，鼠标悬停显示状态'
  assert.equal(nativeEvidenceSupported(nativeCriterion, { evidenceKind: 'application', evidence: 'native menu callbacks passed' }), false)
  assert.equal(nativeEvidenceSupported(nativeCriterion, { evidenceKind: 'desktop', evidence: '无法注入真实鼠标输入，菜单回调通过。' }), false)
  assert.equal(nativeEvidenceSupported('短时后台计时推进', { evidenceKind: 'application', evidence: 'short runtime measurement' }), true)
  const native = fixture({ criteria: [nativeCriterion] })
  native.feature.stage = 'blocked'; native.feature.verificationPending = true; native.feature.repairRound = 3
  fs.writeFileSync(path.join(native.root, 'tests/verify.cjs'), 'console.log("API_CALLBACK_ONLY")')
  model.complete = async (_connection, system, messages) => {
    if (system.includes('VERIFICATION_DIAGNOSIS')) return answer({ gaps: native.feature.verificationPreparation.gaps.map(g => ({ id: g.id, disposition: 'unknown', reason: '需要进一步核对原生输入驱动，不能以回调作为证据', nextStep: '保留未验证及本次检查记录' })) })
    if (!messages.some(m => m.role === 'tool')) return call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKinds: ['application', 'desktop'] })
    return answer({ results: [{ criterion: nativeCriterion, passed: true, status: 'passed', evidenceKind: 'application', evidence: 'API_CALLBACK_ONLY', commandIds: ['check-1'] }] })
  }
  await run(native.service, true)
  assert.equal(native.feature.results[0].status, 'unverified'); assert.equal(native.feature.stage, 'blocked'); assert.equal(native.feature.repairRound, 3)
  assert.match(native.feature.results[0].evidence, /原生界面交互/)
  // Replay the unsupported saved report observed in the real-provider run.
  native.feature.results[0] = { criterion: nativeCriterion, passed: true, status: 'passed', evidenceKind: 'application', evidence: '菜单回调通过，但本环境无法注入真实托盘区鼠标输入。' }
  native.feature.stage = 'acceptance'; native.feature.tasks[0].done = true
  native.project.executionPlan.status = 'waiting-acceptance'; native.service.store.save()
  const reopened = new EngineeringService(), migrated = reopened.store.project('p').features[0]
  assert.equal(migrated.stage, 'blocked'); assert.equal(migrated.results[0].status, 'unverified'); assert.equal(migrated.tasks[0].done, false)
  assert.equal(migrated.repairRound, 3); assert.equal(reopened.store.project('p').executionPlan.status, 'stopped')
  migrated.stage = 'acceptance'; migrated.results[0].passed = true; migrated.results[0].status = 'passed'
  reopened.store.project('p').executionPlan.orderedFeatureIds = ['other', 'f']
  reopened.store.project('p').executionPlan.status = 'waiting-acceptance'; reopened.store.save()
  const unrelatedPlan = new EngineeringService()
  assert.equal(unrelatedPlan.store.project('p').executionPlan.status, 'waiting-acceptance', 'migration must not stop another feature waiting for acceptance')
  migrated.stage = 'done'; migrated.results[0].passed = true; migrated.results[0].status = 'passed'; reopened.store.save()
  assert.equal(new EngineeringService().store.project('p').features[0].stage, 'done', 'policy migration never overrides completed human acceptance')
  console.log('PASS: callback-only native UI claims stay unverified, including saved reports; no repair budget or final human acceptance changes')

  const failed = fixture({ defect: true })
  failed.feature.stage = 'blocked'; failed.feature.verificationPending = true; failed.feature.repairRound = 3
  fs.writeFileSync(path.join(failed.root, 'tests/verify.cjs'), 'require("node:assert/strict").equal(require("../value.cjs").sum(2,3),5)')
  fs.writeFileSync(path.join(failed.root, 'tests/unrelated.cjs'), 'require("node:assert/strict").equal(4*4,16)')
  let selectedCheck = 'tests/verify.cjs'
  model.complete = async (_connection, _system, messages) => !messages.some(m => m.role === 'tool')
    ? call('run_command', { program: 'node', args: [selectedCheck], evidenceKind: 'unit' })
    : answer({ results: [{ criterion: failed.feature.criteria[0], passed: true, status: 'passed', evidenceKind: 'unit', evidence: '模型声称通过，必须核对实际结果', commandIds: ['check-1'] }] })
  await run(failed.service, true)
  assert.equal(failed.feature.results[0].status, 'failed')
  const failedAt = failed.feature.verificationChecks[0].at
  selectedCheck = 'tests/unrelated.cjs'
  await run(failed.service, true)
  assert.equal(failed.feature.stage, 'blocked'); assert.equal(failed.feature.results[0].status, 'failed')
  assert.ok(failed.feature.verificationChecks.some(c => c.code !== 0 && c.at === failedAt && c.id.startsWith('unresolved-')))
  assert.equal(failed.feature.repairRound, 3)
  fs.writeFileSync(path.join(failed.root, 'value.cjs'), 'exports.sum=(a,b)=>a+b')
  selectedCheck = 'tests/verify.cjs'; await run(failed.service, true)
  assert.equal(failed.feature.stage, 'acceptance'); assert.ok(failed.feature.verificationChecks.every(c => c.code === 0))
  console.log('PASS: unrelated successful checks cannot erase a known same-source failure; actual repaired-source verification clears it')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }))
