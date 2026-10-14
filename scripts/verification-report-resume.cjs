const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, fixture, model, call, answer, run } = r
async function main() {
  const ctx = fixture()
  ctx.feature.stage = 'blocked'; ctx.feature.verificationPending = true
  fs.writeFileSync(path.join(ctx.root, 'tests/verify.cjs'), 'console.log("REAL_CHECK")')
  ctx.service.store.save()
  let calls = 0
  model.complete = async (_c, _s, messages, tools) => {
    if (++calls === 1) return call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKind: 'unit' })
    if (calls === 3) {
      assert.equal(tools.length, 0)
      assert.ok(messages.at(-1).content.includes('JSON'), 'repair includes concrete format guidance')
    }
    return { text: '{"results": [],}', calls: [] }
  }
  await run(ctx.service, true)
  assert.equal(ctx.feature.stage, 'blocked')
  assert.equal(calls, 3)
  const commandsBefore = ctx.project.events.filter(e => e.kind === 'command').length
  model.complete = async (_c, _s, messages, tools) => {
    assert.equal(tools.length, 0, 'resume of malformed final report must not reopen tool execution')
    assert.ok(messages.at(-1).content.includes('JSON'))
    return answer({ results: [{ criterion: ctx.feature.criteria[0], passed: true, status: 'passed', evidence: 'Actual saved check.', evidenceKind: 'unit', commandIds: ['check-1'] }] })
  }
  await run(ctx.service, true)
  assert.equal(ctx.feature.stage, 'acceptance')
  assert.equal(ctx.feature.verificationChecks.length, 1)
  assert.equal(ctx.feature.verificationChecks[0].code, 0)
  assert.equal(ctx.project.events.filter(e => e.kind === 'command').length, commandsBefore)
  console.log('PASS: malformed report resumes tool-free and preserves actual check evidence')
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => fs.rmSync(r.sandbox, { recursive: true, force: true, maxRetries: 3 }))
