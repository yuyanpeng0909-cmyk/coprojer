const { assert, fs, path, sandbox, model, load } = require('./fixtures/verification-runtime.cjs')
const { contextDecision } = load('src/main/engineering/context-budget.ts')
const { requestWithContext } = load('src/main/engineering/context-request.ts')
const { assertCompleteToolRounds } = load('src/main/engineering/context.ts')
const out = path.resolve('.runtime/context-window-growth'); fs.mkdirSync(out, { recursive: true })
const results = []
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name) }
  catch (e) { results.push({ name, passed: false, error: e.message }); console.error('FAIL', name, e.message); process.exitCode = 1 }
}
const c = { id: 'burst-cold-start', name: 'fixture', baseUrl: 'http://localhost:1', model: 'fixture', protocol: 'chat', apiKey: '',
  capabilities: { contextWindowTokens: 256000, maxOutputTokens: 32768, outputParameter: 'max_tokens',
    windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output',
    contextPolicy: { version: 2, mode: 'adaptive', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 } } }
async function main() {
  await test('historical burst cannot reserve more than the multi-round headroom ceiling', async () => {
    const b = model.prepareModelRequest(c, 'fixed', [], []).budget
    const s = { identity: b.measurementIdentity, samples: [28213,77867,18466,137304], throughSequence: 10, prefixThroughSequence: 0, epoch: 0 }
    const d = contextDecision({ ...b, estimatedInputTokens: 91938 }, s, 91938, 0)
    assert.equal(d.hardLimit, 197632)
    assert.equal(d.growth, 98816)
    assert.equal(d.observedGrowth, 137304)
    assert.equal(d.headroom, 98816)
    assert.equal(d.shouldCompact, false)
    assert.equal(d.hardLimit, b.inputLimit)
    const small = contextDecision(b, { ...s, samples: [4000,5000,6000] }, 0, b.estimatedInputTokens)
    assert.equal(small.growth, 6000)
    const known = contextDecision({ ...b, estimatedInputTokens: 91938 }, s, 91938, 0, 137304)
    assert.equal(known.growth, 137304, 'explicit next growth must not be capped as historical prediction')
    assert.equal(known.reason, 'predicted-capacity')
  })
  await test('large reasoning plus completed writes compact and send during cold start', async () => {
    const messages = [{ role: 'user', content: 'KEEP_GOAL', sequence: 1 },
      { role: 'assistant', content: 'files written', reasoning: 'r'.repeat(90000), sequence: 2,
        calls: [{ id: 'written', name: 'write_file', arguments: JSON.stringify({ path: 'README.md', content: 'x'.repeat(40000) }) }] },
      { role: 'tool', content: '已写入 README.md', callId: 'written', sequence: 3 }]
    const system = 'Mandatory project and accepted prototype '.repeat(1800)
    const b = model.prepareModelRequest(c, system, messages, []).budget
    const continuity = { version: 1, sourceIdentity: 'fixture', inputBaselineHash: 'unchanged',
      growth: { identity: b.measurementIdentity, samples: [28213,77867,18466], throughSequence: 1, prefixThroughSequence: 0, epoch: 0 } }
    let sends = 0, archived = false, compactions = 0
    await requestWithContext(messages, { prepare: h => model.prepareModelRequest(c, system, h, []), assertCurrent() {}, commit() {},
      archive(raw) { assert(raw.includes('README.md')); archived = true; return 'artifact:11111111-1111-4111-8111-111111111111' },
      event() {}, compaction() { compactions++ }, send: async p => {
        sends++; assert.equal(p.budget.estimateMethod, 'utf8-upper-bound-v1', 'do not weaken cold-start input measurement')
        model.assertPreparedCapacity(p); assert.equal(p.budget.adaptive, true)
        assert(p.budget.estimatedInputTokens + p.budget.decision.growth <= p.budget.inputLimit)
        assert(p.payload.includes('KEEP_GOAL')); assert(p.payload.includes('README.md'))
        assertCompleteToolRounds(messages)
        return { text: 'ready for next work', calls: [] }
      } }, new AbortController().signal, { continuity })
    assert.equal(sends, 1); assert.equal(compactions, 1); assert(archived)
    assert(continuity.growth.samples.some(n => n > 98816), 'retain raw burst measurements for diagnostics')
  })
  await test('unavoidable large instructions still fail without committing or sending', async () => {
    const messages = [{ role: 'user', content: 'KEEP_GOAL', sequence: 1 }, { role: 'assistant', content: 'x'.repeat(80000), sequence: 2 }]
    const before = JSON.stringify(messages), b = model.prepareModelRequest(c, 'fixed', [], []).budget
    const continuity = { version: 1, sourceIdentity: 'blocked', inputBaselineHash: 'baseline',
      growth: { identity: b.measurementIdentity, samples: [140000,140000,140000], throughSequence: 2, prefixThroughSequence: 0, epoch: 0 } }
    const original = JSON.stringify(continuity); let sends = 0, commits = 0
    await assert.rejects(requestWithContext(messages, { prepare: h => model.prepareModelRequest(c, 's'.repeat(220000), h, []), assertCurrent() {},
      commit() { commits++ }, archive: () => 'artifact:11111111-1111-4111-8111-111111111111', event() {},
      send: async () => { sends++; return { text: 'must not send', calls: [] } } }, new AbortController().signal, { continuity }), /窗口|预算|工作回合/)
    assert.equal(sends, 0); assert.equal(commits, 0); assert.equal(JSON.stringify(messages), before); assert.equal(JSON.stringify(continuity), original)
  })
  fs.writeFileSync(path.join(out, process.argv.includes('--before') ? 'regression-before.json' : 'regression-after.json'), JSON.stringify(results, null, 2))
}
main().catch(e => { console.error(e.message); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true }))
