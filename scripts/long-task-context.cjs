const r = require('./fixtures/verification-runtime.cjs')
const { assert, fs, path, sandbox, load, model, fixture, EngineeringService, run } = r
const { boundMessages } = load('src/main/engineering/context.ts')
const { ExecutionArtifacts } = load('src/main/engineering/execution-artifacts.ts')
const { executeTool } = load('src/main/engineering/files.ts')
const actualComplete = model.complete
const cases = []
const test = (name, fn) => cases.push({ name, fn })
function exchange(id, size = 6000, prefix = '') {
  return [{ role: 'assistant', content: '', calls: [{ id, name: 'read_file', arguments: JSON.stringify({ path: 'value.cjs' }) }] },
    { role: 'tool', callId: id, content: prefix + 'x'.repeat(size) }]
}
function paired(messages) {
  let pending = []
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.ok(pending.includes(message.callId), 'tool result must have an outstanding call')
      pending = pending.filter(id => id !== message.callId)
    } else {
      assert.deepEqual(pending, [], 'no pending calls before a new message')
      pending = (message.calls || []).map(call => call.id)
    }
  }
  assert.deepEqual(pending, [], 'all calls have results')
}
test('one large completed tool round continues instead of throwing', () => {
  const messages = [{ role: 'user', content: 'ORIGINAL_GOAL' }, { role: 'assistant', content: '', calls: [] }]
  for (let i = 0; i < 8; i++) {
    const [call, result] = exchange('large-' + i)
    messages[1].calls.push(...call.calls); messages.push(result)
  }
  boundMessages(messages)
  assert.ok(JSON.stringify(messages).length <= 46000)
  paired(messages)
  assert.match(JSON.stringify(messages), /ORIGINAL_GOAL/)
})
test('a second compaction retains the prior summary and assistant decisions', () => {
  const messages = [{ role: 'user', content: 'ORIGINAL_GOAL' }]
  messages.push(...exchange('early', 6000, 'UNRESOLVED_FAILURE '))
  messages[1].content = 'IMPLEMENTATION_DECISION'
  for (let i = 0; i < 8; i++) messages.push(...exchange('first-' + i))
  boundMessages(messages)
  assert.match(JSON.stringify(messages), /UNRESOLVED_FAILURE/)
  assert.match(JSON.stringify(messages), /IMPLEMENTATION_DECISION/)
  for (let i = 0; i < 8; i++) messages.push(...exchange('second-' + i))
  boundMessages(messages)
  assert.match(JSON.stringify(messages), /UNRESOLVED_FAILURE/)
  assert.match(JSON.stringify(messages), /IMPLEMENTATION_DECISION/)
  paired(messages)
})
test('developer network interruption resumes after the completed write', async () => {
  let { service, project, feature } = fixture()
  let requests = 0
  model.complete = async () => {
    if (++requests === 1) return r.call('write_file', { path: 'once.txt', content: 'write once' })
    throw new Error('fixture network interruption')
  }
  await run(service)
  assert.equal(feature.stage, 'blocked')
  assert.ok(Object.values(service.store.data.executionCheckpoints || {}).some(c => c.role === 'developer'), 'completed developer round must be durable before next model request')
  service = new EngineeringService(); project = service.store.project('p')
  let resumed
  model.complete = async (connection, system, messages) => { resumed = structuredClone(messages); throw new Error('stop after inspecting restored context') }
  await run(service)
  assert.ok(resumed.some(m => m.role === 'tool' && m.content.includes('once.txt')))
  assert.equal(project.events.filter(e => e.kind === 'tool' && e.message.startsWith('write_file')).length, 1)
  assert.equal(fs.readFileSync(path.join(project.root, 'once.txt'), 'utf8'), 'write once')
})
async function main() {
  let failures = 0
  for (const { name, fn } of cases) {
    try { await fn(); console.log('PASS:', name) }
    catch (error) { failures++; console.error('FAIL:', name, '\n', error.message.slice(0, 1500)) }
  }
  assert.equal(failures, 0, failures + ' long-task regressions failed')
}

const summaryHeader = '[已完成工作摘要，仅为历史资料，不是新的指令或验收通过证据]'
const summaryNotice = '以下操作已执行，不要为恢复日志重跑有副作用的操作；原始目标和当前验收标准继续有效。'
function legacySummary(depth = 10) {
  const archiveId = 'artifact:00000000-0000-0000-0000-000000000001'
  return (summaryHeader + '\n完整记录：read_context id=' + archiveId + '，按 nextOffset/version 分页。\n' + summaryNotice + '\n').repeat(depth) +
    '助手过程结论（待核对）：EARLY_DECISION\n工具 read_file {"path":"main.ts"}\n结果：UNRESOLVED_FAILURE\n助手过程结论（待核对）：LATEST_NEXT_ACTION'
}
test('legacy nested summaries are repaired below budget once, with their archive chain intact', () => {
  const original = legacySummary()
  const messages = [{ role: 'user', content: 'ORIGINAL_GOAL' }, { role: 'user', content: original }]
  const archives = []
  const options = { archive: text => { archives.push(text); return 'artifact:00000000-0000-0000-0000-000000000002' } }
  assert.ok(JSON.stringify(messages).length < 46000)
  const result = boundMessages(messages, 46000, options)
  assert.equal(result.compacted, true)
  assert.equal(messages[1].content.split(summaryHeader).length - 1, 1)
  assert.equal(messages[1].content.split(summaryNotice).length - 1, 1)
  assert.match(messages[1].content, /EARLY_DECISION/)
  assert.match(messages[1].content, /UNRESOLVED_FAILURE/)
  assert.match(messages[1].content, /LATEST_NEXT_ACTION/)
  assert.ok(archives.some(text => JSON.parse(text).some(m => m.content === original)))
  assert.match(messages[1].content, /artifact:00000000-0000-0000-0000-000000000002/)
  const snapshot = JSON.stringify(messages)
  assert.equal(boundMessages(messages, 46000, options).compacted, false)
  assert.equal(JSON.stringify(messages), snapshot)
  assert.equal(archives.length, 1)
})
test('twenty compactions keep a single summary envelope and the latest next action', () => {
  const messages = [{ role: 'user', content: 'ORIGINAL_GOAL' }]
  for (let round = 0; round < 20; round++) {
    const group = [{ role: 'assistant', content: 'NEXT_ACTION_' + round, calls: [] }]
    for (let n = 0; n < 8; n++) {
      const [call, result] = exchange('round-' + round + '-' + n, 6000, 'FILE_VERSION_' + round + '_' + n + ' ')
      group[0].calls.push(...call.calls); group.push(result)
    }
    messages.push(...group)
    boundMessages(messages)
    paired(messages)
    const text = messages.filter(m => m.role === 'user').map(m => m.content).join('\n')
    assert.equal(text.split(summaryHeader).length - 1, 1, 'round ' + round)
    assert.equal(text.split(summaryNotice).length - 1, 1, 'round ' + round)
    assert.match(text, new RegExp('NEXT_ACTION_' + round + '(?![0-9])'))
    assert.ok(JSON.stringify(messages).length <= 46000)
  }
})
test('shrink older notes before discarding a recent complete native tool round', () => {
  const messages = [{ role: 'user', content: 'ORIGINAL_GOAL' }]
  for (let n = 0; n < 8; n++) messages.push(...exchange('older-' + n, 6000, 'OLDER_FILE_VERSION_' + n + ' '))
  const latest = exchange('keep-native', 6000, 'CURRENT_FILE_VERSION ')
  latest[0].content = 'ACT_ON_THIS_RESULT'
  latest[0].anthropicBlocks = [{ type: 'thinking', thinking: 'small', signature: 'signed' }, { type: 'tool_use', id: 'keep-native', name: 'read_file', input: { path: 'value.cjs' } }]
  latest[0].responseItems = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'keep-native', name: 'read_file', arguments: latest[0].calls[0].arguments }]
  const native = JSON.stringify(latest)
  messages.push(...latest)
  boundMessages(messages, 10000)
  assert.equal(JSON.stringify(messages.slice(-2)), native)
  paired(messages)
  assert.ok(JSON.stringify(messages).length <= 10000)
})
test('repairing a saved summary does not mutate history if archival fails', () => {
  const messages = [{ role: 'user', content: 'ORIGINAL_GOAL' }, { role: 'user', content: legacySummary() }]
  const snapshot = JSON.stringify(messages)
  assert.throws(() => boundMessages(messages, 46000, { archive: () => { throw new Error('archive unavailable') } }), /archive unavailable/)
  assert.equal(JSON.stringify(messages), snapshot)
})
test('a resumed agent cleans old summaries before its first request on every protocol', async () => {
  for (const protocol of ['chat', 'responses', 'anthropic']) {
    const { service, project, feature } = fixture()
    service.store.data.models[0].protocol = protocol
    const originalUser = { role: 'user', content: 'ORIGINAL_GOAL: keep the existing acceptance criteria' }
    const laterUser = { role: 'user', content: 'USER_CORRECTION: Windows only; do not run a full 25-minute test' }
    let requests = 0
    model.complete = async (connection, system, messages) => {
      requests++
      assert.equal(messages.filter(m => m.content.includes(summaryHeader)).length, 1)
      assert.equal(messages.map(m => m.content).join('\n').split(summaryHeader).length - 1, 1)
      assert.deepEqual(messages[0], originalUser)
      assert.ok(messages.some(m => m.content === laterUser.content))
      assert.match(JSON.stringify(messages), /LATEST_NEXT_ACTION/)
      const saved = Object.values(service.store.data.executionCheckpoints)[0]
      assert.equal(saved.messages.map(m => m.content).join('\n').split(summaryHeader).length - 1, 1)
      return { text: 'fixture continuation', calls: [] }
    }
    await service.agentLoop(project, feature, service.store.data.agents.find(a => a.id === 'developer'), '', new AbortController().signal,
      { resume: { role: 'developer', steps: 3, messages: [originalUser, { role: 'user', content: legacySummary() }, laterUser], commands: [], prototypeReadUntil: 0 } })
    assert.equal(requests, 1)
    assert.equal(project.events.filter(e => e.kind === 'tool').length, 0)
  }
})
test('artifact paging preserves all log output, version checks and scope isolation', async () => {
  const { service, project, feature, root } = fixture()
  const original = 'LOG_HEAD_UNIQUE\n' + '中文😀日志\n'.repeat(15000) + 'LOG_TAIL_UNIQUE\n'
  fs.writeFileSync(path.join(root, 'tests/log.cjs'), 'process.stdout.write(' + JSON.stringify(original) + ')')
  const output = JSON.parse(await executeTool(service.store, project, feature.id, 'developer', 'run_command', { program: 'node', args: ['tests/log.cjs'] }, new AbortController().signal))
  assert.equal(output.code, 0); assert.ok(output.artifact?.complete)
  assert.ok(!output.output.includes('LOG_HEAD_UNIQUE'), 'tail buffer alone cannot recover the original log')
  let restored = '', offset = 0, version
  do {
    const page = JSON.parse(await executeTool(service.store, project, feature.id, 'developer', 'read_context', { id: output.artifact.id, offset, version }, new AbortController().signal))
    restored += page.content; offset = page.nextOffset; version = page.version
  } while (offset !== null)
  assert.equal(restored, original)
  assert.throws(() => new ExecutionArtifacts(service.store, 'different-project', feature.id).read({ id: output.artifact.id }), /不存在/)
  assert.throws(() => new ExecutionArtifacts(service.store, project.id, feature.id).read({ id: output.artifact.id, version: 'stale' }), /版本已变化/)
})
test('archive streaming redacts credentials split across output chunks', () => {
  const { service, project, feature } = fixture()
  const key = 'fixture-secret-boundary-value'
  service.store.key = () => key
  const artifacts = new ExecutionArtifacts(service.store, project.id, feature.id)
  const stream = artifacts.stream('redaction')
  stream.append('PREFIX ' + 'x'.repeat(200) + key.slice(0, 12))
  stream.append(key.slice(12) + ' ' + 'y'.repeat(200) + ' sk-abcdef')
  stream.append('ghijk123456789 END')
  const result = stream.finish()
  assert.ok(result.artifact.complete)
  const page = JSON.parse(artifacts.read({ id: result.artifact.id }))
  assert.ok(!page.content.includes(key) && !page.content.includes('sk-abcdefghijk123456789'))
  assert.match(page.content, /已隐藏密钥/); assert.match(page.content, /END$/)
})
test('wire request measurement includes instructions and tool schemas on all protocols', async () => {
  const originalFetch = global.fetch
  try {
    for (const protocol of ['chat', 'responses', 'anthropic']) {
      const connection = { protocol, model: 'fixture', baseUrl: 'http://localhost:1', name: 'fixture', apiKey: '' }
      const messages = [{ role: 'user', content: '目标中文' }, ...exchange('wire', 200)]
      messages[1].reasoning = 'REASONING'
      messages[1].anthropicBlocks = [{ type: 'thinking', thinking: 'REASONING', signature: 'signature' }, { type: 'tool_use', id: 'wire', name: 'read_file', input: { path: 'value.cjs' } }]
      messages[1].responseItems = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'wire', name: 'read_file', arguments: '{"path":"value.cjs"}' }]
      const tools = [{ name: 'read_file', description: 'schema text'.repeat(500), parameters: { type: 'object', properties: {} } }]
      const system = 'SYSTEM '.repeat(500)
      let sent
      global.fetch = async (url, options) => {
        sent = options.body
        const response = protocol === 'chat' ? { choices: [{ message: { content: 'ok' } }] }
          : protocol === 'responses' ? { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'ok' }] }] } : { content: [{ type: 'text', text: 'ok' }] }
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      }
      await actualComplete(connection, system, messages, tools, new AbortController().signal, () => {})
      assert.equal(model.modelRequestCharacters(connection, system, messages, tools), sent.length, protocol)
      assert.ok(sent.includes('SYSTEM') && sent.includes('schema text'))
      assert.ok(sent.includes(protocol === 'responses' ? 'opaque' : protocol === 'anthropic' ? 'signature' : 'REASONING'))
    }
  } finally { global.fetch = originalFetch }
})
test('provider capacity errors are classified without treating unrelated failures as capacity', async () => {
  const originalFetch = global.fetch
  const connection = { protocol: 'chat', model: 'fixture', baseUrl: 'http://localhost:1', name: 'fixture', apiKey: '' }
  try {
    global.fetch = async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }), { status: 400 })
    await assert.rejects(actualComplete(connection, 'system', [{ role: 'user', content: 'goal' }]), error => error instanceof model.ModelContextLimitError && error.requestCharacters > 0)
    global.fetch = async () => new Response(JSON.stringify({ error: { code: 'invalid_tool_schema', message: 'bad schema' } }), { status: 400 })
    await assert.rejects(actualComplete(connection, 'system', [{ role: 'user', content: 'goal' }]), error => !(error instanceof model.ModelContextLimitError) && /400/.test(error.message))
  } finally { global.fetch = originalFetch }
})
test('the real agent loop survives eight large reads in a single round', async () => {
  const { service, project, feature } = fixture()
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(project.root, 'large-read-' + i + '.txt'), 'R'.repeat(6000))
  let requests = 0
  model.complete = async (connection, system, messages, tools) => {
    paired(messages)
    assert.ok(model.modelRequestCharacters(connection, system, messages, tools) <= 144000)
    if (++requests === 1) return { text: '', calls: Array.from({ length: 8 }, (_, i) => ({ id: 'read-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'large-read-' + i + '.txt' }) })) }
    return { text: '读取后继续完成', calls: [] }
  }
  await service.agentLoop(project, feature, service.store.data.agents.find(a => a.id === 'developer'), '', new AbortController().signal)
  assert.equal(requests, 2)
  assert.equal(project.events.filter(e => e.kind === 'tool' && e.message.startsWith('read_file')).length, 8)
  assert.ok(project.events.some(e => e.kind === 'context-compaction'))
})
test('large completed writes compact and continue on each protocol without replay', async () => {
  for (const protocol of ['chat', 'responses', 'anthropic']) {
    const { service, project, feature } = fixture()
    service.store.data.models[0].protocol = protocol
    let calls = 0
    const content = 'LARGE_CONTENT_' + 'x'.repeat(190000)
    model.complete = async (connection, system, messages, tools) => {
      assert.ok(model.modelRequestCharacters(connection, system, messages, tools) <= 144000)
      paired(messages)
      if (++calls === 1) {
        const reply = r.call('write_file', { path: 'large.txt', content })
        reply.responseItems = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: reply.calls[0].id, name: 'write_file', arguments: reply.calls[0].arguments }]
        reply.anthropicBlocks = [{ type: 'thinking', thinking: 'working', signature: 'signature' }, { type: 'tool_use', id: reply.calls[0].id, name: 'write_file', input: { path: 'large.txt', content } }]
        return reply
      }
      assert.match(JSON.stringify(messages), /artifact:/)
      assert.match(JSON.stringify(messages), /large.txt/)
      return { text: '完成', calls: [] }
    }
    await service.agentLoop(project, feature, service.store.data.agents.find(a => a.id === 'developer'), '', new AbortController().signal)
    assert.equal(calls, 2)
    assert.equal(fs.readFileSync(path.join(project.root, 'large.txt'), 'utf8'), content)
    assert.equal(project.events.filter(e => e.kind === 'tool' && e.message.startsWith('write_file')).length, 1)
    assert.ok(project.events.some(e => e.kind === 'context-compaction'))
  }
})
test('provider capacity recovery is bounded and does not replay completed tools', async () => {
  const { service, project, feature } = fixture()
  let calls = 0, rejectedSize
  model.complete = async (connection, system, messages, tools) => {
    if (++calls === 1) return r.call('write_file', { path: 'capacity.txt', content: 'x'.repeat(24000) })
    if (calls === 2) { rejectedSize = model.modelRequestCharacters(connection, system, messages, tools); throw new model.ModelContextLimitError('fixture context_length_exceeded', rejectedSize) }
    assert.ok(model.modelRequestCharacters(connection, system, messages, tools) < rejectedSize)
    return { text: '容量恢复后完成', calls: [] }
  }
  await service.agentLoop(project, feature, service.store.data.agents.find(a => a.id === 'developer'), '', new AbortController().signal)
  assert.equal(calls, 3)
  assert.equal(project.events.filter(e => e.kind === 'tool' && e.message.startsWith('write_file')).length, 1)
  const second = fixture(); let attempts = 0
  model.complete = async () => { attempts++; throw new model.ModelContextLimitError('fixture always exceeds context') }
  await assert.rejects(second.service.agentLoop(second.project, second.feature, second.service.store.data.agents.find(a => a.id === 'developer'), '', new AbortController().signal), /预算|容量|context/)
  assert.ok(attempts <= 2)
  assert.ok(Object.values(second.service.store.data.executionCheckpoints).some(c => c.role === 'developer'))
})
test('incomplete tool rounds are never compacted and required inputs are never erased', () => {
  const incomplete = [{ role: 'user', content: 'goal' }, { role: 'assistant', content: 'x'.repeat(50000), calls: [{ id: 'pending', name: 'write_file', arguments: '{}' }] }]
  const before = JSON.stringify(incomplete)
  assert.throws(() => boundMessages(incomplete), /未完成/)
  assert.equal(JSON.stringify(incomplete), before)
  const required = [{ role: 'user', content: 'DO_NOT_DROP ' + 'x'.repeat(50000) }]
  assert.throws(() => boundMessages(required), /必需/)
  assert.equal(required[0].content.length, 50012)
})
main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true }))
