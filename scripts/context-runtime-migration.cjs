const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, fixture, model, call, answer, run, EngineeringService, load } = r
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const files = load('src/main/engineering/files.ts'), realTool = files.executeTool, realComplete = model.complete
const realWrite = fs.writeFileSync
const output = path.resolve('.runtime/context-runtime/m5-migration'); fs.mkdirSync(output, { recursive: true })
const key = JSON.stringify(['p', 'f']), results = [], tests = [], test = (name, fn) => tests.push({ name, fn })
const records = service => Object.values(service.store.data.receiptJournals?.[key]?.receipts ?? {})
const checkpoint = service => service.store.data.executionCheckpoints?.[key]
async function paused(from = 'chat', to = 'chat', options = {}) {
  const ctx = fixture(), writes = { count: 0 }
  options.setup?.(ctx)
  fs.writeFileSync(path.join(ctx.root, 'queued.cjs'), "require('node:fs').writeFileSync('forbidden.txt','no')")
  ctx.feature.runtimePolicy = 'receipts-effects-v1'
  ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget(key)
  const server = await provider((_request, n) => n === 1 ? { text: 'confirmed canonical history', calls: [
    call('write_file', { path: 'value.cjs', content: 'exports.sum = (a,b) => a+b // migrated once' }).calls[0],
    call('run_command', { program: 'node', args: ['queued.cjs'] }).calls[0],
  ] } : options.reply ? options.reply(_request, n) : answer({ status: 'incomplete', summary: '继续当前任务', nextStep: '保持人工验收' }))
  ctx.service.store.data.models[0] = { ...ctx.service.store.data.models[0], protocol: from, baseUrl: server.url, capabilities: { toolCalling: true, ...(options.compatibility === false ? {} : { nativeCompatibilityKey: 'source-contract' }) } }
  ctx.service.store.data.models.push({ id: 'target', name: 'target', model: 'target', protocol: to, baseUrl: server.url, cipher: '', capabilities: { toolCalling: true } })
  let stopped = false
  const save = ctx.service.store.save.bind(ctx.service.store)
  ctx.service.store.save = () => { save(); if (!stopped && records(ctx.service).some(x => x.status === 'completed')) { stopped = true; ctx.service.stop('p') } }
  fs.writeFileSync = (file, ...args) => { const target = file === path.join(ctx.root, 'value.cjs'); if (target) writes.count++; const result = realWrite(file, ...args); if (target) options.afterWrite?.(); return result }
  model.complete = realComplete
  await run(ctx.service); ctx.service.store.save = save
  if (writes.count !== 1 || server.requests.length !== 1 || !checkpoint(ctx.service)?.pending) {
    fs.writeFileSync(path.join(output, 'setup-failure.json'), JSON.stringify({ feature: ctx.feature, events: ctx.project.events, requests: server.requests, receipts: records(ctx.service), writes: writes.count }, null, 2))
    files.executeTool = realTool; fs.writeFileSync = realWrite; await server.close()
  }
  assert.equal(writes.count, 1); assert.equal(server.requests.length, 1); assert.ok(checkpoint(ctx.service).pending)
  return { ...ctx, server, writes, async close() { files.executeTool = realTool; fs.writeFileSync = realWrite; await server.close() } }
}
for (const from of ['chat', 'responses', 'anthropic']) for (const to of ['chat', 'responses', 'anthropic']) {
  test(`actual service switches ${from} to ${to}; one write, cancelled queue, paired wire, retained allowance`, async () => {
    const ctx = await paused(from, to)
    try {
      const before = structuredClone(checkpoint(ctx.service)), agents = JSON.stringify(ctx.service.store.data.agents), used = structuredClone(ctx.feature.runtimeBudget.used)
      ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' })
      assert.equal(ctx.server.requests.length, 1); assert.equal(ctx.writes.count, 1)
      assert.deepEqual(ctx.feature.runtimeBudget.used, used); assert.equal(JSON.stringify(ctx.service.store.data.agents), agents)
      assert.equal(checkpoint(ctx.service).pending, undefined); assert.notEqual(checkpoint(ctx.service).manifest.id, before.manifest.id)
      assert.equal(checkpoint(ctx.service).manifest.model.protocol, to)
      const skipped = records(ctx.service).find(x => x.tool === 'run_command'); assert.equal(skipped.strategy, 'not-started-v1'); assert.equal(skipped.attempts, 0)
      const original = ctx.service.store.data.runtimeOriginals[ctx.feature.runtimeHandoff.originalId]
      assert.deepEqual(original.checkpoint, before); assert.equal(Object.keys(original.journal.receipts).length, 1)
      const page = JSON.parse(ctx.service.readRuntimeArtifact({ projectId: 'p', featureId: 'f', id: 'handoff-original:' + ctx.feature.runtimeHandoff.originalId }))
      assert.equal(page.complete, true); assert.ok(page.content.includes('pending'))
      assert.throws(() => ctx.service.readRuntimeArtifact({ projectId: 'p', id: 'handoff-original:' + ctx.feature.runtimeHandoff.originalId }), /不属于/)
      await run(ctx.service)
      assert.equal(ctx.server.requests.length, 2); assert.equal(ctx.server.requests[1].protocol, to); assert.equal(ctx.writes.count, 1)
      assert.equal(fs.existsSync(path.join(ctx.root, 'forbidden.txt')), false)
      assert.equal(ctx.feature.runtimeBudget.used.requests, used.requests + 1); assert.equal(ctx.feature.runtimeBudget.used.tools, used.tools)
      assert.equal(ctx.feature.stage, 'blocked')
      const wire = ctx.server.requests[1].body, pairs = to === 'chat' ? [wire.messages.flatMap(m => m.tool_calls ?? []).map(c => c.id), wire.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)]
        : to === 'responses' ? [wire.input.filter(m => m.type === 'function_call').map(c => c.call_id), wire.input.filter(m => m.type === 'function_call_output').map(c => c.call_id)]
        : [wire.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(m => m.type === 'tool_use').map(c => c.id), wire.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(m => m.type === 'tool_result').map(c => c.tool_use_id)]
      assert.equal(pairs[0].length, 2); assert.deepEqual(pairs[0], pairs[1]); assert.deepEqual(ctx.server.errors, [])
      fs.writeFileSync(path.join(output, `${from}-${to}.json`), JSON.stringify({ original, feature: ctx.feature, requests: ctx.server.requests, receipts: records(ctx.service), writes: ctx.writes.count }, null, 2))
    } finally { await ctx.close() }
  })
}

test('prepared but never started command cancels explicitly and preserves original command intent', async () => {
  const ctx = await paused()
  try {
    ctx.service.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { ...ctx.feature.runtimeBudget.limits, tools: ctx.feature.runtimeBudget.used.tools }, '仅允许已完成调用')
    await run(ctx.service)
    const unstarted = records(ctx.service).find(x => x.tool === 'run_command')
    assert.equal(unstarted.status, 'prepared'); assert.equal(unstarted.attempts, 0)
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' })
    const original = ctx.service.store.data.runtimeOriginals[ctx.feature.runtimeHandoff.originalId]
    assert.deepEqual(original.journal.receipts[unstarted.logicalId], unstarted)
    const cancelled = records(ctx.service).find(x => x.logicalId === unstarted.logicalId)
    assert.equal(cancelled.strategy, 'not-started-v1'); assert.equal(cancelled.command, undefined); assert.equal(cancelled.attempts, 0)
    assert.equal(ctx.writes.count, 1); assert.equal(ctx.server.requests.length, 1); assert.equal(fs.existsSync(path.join(ctx.root, 'forbidden.txt')), false)
  } finally { await ctx.close() }
})

test('handoff save failure rolls back view, models and original registry and starts no request', async () => {
  const ctx = await paused()
  try {
    ctx.service.reconcileRuntime('p', 'f')
    const before = structuredClone(ctx.service.store.data), save = ctx.service.store.save.bind(ctx.service.store)
    ctx.service.store.save = () => { if (ctx.feature.runtimeHandoff) throw new Error('injected handoff persistence failure'); save() }
    assert.throws(() => ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' }), /injected/)
    assert.deepEqual(ctx.service.store.data.executionCheckpoints, before.executionCheckpoints)
    assert.deepEqual(ctx.service.store.data.runtimeOriginals, before.runtimeOriginals)
    assert.equal(ctx.feature.executionModels, undefined); assert.equal(ctx.feature.runtimeHandoff, undefined)
    assert.equal(ctx.server.requests.length, 1); assert.equal(ctx.writes.count, 1)
  } finally { await ctx.close() }
})

for (const condition of ['no-tools', 'failed-capability', 'active', 'old-revision', 'permission-change', 'unknown-version', 'external-change']) {
  test(`handoff refuses ${condition} before any new request or tool`, async () => {
    const ctx = await paused()
    try {
      if (condition === 'no-tools') ctx.service.store.data.models[1].capabilities.toolCalling = false
      if (condition === 'failed-capability') ctx.service.store.data.models[1].checks = { capabilities: { status: 'failed', at: new Date().toISOString() } }
      if (condition === 'active') ctx.project.designActivity = '正在设计'
      if (condition === 'old-revision') ctx.feature.revision++
      if (condition === 'permission-change') ctx.service.store.data.agents.find(a => a.id === 'developer').tools = ['read_file']
      if (condition === 'unknown-version') checkpoint(ctx.service).version = 99
      if (condition === 'external-change') fs.writeFileSync(path.join(ctx.root, 'external.cjs'), 'exports.changed=true')
      assert.throws(() => ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' }))
      assert.equal(ctx.server.requests.length, 1); assert.equal(ctx.writes.count, 1); assert.equal(ctx.feature.runtimeHandoff, undefined)
    } finally { await ctx.close() }
  })
}

test('journal without checkpoint blocks legacy rollback and legacy execution', async () => {
  const ctx = await paused()
  try {
    delete ctx.service.store.data.executionCheckpoints[key]
    assert.throws(() => ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'legacy' }), /回退不能丢弃/)
    ctx.feature.runtimePolicy = 'legacy'
    assert.throws(() => ctx.service.runFeature('p', 'f'), /即使检查点缺失/)
    assert.equal(ctx.server.requests.length, 1); assert.equal(ctx.writes.count, 1)
  } finally { await ctx.close() }
})

async function legacy() {
  const ctx = fixture(), reads = { count: 0 }
  ctx.feature.runtimePolicy = 'legacy'
  const server = await provider((_request, n) => n === 1 ? call('read_file', { path: 'value.cjs' })
    : answer({ status: 'incomplete', summary: '旧完整回合', nextStep: '继续核对' }))
  ctx.service.store.data.models[0].baseUrl = server.url
  ctx.service.store.data.models.push({ id: 'target', name: 'target', model: 'target', protocol: 'responses', baseUrl: server.url, cipher: '', capabilities: { toolCalling: true } })
  files.executeTool = async (...args) => { if (args[4] === 'read_file') reads.count++; return realTool(...args) }
  model.complete = realComplete; await run(ctx.service)
  assert.equal(reads.count, 1); assert.equal(server.requests.length, 2); assert.equal(checkpoint(ctx.service).version, 2)
  return { ...ctx, reads, server, async close() { files.executeTool = realTool; await server.close() } }
}
for (const format of ['legacy-complete', 'v2-complete', 'unknown-native-canonical']) {
  test(`${format} migrates then switches; preserves raw originals and unknown past usage without invented receipts`, async () => {
    const ctx = await legacy()
    try {
      const cp = checkpoint(ctx.service)
      if (format !== 'v2-complete') { delete cp.version; delete cp.manifest; for (const message of cp.messages) delete message.origin }
      if (format === 'unknown-native-canonical') {
        const m = cp.messages.find(m => m.calls?.length)
        m.responseItems = [{ type: 'reasoning', encrypted_content: 'unknown-secret-native-state' }, ...m.calls.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments }))]
      }
      const original = structuredClone(cp)
      assert.throws(() => ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' }), /先显式迁移/)
      ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'migrate' })
      assert.equal(checkpoint(ctx.service).version, 4); assert.equal(checkpoint(ctx.service).continuity.version, 1); assert.equal(ctx.feature.runtimeBudget.historical.kind, 'unknown'); assert.equal(ctx.feature.runtimeBudget.limits, null)
      assert.equal(records(ctx.service).length, 0); assert.deepEqual(ctx.service.store.data.runtimeOriginals[ctx.feature.runtimeHandoff.originalId].checkpoint, original)
      await run(ctx.service); assert.equal(ctx.server.requests.length, 2); assert.equal(ctx.reads.count, 1)
      ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' })
      ctx.service.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { requests: 4, tools: 4, activeMs: 30000 }, '明确授予迁移后有限额度')
      const resumed = new EngineeringService(); await run(resumed)
      const f = resumed.store.project('p').features[0]
      assert.equal(ctx.server.requests.length, 3); assert.equal(ctx.server.requests[2].protocol, 'responses'); assert.equal(ctx.reads.count, 1)
      assert.equal(f.runtimeBudget.historical.kind, 'unknown'); assert.equal(f.runtimeBudget.used.requests, 1); assert.equal(f.runtimeBudget.used.tools, 0)
      assert.equal(records(resumed).length, 0); assert.equal(f.runtimeHandoffs.length, 2)
      assert.ok(!JSON.stringify(ctx.server.requests[2]).includes('unknown-secret-native-state')); assert.equal(f.stage, 'blocked')
      fs.writeFileSync(path.join(output, format + '.json'), JSON.stringify({ feature: f, original, requests: ctx.server.requests, reads: ctx.reads.count }, null, 2))
    } finally { await ctx.close() }
  })
}
for (const format of ['legacy-partial', 'unknown-version', 'unknown-native-only']) {
  test(`${format} is preserved and cannot migrate or send new requests`, async () => {
    const ctx = await legacy()
    try {
      const cp = checkpoint(ctx.service)
      if (format === 'legacy-partial') { delete cp.version; delete cp.manifest; cp.messages = cp.messages.filter(m => m.role !== 'tool') }
      if (format === 'unknown-version') cp.version = 99
      if (format === 'unknown-native-only') { delete cp.version; delete cp.manifest; cp.messages = [{ role: 'assistant', content: '', responseItems: [{ type: 'reasoning', encrypted_content: 'opaque' }] }] }
      const original = JSON.stringify(cp)
      assert.throws(() => ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'migrate' }))
      assert.equal(JSON.stringify(cp), original); assert.equal(ctx.feature.runtimePolicy, 'legacy'); assert.equal(ctx.feature.runtimeBudget, undefined)
      assert.equal(ctx.server.requests.length, 2); assert.equal(ctx.reads.count, 1)
    } finally { await ctx.close() }
  })
}

for (const native of ['declared-compatible', 'different-model', 'unknown-origin', 'different-compatibility']) {
  test(`native state ${native} is reused only with explicit matching origin and compatibility`, async () => {
    const ctx = await paused('responses', 'responses')
    try {
      const m = checkpoint(ctx.service).pending.assistant
      m.responseItems.unshift({ type: 'reasoning', encrypted_content: 'scoped-encrypted-state' })
      if (native === 'unknown-origin') delete m.origin
      if (native === 'different-compatibility') m.origin.nativeCompatibilityKey = 'old-contract'
      ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: native === 'different-model' ? 'target' : 'fixture' })
      await run(ctx.service)
      assert.equal(JSON.stringify(ctx.server.requests[1]).includes('scoped-encrypted-state'), native === 'declared-compatible')
      assert.equal(ctx.writes.count, 1)
    } finally { await ctx.close() }
  })
}

test('legacy rollback without new receipts preserves originals and cumulative usage', async () => {
  const ctx = await legacy()
  try {
    ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget(key)
    ctx.feature.runtimeBudget.used.requests = 7
    const cp = structuredClone(checkpoint(ctx.service)), budget = structuredClone(ctx.feature.runtimeBudget)
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'legacy' })
    assert.equal(ctx.feature.runtimePolicy, 'legacy'); assert.deepEqual(ctx.feature.runtimeBudget, budget)
    assert.deepEqual(ctx.service.store.data.runtimeOriginals[ctx.feature.runtimeHandoff.originalId].checkpoint, cp)
    assert.equal(ctx.server.requests.length, 2)
  } finally { await ctx.close() }
})

for (const origin of ['known', 'unknown']) test(`ordinary persistent resume with ${origin} origin does not send undeclared native state`, async () => {
  const ctx = await paused('responses', 'responses', { compatibility: false })
  try {
    const m = checkpoint(ctx.service).pending.assistant
    m.responseItems.unshift({ type: 'reasoning', encrypted_content: 'never-send-unconfirmed-native' })
    if (origin === 'unknown') delete m.origin
    await run(ctx.service)
    assert.equal(ctx.server.requests.length, 2); assert.equal(ctx.writes.count, 1)
    assert.ok(!JSON.stringify(ctx.server.requests[1]).includes('never-send-unconfirmed-native'))
    assert.ok(JSON.stringify(checkpoint(ctx.service).messages).includes('never-send-unconfirmed-native'), 'original native history remains stored')
  } finally { await ctx.close() }
})

for (const role of ['preparer', 'diagnoser']) test(`${role} handoff retains its true base agent, permissions and inherited model`, async () => {
  const ctx = fixture(); let stopped = false, switched = false, writes = 0
  ctx.feature.runtimePolicy = 'receipts-effects-v1'; ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget(key)
  const server = await provider(req => {
    if (req.system.includes('VERIFICATION_DIAGNOSIS')) {
      if (role === 'diagnoser' && !switched) return { text: '', calls: [call('read_file', { path: 'value.cjs' }).calls[0], call('list_files', {}).calls[0]] }
      return answer({ gaps: ctx.feature.verificationPreparation.gaps.map(g => ({ id: g.id, disposition: switched && role === 'diagnoser' ? 'technical' : 'automatic', reason: '需要项目内实际检查脚本', nextStep: '新增补充检查脚本' })) })
    }
    if (req.system.includes('VERIFICATION_PREPARATION')) return switched ? answer({ status: 'blocked', summary: '准备效果保留', nextStep: '等待独立验证' })
      : { text: '', calls: [call('write_file', { path: 'tests/handoff.cjs', content: "require('node:assert/strict').equal(require('../value.cjs').sum(2,3),5)" }).calls[0], call('list_files', {}).calls[0]] }
    if (req.system.includes('你是 Coprojer 的开发智能体')) return answer({ status: 'complete', summary: '实现已交付', nextStep: '独立验证' })
    return answer({ summary: '缺实际检查', results: [{ criterion: ctx.feature.criteria[0], passed: false, status: 'unverified', evidence: '需要项目内行为检查脚本，尚未实际验证', evidenceKind: 'inspection' }] })
  })
  try {
    const base = role === 'preparer' ? 'developer' : 'reviewer'
    ctx.service.store.data.models[0].baseUrl = server.url
    for (const id of ['inherited', 'target']) ctx.service.store.data.models.push({ id, name: id, model: id, protocol: 'chat', baseUrl: server.url, cipher: '', capabilities: { toolCalling: true } })
    ctx.feature.executionModels = { [base]: 'inherited' }
    const save = ctx.service.store.save.bind(ctx.service.store)
    ctx.service.store.save = () => { save(); if (!stopped && records(ctx.service).some(x => x.role === role && x.status === 'completed')) { stopped = true; ctx.service.stop('p') } }
    fs.writeFileSync = (file, ...args) => { if (file === path.join(ctx.root, 'tests/handoff.cjs')) writes++; return realWrite(file, ...args) }
    model.complete = realComplete; await run(ctx.service); ctx.service.store.save = save
    assert.equal(checkpoint(ctx.service).role, role); assert.equal(records(ctx.service).find(x => x.role === role).agentId, base)
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'migrate' })
    assert.equal(checkpoint(ctx.service).manifest.model.connectionId, 'inherited')
    const record = records(ctx.service).find(x => x.role === role && x.strategy === 'not-started-v1')
    assert.equal(record.agentId, base); assert.deepEqual(record.permissions, ctx.service.store.data.agents.find(x => x.id === base).tools)
    const used = structuredClone(ctx.feature.runtimeBudget.used), count = server.requests.length
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' })
    assert.deepEqual(ctx.feature.runtimeBudget.used, used); assert.equal(server.requests.length, count)
    switched = true; await run(ctx.service)
    assert.equal(server.requests[count].body.model, 'target'); assert.equal(ctx.feature.stage, 'blocked')
    assert.equal(writes, role === 'preparer' ? 1 : 0)
    fs.writeFileSync(path.join(output, role + '-handoff.json'), JSON.stringify({ feature: ctx.feature, requests: server.requests, receipts: records(ctx.service), writes }, null, 2))
  } finally { fs.writeFileSync = realWrite; await server.close() }
})

test('switched developer hands facts to independent reviewer; real read and command required before acceptance', async () => {
  let phase = 0
  const ctx = await paused('chat', 'responses', { setup: ctx => fs.writeFileSync(path.join(ctx.root, 'tests/behavior.cjs'), "require('node:assert/strict').equal(require('../value.cjs').sum(2,3),5);console.log('REAL_REVIEW_PASSED')"), reply: req => {
    if (req.system.includes('你是 Coprojer 的开发智能体')) return answer({ status: 'complete', summary: '开发口头报告不能代替验证', nextStep: '独立读取并执行测试' })
    if (req.system.includes('VERIFICATION_DIAGNOSIS')) return answer({ gaps: [] })
    if (phase++ === 0) return call('read_file', { path: 'value.cjs' })
    if (phase === 2) return call('run_command', { program: 'node', args: ['tests/behavior.cjs'], evidenceKind: 'unit' })
    return answer({ summary: '独立执行实际检查', results: [{ criterion: ctx.feature.criteria[0], passed: true, status: 'passed', evidence: '实际读取 value.cjs 并运行 tests/behavior.cjs，REAL_REVIEW_PASSED', evidenceKind: 'unit' }] })
  } })
  try {
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' })
    assert.equal(ctx.server.requests.length, 1)
    await run(ctx.service)
    assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(ctx.writes.count, 1)
    const reviewer = records(ctx.service).filter(x => x.role === 'reviewer')
    assert.ok(reviewer.some(x => x.tool === 'read_file' && x.status === 'completed'))
    assert.ok(reviewer.some(x => x.tool === 'run_command' && x.status === 'completed'))
    assert.ok(ctx.feature.results[0].passed); assert.notEqual(ctx.feature.stage, 'done')
    const request = ctx.server.requests.find(req => req.system.includes('你是 Coprojer 的验证智能体'))
    const wire = JSON.stringify(request.body)
    for (const fact of ['contractFingerprint', 'changes', 'value.cjs', 'unfinished', 'nextStep', 'handoff-original:', 'independentVerification', 'evidence']) assert.ok(wire.includes(fact), fact)
    fs.writeFileSync(path.join(output, 'independent-review-handoff.json'), JSON.stringify({ feature: ctx.feature, requests: ctx.server.requests, receipts: records(ctx.service), writes: ctx.writes.count }, null, 2))
  } finally { await ctx.close() }
})

for (const native of ['declared-compatible', 'different-model', 'unknown-origin', 'different-compatibility']) test(`Anthropic signature ${native} obeys explicit compatibility`, async () => {
  const ctx = await paused('anthropic', 'anthropic')
  try {
    const m = checkpoint(ctx.service).pending.assistant
    m.anthropicBlocks.unshift({ type: 'thinking', thinking: 'canonical-adjacent thought', signature: 'scoped-anthropic-signature' })
    if (native === 'unknown-origin') delete m.origin
    if (native === 'different-compatibility') m.origin.nativeCompatibilityKey = 'obsolete'
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: native === 'different-model' ? 'target' : 'fixture' })
    await run(ctx.service)
    assert.equal(JSON.stringify(ctx.server.requests[1]).includes('scoped-anthropic-signature'), native === 'declared-compatible')
    assert.equal(ctx.writes.count, 1); assert.deepEqual(ctx.server.errors, [])
  } finally { await ctx.close() }
})

test('target model can read only its own skill; another role private body never enters its requests', async () => {
  const ctx = await paused('chat', 'responses', { setup: ctx => {
    ctx.service.store.data.skills.find(s => s.id === 'developer::delivery').content += '\nOWN_SKILL_VISIBLE'
    ctx.service.store.data.skills.find(s => s.id === 'reviewer::verification').content += '\nOTHER_ROLE_PRIVATE_BODY'
  }, reply: (_req, n) => n === 2 ? call('read_skill', { id: 'developer::delivery' }) : n === 3 ? call('read_skill', { id: 'reviewer::verification' }) : answer({ status: 'incomplete', summary: '技能边界已核对', nextStep: '等待人工继续' }) })
  try {
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' }); await run(ctx.service)
    assert.equal(ctx.writes.count, 1); assert.equal(ctx.server.requests.length, 4)
    assert.ok(JSON.stringify(ctx.server.requests[2]).includes('OWN_SKILL_VISIBLE'))
    assert.ok(!JSON.stringify(ctx.server.requests).includes('OTHER_ROLE_PRIVATE_BODY'))
    const skills = records(ctx.service).filter(r => r.tool === 'read_skill')
    assert.equal(skills.length, 2); assert.equal(skills[0].status, 'completed'); assert.equal(skills[1].status, 'failed')
    assert.match(skills[1].result.output, /不属于|其他智能体/)
    fs.writeFileSync(path.join(output, 'skill-isolation.json'), JSON.stringify({ feature: ctx.feature, requests: ctx.server.requests, receipts: records(ctx.service) }, null, 2))
  } finally { await ctx.close() }
})

for (const condition of ['permission-revoked-in-flight', 'revision-changed-in-flight']) test(`target reply ${condition} cannot start a write or advance new task`, async () => {
  const ctx = await paused('chat', 'responses', { reply: (_req, n) => {
    if (n === 2) {
      if (condition === 'permission-revoked-in-flight') ctx.service.store.data.agents.find(a => a.id === 'developer').tools = ['read_file']
      else { ctx.feature.revision++; ctx.feature.title = 'NEW_CURRENT_GOAL'; ctx.feature.stage = 'ready' }
      ctx.service.store.save()
      return call('write_file', { path: 'late-effect.txt', content: 'must not execute' })
    }
    return answer({ status: 'incomplete', summary: '停止', nextStep: '人工核对' })
  } })
  try {
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' })
    const used = ctx.feature.runtimeBudget.used.tools; await run(ctx.service)
    assert.equal(ctx.writes.count, 1); assert.equal(fs.existsSync(path.join(ctx.root, 'late-effect.txt')), false)
    assert.equal(ctx.feature.runtimeBudget.used.tools, used)
    if (condition === 'revision-changed-in-flight') {
      assert.equal(ctx.feature.title, 'NEW_CURRENT_GOAL'); assert.equal(ctx.feature.stage, 'ready')
      assert.ok(ctx.project.events.some(e => e.kind === 'historical-result'))
    } else assert.ok(ctx.project.events.some(e => e.message.includes('当前角色不可使用')))
    fs.writeFileSync(path.join(output, condition + '.json'), JSON.stringify({ feature: ctx.feature, requests: ctx.server.requests, events: ctx.project.events, receipts: records(ctx.service) }, null, 2))
  } finally { await ctx.close() }
})

test('uncertain actual file effect plus external conflict refuses handoff and preserves both records', async () => {
  const ctx = await paused('chat', 'responses', { afterWrite: () => { throw new Error('actual write happened, receipt save boundary lost') } })
  try {
    assert.equal(records(ctx.service)[0].status, 'uncertain')
    realWrite(path.join(ctx.root, 'value.cjs'), 'external conflict, do not overwrite')
    assert.throws(() => ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'target' }), /当前文件与预期写入版本不一致；未默认重写/)
    assert.equal(ctx.server.requests.length, 1); assert.equal(ctx.writes.count, 1); assert.equal(ctx.feature.runtimeHandoff, undefined)
    assert.equal(records(ctx.service)[0].status, 'uncertain'); assert.equal(fs.readFileSync(path.join(ctx.root, 'value.cjs'), 'utf8'), 'external conflict, do not overwrite')
    fs.writeFileSync(path.join(output, 'uncertain-handoff.json'), JSON.stringify({ feature: ctx.feature, receipts: records(ctx.service), requests: ctx.server.requests }, null, 2))
  } finally { await ctx.close() }
})

;(async () => {
  try { for (const t of tests) { try { await t.fn(); results.push({ name: t.name, status: 'passed' }); console.log('PASS:', t.name) }
    catch (error) { results.push({ name: t.name, status: 'failed', error: error.stack }); throw error } } }
  finally { files.executeTool = realTool; model.complete = realComplete; fs.writeFileSync = realWrite; fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
