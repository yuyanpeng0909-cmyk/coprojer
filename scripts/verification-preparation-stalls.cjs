const { assert, fs, path, sandbox, fixture, model, load, answer, call } = require('./fixtures/verification-runtime.cjs')
const { ExecutionProgress } = load('src/main/engineering/execution-progress.ts')
const { verificationEnvironment, digest } = load('src/main/engineering/verification.ts')
const http = require('node:http')
const actualComplete = model.complete, results = []
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS:', name) }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log('FAIL:', name, error.message) }
  finally { model.complete = actualComplete }
}
async function main() {
  await test('same preparation admission blocker survives changed arguments, interleaved reads and restart', async () => {
    let progress = new ExecutionProgress()
    for (let i = 0; i < 3; i++) {
      progress.observe('read_file', JSON.stringify({ path: 'source-' + i }), 'new source ' + i, '', false)
      progress.observe('write_file', JSON.stringify({ path: 'apps/web/check-' + i + '.cjs', content: 'different ' + i }),
        '工具错误：准备阶段只能写入 tests/test/__tests__/scripts/fixtures 测试资料，不能修改业务源码。', '', false)
      if (i < 2) progress = new ExecutionProgress(progress.snapshot())
    }
    assert.match(progress.pauseReason, /同一.*阻塞.*3 次/)
    progress.observe('write_file', '{}', '已写入 tests/check.cjs', 'new-source', true)
    assert.equal(progress.pauseReason, '')
  })
  await test('preparation resume uses a bounded action summary and excludes unrelated prototype HTML', async () => {
    const ctx = fixture(), { service, project, feature } = ctx
    const prototype = { id: 'approved', title: '原型', html: '<html>' + 'PROTOTYPE_BODY_'.repeat(1000) + '</html>' }
    project.prototypes = [prototype]; feature.prototypeId = prototype.id
    const environment = verificationEnvironment(project)
    const environmentFingerprint = digest({ platform: environment.platform, arch: environment.arch, runtime: environment.runtime, desktop: environment.desktop })
    const actions = Array.from({ length: 80 }, () => 'read_file: HISTORICAL_RAW_BODY_' + 'x'.repeat(1450))
    actions.push('created:tests/existing.cjs', 'write_file: 工具错误：准备阶段保留原有脚本和断言；请添加补充检查脚本，不能覆盖已有测试或降低标准。')
    feature.verificationPreparation = { phase: 'blocked', round: 1, limit: 2, gaps: [{ id: 'gap', criterion: feature.criteria[0], disposition: 'automatic', reason: '缺检查脚本', nextStep: '添加补充检查' }],
      attempts: [{ id: 'attempt', key: 'key', round: 1, at: new Date().toISOString(), status: 'failed', beforeFingerprint: service.sourceFingerprint(project), actions, result: '上次请求超时', nextStep: '保留已有测试' }] }
    let prompt
    model.complete = async (_c, system, _messages, _tools, _signal, emit) => {
      prompt = system
      assert.equal(system.includes('HISTORICAL_RAW_BODY_'), false)
      assert.equal(system.includes('PROTOTYPE_BODY_'), false)
      assert.ok(system.includes('tests/existing.cjs'))
      assert.ok(system.includes('项目根目录'))
      assert.equal(_c.requestTimeoutMs, 180000)
      assert.match(project.activity, /等待模型响应/)
      emit({ kind: 'reasoning', text: '实际推理增量' }); assert.match(project.activity, /模型正在推理/)
      emit({ kind: 'tool', text: '{}', name: 'write_file', id: 'not-executed' }); assert.match(project.activity, /接收工具参数/)
      return answer({ status: 'blocked', summary: '受控结束，没有伪造检查', nextStep: '检查条件' })
    }
    const checkpoint = { role: 'preparer', environmentFingerprint, prototypeReadUntil: JSON.stringify(prototype).length, messages: [{ role: 'user', content: '续接' }], commands: [], steps: 4 }
    await service.prepareVerification(project, feature, service.store.data.agents.find(a => a.id === 'developer'), service.store.data.agents.find(a => a.id === 'reviewer'), new AbortController().signal, '已完成开发', checkpoint)
    assert.ok(prompt.length < 30000, '固定准备提示不应随原始动作输出无限增长')
    assert.deepEqual(feature.verificationPreparation.attempts[0].actions, actions)
  })
  await test('stage-specific timeout aborts a live SSE response without waiting for ten minutes', async () => {
    let disconnected = false, calls = 0
    const server = http.createServer((req, res) => {
      calls++; req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'still thinking' } }] }) + '\n\n')
      res.on('close', () => { disconnected = true })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const controller = new AbortController(), guard = setTimeout(() => controller.abort(new Error('REGRESSION_GUARD')), 2500)
    try {
      const start = Date.now()
      await assert.rejects(actualComplete({ name: 'fixture', protocol: 'chat', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', requestTimeoutMs: 100 }, '', [], [], controller.signal, () => {}), /模型响应超时/)
      assert.ok(Date.now() - start < 2000)
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(disconnected, true); assert.equal(calls, 1)
    } finally { clearTimeout(guard); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
  await test('timeout preserves a completed write and resumes without executing a streamed unfinished call', async () => {
    const { service, project, feature, root } = fixture()
    const agent = service.store.data.agents.find(a => a.id === 'developer')
    let requests = 0
    const server = http.createServer((req, res) => {
      req.resume(); const first = ++requests === 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-' + requests, type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: first ? 'tests/completed.cjs' : 'tests/unfinished.cjs', content: 'module.exports = 1' }) } }] } }] }) + '\n\n')
      if (first) res.end('data: [DONE]\n\n')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    service.store.data.models.find(item => item.id === 'fixture').baseUrl = `http://127.0.0.1:${server.address().port}/v1`
    model.complete = (connection, ...args) => actualComplete({ ...connection, requestTimeoutMs: 250 }, ...args)
    try {
      await assert.rejects(service.agentLoop(project, feature, agent, '', new AbortController().signal, { role: 'preparer' }), /模型响应超时/)
      const checkpoint = service.store.data.executionCheckpoints[JSON.stringify([project.id, feature.id])]
      assert.equal(checkpoint.role, 'preparer'); assert.equal(checkpoint.steps, 1)
      const written = path.join(root, 'tests/completed.cjs'), timestamp = fs.statSync(written).mtimeMs
      assert.equal(fs.existsSync(path.join(root, 'tests/unfinished.cjs')), false)
      model.complete = async (_connection, _prompt, history) => {
        assert.ok(history.some(message => message.role === 'tool' && message.content.includes('completed.cjs')))
        return answer({ status: 'ready', summary: '已有检查资料已保留', nextStep: '独立复验' })
      }
      await service.agentLoop(project, feature, agent, '', new AbortController().signal, { role: 'preparer', resume: checkpoint })
      assert.equal(fs.statSync(written).mtimeMs, timestamp)
      assert.equal(fs.existsSync(path.join(root, 'tests/unfinished.cjs')), false)
      assert.equal(requests, 2)
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
  fs.mkdirSync(path.resolve('.runtime/preparation-stalls'), { recursive: true })
  fs.writeFileSync(path.resolve('.runtime/preparation-stalls', process.argv.includes('--before') ? 'before.json' : 'after.json'), JSON.stringify(results, null, 2))
  assert.ok(results.every(r => r.passed), JSON.stringify(results.filter(r => !r.passed)))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true }))
