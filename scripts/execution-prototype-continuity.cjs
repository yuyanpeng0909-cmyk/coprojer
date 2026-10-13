const { assert, fs, path, sandbox, fixture, model, load, EngineeringService } = require('./fixtures/verification-runtime.cjs')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const { contextHash } = load('src/main/engineering/context.ts')
const { newRuntimeBudget } = load('src/main/engineering/runtime-budget.ts')
const { assertCompleteToolRounds } = load('src/main/engineering/context.ts')
const key = JSON.stringify(['p', 'f'])
const results = []
async function test(name, fn) {
  try { await fn(); console.log('PASS:', name); results.push({ name, passed: true }) }
  catch (error) { console.error('FAIL:', name, error.message); results.push({ name, passed: false, error: error.message }) }
}
function setup() {
  const ctx = fixture()
  const prototype = { id: 'approved', title: '已确认原型', at: '2026-10-09T00:00:00Z', html: '' }
  const padding = 33245 - JSON.stringify(prototype).length
  prototype.html = '\\'.repeat(Math.floor(padding / 2)) + 'X'.repeat(padding % 2)
  ctx.project.prototypes = [prototype]; ctx.feature.prototypeId = prototype.id
  ctx.feature.runtimePolicy = 'receipts-effects-v1'
  ctx.feature.runtimeBudget = newRuntimeBudget(key)
  return { ...ctx, prototype, version: contextHash(JSON.stringify(prototype)), total: JSON.stringify(prototype).length }
}
async function runLoop(ctx, resume) {
  const agent = ctx.service.store.data.agents.find(a => a.id === ctx.feature.developerId)
  try { await ctx.service.agentLoop(ctx.project, ctx.feature, agent, '', new AbortController().signal, resume ? { resume } : undefined) }
  catch (error) { if (!/报告明确未完成/.test(error.message)) throw error }
}
function progressFrom(system) {
  const line = system.split('\n').find(line => line.startsWith('必读资料进度：'))
  return line ? JSON.parse(line.slice('必读资料进度：'.length))[0] : undefined
}
async function main() {
  await test('completed small prototype stays exact in working input; unread or oversized sources are not injected', async () => {
    const actual = model.complete
    try {
      for (const [read, large] of [[0, false], [100, false], [100, true]]) {
        const ctx = setup(); ctx.prototype.html = large ? 'x'.repeat(40000) : '<button>原型细节_7F29</button>'
        const total = JSON.stringify(ctx.prototype).length
        const resume = { role: 'developer', version: 4, fingerprint: ctx.service.executionFingerprint(ctx.project, ctx.feature), sourceFingerprint: ctx.service.sourceFingerprint(ctx.project),
          round: 0, development: '', messages: [{ role: 'user', content: '继续当前任务。', sequence: 1 }], commands: [], prototypeReadUntil: read ? total : 0, steps: 0 }
        model.complete = async (_connection, system) => {
          const line = system.split('\n').find(line => line.startsWith('已读原型工作资料：'))
          assert.equal(!!line, !!read && !large)
          if (line) assert.equal(JSON.parse(line.slice('已读原型工作资料：'.length)).html, ctx.prototype.html)
          return { text: JSON.stringify({ status: 'incomplete', summary: '隔离观察结束。', nextStep: '继续。' }), calls: [] }
        }
        await runLoop(ctx, resume)
      }
    } finally { model.complete = actual }
  })
  await test('archived successful reads can be restored once; duplicate visible reads and failed calls still pause', async () => {
    const { ExecutionProgress } = load('src/main/engineering/execution-progress.ts')
    const progress = new ExecutionProgress(), args = JSON.stringify({ path: 'package.json' }), output = 'package contents'
    progress.observe('read_file', args, output, '', false)
    for (let i = 0; i < 5; i++) progress.observe('read_file', args, output, '', false)
    assert.ok(progress.pauseReason)
    const saved = progress.snapshot(), restored = new ExecutionProgress(saved)
    restored.observe('read_file', args, output, '', false, true)
    assert.equal(restored.pauseReason, '', 'restoring evicted successful content must permit the next work round')
    assert.equal(restored.snapshot().repeated, saved.repeated, 'restoration does not reset prior repeat counters')
    const restarted = new ExecutionProgress(restored.snapshot())
    restarted.observe('read_file', args, output, '', false, true)
    assert.match(restarted.pauseReason, /重复/, 'restoration allowance cannot be renewed by restart or another compaction')
    const errors = new ExecutionProgress()
    for (let i = 0; i < 3; i++) errors.observe('read_file', args, '工具错误：missing', '', false, true)
    assert.match(errors.pauseReason, /失败 3 次/)
  })
  await test('compacted file reads in a stopped engineering checkpoint restore once then allow a real write', async () => {
    const ctx = setup(), actual = model.complete; let count = 0
    const fileCalls = () => [{ id: 'list-' + count, name: 'list_files', arguments: '{}' }, { id: 'package-' + count, name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) }]
    try {
      model.complete = async () => {
        if (count++) throw new Error('isolated interruption')
        const calls = []
        for (let offset = 0; offset < ctx.total; offset += 6000) calls.push({ id: 'page-' + offset, name: 'read_context', arguments: JSON.stringify({ id: 'prototype:approved', offset, version: ctx.version }) })
        return { text: '', calls: [...calls, ...fileCalls()] }
      }
      await assert.rejects(runLoop(ctx), /isolated interruption/)
      const saved = ctx.service.store.data.executionCheckpoints[key]
      assert.ok(ctx.feature.contextRuntime.compactions.length > 0)
      assert.equal(saved.messages.filter(m => m.role === 'tool').length, 0, 'fixture must actually evict raw tool results')
      saved.progress.repeated = 7; ctx.service.store.save()
      const resumed = new EngineeringService(), p = resumed.store.project('p'), f = p.features[0]; count = 0
      model.complete = async () => {
        const n = count++
        if (!n) return { text: '', calls: fileCalls() }
        if (n === 1) return { text: '', calls: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'restored.txt', content: 'forward progress' }) }] }
        return { text: JSON.stringify({ status: 'incomplete', summary: '隔离恢复取得实际修改。', nextStep: '继续余下工作。' }), calls: [] }
      }
      await runLoop({ ...ctx, service: resumed, project: p, feature: f }, resumed.store.data.executionCheckpoints[key])
      assert.equal(fs.readFileSync(path.join(ctx.root, 'restored.txt'), 'utf8'), 'forward progress')
      assert.equal(count, 3)
    } finally { model.complete = actual }
  })
  await test('resume keeps repeat counters and exposes prior file reads with changed-file invalidation', async () => {
    const ctx = setup(), actual = model.complete; let count = 0
    try {
      model.complete = async () => {
        if (count++) throw new Error('isolated interruption')
        return { text: '', calls: [{ id: 'package', name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) }] }
      }
      await assert.rejects(runLoop(ctx), /isolated interruption/)
      const saved = ctx.service.store.data.executionCheckpoints[key]; saved.progress.repeated = 7; ctx.service.store.save()
      const resumed = new EngineeringService(), p = resumed.store.project('p'), f = p.features[0], checkpoint = resumed.store.data.executionCheckpoints[key]
      const loop = { ...ctx, service: resumed, project: p, feature: f }
      const inspect = expected => async (_connection, system) => {
        assert.match(system, /检测到重复无进展/, 'resume must expose the previous repeated-call warning')
        const line = system.split('\n').find(line => line.startsWith('已读资料索引：'))
        assert.ok(line, 'saved read registry must reach the model prompt')
        const data = JSON.parse(line.slice('已读资料索引：'.length)), file = data.records.find(r => r.sourceId === 'read_file::package.json')
        assert.equal(file.currentVersion, expected); assert.equal(data.repeated, 7)
        assert.equal(checkpoint.progress.repeated, 7, 'do not reset repeat counters as a workaround')
        return { text: JSON.stringify({ status: 'incomplete', summary: '隔离观察结束。', nextStep: '继续当前任务。' }), calls: [] }
      }
      model.complete = inspect('unchanged'); await runLoop(loop, checkpoint)
      fs.writeFileSync(path.join(ctx.root, 'package.json'), '{"name":"changed"}')
      model.complete = inspect('changed-or-missing'); await runLoop(loop, checkpoint)
    } finally { model.complete = actual }
  })
  await test('engineering compaction projects completed prototype reads; no full reread and actual write follows', async () => {
    const ctx = setup(), offsets = [], observations = []; let rounds = 0
    const server = await provider(req => {
      const system = req.body.messages[0].content, progress = progressFrom(system); observations.push(progress)
      if (++rounds > 5) throw new Error('loop did not converge')
      if (!progress?.complete) {
        const start = progress?.nextOffset ?? 0
        const calls = []
        for (let offset = start; offset < ctx.total; offset += 6000) {
          offsets.push(offset); calls.push({ id: 'page-' + rounds + '-' + offset, name: 'read_context', arguments: JSON.stringify({ id: 'prototype:approved', offset, limit: 6000, version: ctx.version }) })
        }
        return { text: '读取原型后继续工程工作。', calls }
      }
      if (fs.existsSync(path.join(ctx.root, 'progress.txt'))) return { text: JSON.stringify({ status: 'incomplete', summary: '已完成隔离写入检查，业务仍待开发。', nextStep: '继续剩余实现。' }), calls: [] }
      return { text: '', calls: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'progress.txt', content: 'actual forward progress' }) }] }
    })
    try {
      ctx.service.store.data.models[0].baseUrl = server.url
      await runLoop(ctx)
      assert.equal(new Set(offsets).size, offsets.length, 'completed pages must not be reloaded after compaction')
      assert.ok(observations.some(p => p?.complete && p.read === ctx.total && p.nextOffset === null && p.version === ctx.version))
      assert.ok(ctx.feature.contextRuntime.compactions.length > 0, 'must exercise actual history compaction')
      assert.equal(fs.readFileSync(path.join(ctx.root, 'progress.txt'), 'utf8'), 'actual forward progress')
      const checkpoint = ctx.service.store.data.executionCheckpoints[key]
      assert.equal(checkpoint.prototypeReadUntil, ctx.total)
      assert.equal(checkpoint.continuity.requiredReads[0].read, ctx.total)
      assertCompleteToolRounds(checkpoint.messages)
    } finally { await server.close() }
  })
  await test('saved partial and complete prototype cursors appear on the first request after restart', async () => {
    for (const partial of [true, false]) {
      const ctx = setup(); let count = 0
      const actual = model.complete
      try {
        model.complete = async () => {
          if (count++) throw new Error('isolated interruption')
          const end = partial ? 12000 : ctx.total, calls = []
          for (let offset = 0; offset < end; offset += 6000) calls.push({ id: 'read-' + offset, name: 'read_context', arguments: JSON.stringify({ id: 'prototype:approved', offset, version: ctx.version }) })
          return { text: '', calls }
        }
        await assert.rejects(runLoop(ctx), /isolated interruption/)
        const resumed = new EngineeringService(), p = resumed.store.project('p'), f = p.features[0], saved = resumed.store.data.executionCheckpoints[key]
        assert.equal(saved.prototypeReadUntil, partial ? 12000 : ctx.total)
        model.complete = async (_c, system) => {
          const progress = progressFrom(system)
          assert.ok(progress, 'saved prototype cursor must be injected into engineering prompt')
          assert.deepEqual(progress, { id: 'prototype:approved', version: ctx.version, read: partial ? 12000 : ctx.total, totalCharacters: ctx.total, complete: !partial, nextOffset: partial ? 12000 : null })
          return { text: JSON.stringify({ status: 'incomplete', summary: '停止隔离恢复检查。', nextStep: '保留当前进度。' }), calls: [] }
        }
        await runLoop({ ...ctx, service: resumed, project: p, feature: f }, saved)
      } finally { model.complete = actual }
    }
  })
  const output = path.resolve('.runtime/prototype-read-loop'); fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'regression.json'), JSON.stringify(results, null, 2))
  if (results.some(r => !r.passed)) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true }))
