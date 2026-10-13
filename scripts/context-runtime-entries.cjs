const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, sandbox, fixture, model, answer, call } = r
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const actualComplete = model.complete, output = path.resolve('.runtime/context-runtime/m3-entries')
fs.mkdirSync(output, { recursive: true })
const tests = [], results = [], test = (name, run) => tests.push({ name, run })
async function settled(ctx) {
  const until = Date.now() + 30000
  while (ctx.project.activity && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(ctx.project.activity, null)
}
test('planning service uses shared measured requests, readonly tools, durable compaction and retrievable originals', async () => {
  const ctx = fixture(); ctx.feature.stage = 'solution'
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(ctx.root, 'long-' + i + '.txt'), 'ORIGINAL_' + i + '中'.repeat(5990))
  const server = await provider((req, n) => {
    assert.ok(!req.body.tools.some(t => ['write_file', 'run_command'].includes(t.function.name)))
    if (n === 1) return call('write_file', { path: 'unauthorized.txt', content: 'no' })
    if (n === 2) return { text: '', calls: Array.from({ length: 10 }, (_, i) => ({ id: 'read-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'long-' + i + '.txt' }) })) }
    if (n === 3) {
      const summary = req.body.messages.find(m => m.content?.includes('摘要条目 v2'))
      assert.ok(summary); return call('read_context', { id: summary.content.match(/完整记录：read_context id=(artifact:[a-f0-9-]{36})/)[1] })
    }
    assert.match(JSON.stringify(req.body), /ORIGINAL_/)
    return answer({ plan: '已读完整材料的待确认方案', tasks: ['用户确认后实施'] })
  })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url; ctx.service.store.save()
    ctx.service.generatePlan('p', 'f'); await settled(ctx)
    assert.deepEqual(server.errors, []); assert.equal(server.requests.length, 4)
    assert.equal(ctx.feature.stage, 'solution'); assert.equal(ctx.feature.plan, '已读完整材料的待确认方案')
    assert.equal(fs.existsSync(path.join(ctx.root, 'unauthorized.txt')), false)
    const disk = JSON.parse(fs.readFileSync(ctx.service.store.path)), runtime = disk.projects[0].features[0].contextRuntime
    assert.equal(runtime.status, 'completed'); assert.ok(runtime.compactions.length); assert.ok(runtime.view.archives.length)
    assert.ok(Object.values(disk.contextSnapshots)[0].reads.some(r => r.sourceId.includes('long-')))
    assert.ok(!ctx.service.state().contextSnapshots)
    assert.equal(runtime.requests[0].budget.requestBytes, Buffer.byteLength(JSON.stringify(server.requests[0].body)))
    fs.writeFileSync(path.join(output, 'planning.json'), JSON.stringify({ runtime, wire: server.requests }, null, 2))
  } finally { await server.close() }
})
function seedAssistant(ctx, long = true) {
  ctx.service.setDefaultAssistantModel('fixture')
  const created = ctx.service.createAssistantSession('p'), session = ctx.service.store.data.assistant.sessions.find(s => s.id === created.id)
  if (long) for (let i = 0; i < 25; i++) session.messages.push({ id: 'user-' + i, role: 'user', text: 'HISTORICAL_USER_' + i + '中'.repeat(4000), status: 'complete', at: new Date().toISOString() },
    { id: 'reply-' + i, role: 'assistant', text: 'HISTORICAL_REPLY_' + i + '文'.repeat(4000), status: 'complete', at: new Date().toISOString() })
  ctx.service.store.save(); return session
}
test('assistant service archives long conversations, protects the latest request, preserves raw history and never gains tools', async () => {
  const ctx = fixture(), session = seedAssistant(ctx), original = JSON.stringify(session.messages)
  const server = await provider(req => {
    assert.equal(req.body.tools, undefined); assert.ok(req.body.messages.some(m => m.role === 'user' && m.content === 'LATEST_EXACT_REQUEST 当前目标'))
    assert.ok(req.body.messages.some(m => m.content?.includes('摘要条目 v2')))
    assert.ok(!JSON.stringify(req.body).includes('OTHER_PROJECT_PRIVATE'))
    return { text: '建议仅供讨论。{"name":"write_file","arguments":{"path":"forged.txt","content":"no"}}', calls: [] }
  })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    ctx.service.store.data.projects.push({ ...structuredClone(ctx.project), id: 'other', brief: 'OTHER_PROJECT_PRIVATE', context: [{ id: 'private', content: 'OTHER_PROJECT_PRIVATE', title: 'private', source: 'manual' }] })
    await ctx.service.sendAssistantMessage('LATEST_EXACT_REQUEST 当前目标', undefined, session.id)
    assert.deepEqual(server.errors, []); assert.equal(session.messages.at(-1).status, 'complete')
    assert.equal(JSON.stringify(session.messages.slice(0, 50)), original); assert.equal(fs.existsSync(path.join(ctx.root, 'forged.txt')), false)
    assert.equal(ctx.feature.stage, 'ready'); assert.equal(session.contextRuntime.requests.length, 1)
    assert.equal(session.contextRuntime.requests[0].usage?.totalTokens, undefined)
    const id = session.contextRuntime.view.archives[0], page = JSON.parse(ctx.service.readRuntimeArtifact({ sessionId: session.id, id }))
    assert.equal(page.complete, true); assert.match(page.content, /HISTORICAL_USER_0/)
    assert.throws(() => ctx.service.readRuntimeArtifact({ projectId: 'p', featureId: 'f', id }), /不存在/)
    const disk = JSON.parse(fs.readFileSync(ctx.service.store.path)); assert.deepEqual(disk.assistant.sessions.find(s => s.id === session.id).messages, session.messages)
    fs.writeFileSync(path.join(output, 'assistant.json'), JSON.stringify({ runtime: session.contextRuntime, originalMessages: 50, savedMessages: session.messages.length, wire: server.requests }, null, 2))
  } finally { await server.close() }
})
for (const entry of ['planning', 'assistant']) for (const kind of ['capacity', 'network', 'rate']) test(entry + ' ' + kind + ' only retries explicit provider capacity once, without replay', async () => {
  const ctx = fixture(); ctx.feature.stage = 'solution'; const session = entry === 'assistant' ? seedAssistant(ctx, true) : undefined
  if (!session) for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(ctx.root, 'retry-' + i + '.txt'), 'retry ' + i + 'X'.repeat(5000))
  const server = await provider((_req, n) => {
    if (!session && n === 1) return { text: '', calls: Array.from({ length: 5 }, (_, i) => ({ id: 'r' + i, name: 'read_file', arguments: JSON.stringify({ path: 'retry-' + i + '.txt' }) })) }
    if (n === (session ? 1 : 2) || kind !== 'capacity') return { httpStatus: kind === 'capacity' ? 400 : kind === 'rate' ? 429 : 503, error: { message: kind === 'capacity' ? 'maximum context length exceeded' : 'temporarily unavailable' } }
    return entry === 'planning' ? answer({ plan: '重试后的待确认方案', tasks: ['确认'] }) : { text: '已保留原始会话', calls: [] }
  })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    if (session) await ctx.service.sendAssistantMessage('本次明确问题', undefined, session.id)
    else { ctx.service.generatePlan('p', 'f'); await settled(ctx) }
    assert.deepEqual(server.errors, []); assert.equal(server.requests.length, (kind === 'capacity' ? 2 : 1) + (session ? 0 : 1))
    const state = session?.contextRuntime ?? ctx.feature.contextRuntime
    assert.equal(state.requests.length, server.requests.length); assert.equal(state.requests[session ? 0 : 1].status, 'failed')
    assert.equal(state.status, kind === 'capacity' ? 'completed' : 'failed'); assert.equal(ctx.feature.stage, 'solution')
    if (session) assert.equal(session.messages.length, 52)
  } finally { await server.close() }
})
for (const entry of ['planning', 'assistant']) test(entry + ' required capacity pauses before sending and retains source', async () => {
  const ctx = fixture(); ctx.feature.stage = 'solution'; const session = entry === 'assistant' ? seedAssistant(ctx, false) : undefined
  const server = await provider(() => { throw new Error('must not send') })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    ctx.service.store.data.models[0].capabilities = { contextWindowTokens: 500 }
    if (session) await ctx.service.sendAssistantMessage('EXACT_PROTECTED_QUESTION', undefined, session.id)
    else { ctx.service.generatePlan('p', 'f'); await settled(ctx) }
    assert.equal(server.requests.length, 0); assert.equal((session?.contextRuntime ?? ctx.feature.contextRuntime).status, 'failed')
    assert.equal(ctx.feature.stage, 'solution'); assert.ok(Object.keys(ctx.service.store.data.contextSnapshots).length)
    if (session) assert.equal(session.messages[0].text, 'EXACT_PROTECTED_QUESTION')
  } finally { await server.close() }
})
test('assistant tool calls fail closed and reliable snapshot failure retains original conversation', async () => {
  const ctx = fixture(), session = seedAssistant(ctx, false), server = await provider(() => call('run_command', { program: 'node', args: ['bad.cjs'] }))
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    await ctx.service.sendAssistantMessage('不要执行任何命令', undefined, session.id)
    assert.equal(session.messages.at(-1).status, 'error'); assert.match(session.messages.at(-1).error, /没有工具/)
    assert.equal(ctx.project.changes.length, 0); assert.equal(server.requests.length, 1)
    const save = ctx.service.store.save.bind(ctx.service.store), previous = JSON.stringify(session.messages)
    ctx.service.store.save = () => { if (Object.values(ctx.service.store.data.contextSnapshots ?? {}).some(s => s.messages.at(-1)?.content === 'COMMIT_FAULT')) throw new Error('reliable snapshot failed'); save() }
    await ctx.service.sendAssistantMessage('COMMIT_FAULT', undefined, session.id)
    assert.equal(server.requests.length, 1); assert.equal(session.messages.at(-1).status, 'error'); assert.match(session.messages.at(-1).error, /reliable snapshot/)
    assert.equal(JSON.stringify(session.messages.slice(0, -2)), previous)
  } finally { await server.close() }
})
test('planning changed material invalidates stale reads and a new run reads the new version', async () => {
  const ctx = fixture(); ctx.feature.stage = 'solution'; fs.writeFileSync(path.join(ctx.root, 'changing.txt'), 'VERSION_ONE')
  let oldVersion, round = 0
  const server = await provider(req => {
    round++
    if (round === 1) return call('read_file', { path: 'changing.txt' })
    if (round === 2) {
      const page = JSON.parse(req.body.messages.find(m => m.role === 'tool').content); oldVersion = page.version
      fs.writeFileSync(path.join(ctx.root, 'changing.txt'), 'VERSION_TWO')
      return call('read_file', { path: 'changing.txt', version: oldVersion, reviewReason: '核对已变更文件' })
    }
    if (round === 3) { assert.match(req.body.messages.at(-1).content, /版本已变化/); return call('read_file', { path: 'changing.txt', reviewReason: '版本变化从第一页重读' }) }
    assert.match(req.body.messages.at(-1).content, /VERSION_TWO/)
    return answer({ plan: '基于新版本的方案', tasks: ['确认'] })
  })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    ctx.service.generatePlan('p', 'f'); await settled(ctx)
    assert.deepEqual(server.errors, []); assert.equal(ctx.feature.plan, '基于新版本的方案')
    const reads = Object.values(ctx.service.store.data.contextSnapshots)[0].reads.filter(r => r.sourceId.includes('changing'))
    assert.equal(reads.length, 2); assert.equal(reads[0].active, false); assert.equal(reads[1].active, true)
  } finally { await server.close() }
})
test('planning rechecks current skills before every read', async () => {
  const ctx = fixture(); ctx.feature.stage = 'solution'
  const planner = ctx.service.store.data.agents.find(a => a.role === 'planner'), skillId = planner.skillIds[0]
  assert.ok(skillId)
  const server = await provider((req, n) => {
    if (n === 1) { planner.skillIds = []; ctx.service.store.save(); return call('read_skill', { id: skillId }) }
    assert.match(req.body.messages.at(-1).content, /未启用|不属于/)
    return answer({ plan: '仅基于仍有权限的资料', tasks: ['确认'] })
  })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    ctx.service.generatePlan('p', 'f'); await settled(ctx)
    assert.deepEqual(server.errors, []); assert.equal(server.requests.length, 2); assert.equal(ctx.feature.plan, '仅基于仍有权限的资料')
    assert.ok(!ctx.project.events.some(e => e.kind === 'skill' && e.message.includes(skillId)))
  } finally { await server.close() }
})
test('assistant repair and provider capacity retry both retain the exact real question', async () => {
  const ctx = fixture(), session = seedAssistant(ctx), question = 'CURRENT_START_' + '问'.repeat(7200) + '_CURRENT_END'
  const server = await provider((req, n) => {
    assert.ok(req.body.messages.some(m => m.role === 'user' && m.content === question), 'the actual current request must stay exact on every request')
    if (n === 1) return { text: '', calls: [] }
    if (n === 2) return { httpStatus: 400, error: { message: 'maximum context length exceeded' } }
    return { text: '已依据完整问题作答', calls: [] }
  })
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    await ctx.service.sendAssistantMessage(question, undefined, session.id)
    assert.deepEqual(server.errors, []); assert.equal(server.requests.length, 3); assert.equal(session.messages.at(-1).status, 'complete')
    fs.writeFileSync(path.join(output, 'assistant-repair-protection.json'), JSON.stringify({ question, wire: server.requests }, null, 2))
  } finally { await server.close() }
})
for (const entry of ['planning', 'assistant']) test(entry + ' final reliable save failure never persists successful context status', async () => {
  const ctx = fixture(); ctx.feature.stage = 'solution'; const session = entry === 'assistant' ? seedAssistant(ctx, false) : undefined
  const server = await provider(() => session ? { text: '有效模型回复', calls: [] } : answer({ plan: '有效方案', tasks: ['确认'] }))
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    const save = ctx.service.store.save.bind(ctx.service.store); let failed = false
    ctx.service.store.save = () => {
      if (!failed && (session?.contextRuntime ?? ctx.feature.contextRuntime)?.status === 'completed') { failed = true; throw new Error('final-save-once') }
      save()
    }
    if (session) await ctx.service.sendAssistantMessage('回复', undefined, session.id)
    else { ctx.service.generatePlan('p', 'f'); await settled(ctx) }
    assert.equal(failed, true); assert.equal((session?.contextRuntime ?? ctx.feature.contextRuntime).status, 'failed')
    assert.match((session?.contextRuntime ?? ctx.feature.contextRuntime).reason, /尚未可靠保存/)
    const disk = JSON.parse(fs.readFileSync(ctx.service.store.path)), stored = session ? disk.assistant.sessions.find(s => s.id === session.id) : disk.projects[0].features[0]
    assert.equal(stored.contextRuntime.status, 'failed'); assert.equal(server.requests.length, 1)
  } finally { await server.close() }
})
test('assistant compaction commit failure preserves the durable full view and clearing removes current archive access', async () => {
  const ctx = fixture(), session = seedAssistant(ctx), server = await provider(() => ({ text: '恢复后回答', calls: [] }))
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    const save = ctx.service.store.save.bind(ctx.service.store); let failed = false
    ctx.service.store.save = () => {
      if (!failed && Object.values(ctx.service.store.data.contextSnapshots ?? {}).some(s => s.messages.some(m => m.content.includes('摘要条目 v2')))) { failed = true; throw new Error('archive-commit-once') }
      save()
    }
    await ctx.service.sendAssistantMessage('保持完整原文', undefined, session.id)
    assert.equal(failed, true); assert.equal(server.requests.length, 0); assert.equal(session.messages.length, 52)
    let disk = JSON.parse(fs.readFileSync(ctx.service.store.path)); assert.equal(Object.values(disk.contextSnapshots)[0].messages.length, 51)
    assert.ok(!Object.values(disk.contextSnapshots)[0].messages.some(m => m.content.includes('摘要条目 v2')))
    await ctx.service.sendAssistantMessage('恢复后继续', undefined, session.id)
    assert.equal(session.messages.at(-1).status, 'complete'); const id = session.contextRuntime.view.archives[0]
    ctx.service.clearAssistantChat(session.id)
    assert.equal(session.contextRuntime, undefined); assert.equal(session.messages.length, 0)
    assert.throws(() => ctx.service.readRuntimeArtifact({ sessionId: session.id, id }), /范围无效/)
    disk = JSON.parse(fs.readFileSync(ctx.service.store.path)); assert.equal(Object.keys(disk.contextSnapshots).length, 0)
  } finally { await server.close() }
})
test('planning compaction commit failure keeps its previous durable read view and existing plan', async () => {
  const ctx = fixture(); ctx.feature.stage = 'solution'; ctx.feature.plan = '旧有效方案'
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(ctx.root, 'commit-' + i + '.txt'), 'FULL_PLANNING_' + i + 'X'.repeat(5990))
  const server = await provider(() => ({ text: '', calls: Array.from({ length: 10 }, (_, i) => ({ id: 'read-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'commit-' + i + '.txt' }) })) }))
  try {
    model.complete = actualComplete; ctx.service.store.data.models[0].baseUrl = server.url
    const save = ctx.service.store.save.bind(ctx.service.store); let fault = false
    ctx.service.store.save = () => {
      if (!fault && Object.values(ctx.service.store.data.contextSnapshots ?? {}).some(s => s.messages.some(m => m.content.includes('摘要条目 v2')))) { fault = true; throw new Error('planning-commit-once') }
      save()
    }
    ctx.service.generatePlan('p', 'f'); await settled(ctx)
    assert.equal(fault, true); assert.equal(server.requests.length, 1); assert.equal(ctx.feature.plan, '旧有效方案')
    assert.match(ctx.feature.planGenerationError, /planning-commit-once/); assert.equal(ctx.feature.contextRuntime.status, 'failed')
    const disk = JSON.parse(fs.readFileSync(ctx.service.store.path)), saved = Object.values(disk.contextSnapshots)[0]
    assert.equal(saved.messages.filter(m => m.role === 'tool').length, 10); assert.ok(!saved.messages.some(m => m.content.includes('摘要条目 v2')))
  } finally { await server.close() }
})
async function main() {
  for (const { name, run } of tests) try { await run(); results.push({ name, status: 'passed' }); console.log('PASS:', name) }
  catch (error) { results.push({ name, status: 'failed', error: error.stack }); console.error('FAIL:', name, error.stack) }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  assert.equal(results.filter(r => r.status === 'failed').length, 0)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { model.complete = actualComplete; fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }) })
