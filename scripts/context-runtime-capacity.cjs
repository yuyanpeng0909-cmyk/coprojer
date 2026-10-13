const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, sandbox, load, model, fixture, run, answer, call } = r
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const { boundMessages, readPage, assertCompleteToolRounds } = load('src/main/engineering/context.ts')
const { ExecutionArtifacts } = load('src/main/engineering/execution-artifacts.ts')
const { ReadRegistry } = load('src/main/engineering/read-registry.ts')
const { executeReadOnly } = load('src/main/engineering/files.ts')
const actualComplete = model.complete, output = path.resolve('.runtime/context-runtime/m2-capacity')
fs.mkdirSync(output, { recursive: true })
const cases = [], results = []
const test = (name, fn) => cases.push({ name, fn })
const connection = protocol => ({ id: 'isolated', name: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: 'fixture-secret', protocol })
function exchange(id, size = 6000, sequence = 1) {
  return [{ sequence, role: 'assistant', content: '', calls: [{ id, name: 'read_file', arguments: '{"path":"source.txt"}' }] },
    { sequence: sequence + 1, role: 'tool', callId: id, content: 'ORIGINAL_' + id + '中'.repeat(size) }]
}
for (const protocol of ['chat', 'responses', 'anthropic']) test(protocol + ' sends exactly the measured payload with schemas, native pairs, usage and output limits', async () => {
  const usage = protocol === 'chat' ? { prompt_tokens: 21, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } }
    : { input_tokens: 21, output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 } }
  const server = await provider(() => ({ text: 'complete', usage }))
  try {
    const c = { ...connection(protocol), baseUrl: server.url, capabilities: { contextWindowTokens: 200000, maxOutputTokens: 1234,
      outputParameter: protocol === 'responses' ? 'max_output_tokens' : protocol === 'chat' ? 'max_completion_tokens' : 'max_tokens',
      windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output', extraReasoningTokens: 500, toolCalling: true } }
    const calls = [0, 1].map(i => ({ id: 'native-' + i, name: 'read_file', arguments: JSON.stringify({ path: '中文-' + i + '.txt' }) }))
    const assistant = { role: 'assistant', content: '读取', calls }
    if (protocol === 'responses') assistant.responseItems = [{ type: 'reasoning', id: 'reason', encrypted_content: 'SIGNED_ENCRYPTED_BLOCK' }, ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }))]
    if (protocol === 'anthropic') assistant.anthropicBlocks = [{ type: 'thinking', thinking: '思考', signature: 'SIGNED_NATIVE_BLOCK' }, ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }))]
    const messages = [{ role: 'user', content: '目标/授权/标准 JSON {"a":"中文"}' }, assistant, ...calls.map(call => ({ role: 'tool', callId: call.id, content: JSON.stringify({ content: '中文内容', version: 'v1' }) }))]
    const tools = [{ name: 'read_file', description: '大型声明' + '中'.repeat(10000), parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }]
    const prepared = model.prepareModelRequest(c, 'SYSTEM_POLICY', messages, tools)
    assert.equal(prepared.budget.requestBytes, Buffer.byteLength(prepared.payload)); assert.equal(prepared.budget.requestCharacters, prepared.payload.length)
    assert.equal(prepared.budget.reserves.extraReasoningTokens, 0, 'reasoning included in output must not be deducted twice')
    assert.equal(prepared.budget.reserves.outputTokens, 1234); assert.equal(prepared.profile.documentation.length, 0)
    messages[0].content = 'MUTATED_AFTER_PREPARATION'; tools[0].description = 'MUTATED_SCHEMA'
    const reply = await actualComplete(c, 'MUTATED_SYSTEM', messages, tools, new AbortController().signal, () => {}, prepared)
    assert.deepEqual(server.requests[0].body, JSON.parse(prepared.payload), 'send uses the already measured immutable payload')
    assert.equal(server.requests[0].body[c.capabilities.outputParameter], 1234)
    assert.equal(reply.usage.inputTokens, 21); assert.equal(reply.usage.outputTokens, 8); assert.equal(reply.usage.totalTokens, 29)
    fs.writeFileSync(path.join(output, protocol + '-prepared.json'), JSON.stringify({ prepared, wire: server.requests[0].body, usage: reply.usage }, null, 2))
    if (protocol !== 'chat') {
      const bad = structuredClone(messages); bad[1].calls[0].id = 'unpaired'
      assert.throws(() => model.prepareModelRequest(c, 's', bad, []), /对应|匹配/)
      const nativeBad = structuredClone(messages)
      if (protocol === 'responses') nativeBad[1].responseItems[1].call_id = 'wrong-native'
      else nativeBad[1].anthropicBlocks[1].id = 'wrong-native'
      assert.throws(() => model.prepareModelRequest(c, 's', nativeBad, []), /原生工具块/)
    }
  } finally { await server.close() }
})
test('unknown usage/window stays unknown and separate reasoning is reserved exactly once', async () => {
  const server = await provider(() => ({ text: 'no usage' }))
  try {
    const c = { ...connection('chat'), baseUrl: server.url }, messages = [{ role: 'user', content: 'hello' }]
    const prepared = model.prepareModelRequest(c, 's', messages, [])
    assert.equal(prepared.budget.contextWindowTokens, undefined); assert.ok(prepared.profile.unknown.includes('contextWindowTokens'))
    const reply = await actualComplete(c, 's', messages, [], undefined, () => {}, prepared)
    assert.equal(reply.usage.totalTokens, undefined); assert.equal(reply.usage.inputTokens, undefined)
    c.capabilities = { contextWindowTokens: 20000, maxOutputTokens: 1000, outputParameter: 'max_tokens', reasoningAccounting: 'separate', extraReasoningTokens: 200, windowAccounting: 'input-plus-output' }
    const known = model.prepareModelRequest(c, 's', messages, []).budget
    assert.equal(known.reserves.extraReasoningTokens, 200)
    assert.equal(known.estimatedTotalTokens, known.estimatedInputTokens + known.reserves.safetyTokens + 1200)
    c.capabilities.windowAccounting = 'input-only'
    const inputOnly = model.prepareModelRequest(c, 's', messages, []).budget
    assert.equal(inputOnly.estimatedTotalTokens, inputOnly.estimatedInputTokens + inputOnly.reserves.safetyTokens)
  } finally { await server.close() }
})
test('monitor failure is isolated but reliable request and usage callbacks are not swallowed', async () => {
  const server = await provider(() => ({ text: 'valid', usage: { prompt_tokens: 1, completion_tokens: 2 } }))
  try {
    let starts = 0, updates = 0
    const c = { ...connection('chat'), baseUrl: server.url, traffic: { start() { throw new Error('monitor broken') } }, onRequest: () => starts++, onResponse: () => updates++ }
    const reply = await actualComplete(c, 's', [{ role: 'user', content: 'hello' }], [], undefined, () => {})
    assert.equal(reply.text, 'valid'); assert.equal(starts, 1); assert.ok(updates >= 2)
    c.onRequest = () => { throw new Error('reliable request persistence failed') }
    await assert.rejects(actualComplete(c, 's', [], []), /reliable request persistence failed/)
    assert.equal(server.requests.length, 1)
    c.onRequest = () => {}; c.onResponse = update => { if (update.usage) throw new Error('reliable usage persistence failed') }
    await assert.rejects(actualComplete(c, 's', [], [], undefined, () => {}), /reliable usage persistence failed/)
  } finally { await server.close() }
})
test('separate reasoning cannot be declared with an unknown reserve', () => {
  assert.throws(() => model.prepareModelRequest({ ...connection('chat'), capabilities: { reasoningAccounting: 'separate' } }, 's', [], []), /独立推理预留未知/)
  assert.equal(model.prepareModelRequest(connection('chat'), 's', [], []).budget.reserves.extraReasoningTokens, undefined)
})
test('usage received before real SSE disconnect or cancellation remains durable', async () => {
  for (const mode of ['disconnect', 'cancel']) {
    const ctx = fixture(); let timer
    const server = require('node:http').createServer(async (req, res) => {
      for await (const _chunk of req) {}
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 2 }, choices: [] }) + '\n\n')
      if (mode === 'disconnect') return res.end()
      timer = setInterval(() => {
        if (ctx.feature.contextRuntime?.requests.at(-1)?.usage?.inputTokens === 9) { clearInterval(timer); ctx.service.stop('p'); res.end() }
      }, 5)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      ctx.service.store.data.models[0].baseUrl = `http://127.0.0.1:${server.address().port}/v1`
      model.complete = actualComplete
      await run(ctx.service)
      const request = ctx.feature.contextRuntime.requests.at(-1)
      assert.equal(request.status, 'failed'); assert.equal(request.usage.inputTokens, 9); assert.equal(request.usage.outputTokens, 2)
      assert.equal(ctx.feature.contextRuntime.status, mode === 'cancel' ? 'cancelled' : 'failed')
      const disk = JSON.parse(fs.readFileSync(ctx.service.store.path))
      assert.equal(disk.projects[0].features[0].contextRuntime.requests.at(-1).usage.inputTokens, 9)
      fs.writeFileSync(path.join(output, 'partial-usage-' + mode + '.json'), JSON.stringify(ctx.feature.contextRuntime, null, 2))
    } finally { clearInterval(timer); await new Promise(resolve => server.close(resolve)) }
  }
})
test('required input over declared capacity saves the task and pauses before any model/tool execution', async () => {
  const ctx = fixture(), before = structuredClone({ criteria: ctx.feature.criteria, description: ctx.feature.description })
  ctx.service.store.data.models[0].capabilities = { contextWindowTokens: 500, maxOutputTokens: 100, outputParameter: 'max_tokens', windowAccounting: 'input-plus-output' }
  let requests = 0; model.complete = async () => { requests++; return answer({ status: 'complete', summary: 'should not send', nextStep: 'review' }) }
  await run(ctx.service)
  assert.equal(requests, 0); assert.equal(ctx.feature.stage, 'blocked'); assert.equal(ctx.project.changes.length, 0)
  assert.deepEqual({ criteria: ctx.feature.criteria, description: ctx.feature.description }, before)
  const checkpoint = Object.values(ctx.service.store.data.executionCheckpoints)[0]
  assert.equal(checkpoint.version, 2); assert.equal(checkpoint.manifest.version, 1); assert.equal(checkpoint.manifest.upstreamVersion, null)
  assert.equal(checkpoint.manifest.credentialRef, 'fixture'); assert.ok(!JSON.stringify(checkpoint.manifest).includes('apiKey'))
  fs.writeFileSync(path.join(output, 'required-capacity.json'), JSON.stringify({ checkpoint, context: ctx.feature.contextRuntime }, null, 2))
})
test('run configuration is fixed while later runs observe changed model settings', async () => {
  const ctx = fixture(); let n = 0; const models = []
  model.complete = async c => {
    models.push(c.model)
    if (++n === 1) { ctx.service.store.data.models[0].model = 'changed-next-run'; return call('read_file', { path: 'value.cjs' }) }
    return answer({ status: 'incomplete', summary: 'keep progress', nextStep: 'continue' })
  }
  await run(ctx.service); assert.deepEqual(models, ['fixture', 'fixture'])
  const checkpoint = Object.values(ctx.service.store.data.executionCheckpoints)[0]
  assert.equal(checkpoint.manifest.model.model, 'fixture')
  await run(ctx.service); assert.equal(models.at(-1), 'changed-next-run')
  assert.equal(ctx.feature.contextRuntime.manifest.model.model, 'changed-next-run')
})
test('unknown saved snapshot version is diagnostic only and cannot start work', async () => {
  const ctx = fixture(); let requests = 0
  model.complete = async () => { requests++; return answer({ status: 'incomplete', summary: 'paused', nextStep: 'continue' }) }
  await run(ctx.service)
  const checkpoint = Object.values(ctx.service.store.data.executionCheckpoints)[0]; checkpoint.version = 999
  const original = JSON.stringify(checkpoint)
  assert.throws(() => ctx.service.runFeature('p', 'f'), /版本未知/)
  assert.equal(requests, 1); assert.equal(JSON.stringify(checkpoint), original)
})
test('unknown nested manifest contracts and missing v2 fields cannot start work', async () => {
  const ctx = fixture(); let requests = 0
  model.complete = async () => { requests++; return answer({ status: 'incomplete', summary: 'pause', nextStep: 'continue' }) }
  await run(ctx.service)
  const key = Object.keys(ctx.service.store.data.executionCheckpoints)[0], original = structuredClone(ctx.service.store.data.executionCheckpoints[key])
  for (const mutate of [c => delete c.manifest, c => c.manifest.profile.version = 999, c => c.manifest.versions.context = 'unknown',
    c => c.manifest.versions.checkpoint = 'unknown', c => c.manifest.profile.identity.model = 'another-model']) {
    const checkpoint = structuredClone(original); mutate(checkpoint); ctx.service.store.data.executionCheckpoints[key] = checkpoint
    assert.throws(() => ctx.service.runFeature('p', 'f'), /版本未知|记录不完整/)
  }
  assert.equal(requests, 1)
})
test('persisted sequence survives compressing the latest full round and rebuilding the service', async () => {
  let ctx = fixture(), requests = 0
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(ctx.root, 'seq-' + i + '.txt'), String(i) + 'x'.repeat(5999))
  model.complete = async () => {
    if (++requests === 1) return { text: '', calls: Array.from({ length: 10 }, (_, i) => ({ id: 'seq-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'seq-' + i + '.txt' }) })) }
    throw new Error('stop after compaction')
  }
  await run(ctx.service)
  const before = Object.values(ctx.service.store.data.executionCheckpoints)[0]
  assert.ok(before.messages.some(m => m.content.includes('摘要条目 v2'))); assert.ok(before.lastSequence >= 12)
  const lastSequence = before.lastSequence, service = new r.EngineeringService()
  let resumed = 0
  model.complete = async () => ++resumed === 1 ? call('read_file', { path: 'value.cjs' }) : answer({ status: 'incomplete', summary: 'preserve new sequence', nextStep: 'continue' })
  await run(service)
  const after = Object.values(service.store.data.executionCheckpoints)[0]
  const newCall = after.messages.find(m => m.calls?.some(c => c.name === 'read_file'))
  assert.ok(newCall.sequence > lastSequence); assert.ok(after.lastSequence > newCall.sequence)
  fs.writeFileSync(path.join(output, 'sequence-restart.json'), JSON.stringify({ before, after }, null, 2))
})
test('twenty transactional v2 compactions preserve flat provenance, coverage and retrievable originals', () => {
  const ctx = fixture(), artifacts = new ExecutionArtifacts(ctx.service.store.artifactHost(), 'p', 'f')
  const messages = [{ sequence: 1, role: 'user', content: 'GOAL_AUTHORIZATION_CRITERIA' }], committed = []
  let sequence = 1, revision = 1
  for (let round = 0; round < 20; round++) {
    if (round === 10) revision++
    for (let i = 0; i < 5; i++) { messages.push(...exchange(round + '-' + i, 6000, ++sequence)); sequence++ }
    const result = boundMessages(messages, 17000, { archive: value => artifacts.write(value, 'round ' + round),
      provenance: { taskRevision: revision, sources: ['source:' + round, 'evidence:' + round] }, commit: value => committed.push(structuredClone(value)) })
    assert.equal(result.compacted, true); assertCompleteToolRounds(messages)
    const summaries = messages.filter(m => m.content.startsWith('[已完成工作摘要'))
    assert.equal(summaries.length, 1); assert.equal(summaries[0].content.split('[已完成工作摘要').length - 1, 1)
    const record = JSON.parse(summaries[0].content.split('\n摘要条目 v2：\n')[1])
    assert.equal(record.version, 2); assert.equal(record.taskRevision, revision); assert.ok(record.sources.includes('evidence:' + round))
    assert.ok(record.coverage.throughSequence >= record.coverage.fromSequence)
    const original = JSON.parse(artifacts.read({ id: result.archiveId }))
    assert.equal(original.complete, true); assert.match(original.content, /ORIGINAL_/)
    assert.equal(messages[0].content, 'GOAL_AUTHORIZATION_CRITERIA')
  }
  fs.writeFileSync(path.join(output, 'twenty-compactions.json'), JSON.stringify({ final: messages, committed: committed.length }, null, 2))
})
test('engineering service sends current facts through twenty compactions and a real task revision', async () => {
  const ctx = fixture(), captured = []
  for (let i = 0; i < 210; i++) fs.writeFileSync(path.join(ctx.root, 'material-' + i + '.txt'), 'SOURCE_' + i + '_' + '中'.repeat(5990))
  fs.writeFileSync(path.join(ctx.root, 'tests/check.cjs'), 'console.log("CURRENT_COMMAND_EVIDENCE")')
  let round = 0, revised = false
  const server = await provider(request => {
    const projection = JSON.parse(request.system.split('宿主当前任务事实（每次请求重新装载）：\n').at(-1).split('\n')[0])
    const summaries = request.body.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('[已完成工作摘要'))
    assert.equal(projection.goal.title, ctx.feature.title); assert.deepEqual(projection.criteria, ctx.feature.criteria)
    assert.equal(projection.taskRevision, ctx.feature.revision); assert.equal(projection.authorization.finalAcceptance, 'user-only')
    assert.equal(projection.authorization.root, ctx.root)
    assert.deepEqual([...projection.authorization.tools].sort(), [...ctx.service.store.data.agents.find(a => a.id === 'developer').tools].sort())
    assert.ok(summaries.length <= 1)
    for (const summary of summaries) {
      assert.equal(summary.content.split('[已完成工作摘要').length - 1, 1)
      assert.equal(JSON.parse(summary.content.split('\n摘要条目 v2：\n')[1]).taskRevision, ctx.feature.revision)
    }
    captured.push({ projection, summaries })
    if (revised) {
      assert.ok(!projection.authorization.tools.includes('write_file'))
      assert.ok(projection.evidence.records.every(e => e.taskRevision === ctx.feature.revision || e.disposition !== 'current'))
      return answer({ status: 'incomplete', summary: '新修订资料已保留', nextStep: '等待后续工作' })
    }
    if (round++ === 0) return call('run_command', { program: 'node', args: ['tests/check.cjs'], evidenceKind: 'unit' })
    if (round <= 22) return { text: '', calls: Array.from({ length: 10 }, (_, i) => ({ id: 'round-' + round + '-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'material-' + ((round - 2) * 10 + i) + '.txt' }) })) }
    assert.ok(projection.evidence.records.some(e => e.disposition === 'current' && e.code === 0))
    return answer({ status: 'incomplete', summary: '完整资料已读，仍需后续工作', nextStep: '保留当前现场' })
  })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; ctx.service.store.save()
    await run(ctx.service)
    assert.deepEqual(server.errors, [])
    const compacted = ctx.project.events.filter(e => e.kind === 'context-compaction').length
    assert.ok(compacted >= 20, 'actual service must compact at least twenty times: ' + compacted)
    assert.equal(ctx.feature.stage, 'blocked')
    const checkpoint = Object.values(ctx.service.store.data.executionCheckpoints)[0]
    assertCompleteToolRounds(checkpoint.messages)
    const archives = new ExecutionArtifacts(ctx.service.store.artifactHost(), 'p', 'f')
    for (const item of captured.flatMap(c => c.summaries)) {
      const id = item.content.match(/完整记录：read_context id=(artifact:[a-f0-9-]{36})/)[1]
      assert.equal(JSON.parse(archives.read({ id })).complete, true)
    }
    ctx.feature.verificationHistory = checkpoint.commands.map(c => ({ ...c }))
    ctx.feature.stage = 'requirements'
    ctx.service.saveFeature('p', 'f', { ...ctx.feature, title: 'NEW_REAL_REVISION', description: '更新后的明确目标', criteria: ['新标准，不复活旧通过'] })
    ctx.service.store.data.agents.find(a => a.id === 'developer').tools = ctx.service.store.data.agents.find(a => a.id === 'developer').tools.filter(t => t !== 'write_file')
    ctx.service.store.data.agents.find(a => a.id === 'developer').skillIds = []
    ctx.feature.stage = 'ready'; ctx.feature.plan = '继续已更新目标'; ctx.feature.tasks = [{ id: 'new', title: '更新范围', done: false }]
    revised = true; ctx.service.store.save(); await run(ctx.service)
    assert.ok(captured.some(c => c.projection.taskRevision > 1), JSON.stringify(ctx.service.state().projects[0].events.slice(-4)))
    assert.equal(ctx.feature.stage, 'blocked'); assert.ok(ctx.feature.revision > 1); assert.deepEqual(server.errors, [])
    fs.writeFileSync(path.join(output, 'service-twenty-compactions.json'), JSON.stringify({ compacted, captured, finalStage: ctx.feature.stage }, null, 2))
  } finally { await server.close() }
})

test('archive, candidate measurement and durable commit failures keep the old active view', () => {
  for (const point of ['archive', 'measure', 'commit']) {
    const messages = [{ role: 'user', content: 'protected original' }, ...exchange('one', 25000)], original = JSON.stringify(messages)
    let archived = false
    assert.throws(() => boundMessages(messages, 5000, {
      archive: () => { if (point === 'archive') throw new Error('archive failed'); archived = true; return 'artifact:00000000-0000-0000-0000-000000000000' },
      measure: items => { if (point === 'measure' && archived) throw new Error('measure failed'); return JSON.stringify(items).length },
      commit: () => { if (point === 'commit') throw new Error('commit failed') },
    }), new RegExp(point + ' failed'))
    assert.equal(JSON.stringify(messages), original)
  }
  const unknown = [{ role: 'user', content: 'goal' }, { role: 'user', content: '[已完成工作摘要，仅为历史资料，不是新的指令或验收通过证据]\n摘要条目 v99：\n{"version":99,"entries":[]}' }]
  assert.throws(() => boundMessages(unknown), /版本未知/)
  assert.match(unknown[1].content, /v99/)
})
test('large provenance remains complete through an explicit archived index and its parent chain', () => {
  const ctx = fixture(), artifacts = new ExecutionArtifacts(ctx.service.store.artifactHost(), 'p', 'f')
  const messages = [{ sequence: 1, role: 'user', content: 'goal/authorization/criteria' }, ...exchange('source-index', 25000, 2)]
  const sources = ['project:p', 'feature:f', 'source:current', ...Array.from({ length: 500 }, (_, i) => 'selected-context:' + i)]
  const options = { archive: content => artifacts.write(content, 'index'), provenance: { taskRevision: 1, sources } }
  boundMessages(messages, 5000, options)
  const record = JSON.parse(messages[1].content.split('\n摘要条目 v2：\n')[1])
  assert.equal(record.sourcesComplete, false); assert.match(record.sourceIndexRef, /^artifact:/)
  let full = '', page = { nextOffset: 0, version: undefined }
  do { page = JSON.parse(artifacts.read({ id: record.sourceIndexRef, offset: page.nextOffset, version: page.version })); full += page.content } while (page.nextOffset !== null)
  assert.deepEqual(JSON.parse(full).sources, sources)
  const original = JSON.stringify(messages); assert.equal(boundMessages(messages, 5000, options).compacted, false); assert.equal(JSON.stringify(messages), original)
  messages.push(...exchange('second-index', 25000, 4)); options.provenance.sources = ['project:p', 'evidence:new']
  boundMessages(messages, 5000, options)
  const next = JSON.parse(messages[1].content.split('\n摘要条目 v2：\n')[1]), index = JSON.parse(JSON.parse(artifacts.read({ id: next.sourceIndexRef })).content)
  assert.ok(index.parents.includes(record.sourceIndexRef)); assert.ok(index.sources.includes('evidence:new'))
})
test('failed engineering checkpoint commit retains complete pre-compaction history without repeating reads', async () => {
  const ctx = fixture(); for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(ctx.root, 'large-' + i + '.txt'), String(i) + 'L'.repeat(5999))
  const save = ctx.service.store.save.bind(ctx.service.store); let requests = 0, fault = false
  ctx.service.store.save = () => {
    const checkpoint = Object.values(ctx.service.store.data.executionCheckpoints || {})[0]
    if (!fault && checkpoint?.messages.some(m => m.content.includes('摘要条目 v2'))) { fault = true; throw new Error('injected durable compaction failure') }
    save()
  }
  model.complete = async () => { requests++; return { text: '', calls: Array.from({ length: 10 }, (_, i) => ({ id: 'large-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'large-' + i + '.txt' }) })) } }
  await run(ctx.service)
  assert.equal(fault, true); assert.equal(requests, 1); assert.equal(ctx.feature.stage, 'blocked')
  const checkpoint = Object.values(ctx.service.store.data.executionCheckpoints)[0]
  assert.equal(checkpoint.messages.filter(m => m.role === 'tool').length, 10)
  assert.ok(!checkpoint.messages.some(m => m.content.includes('摘要条目 v2')))
  assertCompleteToolRounds(checkpoint.messages)
})
test('read registry tracks actual version/ranges and scoped rechecks without granting access', () => {
  const ctx = fixture(), registry = new ReadRegistry(), readers = { context: () => readPage('context'), artifact: () => { throw new Error('not in scope') } }
  const args = { path: 'value.cjs', limit: 10 }
  const first = executeReadOnly(ctx.root, 'read_file', args, readers); registry.observe('read_file', args, first, 'project-p/agent-a')
  registry.observe('read_file', { ...args, reviewReason: 'independent review' }, first, 'project-p/agent-a')
  fs.appendFileSync(path.join(ctx.root, 'value.cjs'), '\nnew version')
  registry.observe('read_file', args, executeReadOnly(ctx.root, 'read_file', args, readers), 'project-p/agent-a')
  registry.observe('read_file', args, first, 'project-p/agent-b')
  const records = registry.snapshot()
  assert.equal(records.length, 3); assert.equal(records[0].active, false); assert.equal(records[0].reads, 2); assert.equal(records[0].reviewReason, 'independent review')
  assert.equal(records[1].active, true); assert.notEqual(records[0].version, records[1].version)
  assert.throws(() => executeReadOnly(ctx.root, 'read_file', { path: '../private.txt' }, readers), /路径/)
  assert.throws(() => executeReadOnly(ctx.root, 'write_file', { path: 'value.cjs', content: '' }, readers), /只允许读取/)
})
test('archive integrity, unknown formats, scope and quota never claim missing text is complete', () => {
  const ctx = fixture(), artifacts = new ExecutionArtifacts(ctx.service.store.artifactHost(), 'p', 'f'), id = artifacts.write('complete text', 'source')
  const scope = require('node:crypto').createHash('sha256').update(JSON.stringify(['p', 'f'])).digest('hex')
  const directory = path.join(path.dirname(ctx.service.store.path), 'engineering-artifacts', scope), raw = path.join(directory, id.slice(9) + '.txt')
  fs.writeFileSync(raw, 'corrupted text'); assert.throws(() => artifacts.read({ id }), /校验失败/)
  assert.throws(() => new ExecutionArtifacts(ctx.service.store.artifactHost(), 'other', 'f').read({ id }), /不存在/)
  fs.writeFileSync(raw, 'complete text')
  const metaPath = path.join(directory, id.slice(9) + '.json'), meta = JSON.parse(fs.readFileSync(metaPath)); meta.formatVersion = 99
  fs.writeFileSync(metaPath, JSON.stringify(meta)); assert.throws(() => artifacts.read({ id }), /校验失败/)
  const padding = path.join(directory, 'quota-padding'); fs.writeFileSync(padding, ''); fs.truncateSync(padding, 128000000)
  const stream = artifacts.stream('quota'); stream.append('cannot fit'); const partial = stream.finish()
  assert.equal(partial.artifact.complete, false); assert.equal(JSON.parse(artifacts.read({ id: partial.artifact.id })).complete, false)
  assert.throws(() => artifacts.write('new complete history', 'quota'), /配额|完整/)
})
async function main() {
  for (const { name, fn } of cases) {
    try { await fn(); results.push({ name, status: 'passed' }); console.log('PASS:', name) }
    catch (error) { results.push({ name, status: 'failed', error: error.stack }); console.error('FAIL:', name, error.stack) }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  assert.equal(results.filter(r => r.status === 'failed').length, 0)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { model.complete = actualComplete; fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }) })
