const { assert, fs, path, sandbox, fixture, model, load, run, answer, call } = require('./fixtures/verification-runtime.cjs')
const http = require('node:http')
const { requestWithContext } = load('src/main/engineering/context-request.ts')
const { ModelTrafficMonitor } = load('src/main/engineering/model-traffic.ts')
const output = path.resolve('.runtime/execution-network-resume'); fs.mkdirSync(output, { recursive: true })
const results = [], originalComplete = model.complete, originalFetch = global.fetch
async function test(name, work) {
  try { await work(); results.push({ name, passed: true }); console.log('PASS', name) }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.error('FAIL', name, error.message); process.exitCode = 1 }
  finally { model.complete = originalComplete; global.fetch = originalFetch }
}
const c = { id: 'network-fixture', model: 'fixture', protocol: 'chat', name: 'fixture', apiKey: 'secret-fixture', baseUrl: 'http://localhost:1' }
const socketError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('secret-fixture'), { code: 'UND_ERR_SOCKET' }) })
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'READY' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
async function requestFixture(options = {}) {
  const messages = [{ role: 'user', content: 'KEEP_GOAL' }], events = [], statuses = [], payloads = []
  const controller = options.controller ?? new AbortController()
  let reserved = 0
  const connection = { ...c, onRequest() { reserved++; if (options.limit && reserved > options.limit) throw new Error('REQUEST_BUDGET_EXHAUSTED') } }
  let error, reply
  try {
    reply = await requestWithContext(messages, {
      prepare: h => model.prepareModelRequest(connection, 'fixed', h, []), assertCurrent: options.assertCurrent ?? (() => {}),
      commit() {}, archive() { throw new Error('must not compact') },
      event(kind, message) { events.push({ kind, message }); options.event?.(kind, message, controller) },
      request(p, status) { statuses.push(status) },
      send(p, signal) { payloads.push(p.payload); return model.complete(connection, 'fixed', messages, [], signal, undefined, p) },
    }, controller.signal)
  } catch (e) { error = e }
  return { error, reply, events, statuses, payloads, reserved, messages }
}
async function main() {
  await test('resume preserves saved step number and completed write without replay', async () => {
    const { service, project, feature, root } = fixture()
    let requests = 0
    model.complete = async () => ++requests === 1 ? call('write_file', { path: 'once.txt', content: 'WRITTEN_ONCE' })
      : answer({ status: 'incomplete', summary: '写入已完成', nextStep: '继续剩余检查' })
    await run(service)
    const key = JSON.stringify([project.id, feature.id]), before = service.store.data.executionCheckpoints[key]
    assert.equal(before.steps, 2)
    const originalHistory = structuredClone(before.messages), index = project.events.length
    let prompt
    model.complete = async (_c, system, history) => {
      prompt = system
      assert(history.some(m => m.role === 'tool' && m.content.includes('once.txt')))
      for (const m of originalHistory) assert(history.some(current => current.sequence === m.sequence && current.content === m.content))
      return answer({ status: 'incomplete', summary: '继续检查中', nextStep: '待核对' })
    }
    await run(service)
    assert.equal(service.store.data.executionCheckpoints[key].steps, 3, 'resume must not overwrite the durable step with batch step 1')
    assert.match(project.events.slice(index).find(e => e.kind === 'model').message, /接续第 3 步.*本次第 1 步/)
    assert.match(prompt, /接续第 3 步/)
    assert.equal(project.events.filter(e => e.kind === 'tool' && e.message.includes('write_file')).length, 1)
    assert.equal(fs.readFileSync(path.join(root, 'once.txt'), 'utf8'), 'WRITTEN_ONCE')
  })
  await test('real HTTP socket drop after committed write retries identical model request only', async () => {
    const { service, project, feature } = fixture()
    feature.runtimePolicy = 'receipts-effects-v1'
    feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('network-fixture')
    const payloads = []
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      payloads.push(Buffer.concat(chunks).toString())
      if (payloads.length === 2) { req.socket.destroy(); return }
      const message = payloads.length === 1
        ? { content: '', tool_calls: [{ id: 'write-once', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'once.txt', content: 'COMMITTED' }) } }] }
        : { content: JSON.stringify({ status: 'incomplete', summary: '请求恢复', nextStep: '后续检查' }) }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 1 } }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const traffic = new ModelTrafficMonitor(path.join(sandbox, 'network-traffic.json'))
    try {
      service.store.data.models[0].baseUrl = 'http://127.0.0.1:' + server.address().port
      model.complete = (connection, ...args) => originalComplete({ ...connection, traffic }, ...args)
      await run(service)
      assert.equal(payloads.length, 3)
      assert.equal(payloads[1], payloads[2], 'retry must preserve exact prepared payload')
      const checkpoint = service.store.data.executionCheckpoints[JSON.stringify([project.id, feature.id])]
      assert.equal(checkpoint.steps, 2)
      const receipts = Object.values(service.store.data.receiptJournals[JSON.stringify([project.id, feature.id])].receipts)
      assert.equal(receipts.filter(r => r.tool === 'write_file').length, 1)
      assert.equal(receipts[0].attempts, 1)
      assert.equal(feature.runtimeBudget.used.requests, 3, 'every HTTP attempt consumes request budget')
      assert.deepEqual(feature.contextRuntime.requests.map(r => r.status), ['completed', 'failed', 'completed'])
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sandbox, 'network-traffic.json'))).requests.map(r => r.status), ['succeeded', 'failed', 'succeeded'])
      assert(project.events.some(e => e.kind === 'model-retry'))
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
  await test('persistent connection failure stops after two retries and retains history', async () => {
    let requests = 0; global.fetch = async () => { requests++; throw socketError() }
    const result = await requestFixture()
    assert.equal(requests, 3); assert.equal(result.reserved, 3)
    assert.equal(result.events.filter(e => e.kind === 'model-retry').length, 2)
    assert.equal(new Set(result.payloads).size, 1)
    assert.deepEqual(result.statuses, ['prepared', 'failed', 'prepared', 'failed', 'prepared', 'failed'])
    assert.match(result.error.message, /UND_ERR_SOCKET/); assert(!result.error.message.includes('secret-fixture'))
    assert.deepEqual(result.messages, [{ role: 'user', content: 'KEEP_GOAL' }])
  })
  await test('cancel during recovery does not send another request', async () => {
    let requests = 0; global.fetch = async () => { requests++; throw socketError() }
    const result = await requestFixture({ event(kind, _message, controller) { if (kind === 'model-retry') controller.abort(new Error('USER_STOP')) } })
    assert.equal(requests, 1); assert.match(result.error.message, /USER_STOP|aborted/i)
  })
  await test('request budget and revision are rechecked before retry', async () => {
    let requests = 0; global.fetch = async () => { requests++; throw socketError() }
    const limited = await requestFixture({ limit: 1 })
    assert.equal(requests, 1); assert.match(limited.error.message, /REQUEST_BUDGET_EXHAUSTED/)
    let revised = false
    const stale = await requestFixture({ event(kind) { if (kind === 'model-retry') revised = true }, assertCurrent() { if (revised) throw new Error('TASK_CHANGED') } })
    assert.equal(requests, 2); assert.match(stale.error.message, /TASK_CHANGED/)
  })
  await test('HTTP auth errors and partial response disconnects do not auto-retry', async () => {
    let requests = 0
    global.fetch = async () => { requests++; return new Response('unauthorized', { status: 401 }) }
    const auth = await requestFixture(); assert.equal(requests, 1); assert.match(auth.error.message, /401/)
    global.fetch = async () => { requests++; return new Response(new ReadableStream({ start(controller) { controller.error(socketError()) } })) }
    const partial = await requestFixture(); assert.equal(requests, 2); assert.match(partial.error.message, /UND_ERR_SOCKET/)
    global.fetch = async () => { requests++; return response() }
    const good = await requestFixture(); assert.equal(good.reply.text, 'READY'); assert.equal(requests, 3)
  })
  fs.writeFileSync(path.join(output, process.argv.includes('--before') ? 'regression-before.json' : 'regression-after.json'), JSON.stringify(results, null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => { model.complete = originalComplete; global.fetch = originalFetch; fs.rmSync(sandbox, { recursive: true, force: true }) })
