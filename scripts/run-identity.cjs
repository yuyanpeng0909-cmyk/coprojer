const { fs, path, assert, sandbox, fixture, load, model, answer, run, testScript, EngineeringService } = require('./fixtures/verification-runtime.cjs')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const { performance } = require('node:perf_hooks')
const budget = load('src/main/engineering/runtime-budget.ts')
const key = JSON.stringify(['p', 'f']), output = path.resolve('.runtime/harness-refactor/run-identity')
const complete = model.complete, results = [], counters = {}
const pause = () => answer({ status: 'incomplete', summary: '保留已完成检查', nextStep: '继续下一项检查' })
const finish = () => answer({ status: 'complete', summary: '本段已完成', nextStep: '独立验证' })
const tool = (id, name, args) => ({ text: '', calls: [{ id, name, arguments: JSON.stringify(args) }] })
const command = id => tool(id, 'run_command', { program: 'node', args: ['tests/check.cjs'], evidenceKind: 'unit', timeoutSeconds: 5 })
const snapshot = ctx => ctx.service.store.data.executionCheckpoints[key]
const commands = ctx => snapshot(ctx)?.commands ?? []
const evidenceKey = command => JSON.stringify([command.executionRunId, command.id, command.at])
const saveArtifact = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n')
function setup(options) {
  const ctx = fixture(options)
  ctx.feature.runtimePolicy = 'receipts-effects-v1'; ctx.feature.runtimeBudget = budget.newRuntimeBudget('run-identity')
  fs.writeFileSync(path.join(ctx.root, 'tests/check.cjs'), "console.log('IDENTITY_COMMAND')")
  return ctx
}
function projection(system) {
  const marker = '宿主当前任务事实（每次请求重新装载）：\n', start = system.indexOf(marker)
  assert.notEqual(start, -1, 'host task projection remains available')
  return JSON.parse(system.slice(start + marker.length).split('\n')[0])
}
function assertProjection(value, expected) {
  assert.deepEqual(value.evidence.records.map(record => record.id), expected.map(command => command.id), 'projection has every command once in order')
  assert.deepEqual(value.evidence.records.map(record => record.runId), expected.map(command => command.runId), 'projection retains each command identity')
  assert.equal(new Set(value.evidence.records.map(record => JSON.stringify([record.runId, record.id]))).size, expected.length)
}
function measured(ctx) {
  const store = ctx.service.store, originals = { save: store.save, event: store.event, reserveTime: budget.RuntimeBudgetLease.prototype.reserveTime }
  const counts = { counted: 0, timeLease: 0, outputEvent: 0 }; let inTime = 0, inOutput = 0
  budget.RuntimeBudgetLease.prototype.reserveTime = function (...args) { inTime++; try { return originals.reserveTime.apply(this, args) } finally { inTime-- } }
  store.save = function (...args) { const value = originals.save.apply(this, args); counts[inTime ? 'timeLease' : inOutput ? 'outputEvent' : 'counted']++; return value }
  store.event = function (project, kind, ...args) { if (kind === 'output') inOutput++; try { return originals.event.call(this, project, kind, ...args) } finally { if (kind === 'output') inOutput-- } }
  return { counts, restore() { store.save = originals.save; store.event = originals.event; budget.RuntimeBudgetLease.prototype.reserveTime = originals.reserveTime } }
}
async function scripted(reply, work) {
  const original = model.complete
  model.complete = reply
  try { return await work() } finally { model.complete = original }
}
async function settle(ctx) {
  const deadline = Date.now() + 30000
  while (ctx.project.activity && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  if (ctx.project.activity) { ctx.service.stop('p'); throw new Error('isolated entry did not settle') }
}
async function firstPaused(ctx, id) {
  let requests = 0
  await scripted(async () => ++requests === 1 ? command(id) : pause(), () => run(ctx.service))
  assert.equal(requests, 2); assert.equal(ctx.feature.contextRuntime.status, 'paused')
  assert.equal(commands(ctx).length, 1)
}
const cases = []
const test = (id, name, work) => cases.push({ id, name, work })

test('R1', 'uninterrupted developer loop keeps command step and projection identity', async () => {
  const ctx = setup(), meter = measured(ctx), requests = [], emitted = []
  let result
  try {
    result = await scripted(async (_connection, system) => {
      const current = snapshot(ctx); requests.push({ step: current.steps, projection: projection(system) })
      if (requests.length === 1) return tool('r1-read', 'read_file', { path: 'value.cjs' })
      if (requests.length === 2) { emitted.push({ callId: 'r1-command', step: String(current.steps) }); return command('r1-command') }
      assert.equal(requests.length, 3); return finish()
    }, () => ctx.service.agentLoop(ctx.project, ctx.feature, ctx.service.executionAgent(ctx.feature, 'developer', 'p'), '', new AbortController().signal, { role: 'developer' }))
  } finally { meter.restore() }
  assert.equal(ctx.feature.contextRuntime.status, 'completed'); assert.equal(requests.length, 3)
  assert.deepEqual(result.commands.map(command => command.id), ['check-1'])
  for (const evidence of result.commands) {
    assert.equal(evidence.stepId, emitted.find(call => call.callId === evidence.providerCallId).step)
    assert.equal(evidence.executionRunId, ctx.feature.evidenceProjection.executionRunId)
  }
  assertProjection(requests.at(-1).projection, result.commands)
  assert.deepEqual(requests.map(request => request.step), [0, 1, 2])
  const requestRecords = ctx.feature.contextRuntime.requests
  assert.deepEqual(requestRecords.map(record => record.stepId), ['0', '1', '2'])
  for (const record of requestRecords) assert.equal(record.executionRunId, ctx.feature.evidenceProjection.executionRunId)
  const modelEvents = ctx.project.events.filter(event => event.kind === 'model')
  assert.deepEqual(modelEvents.map(event => event.stepId), ['0', '1', '2'])
  for (const event of modelEvents) assert.equal(event.executionRunId, ctx.feature.evidenceProjection.executionRunId)
  const receipts = Object.values(ctx.service.store.data.receiptJournals[key].receipts)
  const { receiptIntentHash } = load('src/main/engineering/receipt-ledger.ts')
  assert.deepEqual(receipts.map(record => [record.providerCallId, record.stepId]), [['r1-read', '0'], ['r1-command', '1']])
  for (const record of receipts) {
    const request = requestRecords.find(request => request.stepId === record.stepId)
    assert.ok(request); assert.equal(record.executionRunId, request.executionRunId)
    const withoutRef = { ...record }; delete withoutRef.executionRunId; delete withoutRef.stepId
    assert.equal(receiptIntentHash(record), receiptIntentHash(withoutRef), 'run references do not change the intent hash')
    assert.equal(record.intentHash, receiptIntentHash(withoutRef))
  }
  counters.R1 = { ...meter.counts }

  // Keep the fixed R1 save count scoped to its original three-step run.
  const limited = setup(), stepLimit = load('src/main/engineering/execution.ts').diagnosisStepLimit
  let limitedRequests = 0
  for (let step = 0; step < stepLimit; step++) fs.writeFileSync(path.join(limited.root, 'step-' + step + '.cjs'), 'exports.step = ' + step)
  await scripted(async (_connection, _system, _messages, tools) => {
    const step = limitedRequests++
    assert.equal(snapshot(limited).steps, step)
    if (step < stepLimit) return tool('r1-limited-' + step, 'read_file', { path: 'step-' + step + '.cjs' })
    assert.equal(step, stepLimit); assert.deepEqual(tools, [])
    return { text: '', calls: [] }
  }, () => assert.rejects(limited.service.agentLoop(limited.project, limited.feature,
    limited.service.executionAgent(limited.feature, 'reviewer', 'p'), '', new AbortController().signal, { role: 'diagnoser' }),
    load('src/main/engineering/execution.ts').ExecutionBudgetPause))
  assert.equal(limitedRequests, stepLimit + 1); assert.equal(limited.feature.contextRuntime.status, 'paused')
  const conclusionRecords = limited.feature.contextRuntime.requests
  assert.deepEqual(conclusionRecords.map(record => record.stepId), Array.from({ length: stepLimit + 1 }, (_, step) => String(step)))
  assert.equal(conclusionRecords.at(-1).stepId, String(stepLimit))
  for (const record of conclusionRecords) assert.equal(record.executionRunId, snapshot(limited).executionRunId)
  saveArtifact('R1', { entry: 'agentLoop', requests, requestRecords, modelEvents, receipts, commands: result.commands, projection: ctx.feature.evidenceProjection,
    saves: counters.R1, conclusion: { stepLimit, requests: conclusionRecords, checkpoint: snapshot(limited) } })
})

test('R2', 'pause and resume retains both commands and one execution identity', async () => {
  const ctx = setup(), meter = measured(ctx), requests = [], emitted = []
  let first, firstSaves, firstRunId, firstAgent
  try {
    await scripted(async (_connection, system) => {
      const number = requests.length + 1, current = snapshot(ctx)
      requests.push({ step: current.steps, projection: projection(system) })
      if (number === 1 || number === 3) { const id = number === 1 ? 'r2-first' : 'r2-second'; emitted.push({ callId: id, step: String(current.steps) }); return command(id) }
      assert.ok(number === 2 || number === 4); return pause()
    }, async () => {
      await run(ctx.service); first = structuredClone(commands(ctx)); firstSaves = { ...meter.counts }
      assert.equal(ctx.feature.contextRuntime.status, 'paused'); assert.equal(first.length, 1)
      firstRunId = snapshot(ctx).executionRunId; firstAgent = structuredClone(ctx.project.agentRuns.at(-1))
      assert.match(firstRunId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)
      assert.notEqual(firstRunId, firstAgent.id, 'a new run has its own identity, separate from the agent snapshot')
      await run(ctx.service)
    })
  } finally { meter.restore() }
  const records = commands(ctx)
  assert.equal(requests.length, 4); assert.equal(ctx.feature.contextRuntime.status, 'paused')
  assert.deepEqual(records.map(command => command.id), ['check-1', 'check-2'])
  assert.deepEqual(records[0], first[0], 'resume does not rewrite old evidence')
  for (const evidence of records) assert.equal(evidence.stepId, emitted.find(call => call.callId === evidence.providerCallId).step)
  assertProjection(requests[1].projection, first); assertProjection(requests[2].projection, first); assertProjection(requests[3].projection, records)
  assert.equal(snapshot(ctx).executionRunId, firstRunId)
  for (const evidence of records) assert.equal(evidence.executionRunId, firstRunId)
  for (const request of requests) assert.equal(request.projection.executionRunId, firstRunId)
  const lastAgent = ctx.project.agentRuns.at(-1)
  assert.notEqual(lastAgent.id, firstAgent.id, 'resume still creates an independent agent snapshot')
  assert.deepEqual(ctx.project.agentRuns.find(agent => agent.id === firstAgent.id), firstAgent)
  assert.equal(firstAgent.executionRunId, firstRunId); assert.equal(lastAgent.executionRunId, firstRunId)
  assert.equal(ctx.feature.evidenceProjection.executionRunId, records[1].executionRunId)
  counters.R2 = { first: firstSaves, total: { ...meter.counts } }
  saveArtifact('R2', { entry: 'runFeature', requests, commands: records, checkpoint: snapshot(ctx), agentRuns: [firstAgent, lastAgent], saves: counters.R2 })
})

test('R3', 'failed verification repairs once and archives an existing check only once', async () => {
  const ctx = setup({ defect: true }), phases = []; let repaired = false, failedCheck
  fs.writeFileSync(path.join(ctx.root, 'tests/check.cjs'), testScript())
  await scripted(async (_connection, system, messages) => {
    if (system.includes('你是 Coprojer 的开发智能体')) {
      if (ctx.feature.repairRound === 0) { phases.push('develop'); return finish() }
      if (!repaired) {
        repaired = true; phases.push('repair')
        assert.equal(ctx.feature.verificationChecks.length, 1); failedCheck = structuredClone(ctx.feature.verificationChecks[0])
        assert.notEqual(failedCheck.code, 0)
        // Seed the already-persisted check in history to exercise the deduplication guard.
        ctx.feature.verificationHistory = [structuredClone(failedCheck)]
        return tool('r3-repair', 'write_file', { path: 'value.cjs', content: 'exports.sum = (a,b) => a+b' })
      }
      return finish()
    }
    assert.ok(!system.includes('VERIFICATION_DIAGNOSIS') && !system.includes('VERIFICATION_PREPARATION'), 'a real assertion failure remains a code repair')
    const history = messages.filter(message => message.role === 'tool')
    if (!history.length) { phases.push('review-' + ctx.feature.repairRound); return command('r3-review-' + ctx.feature.repairRound) }
    const passed = history.some(message => message.content.includes('ACTUAL_ASSERTION_PASSED'))
    return answer({ summary: '依据实际断言输出', results: [{ criterion: ctx.feature.criteria[0], passed, status: passed ? 'passed' : 'failed',
      evidence: passed ? 'tests/check.cjs 实际断言通过' : '实际断言失败：sum(2,3) 不等于 5', evidenceKind: 'unit', commandIds: ['check-1'] }] })
  }, () => run(ctx.service))
  assert.equal(ctx.feature.stage, 'acceptance'); assert.equal(ctx.feature.repairRound, 1)
  assert.deepEqual(phases, ['develop', 'review-0', 'repair', 'review-1'])
  assert.equal(ctx.feature.verificationHistory.length, 1); assert.deepEqual(ctx.feature.verificationHistory[0], failedCheck)
  assert.equal(new Set(ctx.feature.verificationHistory.map(evidenceKey)).size, ctx.feature.verificationHistory.length)
  assert.equal(ctx.feature.verificationChecks.length, 1); assert.equal(ctx.feature.verificationChecks[0].code, 0)
  assert.equal(ctx.feature.results[0].status, 'passed')
  saveArtifact('R3', { phases, history: ctx.feature.verificationHistory, checks: ctx.feature.verificationChecks, stage: ctx.feature.stage, repairRound: ctx.feature.repairRound })
})

test('R4', 'same-connection handoff renews manifest while retaining fingerprint on resume', async () => {
  const ctx = setup()
  await firstPaused(ctx, 'r4-first')
  const before = structuredClone(snapshot(ctx)), fingerprint = ctx.service.executionFingerprint(ctx.project, ctx.feature)
  ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'migrate' })
  const handoff = structuredClone(snapshot(ctx))
  assert.notEqual(handoff.manifest.id, before.manifest.id); assert.equal(handoff.fingerprint, before.fingerprint)
  assert.equal(typeof before.executionRunId, 'string'); assert.equal(handoff.executionRunId, before.executionRunId)
  assert.equal(ctx.service.executionFingerprint(ctx.project, ctx.feature), fingerprint)
  const previousRequests = ctx.feature.contextRuntime.requests.length
  let requests = 0
  await scripted(async () => {
    requests++; assert.equal(snapshot(ctx).manifest.id, handoff.manifest.id)
    return pause()
  }, () => run(ctx.service))
  const resumed = snapshot(ctx)
  assert.equal(requests, 1); assert.equal(ctx.feature.contextRuntime.requests.length, previousRequests + 1)
  assert.equal(ctx.feature.contextRuntime.requests.at(-1).status, 'completed')
  assert.equal(ctx.feature.contextRuntime.requests.at(-1).manifestId, handoff.manifest.id)
  assert.equal(ctx.feature.contextRuntime.status, 'paused'); assert.equal(resumed.manifest.id, handoff.manifest.id)
  assert.equal(resumed.fingerprint, before.fingerprint); assert.equal(ctx.service.executionFingerprint(ctx.project, ctx.feature), fingerprint)
  assert.deepEqual(resumed.commands, before.commands)
  assert.equal(resumed.executionRunId, before.executionRunId)
  assert.equal(ctx.project.agentRuns.at(-1).executionRunId, before.executionRunId)
  saveArtifact('R4', { before, handoff, resumed, fingerprint })
})

test('R5', 'legacy checkpoint without run identity resumes without rewriting old command evidence', async () => {
  const ctx = setup()
  await firstPaused(ctx, 'r5-first')
  const before = structuredClone(snapshot(ctx))
  delete snapshot(ctx).executionRunId; ctx.service.store.save()
  // JSON persistence omits undefined optional fields; compare the durable record.
  const prior = JSON.parse(fs.readFileSync(ctx.service.store.path, 'utf8')).executionCheckpoints[key].commands
  const restored = new EngineeringService()
  ctx.service = restored; ctx.project = restored.store.project('p'); ctx.feature = ctx.project.features[0]
  assert.equal(Object.hasOwn(snapshot(ctx), 'executionRunId'), false)
  const legacyCheckpoint = snapshot(ctx), save = restored.store.save
  let requests = 0, firstSaved
  restored.store.save = function (...args) {
    const result = save.apply(this, args)
    if (!firstSaved && this.data.executionCheckpoints[key] !== legacyCheckpoint)
      firstSaved = JSON.parse(fs.readFileSync(this.path, 'utf8')).executionCheckpoints[key]
    return result
  }
  try {
    await scripted(async (_connection, system, messages) => {
      if (++requests === 1) {
        assert.ok(firstSaved, 'the first replacement checkpoint is already durable before inference')
        assert.equal(typeof firstSaved.executionRunId, 'string')
        assertProjection(projection(system), prior)
        assert.ok(messages.some(message => message.role === 'tool' && message.content.includes('IDENTITY_COMMAND')), 'old tool result survives disk resume')
        return command('r5-second')
      }
      return pause()
    }, () => run(ctx.service))
  } finally { restored.store.save = save }
  const after = snapshot(ctx)
  assert.equal(requests, 2); assert.equal(after.fingerprint, before.fingerprint)
  assert.deepEqual(after.commands.map(command => command.id), ['check-1', 'check-2'])
  assert.deepEqual(after.commands[0], prior[0], 'all prior command identity fields remain unchanged')
  assert.equal(new Set(after.commands.map(evidenceKey)).size, after.commands.length)
  assert.match(firstSaved.executionRunId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)
  assert.notEqual(firstSaved.executionRunId, before.executionRunId, 'a legacy checkpoint gets a fresh run identity')
  assert.equal(firstSaved.fingerprint, before.fingerprint); assert.equal(after.executionRunId, firstSaved.executionRunId)
  assert.equal(after.commands[1].executionRunId, after.executionRunId)
  assert.equal(ctx.project.agentRuns.at(-1).executionRunId, after.executionRunId)
  saveArtifact('R5', { before, firstSaved, after, restoredFromDisk: true })
})

test('R6', 'planning, assistant and discussion currently omit run identity from requests and events', async () => {
  const entries = []
  for (const entry of ['planning', 'assistant', 'discussion']) {
    const ctx = fixture(); let owner, requests = 0, eventsBefore
    await scripted(async () => { requests++; return entry === 'planning' ? answer({ plan: '隔离规划方案', tasks: ['确认后执行'] }) : { text: '隔离入口回复', calls: [] } }, async () => {
      if (entry === 'planning') { ctx.feature.stage = 'solution'; owner = ctx.feature; ctx.service.generatePlan('p', 'f'); await settle(ctx) }
      if (entry === 'assistant') {
        ctx.service.setDefaultAssistantModel('fixture')
        const id = ctx.service.createAssistantSession('p').id
        owner = ctx.service.store.data.assistant.sessions.find(session => session.id === id)
        eventsBefore = structuredClone(ctx.project.events)
        await ctx.service.sendAssistantMessage('隔离消息', undefined, id)
        assert.equal(owner.messages.at(-1).status, 'complete'); assert.deepEqual(ctx.project.events, eventsBefore, 'assistant does not emit project activity events')
      }
      if (entry === 'discussion') { ctx.project.discussionModelId = 'fixture'; owner = ctx.project; ctx.service.discuss('p', '隔离需求讨论'); await settle(ctx) }
    })
    assert.equal(requests, 1); assert.equal(owner.contextRuntime.requests.length, 1)
    if (entry !== 'discussion') assert.equal(owner.contextRuntime.status, 'completed')
    assert.equal(owner.contextRuntime.requests[0].status, 'completed')
    if (entry === 'discussion') assert.equal(ctx.project.chat.at(-1).status, 'complete')
    // A6 flips these assertions and adds same-turn/new-turn continuity cases.
    for (const record of owner.contextRuntime.requests) assert.equal(Object.hasOwn(record, 'executionRunId'), false, entry + ' request currently has no run id')
    for (const event of ctx.project.events) assert.equal(Object.hasOwn(event, 'executionRunId'), false, entry + ' event currently has no run id')
    if (entry !== 'assistant') assert.ok(ctx.project.events.length, entry + ' actually emitted activity events')
    entries.push({ entry, requests: owner.contextRuntime.requests, events: ctx.project.events, status: owner.contextRuntime.status })
  }
  saveArtifact('R6', entries)
})

test('R7', 'real model transport calls traffic start with two arguments and tolerates recorder failure', async () => {
  const arms = []
  for (const throws of [false, true]) {
    const ctx = setup(), captured = [], finishes = [], originalTraffic = ctx.service.traffic, originalComplete = model.complete
    const server = await provider(() => finish())
    try {
      model.complete = complete; ctx.service.store.data.models[0].baseUrl = server.url
      ctx.service.traffic = { start(...args) {
        captured.push({ count: args.length, connection: { id: args[0].id, model: args[0].model, protocol: args[0].protocol }, purpose: args[1], ref: args[2] })
        if (throws) throw new Error('isolated traffic failure')
        return { observe() {}, finish(status) { finishes.push(status) } }
      } }
      const result = await ctx.service.agentLoop(ctx.project, ctx.feature, ctx.service.executionAgent(ctx.feature, 'developer', 'p'), '', new AbortController().signal, { role: 'developer' })
      assert.equal(JSON.parse(result.text).status, 'complete'); assert.equal(ctx.feature.contextRuntime.status, 'completed')
      assert.equal(server.requests.length, 1); assert.deepEqual(server.errors, []); assert.equal(captured.length, 1)
      // A7 flips this to referenced inference/auxiliary traffic records.
      assert.equal(captured[0].count, 2); assert.equal(captured[0].purpose, 'inference'); assert.equal(captured[0].connection.id, 'fixture')
      assert.deepEqual(finishes, throws ? [] : ['succeeded'])
      assert.equal(ctx.feature.contextRuntime.requests.length, 1); assert.equal(ctx.feature.contextRuntime.requests[0].status, 'completed')
      arms.push({ throws, captured, finishes, status: ctx.feature.contextRuntime.status, requests: ctx.feature.contextRuntime.requests })
    } finally { ctx.service.traffic = originalTraffic; model.complete = originalComplete; await server.close() }
  }
  saveArtifact('R7', arms)
})

test('R8', 'R1 and R2 counted durable saves remain fixed across identity work packages', async () => {
  assert.ok(counters.R1 && counters.R2, 'R8 requires the measured R1 and R2 runs')
  const counted = { R1: counters.R1.counted, R2First: counters.R2.first.counted, R2Total: counters.R2.total.counted }
  console.log('COUNTED:', JSON.stringify(counted))
  // Counts are filled from the unchanged A0 product source, then held through A1-A8.
  const expected = { R1: 40, R2First: 29, R2Total: 59 }
  saveArtifact('R8', { expected, counted, actual: counters })
  assert.deepEqual(counted, expected)
})

async function main() {
  fs.mkdirSync(output, { recursive: true })
  const started = performance.now()
  for (const { id, name, work } of cases) {
    try { await work(); results.push({ id, name, status: 'passed' }); console.log(`PASS ${id}: ${name}`) }
    catch (error) { results.push({ id, name, status: 'failed', error: error.stack }); console.error(`FAIL ${id}: ${error.stack}`) }
    saveArtifact('results', results)
  }
  console.log(`${results.filter(result => result.status === 'passed').length}/${results.length} cases passed in ${((performance.now() - started) / 1000).toFixed(2)}s`)
  assert.ok(results.every(result => result.status === 'passed'))
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(() => {
  model.complete = complete
  const resolved = path.resolve(sandbox), temporaryRoot = path.resolve(require('node:os').tmpdir()) + path.sep
  assert.ok(resolved.startsWith(temporaryRoot + 'coprojer-preparation-'))
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 })
})
