const { fs, path, assert, sandbox, load, model, EngineeringService, fixture, testScript, answer, call, run } = require('./fixtures/verification-runtime.cjs')
const { executeTool, sourceFingerprint } = load('src/main/engineering/files.ts')
function provider(ctx, options = {}) {
  const seen = { developers: 0, diagnoses: 0, preparations: 0, reviews: 0, actualChecks: 0, phases: [], canFinish: false }
  if (options.budget) for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(ctx.root, 'budget-' + i + '.txt'), 'Distinct preparation evidence ' + i)
  model.complete = async (_connection, system, messages, tools, signal) => {
    const history = messages.filter(m => m.role === 'tool')
    if (system.includes('VERIFICATION_DIAGNOSIS')) {
      if (options.cancelDiagnosis && !seen.canFinish) { ctx.service.stop('p'); signal.throwIfAborted() }
      if (!history.length) { seen.diagnoses++; seen.phases.push('diagnosis'); return call('list_files', {}) }
      return answer({ summary: '核对本机事实及项目文件', gaps: ctx.feature.verificationPreparation.gaps.map(r => ({ criterion: r.criterion,
        disposition: options.unknown ? 'unknown' : r.criterion.includes('外部') ? 'external' : 'automatic',
        reason: r.criterion.includes('外部') ? '当前主机平台为 ' + process.platform + '，缺少目标设备和真实桌面输入驱动。' : '已读取文件清单；当前缺少可执行行为检查或开发依赖。',
        nextStep: r.criterion.includes('外部') ? '提供目标设备上的真实桌面交互记录及对应源码版本。' : '添加 tests/verify.cjs 并安装缺失的项目测试开发依赖。' })) })
    }
    if (system.includes('VERIFICATION_PREPARATION')) {
      if (!history.length) { seen.preparations++; seen.phases.push('preparation') }
      if (options.cancelImmediately && !seen.canFinish) { ctx.service.stop('p'); signal.throwIfAborted() }
      if (options.noProgress) return answer({ status: 'ready', summary: '仅文字，未执行动作', nextStep: '重新诊断工具限制' })
      if (options.loop) return call('read_file', { path: 'value.cjs' })
      if (options.budget) return call('read_file', { path: 'budget-' + history.length + '.txt' })
      if (options.preparationDefect && fs.readFileSync(path.join(ctx.root, 'value.cjs'), 'utf8').includes('a-b')) return answer({ status: 'defect', summary: 'value.cjs 将加法实现为减法，2+3 实际为 -1。', nextStep: '开发修复 sum，然后独立验证。' })
      if (!history.some(m => m.content.includes('已写入 tests/verify.cjs'))) return call('write_file', { path: 'tests/verify.cjs', content: testScript(options.dependency) })
      if (options.cancel && !seen.canFinish) { ctx.service.stop('p'); signal.throwIfAborted() }
      if (options.failAfterWrite && !seen.canFinish) throw Error('isolated preparation network failure')
      if (options.dependency && !history.some(m => m.content.includes('added 1 package'))) return call('run_command', {
        program: 'npm', args: ['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', 'file:tests/fixtures/helper'], timeoutSeconds: 30 })
      if (!history.some(m => m.content.includes('package.json'))) {
        const manifest = JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'))
        manifest.scripts['test:verification'] = 'node tests/verify.cjs'
        return call('write_file', { path: 'package.json', content: JSON.stringify(manifest) })
      }
      return answer({ status: options.partial ? 'blocked' : 'ready', summary: '已生成真实断言脚本并补齐命令。', nextStep: '独立执行 npm run test:verification。' })
    }
    if (system.includes('你是 Coprojer 的开发智能体')) {
      seen.developers++; seen.phases.push('developer')
      if (seen.developers > 1 && options.repair) fs.writeFileSync(path.join(ctx.root, 'value.cjs'), 'exports.sum = (a,b) => a+b')
      return { text: '实现已提交', calls: [] }
    }
    if (!history.length) { seen.reviews++; seen.phases.push('review') }
    if (options.sourceChange && !history.length) fs.appendFileSync(path.join(ctx.root, 'value.cjs'), '\n// external change')
    const hasScript = fs.existsSync(path.join(ctx.root, 'tests/verify.cjs'))
    if (hasScript && !history.length) { seen.actualChecks++; return call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKind: options.history ? 'history' : 'unit' }) }
    const passed = history.some(m => m.content.includes('ACTUAL_ASSERTION_PASSED'))
    const defect = history.some(m => m.content.includes('ERR_ASSERTION')) || options.explicitDefect && !seen.canFinish
    return answer({ summary: '逐项报告，实际证据与缺口分开', results: ctx.feature.criteria.map(criterion => ({ criterion,
      passed: !criterion.includes('外部') && passed && !options.repeatGap,
      status: criterion.includes('外部') ? 'unverified' : defect ? 'failed' : passed && !options.repeatGap ? 'passed' : 'unverified',
      evidence: criterion.includes('外部') ? '缺少目标设备与真实桌面输入能力。' : defect ? '已复现 sum(2,3) 不等于 5。' : passed ? '实际运行 tests/verify.cjs，断言输出可回查。' : '项目缺少行为检查脚本及运行条件。',
      evidenceKind: options.kindClaim || (options.history ? 'history' : 'unit'), measuredDurationSeconds: options.claimSeconds, commandIds: passed ? ['check-1'] : [] })) })
  }
  return seen
}
async function main() {
  let ctx = fixture(), seen = provider(ctx)
  await run(ctx.service)
  assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(ctx.feature.repairRound, 0)
  assert.equal(ctx.feature.verificationPreparation.round, 1); assert.equal(seen.developers, 1)
  assert.deepEqual(seen.phases, ['developer', 'review', 'diagnosis', 'preparation', 'review'])
  assert.equal(seen.actualChecks, 1); assert.match(ctx.feature.verificationChecks[0].output, /ACTUAL_ASSERTION_PASSED/)
  assert.equal(ctx.feature.verificationChecks[0].sourceFingerprint, sourceFingerprint(ctx.root))
  assert.equal(ctx.project.executionPlan.status, 'waiting-acceptance'); assert.equal(ctx.project.executionPlan.currentIndex, 0)
  assert.equal(fs.readdirSync(path.join(ctx.root, '.runtime/verification-evidence')).length, 1)
  ctx.service.accept('p', 'f'); assert.equal(ctx.feature.stage, 'done')
  console.log('PASS: real script created, actual assertion executed independently, no extra click, manual acceptance retained')

  ctx = fixture(); seen = provider(ctx, { dependency: true }); await run(ctx.service)
  assert.equal(ctx.feature.stage, 'acceptance', JSON.stringify(ctx.project.events.slice(-5)))
  assert.equal(ctx.feature.repairRound, 0)
  assert.ok(fs.existsSync(path.join(ctx.root, 'node_modules/local-test-helper/package.json')))
  assert.ok(JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'))).devDependencies['local-test-helper'])
  assert.match(ctx.feature.verificationChecks[0].output, /ACTUAL_ASSERTION_PASSED/)
  console.log('PASS: real offline npm development dependency installation followed by independent execution')

  ctx = fixture(); fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), testScript(true))
  seen = provider(ctx, { dependency: true }); await run(ctx.service)
  assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(ctx.feature.repairRound, 0)
  assert.equal(seen.actualChecks, 2, 'missing module command must be rerun after dependency preparation')
  assert.ok(ctx.project.events.some(e => e.message.includes('MODULE_NOT_FOUND')))
  console.log('PASS: actual missing-module failure routes through dependency preparation, not code repair')

  ctx = fixture({ criteria: ['计算行为正确', '外部平台桌面交互'] }); seen = provider(ctx, { partial: true }); await run(ctx.service)
  assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.feature.verificationPending, true)
  assert.equal(ctx.feature.results[0].passed, true); assert.equal(ctx.feature.results[1].status, 'unverified')
  assert.equal(ctx.feature.repairRound, 0); assert.equal(seen.preparations, 1); assert.equal(ctx.project.executionPlan.status, 'stopped')
  assert.equal(ctx.feature.verificationPreparation.gaps[0].disposition, 'external')
  assert.throws(() => ctx.service.accept('p', 'f'), /尚未通过/)
  ctx.service = new EngineeringService(); ctx.feature = ctx.service.store.project('p').features[0]
  await run(ctx.service); assert.equal(ctx.feature.repairRound, 0); assert.equal(seen.developers, 1)
  console.log('PASS: automatic part completed before external blockers, platform evidence remains unverified across restart')

  ctx = fixture({ defect: true, criteria: ['计算行为正确', '外部平台桌面交互'] })
  fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), testScript())
  seen = provider(ctx, { repair: true }); await run(ctx.service)
  assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.feature.verificationPending, true)
  assert.equal(ctx.feature.repairRound, 1); assert.equal(seen.developers, 2)
  assert.equal(ctx.feature.results[0].passed, true); assert.equal(seen.preparations, 0)
  console.log('PASS: actual code defect repaired before unresolved external validation, no defect hidden as missing environment')

  ctx = fixture({ defect: true }); seen = provider(ctx, { preparationDefect: true, repair: true }); await run(ctx.service)
  assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(ctx.feature.repairRound, 1)
  assert.equal(ctx.feature.verificationPreparation.attempts[0].status, 'defect')
  console.log('PASS: preparation diagnosis hands business defect back to existing repair loop')

  for (const options of [{ noProgress: true }, { unknown: true }, { loop: true }, { budget: true }, { repeatGap: true }]) {
    ctx = fixture(); seen = provider(ctx, options); await run(ctx.service)
    assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.feature.verificationPending, true); assert.equal(ctx.feature.repairRound, 0)
    assert.ok(seen.preparations <= 2); assert.ok(seen.developers === 1)
    if (options.loop) {
      assert.ok(ctx.service.store.data.executionCheckpoints['["p","f"]'].steps <= 6, 'unchanged repeated reads pause before the preparation budget')
      assert.ok(ctx.project.events.some(e => e.kind === 'stopped' && /重复|无进展/.test(e.message)))
    }
    if (options.budget) assert.equal(ctx.service.store.data.executionCheckpoints['["p","f"]'].steps, 12)
    const before = ctx.feature.verificationPreparation.round
    if (!options.loop && !options.budget) { await run(ctx.service); assert.equal(ctx.feature.verificationPreparation.round, before) }
  }
  console.log('PASS: unknown diagnostics, no-op claims, preparation budget and identical failures stop finitely without resetting repair')

  for (const options of [{ cancel: true }, { cancelImmediately: true }, { failAfterWrite: true }]) {
    ctx = fixture(); seen = provider(ctx, options); await run(ctx.service)
    assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.feature.verificationPreparation.round, 1)
    assert.equal(fs.existsSync(path.join(ctx.root, 'tests/verify.cjs')), !options.cancelImmediately)
    ctx.service = new EngineeringService(); ctx.feature = ctx.service.store.project('p').features[0]; ctx.project = ctx.service.store.project('p')
    seen.canFinish = true; await run(ctx.service)
    assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(seen.developers, 1)
    assert.equal(ctx.feature.verificationPreparation.round, 1)
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'))).scripts['test:verification'], 'node tests/verify.cjs', 'resumes the unfinished preparation phase')
    assert.equal(ctx.project.executionPlan.status, 'waiting-acceptance'); assert.equal(ctx.project.executionPlan.currentIndex, 0)
    assert.equal(ctx.project.events.filter(e => e.kind === 'tool' && e.message === 'write_file tests/verify.cjs').length, 1)
  }
  console.log('PASS: cancellation and connection failure preserve completed preparation, restart continues without replaying writes')

  ctx = fixture(); seen = provider(ctx, { cancelDiagnosis: true }); await run(ctx.service)
  assert.equal(ctx.feature.verificationPreparation.gaps.length, 1); assert.equal(ctx.feature.verificationPreparation.round, 0)
  ctx.service = new EngineeringService(); ctx.feature = ctx.service.store.project('p').features[0]; seen.canFinish = true
  await run(ctx.service)
  assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(seen.developers, 1)
  assert.equal(ctx.feature.verificationPreparation.round, 1)
  console.log('PASS: cancellation before the first diagnostic request retains its gaps and resumes the correct phase')

  ctx = fixture(); seen = provider(ctx, { cancel: true }); await run(ctx.service)
  fs.appendFileSync(path.join(ctx.root, 'value.cjs'), '\n// modified after cancellation')
  ctx.service = new EngineeringService(); ctx.feature = ctx.service.store.project('p').features[0]; seen.canFinish = true
  await run(ctx.service); assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(seen.developers, 1)
  assert.equal(ctx.feature.verificationChecks[0].sourceFingerprint, sourceFingerprint(ctx.root))
  fs.writeFileSync(path.join(ctx.root, 'package-lock.json'), '{"lockfileVersion":3}')
  assert.throws(() => ctx.service.accept('p', 'f'), /旧验证证据/)
  assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.feature.tasks[0].done, false)
  assert.equal(ctx.feature.verificationPreparation.phase, 'blocked')
  console.log('PASS: changed source discards stale preparation conversation; lockfile changes invalidate final acceptance')

  ctx = fixture(); fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), testScript())
  seen = provider(ctx, { history: true }); await run(ctx.service)
  assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.feature.verificationPending, true)
  assert.match(ctx.feature.results[0].evidence, /历史证据/)
  console.log('PASS: reading historical evidence never substitutes for a fresh required runtime check')

  for (const kindClaim of ['desktop', 'application', 'duration']) {
    ctx = fixture(); fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), testScript())
    seen = provider(ctx, { kindClaim, claimSeconds: 1500, noProgress: true }); await run(ctx.service)
    assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.feature.repairRound, 0)
    assert.equal(ctx.feature.results[0].status, 'unverified')
    assert.match(ctx.feature.results[0].evidence, /类型或实测时长/)
  }
  console.log('PASS: unit execution cannot be relabeled as desktop, application or long-duration evidence')

  ctx = fixture(); seen = provider(ctx); const signal = new AbortController().signal
  const tool = (role, name, args) => executeTool(ctx.service.store, ctx.project, 'f', role, name, args, signal)
  await assert.rejects(tool('reviewer', 'write_file', { path: 'tests/a.cjs', content: 'no' }), /不能修改/)
  await assert.rejects(tool('diagnoser', 'run_command', { program: 'node', args: ['value.cjs'] }), /只允许读取/)
  await assert.rejects(tool('preparer', 'write_file', { path: 'value.cjs', content: 'no' }), /不能修改业务/)
  fs.writeFileSync(path.join(ctx.root, 'tests/original.cjs'), 'require("node:assert").ok(false)')
  await assert.rejects(tool('preparer', 'write_file', { path: 'tests/original.cjs', content: '' }), /保留原有/)
  await assert.rejects(tool('preparer', 'run_command', { program: 'npm', args: ['install', '-g', 'playwright'] }), /只允许/)
  await assert.rejects(tool('preparer', 'run_command', { program: 'node', args: ['-e', 'process.exit(0)'] }), /只能执行/)
  await assert.rejects(tool('reviewer', 'run_command', { program: 'npm', args: ['test', '--prefix', '..'] }), /额外参数/)
  fs.writeFileSync(path.join(ctx.root, 'tests/bad.cjs'), "require('node:fs').writeFileSync('value.cjs','illegal change')")
  await assert.rejects(tool('preparer', 'run_command', { program: 'node', args: ['tests/bad.cjs'] }), /受保护工程文件/)
  console.log('PASS: role separation, read-only diagnosis, protected code/tests, no global installs or command-path bypass')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }))
