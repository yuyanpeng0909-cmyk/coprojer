const { assert, fixture, load, model, fs, path } = require('./fixtures/verification-runtime.cjs')
const policy = { version: 2, mode: 'adaptive', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 }
const capabilities = { contextWindowTokens: 256000, maxOutputTokens: 32768, outputParameter: 'max_tokens', windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output', contextPolicy: { ...policy, mode: 'legacy' } }
const roles = ['developer', 'reviewer', 'diagnoser', 'preparer'], mapping = Object.fromEntries(roles.map(role => [role, role === 'developer' || role === 'preparer' ? 'full' : 'flash']))
const key = JSON.stringify(['p', 'f']), originalComplete = model.complete, results = []
async function capture(ctx, role, resume) {
  let prepared, calls = 0
  const stop = new Error('CAPTURE_ONLY')
  model.complete = async (...args) => { calls++; prepared = args[6]; throw stop }
  const agent = ctx.service.executionAgent(ctx.feature, role === 'developer' || role === 'preparer' ? 'developer' : 'reviewer', 'p')
  try { await ctx.service.agentLoop(ctx.project, ctx.feature, agent, '', new AbortController().signal, { role, ...(resume ? { resume: structuredClone(resume) } : {}) }) }
  catch (e) { if (e !== stop) throw e }
  finally { model.complete = originalComplete }
  assert.equal(calls, 1)
  return prepared
}
async function setup() {
  const ctx = fixture()
  ctx.feature.runtimePolicy = 'receipts-effects-v1'; ctx.feature.contextPolicy = policy
  ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget(key)
  ctx.service.store.data.models.push(...['full', 'flash'].map(id => ({ ...ctx.service.store.data.models[0], id, name: id, model: id, capabilities })))
  const before = await capture(ctx, 'preparer')
  assert.equal(before.budget.adaptive, false, 'undeclared preparer connection reproduces legacy fallback')
  ctx.feature.stage = 'blocked'
  return ctx
}
async function main() {
  const ctx = await setup(), saved = structuredClone(ctx.service.store.data.executionCheckpoints[key])
  const used = structuredClone(ctx.feature.runtimeBudget.used), agents = structuredClone(ctx.service.store.data.agents), models = structuredClone(ctx.service.store.data.models)
  assert.equal(saved.role, 'preparer')
  ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'full', executionModels: mapping })
  assert.deepEqual(ctx.feature.executionModels, mapping)
  assert.deepEqual(ctx.feature.runtimeBudget.used, used); assert.deepEqual(ctx.service.store.data.agents, agents); assert.deepEqual(ctx.service.store.data.models, models)
  const migrated = structuredClone(ctx.service.store.data.executionCheckpoints[key])
  for (const field of ['role', 'steps', 'progress', 'reads', 'commands', 'prototypeReadUntil']) assert.deepEqual(migrated[field], saved[field])
  assert.deepEqual(ctx.service.store.data.runtimeOriginals[ctx.feature.runtimeHandoff.originalId].checkpoint, saved)
  assert.equal(migrated.fingerprint, ctx.service.executionFingerprint(ctx.project, ctx.feature))
  assert.equal(ctx.feature.contextRuntime.latestBudget, undefined)
  for (const role of roles) {
    const request = await capture(ctx, role, role === 'preparer' ? migrated : undefined)
    assert.equal(request.budget.adaptive, true, role); assert.equal(request.budget.contextWindowTokens, 256000); assert.equal(request.budget.inputLimit, 197632)
    results.push({ role, adaptive: request.budget.adaptive, inputLimit: request.budget.inputLimit })
  }
  for (const [name, change, pattern] of [
    ['unknown-role', { executionModels: { ...mapping, unknown: 'full' } }, /角色连接配置/],
    ['incomplete-capabilities', { executionModels: { ...mapping, reviewer: 'fixture' } }, /不完整/],
    ['conflicting-current-role', { modelId: 'flash' }, /不一致/],
    ['save-failure', {}, /injected/],
  ]) {
    const c = await setup(), before = structuredClone(c.service.store.data)
    if (name === 'save-failure') { const save = c.service.store.save.bind(c.service.store); c.service.store.save = () => { if (c.feature.runtimeHandoff) throw new Error('injected save failure'); save() } }
    assert.throws(() => c.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'full', executionModels: mapping, ...change }), pattern)
    assert.deepEqual(c.feature.executionModels, before.projects.find(p => p.id === 'p').features[0].executionModels)
    assert.deepEqual(c.service.store.data.executionCheckpoints, before.executionCheckpoints)
    assert.deepEqual(c.service.store.data.runtimeOriginals, before.runtimeOriginals)
    results.push({ name, preserved: true })
  }
  const { effectiveContextMode, compactionDescription } = load('src/shared/context-display.ts')
  assert.equal(effectiveContextMode({ adaptive: false, policy }), '兼容保护（自适应未生效）')
  assert.equal(effectiveContextMode({ adaptive: true, policy }), '自适应（已生效）')
  const old = compactionDescription({ at: '2026-10-13T11:05:44Z', reason: 'legacy', before: 104844, after: 71107 })
  assert.ok(old.includes('字符') && old.includes('角色未记录') && !old.includes('token'))
  const recent = compactionDescription({ at: '2026-10-13T11:05:44Z', reason: 'soft-limit', role: 'reviewer', model: 'flash', unit: 'tokens', before: 100000, after: 70000 })
  assert.ok(recent.includes('独立验证') && recent.includes('flash') && recent.includes('token'))
  results.push({ name: 'effective-policy-and-history-units', passed: true })
  const compressed = fixture(), stop = new Error('COMPACTION_INSPECTED')
  compressed.feature.contextPolicy = policy
  compressed.service.store.data.models[0].capabilities = capabilities
  let calls = 0
  model.complete = async () => {
    if (++calls > 1) throw stop
    return { text: 'read before review', reasoning: 'r'.repeat(225000), calls: [{ id: 'only-read', name: 'read_file', arguments: JSON.stringify({ path: 'value.cjs' }) }] }
  }
  try { await compressed.service.agentLoop(compressed.project, compressed.feature, compressed.service.executionAgent(compressed.feature, 'reviewer', 'p'), '', new AbortController().signal, { role: 'reviewer' }) }
  catch (e) { if (e !== stop) throw e }
  finally { model.complete = originalComplete }
  assert.equal(calls, 2)
  const records = compressed.feature.contextRuntime.compactions
  assert.equal(records.length, 1); assert.equal(records[0].role, 'reviewer'); assert.equal(records[0].model, 'fixture'); assert.equal(records[0].unit, 'tokens')
  assert.equal(records[0].manifestId, compressed.feature.contextRuntime.manifest.id)
  const event = compressed.project.events.find(e => e.kind === 'context-compaction')
  assert.ok(event.message.includes(`${records[0].before} → ${records[0].after}`))
  results.push({ name: 'actual-service-compaction-provenance-and-event-unit', passed: true })
  fs.mkdirSync(path.resolve('.runtime/reviewer-adaptive'), { recursive: true })
  fs.writeFileSync(path.resolve('.runtime/reviewer-adaptive/role-regression.json'), JSON.stringify({ status: 'passed', results }, null, 2))
  console.log('PASS role migration: legacy reproduced; four service roles adaptive; rollback, checkpoint and display verified')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
