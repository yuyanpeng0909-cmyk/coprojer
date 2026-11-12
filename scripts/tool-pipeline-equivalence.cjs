const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, sandbox, fixture, load, model, answer, call, run, testScript } = r
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const budget = load('src/main/engineering/runtime-budget.ts')
const baselinePath = path.join(__dirname, 'fixtures/tool-pipeline-equivalence.baseline.json')
const output = path.resolve('.runtime/context-runtime/tool-pipeline-equivalence')
const key = JSON.stringify(['p', 'f']), secret = 'sk-isolatedfixture12345'
const effects = 'receipts-effects-v1', readonly = 'receipts-readonly-v1'
const receipts = ctx => Object.values(ctx.service.store.data.receiptJournals?.[key]?.receipts ?? {})
const done = () => answer({ status: 'incomplete', summary: '停', nextStep: '核对' })
const write = (extra = {}) => call('write_file', { path: 'a.txt', content: 'hello', ...extra })
const read = (file = 'value.cjs') => call('read_file', { path: file })
const command = (args = ['value.cjs'], extra = {}) => call('run_command', { program: 'node', args, ...extra })
const group = (...replies) => ({ text: '', calls: replies.flatMap(reply => reply.calls) })
const revoke = (ctx, tool) => { const agent = ctx.service.store.data.agents.find(a => a.id === 'developer'); agent.tools = agent.tools.filter(name => name !== tool) }
const whenReceipt = (status, tool) => ctx => { if (receipts(ctx).some(receipt => receipt.tool === tool && receipt.status === status)) revoke(ctx, tool) }
const prototype = ctx => { ctx.feature.prototypeId = 'prototype'; ctx.project.prototypes.push({ id: 'prototype', title: '完整原型', html: '<main>' + 'x'.repeat(8000) + '</main>', at: new Date().toISOString() }) }
const preparation = ctx => {
  ctx.feature.verificationPreparation = { phase: 'running', round: 1, limit: 2,
    gaps: [{ id: 'gap', criterion: ctx.feature.criteria[0], disposition: 'automatic', reason: '缺检查脚本', nextStep: '添加补充检查' }],
    attempts: [{ id: 'attempt', key: 'key', round: 1, at: new Date().toISOString(), status: 'running', beforeFingerprint: ctx.service.sourceFingerprint(ctx.project), actions: [] }] }
}
const scenarios = []
function scenario(name, steps, options = {}) {
  scenarios.push({ name, entry: 'run', role: 'developer', policy: '', files: ['a.txt'],
    reply: (n, ctx) => n <= steps.length ? steps[n - 1](ctx) : done(), ...options })
}
const operations = { write: () => write(), read: () => read(), command: () => command() }
for (const stage of ['before', 'after-persist', 'in-work']) for (const [kind, operation] of Object.entries(operations)) {
  for (const policy of stage === 'before' && kind !== 'command' ? ['', effects] : [effects]) {
    const tool = { write: 'write_file', read: 'read_file', command: 'run_command' }[kind]
    scenario(`revoke-${stage}.${policy ? 'effects' : 'legacy'}.${kind}`, [ctx => { if (stage === 'before') revoke(ctx, tool); return operation() }],
      { policy, ...(stage !== 'before' ? { onSave: whenReceipt(stage === 'after-persist' ? 'prepared' : 'running', tool) } : {}) })
  }
}
for (const policy of ['', effects]) scenario(`write.${policy ? 'effects' : 'legacy'}`, [() => write()], { policy })
scenario('readonly-policy.write', [() => write()], { policy: readonly })
scenario('prototype-unread.legacy', [() => write(), () => command()], { setup: prototype })
for (const kind of ['write', 'command']) scenario(`prototype-unread.effects.${kind}`, [operations[kind]], { policy: effects, setup: prototype })
scenario('prototype-read.effects', [() => call('read_context', { id: 'prototype:prototype', offset: 0 }),
  () => call('read_context', { id: 'prototype:prototype', offset: 6000 }), () => write()], { policy: effects, setup: prototype, capture: { requests: [1, 2, 3, 4] } })
for (const policy of ['', effects]) scenario(`secret.${policy ? 'effects' : 'legacy'}`, [() => write({ content: secret }), () => command(['value.cjs', secret])], { policy, secret: true })
scenario('secret.effects.patch', [ctx => call('patch_file', { path: 'value.cjs', expectedVersion: load('src/main/engineering/efficient-files.ts').textVersion(ctx.before),
  startLine: 1, endLine: 1, oldText: 'a+b', newText: 'a + b' })], { policy: effects, secret: true, files: ['value.cjs'], setup: ctx => {
  ctx.before = fs.readFileSync(path.join(ctx.root, 'value.cjs'), 'utf8') + '\n// ' + secret
  fs.writeFileSync(path.join(ctx.root, 'value.cjs'), ctx.before); ctx.service.store.data.agents.find(a => a.id === 'developer').tools.push('patch_file')
} })
for (const policy of ['', effects]) scenario(`commands.${policy ? 'effects' : 'legacy'}`, [
  () => command(['tests/check.cjs'], { evidenceKind: 'unit' }), () => command(), () => command(['check.cjs']), () => command(['fail.cjs']),
  () => call('run_command', { program: 'npm', args: ['test'] }),
], { policy, setup: ctx => {
  fs.writeFileSync(path.join(ctx.root, 'tests/check.cjs'), `console.log('OK ${secret}')`)
  fs.writeFileSync(path.join(ctx.root, 'check.cjs'), "console.log('ROOT_CHECK')")
  fs.writeFileSync(path.join(ctx.root, 'fail.cjs'), "console.log('AssertionError: expected 5');process.exit(1)")
} })
scenario('cancel.effects', [() => group(command(['tests/check.cjs'], { timeoutSeconds: 5, evidenceKind: 'unit' }), write({ path: 'queued.txt', content: 'must not run' }))], {
  policy: effects, platform: 'win32', resume: true, files: ['queued.txt', 'partial.txt'], setup: ctx => {
    fs.writeFileSync(path.join(ctx.root, 'tests/child.cjs'), "require('node:fs').writeFileSync('.runtime/child.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)")
    fs.writeFileSync(path.join(ctx.root, 'tests/check.cjs'), "const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['tests/child.cjs'],{stdio:'inherit',windowsHide:true});fs.writeFileSync('partial.txt','effect before stop');console.log('PARTIAL_OUTPUT');setInterval(()=>console.log('alive'),200)")
  }, stopWhen: ctx => fs.existsSync(path.join(ctx.root, '.runtime/child.json')),
})
for (const policy of ['', effects]) for (const saveFails of [false, true]) scenario(`preparer-actions.${policy ? 'effects' : 'legacy'}${saveFails ? '.save-fails' : ''}`,
  [() => write({ path: 'tests/extra.cjs', content: 'console.log(1)' }), () => answer({ status: 'ready', summary: '已补', nextStep: '独立复验' })], {
    policy, entry: 'agentLoop', role: 'preparer', setup: preparation, files: ['tests/extra.cjs'],
    ...(saveFails ? { failWrite: ctx => ctx.feature.verificationPreparation.attempts.at(-1).actions.some(action => action.startsWith('write_file: ')) } : {}),
  })
for (const role of ['reviewer', 'diagnoser', 'preparer']) for (const policy of ['', effects]) {
  const steps = role === 'reviewer' ? [() => command(['tests/verify.cjs']), () => command(['-e', 'process.exit(0)']), () => write()]
    : role === 'diagnoser' ? [() => command(['tests/verify.cjs']), () => read()]
      : [() => command(['-e', '1']), () => command(['tests/verify.cjs']), () => write({ path: 'value.cjs' })]
  scenario(`${role}.tools.${policy ? 'effects' : 'legacy'}`, steps, { policy, entry: 'agentLoop', role,
    reply: (n, ctx) => n <= steps.length ? steps[n - 1](ctx) : undefined,
    setup: ctx => { if (role !== 'reviewer') preparation(ctx); fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), testScript()) }, files: ['a.txt', 'value.cjs'] })
}
for (const role of ['developer', 'reviewer', 'diagnoser', 'preparer']) scenario(`role-request.${role}`, [], { entry: 'agentLoop', role,
  setup: ctx => { if (role === 'preparer' || role === 'diagnoser') preparation(ctx) }, reply: () => undefined, capture: { requests: [1] } })
for (const policy of ['', effects]) scenario(`read-group.${policy ? 'effects' : 'legacy'}`, [() => group(read(), read('package.json')), () => group(read(), write())], { policy })
scenario('order.unread-prototype.revoke-in-work.effects.write', [() => write()], { policy: effects, setup: prototype, onSave: whenReceipt('running', 'write_file') })
scenario('order.readonly-policy.revoke-before.write', [ctx => { revoke(ctx, 'write_file'); return write() }], { policy: readonly })
scenario('order.revoke-before.secret.effects.write', [ctx => { revoke(ctx, 'write_file'); return write({ content: secret }) }], { policy: effects, secret: true })
scenario('order.secret.unread-prototype.effects.write', [() => write({ content: secret })], { policy: effects, setup: prototype, secret: true })
for (const policy of ['', effects]) scenario(`order.path-escape.unread-prototype.${policy ? 'effects' : 'legacy'}.write`, [() => write({ path: '../outside.txt' })], { policy, setup: prototype })
for (const policy of ['', effects]) {
  scenario(`budget.tools-exhausted.${policy ? 'effects' : 'legacy'}.write`, [() => write()], { policy, budget: true, toolsExhausted: true })
  scenario(`order.revoke-${policy ? 'after-persist' : 'before'}.tools-exhausted.${policy ? 'effects' : 'legacy'}.write`,
    [ctx => { if (!policy) revoke(ctx, 'write_file'); return write() }], { policy, budget: true, toolsExhausted: true, ...(policy ? { onSave: whenReceipt('prepared', 'write_file') } : {}) })
}

function normalize(value, ctx, field) {
  if (field === 'durationMs' && typeof value === 'number') return 0
  if (Array.isArray(value)) return value.map(item => normalize(item, ctx))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([name, item]) => [name, normalize(item, ctx, name)]))
  if (typeof value !== 'string') return value
  for (const [directory, placeholder] of [[ctx.root, '<ROOT>'], [ctx.profile, '<PROFILE>'], [sandbox, '<SANDBOX>']]) {
    for (const variant of [directory.replaceAll('\\', '\\\\'), directory, directory.replaceAll('\\', '/')]) value = value.split(variant).join(placeholder)
  }
  return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/call-0\.\d+/g, '<CALL>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIME>')
    .replace(/\b[0-9a-f]{64}\b/gi, '<HASH>').replace(/((?:\\?"durationMs\\?")\s*:\s*)\d+(?:\.\d+)?/g, '$10')
}
function commandText(value, scenario, isNpm = false) {
  if (isNpm) return '<NPM_OUTPUT_OMITTED>'
  if (scenario.name !== 'cancel.effects' || typeof value !== 'string') return value
  return value.includes('PARTIAL_OUTPUT') ? '<PARTIAL_OUTPUT:true>' : '<PARTIAL_OUTPUT:false>'
}
function toolText(value, scenario) {
  if (typeof value !== 'string') return value
  let parsed
  try { parsed = JSON.parse(value) } catch { return value }
  const isCommand = 'code' in parsed && ('evidenceId' in parsed || 'runId' in parsed)
  if (!isCommand) return value
  const isNpm = parsed.command?.startsWith('npm ') || parsed.evidenceId === 'check-5' && scenario.name.startsWith('commands.')
  if (isNpm) return JSON.stringify(select(parsed, ['id', 'evidenceId', 'command', 'isTest', 'code', 'failureKind']))
  if (scenario.name === 'cancel.effects') {
    if ('output' in parsed) parsed.output = commandText(parsed.output, scenario)
    if ('rawOutput' in parsed) parsed.rawOutput = commandText(parsed.rawOutput, scenario)
    // Output lengths vary with cancellation timing just like the omitted tail.
    if (typeof parsed.artifact?.totalCharacters === 'number') parsed.artifact.totalCharacters = 0
    if (typeof parsed.rawOutput?.bytes === 'number') parsed.rawOutput.bytes = 0
    if (typeof parsed.rawOutput?.totalBytes === 'number') parsed.rawOutput.totalBytes = 0
  }
  return JSON.stringify(parsed)
}
function select(value, keys) { return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) }
function collect(ctx, scenario, state) {
  const events = []
  for (const event of ctx.project.events) {
    if (event.kind === 'output' && events.at(-1)?.kind === 'output') continue
    events.push({ kind: event.kind, ...(['tool', 'tool-result', 'error', 'historical-result'].includes(event.kind) ? { message: toolText(event.message, scenario) } : {}) })
  }
  const commands = state.result?.commands ?? ctx.service.store.data.executionCheckpoints?.[key]?.commands ?? []
  const result = {
    requests: state.requests, toolMessages: state.messages.filter(message => message.role === 'tool').map(message => toolText(message.content, scenario)), events,
    receipts: receipts(ctx).map(receipt => ({ ...select(receipt, ['tool', 'strategy', 'status', 'attempts', 'applied', 'reason', 'effects']),
      ...(receipt.result ? { result: { output: toolText(receipt.result.output, scenario) } } : {}) })),
    receiptTrace: [...state.receiptTrace], commands: commands.map(command => command.command.startsWith('npm ')
      ? select(command, ['id', 'command', 'isTest', 'code', 'failureKind'])
      : { ...select(command, ['id', 'command', 'isTest', 'code', 'evidenceKind', 'evidenceKinds', 'failureKind', 'stepId']), output: commandText(command.output, scenario) }),
    saves: { ...state.saves }, outcome: { status: ctx.feature.contextRuntime?.status, reason: ctx.feature.contextRuntime?.reason, stage: ctx.feature.stage,
      ...(state.error ? { error: { name: state.error.name, message: state.error.message } } : {}) },
    ...(ctx.feature.runtimeBudget ? { budget: select(ctx.feature.runtimeBudget.used, ['requests', 'tools']) } : {}),
    ...(ctx.feature.verificationPreparation ? { actions: [...ctx.feature.verificationPreparation.attempts.at(-1).actions] } : {}),
    files: Object.fromEntries(scenario.files.map(file => { const target = path.join(ctx.root, file); return [file, fs.existsSync(target) ? { exists: true, content: fs.readFileSync(target, 'utf8') } : { exists: false }] })),
    changes: ctx.project.changes.map(change => change.path), ...(scenario.secret ? { secretInStore: JSON.stringify(ctx.service.store.data).includes(secret) } : {}),
    captured: structuredClone(state.captured),
  }
  return normalize(result, ctx)
}
async function execute(scenario) {
  const ctx = fixture(), store = ctx.service.store
  if (scenario.policy) ctx.feature.runtimePolicy = scenario.policy
  if (scenario.policy || scenario.budget) ctx.feature.runtimeBudget = budget.newRuntimeBudget('equivalence')
  if (scenario.toolsExhausted) ctx.feature.runtimeBudget.limits.tools = 0
  scenario.setup?.(ctx)
  const state = { requests: 0, messages: [], captured: {}, saves: { counted: 0, timeLease: 0, outputEvent: 0 }, receiptTrace: [] }
  const original = { complete: model.complete, save: store.save, event: store.event, write: fs.writeFileSync, reserveTime: budget.RuntimeBudgetLease.prototype.reserveTime }
  let inTime = 0, inOutput = 0, failed = false, timer
  budget.RuntimeBudgetLease.prototype.reserveTime = function (...args) { inTime++; try { return original.reserveTime.apply(this, args) } finally { inTime-- } }
  store.save = function (...args) {
    original.save.apply(this, args)
    if (inTime) state.saves.timeLease++
    else if (inOutput) state.saves.outputEvent++
    else { state.saves.counted++; const trace = receipts(ctx).map(receipt => receipt.status).join(','); if (state.receiptTrace.at(-1) !== trace) state.receiptTrace.push(trace) }
    scenario.onSave?.(ctx)
  }
  store.event = function (project, kind, ...rest) { if (kind === 'output') inOutput++; try { return original.event.call(this, project, kind, ...rest) } finally { if (kind === 'output') inOutput-- } }
  if (scenario.failWrite) fs.writeFileSync = (target, ...rest) => {
    if (!failed && target === store.path + '.tmp' && scenario.failWrite(ctx)) { failed = true; throw new Error('injected disk failure') }
    return original.write(target, ...rest)
  }
  model.complete = async (_connection, system, messages, tools, _signal, _onDelta, _prepared) => {
    state.requests++; state.messages = structuredClone(messages)
    if (scenario.capture?.requests.includes(state.requests)) state.captured[state.requests] = structuredClone({ system, messages, tools })
    const reply = scenario.reply(state.requests, ctx)
    if (reply === undefined) throw new Error('CAPTURE_ONLY')
    return reply
  }
  const invoke = async () => {
    state.result = undefined; state.error = undefined
    if (scenario.entry === 'run') { await run(ctx.service); return }
    try {
      const agent = ctx.service.executionAgent(ctx.feature, scenario.role === 'developer' || scenario.role === 'preparer' ? 'developer' : 'reviewer', 'p')
      state.result = await ctx.service.agentLoop(ctx.project, ctx.feature, agent, '', new AbortController().signal, { role: scenario.role })
    } catch (error) { state.error = error }
  }
  try {
    if (scenario.stopWhen) timer = setInterval(() => { if (scenario.stopWhen(ctx)) { clearInterval(timer); ctx.service.stop('p') } }, 25)
    await invoke(); clearInterval(timer)
    if (scenario.failWrite) assert.equal(failed, true, scenario.name + ' reaches injected durable save')
    const first = collect(ctx, scenario, state)
    if (!scenario.resume) return first
    const child = path.join(ctx.root, '.runtime/child.json')
    assert.ok(fs.existsSync(child), 'cancel fixture reached its child process')
    assert.throws(() => process.kill(JSON.parse(fs.readFileSync(child)).pid, 0), 'owned child process stopped')
    await invoke()
    return { stopped: first, resumed: collect(ctx, scenario, state) }
  } finally {
    clearInterval(timer); model.complete = original.complete; store.save = original.save; store.event = original.event
    fs.writeFileSync = original.write; budget.RuntimeBudgetLease.prototype.reserveTime = original.reserveTime
    if (scenario.name === 'cancel.effects') {
      const child = path.join(ctx.root, '.runtime/child.json')
      if (fs.existsSync(child)) {
        const pid = JSON.parse(fs.readFileSync(child)).pid
        assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid, 'isolated child pid is valid')
        let alive = true
        try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
        // A failed stopped-tree assertion must not leave this fixture running.
        if (alive) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' })
      }
    }
  }
}
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'saves' ? { counted: item.counted } : comparable(item)]))
}
function difference(expected, actual, at = '') {
  if (Object.is(expected, actual)) return undefined
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return at || '<root>'
  if (Array.isArray(expected) !== Array.isArray(actual)) return at
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) return at + '.' + key
    const found = difference(expected[key], actual[key], Array.isArray(actual) ? `${at}[${key}]` : at ? `${at}.${key}` : key)
    if (found) return found
  }
}
async function main() {
  const args = process.argv.slice(2), update = args.includes('--update'), onlyAt = args.indexOf('--only'), only = onlyAt < 0 ? '' : args[onlyAt + 1]
  assert.ok(onlyAt < 0 || only && !only.startsWith('--'), '--only requires a scenario name')
  assert.ok(args.every((arg, index) => ['--update', '--only'].includes(arg) || index === onlyAt + 1 && onlyAt >= 0), 'unknown argument')
  if (update) assert.equal(execFileSync('git', ['diff', '--ignore-cr-at-eol', '--name-only', 'HEAD', '--', 'src'], { encoding: 'utf8' }).trim(), '', '--update requires unchanged src/')
  const expected = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { version: 1, scenarios: {} }
  assert.ok(update || fs.existsSync(baselinePath), 'generate the initial baseline with --update')
  assert.equal(expected.version, 1)
  const selected = scenarios.filter(scenario => scenario.name.includes(only)).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  assert.ok(selected.length, 'no matching scenarios')
  const actual = { version: 1, generated: { commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), platform: process.platform, node: process.version }, scenarios: {} }
  const started = performance.now(), differences = []
  fs.mkdirSync(output, { recursive: true })
  for (const scenario of selected) {
    if (scenario.platform && process.platform !== scenario.platform) { console.log(`SKIP ${scenario.name}: requires ${scenario.platform}`); continue }
    const result = await execute(scenario)
    assert.equal(JSON.stringify(result).includes('coprojer-preparation-'), false, scenario.name + ' has an unnormalized temporary path')
    actual.scenarios[scenario.name] = result
    fs.writeFileSync(path.join(output, 'actual.json'), JSON.stringify(actual, null, 2) + '\n')
    const field = difference(comparable(expected.scenarios[scenario.name]), comparable(result))
    if (!update && field) { differences.push({ scenario: scenario.name, field }); console.error(`FAIL ${scenario.name}: ${field}`) }
    else console.log(`${update ? 'CAPTURE' : 'PASS'} ${scenario.name}`)
  }
  if (update) {
    // Time-driven saves remain in actual.json, not in the deterministic fixture.
    const merged = only ? { ...expected.scenarios } : Object.fromEntries(scenarios.filter(s => s.platform && s.platform !== process.platform && expected.scenarios[s.name]).map(s => [s.name, expected.scenarios[s.name]]))
    Object.assign(merged, comparable(actual.scenarios))
    fs.writeFileSync(baselinePath, JSON.stringify({ ...actual, scenarios: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b, 'en'))) }, null, 2) + '\n')
  }
  console.log(`${Object.keys(actual.scenarios).length} scenarios in ${((performance.now() - started) / 1000).toFixed(2)}s; ${differences.length} differences`)
  if (differences.length) process.exitCode = 1
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(() => {
  const resolved = path.resolve(sandbox), temporaryRoot = path.resolve(require('node:os').tmpdir()) + path.sep
  assert.ok(resolved.startsWith(temporaryRoot + 'coprojer-preparation-'))
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 })
})
