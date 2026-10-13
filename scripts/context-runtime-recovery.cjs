const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, sandbox, fixture, model, answer, call, run, load, EngineeringService } = r
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const files = load('src/main/engineering/files.ts'), actualTool = files.executeTool, actualComplete = model.complete
const output = path.resolve('.runtime/context-runtime/m4-recovery'); fs.mkdirSync(output, { recursive: true })
const tests = [], results = [], test = (name, fn) => tests.push({ name, fn })
const receipts = service => Object.values(service.store.data.receiptJournals?.[JSON.stringify(['p', 'f'])]?.receipts ?? {})
function reliable() { const ctx = fixture(); ctx.feature.runtimePolicy = 'receipts-readonly-v1'; ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('isolated-new-task'); ctx.service.store.save(); return ctx }
test('durable readonly group survives cancellation/restart; completed identity reused and same arguments new identity executes', async () => {
  const ctx = reliable(); let executions = 0, stopped = false
  files.executeTool = async (...args) => { executions++; return actualTool(...args) }
  const server = await provider((_req, n) => n === 1 ? { text: '', calls: [call('read_file', { path: 'value.cjs' }).calls[0], call('read_file', { path: 'value.cjs' }).calls[0]] }
    : answer({ status: 'incomplete', summary: '两次读取均已返回', nextStep: '人工核对' }))
  const save = ctx.service.store.save.bind(ctx.service.store)
  ctx.service.store.save = () => { save(); if (!stopped && receipts(ctx.service).some(r => r.status === 'completed')) { stopped = true; ctx.service.stop('p') } }
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    await run(ctx.service); assert.equal(executions, 1); assert.equal(server.requests.length, 1)
    const checkpoint = Object.values(ctx.service.store.data.executionCheckpoints)[0]
    assert.equal(checkpoint.version, 4); assert.equal(checkpoint.continuity.version, 1); assert.equal(checkpoint.pending.logicalIds.length, 2); assert.ok(!checkpoint.messages.some(m => m.calls?.length))
    const resumed = new EngineeringService(); await run(resumed)
    assert.equal(executions, 2); assert.equal(server.requests.length, 2); assert.equal(receipts(resumed).length, 2)
    assert.ok(receipts(resumed).every(r => r.status === 'completed' && r.attempts === 1))
    const wire = server.requests[1].body.messages, calls = wire.flatMap(m => m.tool_calls ?? []), replies = wire.filter(m => m.role === 'tool')
    assert.equal(calls.length, 2); assert.deepEqual(replies.map(r => r.tool_call_id), calls.map(c => c.id))
    assert.equal(resumed.store.project('p').features[0].stage, 'blocked'); assert.ok(!resumed.state().receiptJournals)
    fs.writeFileSync(path.join(output, 'readonly-restart.json'), JSON.stringify({ executions, requests: server.requests, receipts: receipts(resumed), checkpoint }, null, 2))
  } finally { await server.close(); files.executeTool = actualTool }
})
for (const boundary of ['group', 'intent', 'result']) test('reliable ' + boundary + ' save failure stops new actions and preserves recovery', async () => {
  const ctx = reliable(); let executions = 0, injected = false
  files.executeTool = async (...args) => { executions++; return actualTool(...args) }
  const server = await provider(() => ({ text: '', calls: [call('read_file', { path: 'value.cjs' }).calls[0], call('list_files', {}).calls[0]] }))
  const save = ctx.service.store.save.bind(ctx.service.store)
  ctx.service.store.save = () => {
    const records = receipts(ctx.service), pending = Object.values(ctx.service.store.data.executionCheckpoints ?? {})[0]?.pending
    if (!injected && (boundary === 'group' ? pending : boundary === 'intent' ? records.some(r => r.status === 'prepared') : records.some(r => r.status === 'completed'))) {
      injected = true; throw new Error('injected ' + boundary + ' write failure')
    }
    save()
  }
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    await run(ctx.service); assert.equal(injected, true); assert.equal(executions, boundary === 'result' ? 1 : 0); assert.equal(server.requests.length, 1)
    assert.equal(ctx.feature.stage, 'blocked'); assert.match(ctx.feature.contextRuntime.reason, /保存失败/)
    const disk = JSON.parse(fs.readFileSync(ctx.service.store.path)); assert.ok(disk.executionCheckpoints[JSON.stringify(['p', 'f'])])
    if (boundary === 'result') assert.equal(Object.values(disk.receiptJournals[JSON.stringify(['p', 'f'])].receipts)[0].status, 'running')
  } finally { await server.close(); files.executeTool = actualTool }
})
test('unsupported effects cannot fall through to legacy executor in a readonly receipt run', async () => {
  const ctx = reliable(), server = await provider(() => call('write_file', { path: 'no.txt', content: 'no' }))
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.equal(fs.existsSync(path.join(ctx.root, 'no.txt')), false); assert.equal(server.requests.length, 1); assert.match(ctx.feature.contextRuntime.reason, /尚未启用/)
  } finally { await server.close() }
})
test('two consecutive interruptions retain complete history prefix and execute each of three reads exactly once', async () => {
  const ctx = reliable(); let executions = 0
  files.executeTool = async (...args) => { executions++; return actualTool(...args) }
  const server = await provider((_req, n) => n === 1 ? { text: '', calls: Array.from({ length: 3 }, () => call('read_file', { path: 'value.cjs' }).calls[0]) }
    : answer({ status: 'incomplete', summary: '读取完成', nextStep: '继续' }))
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; ctx.service.store.save()
    for (let i = 1; i <= 3; i++) {
      const service = i === 1 ? ctx.service : new EngineeringService(), save = service.store.save.bind(service.store); let stopped = false
      if (i < 3) service.store.save = () => { save(); if (!stopped && receipts(service).filter(r => r.status === 'completed').length === i) { stopped = true; service.stop('p') } }
      await run(service); assert.equal(executions, i)
      const disk = JSON.parse(fs.readFileSync(service.store.path)), checkpoint = disk.executionCheckpoints[JSON.stringify(['p', 'f'])]
      if (i < 3) { assert.ok(checkpoint.pending); assert.ok(!checkpoint.messages.some(m => m.calls?.length)) }
      else { assert.equal(checkpoint.pending, undefined); assert.equal(receipts(service).length, 3) }
    }
    assert.equal(server.requests.length, 2)
  } finally { await server.close(); files.executeTool = actualTool }
})
for (const field of ['schemaVersion', 'groupId', 'role']) test('tampered receipt ' + field + ' cannot be replayed', async () => {
  const ctx = reliable(); let stopped = false, executions = 0
  files.executeTool = async (...args) => { executions++; return actualTool(...args) }
  const server = await provider(() => ({ text: '', calls: [call('read_file', { path: 'value.cjs' }).calls[0], call('list_files', {}).calls[0]] }))
  const save = ctx.service.store.save.bind(ctx.service.store)
  ctx.service.store.save = () => { save(); if (!stopped && receipts(ctx.service).some(r => r.status === 'completed')) { stopped = true; ctx.service.stop('p') } }
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    const restored = new EngineeringService(); receipts(restored)[0][field] = 'unknown'; restored.store.save(); assert.throws(() => restored.runFeature('p', 'f'), /不一致|不完整/)
    assert.equal(executions, 1); assert.equal(server.requests.length, 1); assert.equal(restored.store.project('p').features[0].contextRuntime.status, 'recovery_required')
  } finally { await server.close(); files.executeTool = actualTool }
})
test('malformed journal object stays preserved and cannot dispatch pending calls', async () => {
  const ctx = reliable(); let stopped = false, executions = 0
  files.executeTool = async (...args) => { executions++; return actualTool(...args) }
  const server = await provider(() => ({ text: '', calls: [call('read_file', { path: 'value.cjs' }).calls[0], call('list_files', {}).calls[0]] }))
  const save = ctx.service.store.save.bind(ctx.service.store)
  ctx.service.store.save = () => { save(); if (!stopped && receipts(ctx.service).some(r => r.status === 'completed')) { stopped = true; ctx.service.stop('p') } }
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    const restored = new EngineeringService(); restored.store.data.receiptJournals[JSON.stringify(['p', 'f'])].receipts = []; restored.store.save(); assert.throws(() => restored.runFeature('p', 'f'), /账本损坏/)
    assert.equal(executions, 1); assert.equal(server.requests.length, 1); assert.match(restored.store.project('p').features[0].contextRuntime.reason, /账本损坏/)
    assert.deepEqual(JSON.parse(fs.readFileSync(restored.store.path)).receiptJournals[JSON.stringify(['p', 'f'])].receipts, [])
  } finally { await server.close(); files.executeTool = actualTool }
})
test('prototype coverage is rebuilt from a durable read receipt without rereading', async () => {
  const ctx = reliable(); ctx.feature.prototypeId = 'prototype'; ctx.project.prototypes.push({ id: 'prototype', title: '短原型', html: '<h1>approved</h1>', at: new Date().toISOString() }); let stopped = false, reads = 0
  files.executeTool = async (...args) => { if (args[4] === 'read_context') reads++; return actualTool(...args) }
  const server = await provider(req => req.system.includes('你是 Coprojer 的开发智能体') ? req.body.messages.some(m => m.role === 'tool')
    ? answer({ status: 'complete', summary: '原型已读', nextStep: '独立验证' }) : call('read_context', { id: 'prototype:prototype' }) : { httpStatus: 503, error: { message: 'intentional stop at independent reviewer' } })
  const save = ctx.service.store.save.bind(ctx.service.store)
  ctx.service.store.save = () => { save(); if (!stopped && receipts(ctx.service).some(r => r.status === 'completed')) { stopped = true; ctx.service.stop('p') } }
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    const restored = new EngineeringService(); await run(restored)
    assert.equal(reads, 1); assert.equal(server.requests.length, 3); assert.ok(server.requests[2].system.includes('你是 Coprojer 的验证智能体'))
    assert.ok(!restored.store.project('p').events.some(e => e.message.includes('未完整读取已验收原型')))
  } finally { await server.close(); files.executeTool = actualTool }
})
test('tool/request budgets survive continuation and restart; explicit user total adjustment is audited', async () => {
  const ctx = reliable(); ctx.feature.runtimeBudget.limits = { requests: 1, tools: 1, activeMs: 60000 }; let executions = 0
  files.executeTool = async (...args) => { executions++; return actualTool(...args) }
  const server = await provider((_req, n) => n === 1 ? { text: '', calls: [call('read_file', { path: 'value.cjs' }).calls[0], call('list_files', {}).calls[0]] }
    : answer({ status: 'incomplete', summary: '额度内完成', nextStep: '核对' }))
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.equal(executions, 1); assert.equal(server.requests.length, 1); assert.equal(ctx.feature.runtimeBudget.used.tools, 1); assert.equal(ctx.feature.contextRuntime.status, 'paused')
    const restored = new EngineeringService(); await run(restored); assert.equal(executions, 1); assert.equal(server.requests.length, 1)
    restored.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { requests: 2, tools: 2, activeMs: 60000 }, '本机用户明确增加本任务额度')
    await run(restored); const budget = restored.store.project('p').features[0].runtimeBudget
    assert.equal(executions, 2); assert.equal(server.requests.length, 2); assert.equal(budget.used.requests, 2); assert.equal(budget.used.tools, 2)
    assert.equal(budget.adjustments.at(-1).source, 'local-user'); assert.equal(budget.adjustments.at(-1).before.requests, 1)
    assert.throws(() => restored.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { requests: 1, tools: 2, activeMs: 60000 }, 'too low'), /不得小于/)
    fs.writeFileSync(path.join(output, 'budget-restart.json'), JSON.stringify({ budget, requests: server.requests.length, executions, receipts: receipts(restored) }, null, 2))
  } finally { await server.close(); files.executeTool = actualTool }
})
test('unknown history cannot be set to zero or run before a finite user grant', async () => {
  const ctx = reliable(); delete ctx.feature.runtimeBudget
  const server = await provider(() => answer({ status: 'incomplete', summary: '保留', nextStep: '核对' }))
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.equal(server.requests.length, 0); assert.equal(ctx.feature.runtimeBudget.limits, null); assert.equal(ctx.feature.runtimeBudget.historical.kind, 'unknown')
    ctx.service.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { requests: 1, tools: 0, activeMs: 60000 }, '为历史未知任务明确授予后续一次请求')
    await run(ctx.service); assert.equal(server.requests.length, 1); assert.equal(ctx.feature.runtimeBudget.used.requests, 1); assert.equal(ctx.feature.runtimeBudget.historical.kind, 'unknown')
  } finally { await server.close() }
})
test('budget reservation write failure starts no HTTP request', async () => {
  const ctx = reliable(); let injected = false
  const write = fs.writeFileSync, server = await provider(() => answer({ status: 'incomplete', summary: '不应发送', nextStep: '' }))
  fs.writeFileSync = (target, content, ...rest) => { if (!injected && target === ctx.service.store.path + '.tmp' && ctx.feature.runtimeBudget.used.requests === 1) { injected = true; throw new Error('budget durable write failed') } return write(target, content, ...rest) }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.ok(injected); assert.equal(server.requests.length, 0); assert.equal(ctx.feature.runtimeBudget.used.requests, 0); assert.match(ctx.feature.contextRuntime.reason, /累计额度保存失败/)
  } finally { fs.writeFileSync = write; await server.close() }
})
test('cumulative activity timeout cancels an actual HTTP request and prevents any tool queue', async () => {
  const ctx = reliable(); ctx.feature.runtimeBudget.limits.activeMs = 180; let release
  const server = await provider(async () => { await new Promise(r => { release = r }); return call('list_files', {}) })
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; const start = Date.now(); await run(ctx.service)
    assert.equal(server.requests.length, 1); assert.equal(receipts(ctx.service).length, 0); assert.equal(ctx.feature.runtimeBudget.used.requests, 1)
    assert.ok(ctx.feature.runtimeBudget.used.activeMs >= 180); assert.match(ctx.feature.contextRuntime.reason, /活动时间/); assert.ok(Date.now() - start < 3000)
  } finally { release?.(); await server.close() }
})
test('report repair counts every actual model request independently', async () => {
  const ctx = reliable(); ctx.feature.runtimeBudget.limits.requests = 1
  const server = await provider(() => ({ text: '尚未按规定提供结构化报告', calls: [] }))
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.equal(server.requests.length, 1); assert.equal(ctx.feature.runtimeBudget.used.requests, 1); assert.match(ctx.feature.contextRuntime.reason, /累计模型请求额度/)
  } finally { await server.close() }
})
test('clock rollback cannot refund old time and delayed reservation cannot start HTTP after expiry', async () => {
  const ctx = reliable(); ctx.feature.runtimeBudget.used.activeMs = 5000
  const originalClock = Date.now, server = await provider(() => { Date.now = () => originalClock() - 60000; return answer({ status: 'incomplete', summary: '返回', nextStep: '核对' }) })
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service); assert.ok(ctx.feature.runtimeBudget.used.activeMs >= 5000) }
  finally { Date.now = originalClock; await server.close() }
  // Leave room for prompt/checkpoint preparation; expire deliberately inside the
  // reservation save, rather than racing an 80ms whole-host startup deadline.
  const late = reliable(); late.feature.runtimeBudget.limits.activeMs = 1000; const slow = await provider(() => answer({ status: 'incomplete', summary: '不得发送', nextStep: '' }))
  const save = late.service.store.save.bind(late.service.store); let delayed = false
  late.service.store.save = () => { save(); if (!delayed && late.feature.runtimeBudget.used.requests === 1) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200) } }
  try { model.complete = actualComplete; late.service.store.data.models[0].baseUrl = slow.url; await run(late.service)
    assert.ok(delayed); assert.equal(slow.requests.length, 0); assert.ok(late.feature.runtimeBudget.used.activeMs >= 1200); assert.match(late.feature.contextRuntime.reason, /预占已到期/)
  } finally { await slow.close() }
})
for (const boundary of ['effect', 'result', 'projection']) test('file ' + boundary + ' interruption recovers hashes and business projection without rewriting', async () => {
  const ctx = reliable(); ctx.feature.runtimePolicy = 'receipts-effects-v1'; const original = fs.readFileSync(path.join(ctx.root, 'value.cjs'), 'utf8'), replacement = 'exports.sum = (a,b) => a+b; // effect receipt'
  const write = fs.writeFileSync; let injected = false, writes = 0
  fs.writeFileSync = (target, content, ...rest) => {
    if (target === path.join(ctx.root, 'value.cjs')) { writes++; write(target, content, ...rest); if (boundary === 'effect' && !injected) { injected = true; throw new Error('effect happened before acknowledgement') } return }
    const record = receipts(ctx.service).find(r => r.tool === 'write_file')
    if (!injected && target === ctx.service.store.path + '.tmp' && record && (boundary === 'result' ? record.status === 'completed' : boundary === 'projection' && record.applied && ctx.project.changes.length)) { injected = true; throw new Error('durable ' + boundary + ' failed') }
    return write(target, content, ...rest)
  }
  const server = await provider((_req, n) => n === 1 ? { text: '', calls: [call('write_file', { path: 'value.cjs', content: replacement }).calls[0], call('list_files', {}).calls[0]] }
    : answer({ status: 'incomplete', summary: '已核对文件', nextStep: '后续人工确认' }))
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.ok(injected); assert.equal(writes, 1); assert.equal(server.requests.length, 1); assert.equal(fs.readFileSync(path.join(ctx.root, 'value.cjs'), 'utf8'), replacement)
    const restored = new EngineeringService(); await run(restored); restored.reconcileRuntime('p', 'f'); restored.reconcileRuntime('p', 'f')
    assert.equal(writes, 1); assert.equal(server.requests.length, 2); const project = restored.store.project('p'), change = project.changes.find(c => c.path === 'value.cjs')
    assert.equal(change.before, original); assert.equal(change.after, replacement); assert.equal(project.changes.length, 1)
    assert.equal(receipts(restored).find(r => r.tool === 'write_file').status, 'completed'); assert.equal(receipts(restored).find(r => r.tool === 'write_file').applied, true)
    assert.equal(project.features[0].stage, 'blocked')
    fs.writeFileSync(path.join(output, 'file-' + boundary + '.json'), JSON.stringify({ writes, requests: server.requests.length, changes: project.changes, receipts: receipts(restored) }, null, 2))
  } finally { fs.writeFileSync = write; await server.close() }
})
test('same-argument new file identity executes while interrupted completed identity is reused', async () => {
  const ctx = reliable(); ctx.feature.runtimePolicy = 'receipts-effects-v1'; const write = fs.writeFileSync; let writes = 0, interrupted = false
  const args = { path: 'value.cjs', content: 'same replacement' }, server = await provider((_req, n) => n === 1 ? { text: '', calls: [call('write_file', args).calls[0], call('write_file', args).calls[0]] } : answer({ status: 'incomplete', summary: '分别记录', nextStep: '人工核对' }))
  fs.writeFileSync = (target, content, ...rest) => {
    if (target === path.join(ctx.root, 'value.cjs')) writes++
    if (!interrupted && target === ctx.service.store.path + '.tmp' && receipts(ctx.service).some(r => r.status === 'completed')) { interrupted = true; throw new Error('file result save interrupted') }
    return write(target, content, ...rest)
  }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service); assert.ok(interrupted); assert.equal(writes, 1)
    const restored = new EngineeringService(); await run(restored); restored.reconcileRuntime('p', 'f'); assert.equal(writes, 2); assert.equal(server.requests.length, 2)
    const records = receipts(restored); assert.equal(records.length, 2); assert.notEqual(records[0].logicalId, records[1].logicalId); assert.ok(records.every(r => r.attempts === 1 && r.status === 'completed' && r.applied))
    assert.deepEqual(records[0].args, records[1].args); assert.equal(restored.store.project('p').changes.length, 1)
    fs.writeFileSync(path.join(output, 'file-new-identity.json'), JSON.stringify({ writes, records, requests: server.requests.length }, null, 2))
  } finally { fs.writeFileSync = write; await server.close() }
})
for (const failRenewal of [false, true]) test('delayed reservation renews remaining allowance reliably; save failure ' + failRenewal, async () => {
  const ctx = reliable(); ctx.feature.runtimeBudget.limits.activeMs = 10000; let delayed = false, renewalFailed = false
  const save = ctx.service.store.save.bind(ctx.service.store), server = await provider((_req, n) => n === 1 ? call('read_file', { path: 'value.cjs' }) : answer({ status: 'incomplete', summary: '有限时间内继续', nextStep: '人工核对' }))
  ctx.service.store.save = () => {
    if (failRenewal && delayed && !renewalFailed && ctx.feature.runtimeBudget.activeLease?.reservedMs > 1000) { renewalFailed = true; throw new Error('time renewal save failed') }
    save(); if (!delayed && ctx.feature.runtimeBudget.used.requests === 2) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1250) }
  }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.ok(delayed); assert.equal(server.requests.length, failRenewal ? 1 : 2, ctx.feature.contextRuntime.reason); assert.equal(ctx.feature.runtimeBudget.used.requests, 2)
    assert.ok(ctx.feature.runtimeBudget.used.activeMs >= 1250); assert.equal(renewalFailed, failRenewal)
    if (failRenewal) assert.match(ctx.feature.contextRuntime.reason, /保存失败/)
    else assert.ok(!/时间.*到期|时间.*用完/.test(ctx.feature.contextRuntime.reason ?? ''))
  } finally { await server.close() }
})
test('unprovable file effect stays uncertain, old revision only enters history, and no queued effect starts', async () => {
  const ctx = reliable(); ctx.feature.runtimePolicy = 'receipts-effects-v1'; const replacement = 'exports.value = 2', write = fs.writeFileSync; let interrupted = false, writes = 0
  fs.writeFileSync = (target, content, ...rest) => { if (target === path.join(ctx.root, 'value.cjs')) { writes++; write(target, content, ...rest); if (!interrupted) { interrupted = true; throw new Error('lost result') } return } return write(target, content, ...rest) }
  const server = await provider(() => ({ text: '', calls: [call('write_file', { path: 'value.cjs', content: replacement }).calls[0], call('write_file', { path: 'queued.txt', content: 'no' }).calls[0]] }))
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    write(path.join(ctx.root, 'value.cjs'), 'external conflict')
    const restored = new EngineeringService(); assert.throws(() => restored.runFeature('p', 'f'), /不一致/); assert.equal(writes, 1); assert.equal(server.requests.length, 1)
    assert.equal(receipts(restored)[0].status, 'uncertain'); assert.equal(fs.existsSync(path.join(ctx.root, 'queued.txt')), false)
    write(path.join(ctx.root, 'value.cjs'), replacement); restored.store.project('p').features[0].revision++; restored.store.save()
    restored.reconcileRuntime('p', 'f'); assert.equal(receipts(restored)[0].status, 'completed'); assert.equal(restored.store.project('p').changes.length, 0)
    assert.match(receipts(restored)[0].reason, /旧修订/); assert.throws(() => restored.runFeature('p', 'f'), /显式迁移/); assert.equal(server.requests.length, 1)
  } finally { fs.writeFileSync = write; await server.close() }
})
for (const target of ['b.txt', '.runtime/b.txt', 'B.TXT', 'trace.log']) test('external changes to queued ' + target + ' are preserved after the first write changes source', async () => {
  const ctx = reliable(); ctx.feature.runtimePolicy = 'receipts-effects-v1'; fs.mkdirSync(path.join(ctx.root, '.runtime'), { recursive: true }); fs.writeFileSync(path.join(ctx.root, target), 'old B'); let interrupted = false
  const write = fs.writeFileSync, server = await provider(() => ({ text: '', calls: [call('write_file', { path: 'value.cjs', content: 'A changed' }).calls[0], call('write_file', { path: target.toLowerCase(), content: 'model old B' }).calls[0]] }))
  fs.writeFileSync = (target, content, ...rest) => { write(target, content, ...rest); if (!interrupted && target === path.join(ctx.root, 'value.cjs')) { interrupted = true; throw new Error('lost after A') } }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    write(path.join(ctx.root, target), 'external new B'); const restored = new EngineeringService()
    assert.throws(() => restored.runFeature('p', 'f'), /记录效果之外的修改/); assert.equal(fs.readFileSync(path.join(ctx.root, target), 'utf8'), 'external new B')
    assert.equal(server.requests.length, 1); assert.equal(receipts(restored).length, 1); assert.equal(restored.store.project('p').changes.length, 1)
  } finally { fs.writeFileSync = write; await server.close() }
})
for (const policy of ['legacy', undefined]) test('pending reliable effects reject policy downgrade to ' + policy, async () => {
  const ctx = reliable(); ctx.feature.runtimePolicy = 'receipts-effects-v1'; let interrupted = false
  const write = fs.writeFileSync, server = await provider(() => ({ text: '', calls: [call('write_file', { path: 'value.cjs', content: 'A changed' }).calls[0], call('write_file', { path: 'never.txt', content: 'no' }).calls[0]] }))
  fs.writeFileSync = (target, content, ...rest) => { write(target, content, ...rest); if (!interrupted && target === path.join(ctx.root, 'value.cjs')) { interrupted = true; throw new Error('lost after effect') } }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service); fs.writeFileSync = write; assert.ok(interrupted)
    const restored = new EngineeringService(); restored.store.project('p').features[0].runtimePolicy = policy; restored.store.save()
    assert.throws(() => restored.runFeature('p', 'f'), { name: 'RecoveryRequired', message: /已有可靠(回执|执行断点).*不能.*(降级|切回旧策略)/ }); assert.equal(server.requests.length, 1); assert.equal(fs.existsSync(path.join(ctx.root, 'never.txt')), false)
  } finally { fs.writeFileSync = write; await server.close() }
})
for (const field of ['schemaVersion', 'path']) test('corrupt completed file receipt ' + field + ' cannot mutate business projection', async () => {
  const ctx = reliable(); ctx.feature.runtimePolicy = 'receipts-effects-v1'; let interrupted = false
  const save = ctx.service.store.save.bind(ctx.service.store), server = await provider(() => call('write_file', { path: 'value.cjs', content: 'known new value' }))
  ctx.service.store.save = () => { if (!interrupted && receipts(ctx.service).some(r => r.applied)) { interrupted = true; throw new Error('projection write failed') } save() }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service); assert.equal(ctx.project.changes.length, 0)
    const restored = new EngineeringService(), receipt = receipts(restored)[0]; assert.equal(receipt.status, 'completed'); assert.equal(receipt.applied, false)
    if (field === 'path') receipt.file.path = 'other.txt'; else receipt.schemaVersion = 'unknown'
    restored.store.save(); const original = JSON.stringify(receipt)
    assert.throws(() => restored.reconcileRuntime('p', 'f'), /不一致|不完整/)
    assert.equal(restored.store.project('p').changes.length, 0); assert.equal(JSON.stringify(receipts(restored)[0]), original); assert.equal(server.requests.length, 1)
  } finally { await server.close() }
})
test('failed time settlement retains a durable lease and is reconciled before the next request', async () => {
  const ctx = reliable(); ctx.feature.runtimeBudget.limits.activeMs = 5000; let delayed = false, injected = false
  const write = fs.writeFileSync, server = await provider(() => { if (!delayed) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1250) } return answer({ status: 'incomplete', summary: '收尾', nextStep: '检查' }) })
  fs.writeFileSync = (target, content, ...rest) => {
    if (!injected && target === ctx.service.store.path + '.tmp' && !ctx.feature.runtimeBudget.activeLease && ctx.feature.runtimeBudget.used.activeMs >= 1250) { injected = true; throw new Error('settlement save failed') }
    return write(target, content, ...rest)
  }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.ok(injected); assert.ok(ctx.feature.runtimeBudget.activeLease); const restored = new EngineeringService(); await run(restored)
    const budget = restored.store.project('p').features[0].runtimeBudget; assert.ok(budget.used.activeMs >= 1250); assert.equal(budget.activeLease, undefined); assert.equal(server.requests.length, 2)
  } finally { fs.writeFileSync = write; await server.close() }
})
for (const boundary of ['effect', 'result', 'projection']) test('preparer ' + boundary + ' interruption resumes once, registers created/action once, then hands to independent reviewer', async () => {
  const ctx = reliable(); ctx.feature.runtimePolicy = 'receipts-effects-v1'; let active = ctx.service, injected = false, writes = 0, reviews = 0
  const code = "require('node:assert/strict').equal(require('../value.cjs').sum(2,3),5)", write = fs.writeFileSync
  const server = await provider(req => {
    if (req.system.includes('VERIFICATION_DIAGNOSIS')) return answer({ gaps: active.store.project('p').features[0].verificationPreparation.gaps.map(g => ({ id: g.id, disposition: 'automatic', reason: '需要项目内实际检查脚本', nextStep: '新增补充检查脚本' })) })
    if (req.system.includes('VERIFICATION_PREPARATION')) return req.body.messages.some(m => m.role === 'tool') ? answer({ status: 'ready', summary: '检查脚本已登记', nextStep: '交独立验证运行' })
      : call('write_file', { path: 'tests/verify.cjs', content: code })
    if (req.system.includes('你是 Coprojer 的开发智能体')) return answer({ status: 'complete', summary: '原实现已交付', nextStep: '独立验证' })
    reviews++
    return reviews === 1 ? answer({ summary: '缺少可执行脚本', results: [{ criterion: ctx.feature.criteria[0], passed: false, status: 'unverified', evidence: '需要项目内行为检查脚本，尚未实际验证', evidenceKind: 'inspection' }] })
      : { httpStatus: 503, error: { message: 'intentional reviewer boundary' } }
  })
  fs.writeFileSync = (target, content, ...rest) => {
    if (target === path.join(ctx.root, 'tests/verify.cjs')) { writes++; write(target, content, ...rest); if (!injected && boundary === 'effect') { injected = true; throw new Error('preparer lost write result') } return }
    const record = receipts(ctx.service).find(r => r.tool === 'write_file')
    if (!injected && target === ctx.service.store.path + '.tmp' && record && (boundary === 'result' ? record.status === 'completed' : boundary === 'projection' && record.applied)) { injected = true; throw new Error('preparer ' + boundary + ' save failed') }
    return write(target, content, ...rest)
  }
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service); assert.ok(injected, JSON.stringify({ stage: ctx.feature.stage, reason: ctx.feature.contextRuntime?.reason, feedback: ctx.feature.feedback, events: ctx.project.events.slice(-5) })); assert.equal(writes, 1)
    active = new EngineeringService(); await run(active); active.reconcileRuntime('p', 'f'); active.reconcileRuntime('p', 'f')
    assert.equal(writes, 1); assert.equal(reviews, 2); const feature = active.store.project('p').features[0], attempt = feature.verificationPreparation.attempts[0]
    assert.equal(attempt.actions.filter(a => a === 'created:tests/verify.cjs').length, 1)
    assert.equal(attempt.actions.filter(a => a.startsWith('write_file:')).length, 1); assert.equal(feature.verificationPreparation.attempts.length, 1)
  } finally { fs.writeFileSync = write; await server.close() }
})
test('actual storage failure in tool event is fatal before reads; ordinary read failure is a failed receipt and saved output is redacted', async () => {
  const ctx = reliable(); let executions = 0, injected = false
  files.executeTool = async (...args) => { executions++; return actualTool(...args) }
  const server = await provider((_req, n) => n === 1 ? { text: '', calls: [call('read_file', { path: 'value.cjs' }).calls[0], call('list_files', {}).calls[0]] }
    : answer({ status: 'incomplete', summary: '等待', nextStep: '核对' }))
  const write = fs.writeFileSync
  fs.writeFileSync = (target, content, ...rest) => {
    if (!injected && target === ctx.service.store.path + '.tmp' && receipts(ctx.service).some(r => r.status === 'running') && ctx.project.events.at(-1)?.kind === 'tool') {
      injected = true; throw new Error('actual durable write failure')
    }
    return write(target, content, ...rest)
  }
  try { model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; await run(ctx.service)
    assert.ok(injected); assert.equal(executions, 0); assert.equal(server.requests.length, 1); assert.match(ctx.feature.contextRuntime.reason, /保存失败/)
  } finally { fs.writeFileSync = write; await server.close(); files.executeTool = actualTool }
  const next = reliable(), secret = 'isolated-fixture-private-key-0123456789'
  next.service.store.key = () => secret; fs.writeFileSync(path.join(next.root, 'value.cjs'), secret)
  const errors = await provider((_req, n) => n === 1 ? { text: '', calls: [call('read_file', { path: 'missing.txt' }).calls[0], call('read_file', { path: 'value.cjs' }).calls[0]] }
    : answer({ status: 'incomplete', summary: '等待', nextStep: '核对' }))
  try { model.complete = actualComplete; next.service.store.data.models[0].baseUrl = errors.url; await run(next.service)
    assert.equal(receipts(next.service)[0].status, 'failed'); assert.match(receipts(next.service)[0].reason, /ENOENT/)
    assert.ok(!fs.readFileSync(next.service.store.path, 'utf8').includes(secret)); assert.equal(receipts(next.service)[1].status, 'completed')
  } finally { await errors.close() }
})
async function main() {
  for (const { name, fn } of tests) try { await fn(); results.push({ name, status: 'passed' }); console.log('PASS:', name) }
  catch (error) { results.push({ name, status: 'failed', error: error.stack }); console.error('FAIL:', name, error.stack) }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); assert.ok(results.every(r => r.status === 'passed'))
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => { model.complete = actualComplete; files.executeTool = actualTool; fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }) })
