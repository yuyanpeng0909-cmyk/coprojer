const { assert, load, model } = require('./fixtures/verification-runtime.cjs')
const { contextDecision, rememberInputCount } = load('src/main/engineering/context-budget.ts')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const policy = { version: 2, mode: 'adaptive', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 }
const connection = protocol => ({ id: 'window-policy-' + protocol, name: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', model: 'window-fixture', protocol, apiKey: 'fixture', capabilities: {
  contextWindowTokens: 256000, maxOutputTokens: 16000, outputParameter: protocol === 'responses' ? 'max_output_tokens' : 'max_tokens',
  windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output', contextPolicy: policy,
} })
async function main() {
  for (const protocol of ['chat', 'responses', 'anthropic']) {
    const server = await provider(() => ({ text: 'done' }))
    try {
      const c = { ...connection(protocol), baseUrl: server.url }
      const history = [{ role: 'user', content: 'x'.repeat(180000) }]
      const prepared = model.prepareModelRequest(c, 'policy', history, [], true)
      assert.equal(prepared.budget.adaptive, true)
      assert.equal(prepared.budget.estimateMethod, 'utf8-upper-bound-v1')
      model.assertPreparedCapacity(prepared)
      await model.complete(c, 'policy', history, [], undefined, () => {}, prepared)
      assert.deepEqual(server.requests[0].body, JSON.parse(prepared.payload))
      const over = model.prepareModelRequest(c, 'policy', [{ role: 'user', content: 'x'.repeat(240000) }], [], false)
      assert.throws(() => model.assertPreparedCapacity(over), /窗口/)
      c.capabilities.reasoningAccounting = undefined
      const unknown = model.prepareModelRequest(c, 'policy', history, [], false)
      assert.equal(unknown.budget.adaptive, false)
      assert.throws(() => model.assertPreparedCapacity(unknown), /160000/)
    } finally { await server.close() }
  }
  const c = connection('responses'), initial = model.prepareModelRequest(c, 's', [{ role: 'user', content: 'a' }], [], false)
  rememberInputCount(initial.profile, initial.payload, 180000)
  const measured = model.prepareModelRequest(c, 's', [{ role: 'user', content: 'a' }], [], false)
  assert.equal(measured.budget.inputLimit, 224000)
  assert.equal(measured.budget.estimateMethod, 'provider-count-v1')
  for (const [g, expected] of [[4000, 168000], [16000, 96000]]) {
    const d = contextDecision(measured.budget, { identity: '', samples: [g,g,g], throughSequence: 0, prefixThroughSequence: 0, epoch: 0 }, 0, 180000)
    assert.equal(d.target, expected)
  }
  const state = { identity: '', samples: [4000,4000,4000], throughSequence: 0, prefixThroughSequence: 0, epoch: 0 }
  const bodyBudget = { ...measured.budget, policy: { ...policy, triggerScope: 'body_after_prefix', autoCompactTokenLimit: 200000 } }
  const body = contextDecision(bodyBudget, state, 150000, 30000)
  assert.equal(body.bodyLimit, 70000)
  const spike = contextDecision(bodyBudget, state, 150000, 30000, 60000)
  assert.equal(spike.reason, 'predicted-capacity')
  const high = contextDecision({ ...measured.budget, estimatedInputTokens: 195000 }, { ...state, rearmGrowth: 16000 }, 190000, 5000)
  assert.equal(high.reason, 'rearm-wait')
  assert.equal(high.shouldCompact, false)
  assert.throws(() => model.prepareModelRequest({ ...c, capabilities: { ...c.capabilities, contextPolicy: { ...policy, horizonRounds: 100 } } }, 's', [], []), /策略/)
  const { requestWithContext } = load('src/main/engineering/context-request.ts'), { requestBudget } = load('src/main/engineering/model-profile.ts')
  const guarded = { ...connection('responses'), id: 'growth-before-commit', capabilities: { ...connection('responses').capabilities, contextWindowTokens: 100000, maxOutputTokens: 1000, tokenCounting: 'responses' } }
  const messages = [{ sequence: 1, role: 'user', content: 'KEEP_GOAL' }, { sequence: 2, role: 'assistant', content: 'x'.repeat(80000) }]
  const continuity = { version: 1, sourceIdentity: 'task', inputBaselineHash: 'baseline' }, before = JSON.stringify(messages), old = JSON.stringify(continuity)
  let commits = 0, sends = 0
  const ports = { prepare: h => model.prepareModelRequest(guarded, 'fixed', h, [], false), verify: async p => {
    rememberInputCount(p.profile, p.payload, p.payload.includes('artifact:') ? 90000 : 80000)
    return { ...p, budget: requestBudget(p.payload, p.profile, 1000) }
  }, assertCurrent() {}, commit() { commits++ }, archive: () => 'artifact:11111111-1111-4111-8111-111111111111', event() {}, send: async () => { sends++; return { text: 'ok', calls: [] } } }
  await assert.rejects(requestWithContext(messages, ports, new AbortController().signal, { continuity }), /下一工作回合/)
  assert.equal(commits, 0); assert.equal(sends, 0); assert.equal(JSON.stringify(messages), before); assert.equal(JSON.stringify(continuity), old)
  const imageHistory = [{ role: 'assistant', content: 'image', responseItems: [{ type: 'message', role: 'assistant', content: [{ type: 'input_image', image_url: 'https://example.invalid/image.png' }] }] }]
  const imageRequest = model.prepareModelRequest(connection('responses'), 'fixed', imageHistory, [], false)
  assert.equal(imageRequest.budget.requiresProviderCount, true)
  assert.throws(() => model.assertPreparedCapacity(imageRequest), /可靠 token 计数/)
  await assert.rejects(requestWithContext(imageHistory, { ...ports, prepare: () => imageRequest, verify: undefined }, new AbortController().signal), /可靠 token 计数/)
  assert.equal(commits, 0); assert.equal(sends, 0)
  rememberInputCount(imageRequest.profile, imageRequest.payload, 10000)
  model.assertPreparedCapacity(model.prepareModelRequest(connection('responses'), 'fixed', imageHistory, [], false))
  console.log('PASS context window policy: real wire, large input, fallback, scopes, growth and rearm')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
