const r = require('./verification-runtime.cjs')
const { fs, path, fixture, load, run } = r
const mode = process.argv[2], boundary = process.argv[3]
async function main() {
  let service, root, profile
  if (mode === 'start') {
    const ctx = fixture(); ({ service, root, profile } = ctx)
    ctx.feature.runtimePolicy = 'receipts-effects-v1'
    ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('actual-crash-fixture')
    service.store.data.models[0].baseUrl = process.env.COPROJER_CRASH_PROVIDER
    fs.writeFileSync(path.join(profile, 'crash-fixture.json'), JSON.stringify({ kind: 'isolated-context-crash-test' })); service.store.save()
  } else { profile = process.env.COPROJER_CRASH_PROFILE; service = r.restoreIsolated(profile); root = service.store.project('p').root }
  process.send({ type: 'ready', profile, root, sandbox: r.sandbox })
  const write = fs.writeFileSync
  fs.writeFileSync = (target, content, ...rest) => {
    const result = write(target, content, ...rest)
    if (target === path.join(root, 'value.cjs')) {
      fs.appendFileSync(path.join(profile, 'actual-writes.jsonl'), JSON.stringify({ pid: process.pid, path: target }) + '\n')
      if (mode === 'start' && boundary === 'effect') process.exit(73)
    }
    if (mode === 'start' && target === service.store.path + '.tmp') {
      // Exit only after atomic store.save returns, not while its temp file is uncommitted.
    }
    return result
  }
  const save = service.store.save.bind(service.store)
  service.store.save = () => {
    save()
    const receipts = Object.values(service.store.data.receiptJournals?.[JSON.stringify(['p', 'f'])]?.receipts ?? {})
    if (mode === 'start' && receipts.some(r => r.tool === 'write_file' && r.status === 'completed' && (boundary === 'receipt' ? !r.applied : boundary === 'projection' && r.applied))) process.exit(73)
  }
  if (mode === 'resume') {
    // Effect reconciliation is independent of execution allowance; a crashed time lease is not guessed to be zero.
    service.reconcileRuntime('p', 'f')
    const budget = service.store.project('p').features[0].runtimeBudget
    if (budget.activeLease) service.adjustRuntimeBudget({ projectId: 'p', featureId: 'f' }, { ...budget.limits, activeMs: Math.max(budget.limits.activeMs, budget.used.activeMs + 60000) }, '隔离测试明确授予崩溃后续接的有限时间；原预占保留')
  }
  await run(service)
  service.reconcileRuntime('p', 'f'); service.reconcileRuntime('p', 'f')
  process.send({ type: 'complete', state: service.state(), disk: JSON.parse(fs.readFileSync(service.store.path)) })
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
