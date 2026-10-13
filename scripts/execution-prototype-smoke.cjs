require('./test-display.cjs').install()
const { _electron: electron } = require('playwright')
const { assert, fs, path, sandbox, fixture, model, load } = require('./fixtures/verification-runtime.cjs')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
async function main() {
  const ctx = fixture(), output = path.resolve('output/playwright/prototype-read-loop'); fs.mkdirSync(output, { recursive: true })
  ctx.project.name = '原型读取恢复隔离测试'; ctx.project.executionPlan = undefined
  const prototype = { id: 'approved', title: '原型', html: '<button>当前已读原型</button>' + '\\'.repeat(16500), at: '2026-10-09T00:00:00Z' }
  ctx.project.prototypes = [prototype]; ctx.feature.prototypeId = prototype.id
  ctx.feature.runtimePolicy = 'receipts-effects-v1'; ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('["p","f"]')
  const total = JSON.stringify(prototype).length, version = load('src/main/engineering/context.ts').contextHash(JSON.stringify(prototype))
  const server = await provider(req => {
    const system = req.body.messages[0].content, line = system.split('\n').find(s => s.startsWith('必读资料进度：'))
    assert.ok(line); const read = JSON.parse(line.slice('必读资料进度：'.length))[0]
    assert.equal(read.complete, true); assert.equal(read.read, total); assert.equal(read.version, version)
    if (!fs.existsSync(path.join(ctx.root, 'continued.txt'))) return { text: '', calls: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'continued.txt', content: 'ELECTRON_CONTINUATION_OK' }) }] }
    return { text: JSON.stringify({ status: 'incomplete', summary: '隔离恢复已完成实际文件写入。', nextStep: '其余业务工作尚未实现。' }), calls: [] }
  })
  let app
  try {
    ctx.service.store.data.models[0].baseUrl = server.url
    let round = 0; const original = model.complete
    model.complete = async () => {
      if (round++) throw Error('isolated interruption')
      const calls = []
      for (let offset = 0; offset < total; offset += 6000) calls.push({ id: 'read-' + offset, name: 'read_context', arguments: JSON.stringify({ id: 'prototype:approved', offset, version }) })
      return { text: '', calls }
    }
    try { await ctx.service.agentLoop(ctx.project, ctx.feature, ctx.service.store.data.agents.find(a => a.id === 'developer'), '', new AbortController().signal) }
    catch (error) { assert.match(error.message, /isolated interruption/) }
    finally { model.complete = original }
    ctx.feature.stage = 'blocked'; ctx.project.activity = null; ctx.service.store.save()
    const checkpoint = ctx.service.store.data.executionCheckpoints['["p","f"]']; assert.equal(checkpoint.prototypeReadUntil, total)
    const env = { ...process.env, COPROJER_USER_DATA: ctx.profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: process.cwd(), env })
    const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000)
    await page.getByRole('button', { name: '继续开发 ' + ctx.project.name, exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '开发执行', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: ctx.feature.title, exact: true }).click()
    const drawer = page.getByRole('dialog', { name: ctx.feature.title, exact: true })
    await drawer.getByRole('button', { name: '继续执行', exact: true }).click()
    await page.waitForFunction(async () => { const state = await window.desktop.engineering.state(), p = state.projects[0]; return !p.activity && p.changes.some(c => c.path === 'continued.txt') })
    const current = await page.evaluate(() => window.desktop.engineering.state())
    assert.equal(fs.readFileSync(path.join(ctx.root, 'continued.txt'), 'utf8'), 'ELECTRON_CONTINUATION_OK')
    assert.equal(current.projects[0].features[0].stage, 'blocked', 'incomplete report cannot become acceptance')
    assert.ok(current.projects[0].events.some(e => e.kind === 'resume' && e.message.includes('保留已完成')))
    assert.equal(server.requests.length, 2); assert.deepEqual(errors, []); assert.deepEqual(server.errors, [])
    await drawer.getByRole('tab', { name: '日志', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await page.screenshot({ path: path.join(output, 'continued-maximized.png'), animations: 'disabled' })
    const display = await app.evaluate(() => global.__coprojerTestDisplay)
    assert.ok(display.windows.every(w => !w.initiallyVisible && w.displayId === display.selection.targetId))
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ status: 'passed', level: 'isolated real Electron controls and local HTTP fixture; not live-provider business acceptance', display, requests: server.requests.length, changedFile: 'continued.txt', stage: current.projects[0].features[0].stage, errors }, null, 2))
    console.log('PASS real Electron continue button restores compacted prototype checkpoint, writes file, preserves incomplete boundary')
  } finally { if (app) await app.close(); await server.close(); fs.rmSync(sandbox, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
