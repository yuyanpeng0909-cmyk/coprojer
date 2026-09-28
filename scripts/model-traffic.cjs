const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
fs.mkdirSync('.runtime', { recursive: true })
const root = fs.mkdtempSync(path.resolve('.runtime/model-traffic-test-'))
const cache = new Map(), realFetch = global.fetch
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', code)(exports, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
  return exports
}
const { ModelTrafficMonitor } = load('src/main/engineering/model-traffic.ts')
const { tokenUsage } = load('src/shared/model-traffic.ts')
const { complete, getModels } = load('src/main/engineering/model.ts')
const clockStart = new Date(2026, 8, 28, 12).getTime()
let now = clockStart
const file = path.join(root, 'usage.json'), monitor = new ModelTrafficMonitor(file, () => now)
const connections = ['chat', 'responses', 'anthropic'].map(protocol => ({ id: protocol, model: protocol + '-model', protocol, name: protocol, baseUrl: 'http://localhost:9090/v1', apiKey: 'private-key-must-not-leak', hasKey: true, traffic: monitor }))
const query = () => monitor.snapshot(connections)
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const sse = events => new Response(events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
const invoke = (c, signal, stream = false) => complete(c, 'private-system-prompt', [{ role: 'user', content: 'private-chat-content' }], [], signal, stream ? () => {} : undefined)
async function main() {
  try {
    assert.equal(query().totals.requests, 0)
    assert.equal(query().totals.totalTokens, null)
    assert.equal(query().models.length, 3)
    assert.equal(tokenUsage('chat', { prompt_tokens: 10, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 4 } }).totalTokens, 16)
    assert.equal(tokenUsage('anthropic', { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 2 }).totalTokens, 20)
    assert.equal(tokenUsage('responses', { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 4 } }).totalTokens, 15)
    assert.equal(tokenUsage('chat', { prompt_tokens: '20', completion_tokens: -2 }).totalTokens, undefined)
    assert.equal(tokenUsage('chat', { prompt_tokens: 0, completion_tokens: 0 }).totalTokens, 0)
    for (const c of connections) {
      const usage = c.protocol === 'chat' ? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } : { input_tokens: 10, output_tokens: 5 }
      const result = c.protocol === 'chat' ? { model: c.model, usage, choices: [{ message: { content: 'ok' } }] } : c.protocol === 'responses' ? { model: c.model, usage, output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } : { model: c.model, usage, content: [{ type: 'text', text: 'ok' }] }
      global.fetch = async () => { now += 120; return json(result) }
      assert.equal((await invoke(c)).text, 'ok')
      const events = c.protocol === 'chat' ? [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, { choices: [], usage }, '[DONE]'] : c.protocol === 'responses' ? [{ type: 'response.completed', response: result }] : [{ type: 'message_start', message: { model: c.model, usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } }, { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_delta', usage: { output_tokens: 5 } }, { type: 'message_stop' }]
      global.fetch = async (_, init) => { if (c.protocol === 'chat') assert.equal(JSON.parse(init.body).stream_options.include_usage, true); now += 120; return sse(events) }
      assert.equal((await invoke(c, undefined, true)).text, 'ok')
    }
    assert.equal(query().totals.requests, 6)
    assert.equal(query().totals.succeeded, 6)
    assert.equal(query().totals.totalTokens, 90)
    assert.equal(query().totals.averageDurationMs, 120)
    assert.equal(monitor.snapshot(connections, { connectionId: 'anthropic' }).totals.totalTokens, 30)
    global.fetch = async () => json({ data: [{ id: 'available' }] })
    assert.deepEqual(await getModels(connections[0]), ['available'])
    assert.equal(query().totals.requests, 6, 'model listing is not inference')
    global.fetch = async () => json({ choices: [{ message: { content: 'no usage' } }] })
    await invoke(connections[0])
    assert.equal(query().totals.usageReported, 6)
    assert.equal(query().recent[0].totalTokens, undefined)
    await invoke({ ...connections[0], id: '' })
    assert.equal(query().totals.requests, 7, 'unsaved drafts do not pollute connected-model metrics')
    let fetches = 0
    global.fetch = async () => { fetches++; return json({}) }
    await assert.rejects(complete(connections[0], 'x'.repeat(160001), []), /160000/)
    assert.equal(fetches, 0); assert.equal(query().totals.requests, 7)
    global.fetch = async () => new Response('private-key-must-not-leak private-chat-content', { status: 429 })
    await assert.rejects(invoke(connections[0]), /429/)
    assert.equal(query().recent[0].errorKind, 'rate-limit')
    assert.equal(query().recent[0].httpStatus, 429)
    global.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }) }
    await assert.rejects(invoke(connections[0]), /连接中断/)
    assert.equal(query().recent[0].errorKind, 'network')
    global.fetch = async () => json({ choices: [] })
    await assert.rejects(invoke(connections[0]), /缺少模型回复/)
    assert.equal(query().recent[0].status, 'failed')
    global.fetch = async () => sse([{ usage: { prompt_tokens: 12, completion_tokens: 2 }, choices: [{ delta: { content: 'partial' } }] }])
    await assert.rejects(invoke(connections[0], undefined, true), /提前断开/)
    assert.equal(query().recent[0].totalTokens, 14)
    assert.equal(query().recent[0].status, 'failed')
    const controller = new AbortController()
    global.fetch = (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    const pending = invoke(connections[0], controller.signal)
    assert.equal(query().totals.running, 1)
    controller.abort(new Error('private-cancel-reason'))
    await assert.rejects(pending, /private-cancel/)
    assert.equal(query().recent[0].status, 'cancelled')
    const timed = new AbortController(), timeout = invoke(connections[0], timed.signal)
    timed.abort(new DOMException('Timeout', 'TimeoutError'))
    await assert.rejects(timeout)
    assert.equal(query().recent[0].status, 'failed'); assert.equal(query().recent[0].errorKind, 'timeout')
    const replies = []
    global.fetch = () => new Promise(resolve => replies.push(resolve))
    const parallel = [invoke(connections[0]), invoke(connections[1])]
    assert.equal(query().totals.running, 2)
    replies[1](json({ output: [] })); replies[0](json({ choices: [{ message: { content: 'ok' } }] }))
    await Promise.all(parallel)
    assert.equal(query().totals.running, 0)
    monitor.start(connections[2], 'inference')
    const restored = new ModelTrafficMonitor(file, () => now).snapshot(connections)
    assert.equal(restored.totals.running, 0); assert.equal(restored.totals.interrupted, 1)
    assert.equal(restored.recent[0].durationMs, undefined)
    assert.equal(restored.totals.requests, query().totals.requests)
    const disk = fs.readFileSync(file, 'utf8')
    for (const secret of ['private-key', 'private-chat', 'private-system', 'private-cancel', 'apiKey', 'baseUrl']) assert.ok(!disk.includes(secret), secret)
    const dateFile = path.join(root, 'dates.json'), dates = new ModelTrafficMonitor(dateFile, () => now)
    dates.start(connections[0], 'test').finish('succeeded')
    now += 2 * 86400000
    assert.equal(dates.snapshot(connections).totals.requests, 0)
    assert.equal(dates.snapshot(connections, { window: '7d' }).totals.requests, 1)
    now += 30 * 86400000
    assert.equal(dates.snapshot(connections, { window: '30d' }).totals.requests, 0)
    assert.equal(JSON.parse(fs.readFileSync(dateFile, 'utf8')).requests.length, 0, 'expired records are pruned on disk even when no new calls arrive')
    now = clockStart
    const limitFile = path.join(root, 'limit.json')
    fs.writeFileSync(limitFile, JSON.stringify({ version: 1, enabledAt: new Date(now).toISOString(), requests: Array.from({ length: 10005 }, (_, i) => ({ id: String(i), connectionId: 'chat', model: 'chat-model', protocol: 'chat', purpose: 'inference', startedAt: new Date(now - 10005 + i).toISOString(), status: 'succeeded', durationMs: 10 })) }))
    const limited = new ModelTrafficMonitor(limitFile, () => now).snapshot(connections)
    assert.equal(limited.totals.requests, 10000); assert.ok(limited.truncatedBefore)
    assert.equal(limited.recent.length, 50)
    const brokenFile = path.join(root, 'broken.json'); fs.writeFileSync(brokenFile, 'corrupt-original')
    const broken = new ModelTrafficMonitor(brokenFile, () => now)
    broken.start(connections[0], 'test').finish('succeeded')
    assert.ok(broken.snapshot(connections).storageError); assert.equal(fs.readFileSync(brokenFile, 'utf8'), 'corrupt-original')
    const unwritable = new ModelTrafficMonitor(path.join(root, 'missing', 'usage.json'), () => now)
    global.fetch = async () => json({ choices: [{ message: { content: 'ok' } }] })
    assert.equal((await invoke({ ...connections[0], traffic: unwritable })).text, 'ok')
    assert.equal(unwritable.snapshot(connections).totals.succeeded, 1)
    assert.ok(unwritable.snapshot(connections).storageError)
    console.log('PASS: traffic JSON/SSE across three protocols, cumulative usage, unknown/zero tokens, HTTP/network/abort/timeout, concurrent requests, privacy, persistence, interrupted recovery, filters, retention and storage failures')
  } finally {
    global.fetch = realFetch
    if (path.dirname(root) === path.resolve('.runtime')) fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
