const { assert, load, fs, path } = require('./fixtures/verification-runtime.cjs')
const http = require('node:http'), os = require('node:os')
const model = load('src/main/engineering/model.ts')
const { requestWithContext } = load('src/main/engineering/context-request.ts')
const { responsesCompaction } = load('src/main/engineering/responses-compaction.ts')
const { ExecutionArtifacts } = load('src/main/engineering/execution-artifacts.ts')
const { newContinuity } = load('src/main/engineering/context-continuity.ts')
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coprojer-window-native-')), wire = [], operations = []
  const output = [{ role: 'user', content: 'CANONICAL_USER' }, { type: 'compaction', id: 'cmp-fixture', encrypted_content: 'sk-DO_NOT_REDACT_OPAQUE'.repeat(1000) }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CANONICAL_END' }] }]
  let failCompact = false
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts)); wire.push({ path: req.url, body })
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('input_tokens')) return res.end(JSON.stringify({ input_tokens: body.input.some(i => i.type === 'compaction') ? 5000 : Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 3) }))
    if (req.url.endsWith('compact')) { if (failCompact) { res.statusCode = 404; return res.end('{"error":"unsupported"}') }; return res.end(JSON.stringify({ output, usage: { input_tokens: 201000, output_tokens: 5000 } })) }
    res.end(JSON.stringify({ id: 'reply', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 5000, output_tokens: 2 } }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const c = { id: 'native-fixture', name: 'fixture', model: 'native-fixture', protocol: 'responses', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', onOperation: o => operations.push(o), capabilities: {
    contextWindowTokens: 256000, maxOutputTokens: 16000, outputParameter: 'max_output_tokens', windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output', tokenCounting: 'responses', nativeCompaction: 'responses', nativeCompatibilityKey: 'fixture-native-v1',
    contextPolicy: { version: 2, mode: 'adaptive', triggerScope: 'total', compactor: 'responses-native', horizonRounds: 6 } } }
  const artifacts = new ExecutionArtifacts({ path: path.join(root, 'store.json'), redact: s => s.replace(/sk-\S+/g, 'REDACTED'), secrets: () => [] }, 'p', 'scope')
  let continuity = newContinuity('p/scope/role', 'baseline'), saved
  const messages = [{ role: 'user', content: 'KEEP_GOAL', sequence: 1 }, { role: 'assistant', content: 'x'.repeat(602000), sequence: 2 }]
  const ports = { prepare: h => model.prepareModelRequest(c, 'fixed', h, [], false), verify: (p,s) => model.verifyModelRequest(c,p,s), native: responsesCompaction(c,artifacts),
    send: (p,s) => model.complete(c, 'fixed', messages, [], s, undefined,p), assertCurrent() {}, commit: (m,next) => { saved = structuredClone({ messages:m, continuity:next }) }, archive: (s,l) => artifacts.write(s,l), event() {} }
  try {
    await requestWithContext(messages, ports, new AbortController().signal, { continuity })
    assert.ok(continuity.nativeWindow); assert.equal(messages[1].content.length,602000)
    assert.deepEqual(artifacts.readOpaque(continuity.nativeWindow.reference, continuity.nativeWindow.identity), output)
    assert.deepEqual(wire.findLast(r => r.path === '/v1/responses').body.input, output)
    continuity = structuredClone(saved.continuity); messages.push({ role:'user', content:'NEW_TAIL', sequence:3 })
    await requestWithContext(messages, ports, new AbortController().signal, { continuity })
    const continued = wire.findLast(r => r.path === '/v1/responses').body.input
    assert.deepEqual(continued.slice(0,output.length),output); assert.equal(continued.at(-1).content,'NEW_TAIL')
    assert.equal(wire.filter(r => r.path.endsWith('/compact')).length,1)
    assert.equal(operations.filter(o => o.kind==='compaction'&&o.status==='completed').length,1)
    // Unknown child formats must not read, commit, or send anything.
    const unknown = structuredClone(continuity), requestsBefore = wire.length
    unknown.nativeWindow.version = 99
    await assert.rejects(requestWithContext(messages, ports, new AbortController().signal, { continuity: unknown }), /原生窗口版本/)
    assert.equal(wire.length, requestsBefore)
    // Storage failures cannot become a portable fallback or replace the prior view.
    const fresh = newContinuity('p/scope/role', 'baseline'), original = structuredClone(fresh)
    let commits = 0, sends = 0
    await assert.rejects(requestWithContext(messages, { ...ports, commit() { commits++; throw new Error('checkpoint fault') }, send() { sends++; throw new Error('unexpected send') } }, new AbortController().signal, { continuity: fresh }), /checkpoint fault/)
    assert.deepEqual(fresh, original); assert.equal(commits, 1); assert.equal(sends, 0)
    await assert.rejects(requestWithContext(messages, { ...ports, native: { ...ports.native, write() { throw new Error('opaque fault') } }, commit() { throw new Error('unexpected commit') } }, new AbortController().signal, { continuity: fresh }), /opaque fault/)
    assert.deepEqual(fresh, original)
    // A malformed visible tool group is rejected before it becomes active.
    output.push({ type: 'function_call_output', call_id: 'orphan', output: 'bad' })
    await assert.rejects(ports.native.compact(model.prepareModelRequest(c, 'fixed', [{ role:'user', content:'test' }], [], false), new AbortController().signal), /未配对工具/)
    output.pop()
    // Switching policy rebuilds from canonical messages; opaque state never leaks into portable payloads.
    c.capabilities.contextPolicy.compactor = 'portable'
    await requestWithContext(messages,ports,new AbortController().signal,{continuity})
    assert.equal(continuity.nativeWindow,undefined)
    assert.ok(!wire.findLast(r=>r.path==='/v1/responses').body.input.some(i=>i.type==='compaction'))
    assert.throws(()=>new ExecutionArtifacts({path:path.join(root,'store.json'),redact:s=>s,secrets:()=>[]},'other','scope').readOpaque(saved.continuity.nativeWindow?.reference || 'bad','wrong'))
    console.log('PASS native HTTP count/compact, opaque integrity, canonical order + tail, restart, policy fallback, scope isolation, unknown version, storage rollback and tool pairing')
  } finally { await new Promise(r=>server.close(r)) }
}
main().catch(e=>{console.error(e);process.exitCode=1})
