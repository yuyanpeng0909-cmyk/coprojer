require('./test-display.cjs').install()
const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { fixture, model, load } = require('./fixtures/verification-runtime.cjs')
async function main() {
  const ctx = fixture(), output = path.resolve('output/playwright/context-role-adaptive')
  await fs.mkdir(output, { recursive: true })
  ctx.project.name = '上下文界面隔离测试'
  ctx.feature.contextPolicy = { version: 2, mode: 'adaptive', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 }
  ctx.feature.runtimePolicy = 'receipts-effects-v1'
  ctx.feature.runtimeBudget = load('src/main/engineering/runtime-budget.ts').newRuntimeBudget(JSON.stringify(['p', 'f']))
  const stop = new Error('captured')
  model.complete = async () => { throw stop }
  try { await ctx.service.agentLoop(ctx.project, ctx.feature, ctx.service.executionAgent(ctx.feature, 'reviewer', 'p'), '', new AbortController().signal, { role: 'reviewer' }) } catch (e) { if (e !== stop) throw e }
  ctx.feature.stage = 'blocked'; ctx.project.executionPlan.status = 'paused'
  ctx.feature.contextRuntime.compactions = [
    { at: '2026-10-08T11:05:44Z', reason: 'legacy', before: 104844, after: 71107, method: 'utf8-bytes-divided-by-3-v1' },
    { at: '2026-10-13T11:06:41Z', reason: 'soft-limit', before: 180000, after: 140000, role: 'reviewer', model: 'fixture-flash', unit: 'tokens', method: 'utf8-upper-bound-v1' },
  ]
  ctx.service.store.save()
  const env = { ...process.env, COPROJER_USER_DATA: ctx.profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app, page; const errors = [], screenshots = []
  try {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: process.cwd(), env })
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: '继续开发 ' + ctx.project.name, exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '开发执行', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: ctx.feature.title, exact: true }).click()
    const drawer = page.getByRole('dialog', { name: ctx.feature.title, exact: true })
    await drawer.getByRole('tab', { name: '日志', exact: true }).click()
    const summary = drawer.locator('.eng-context-details > summary').filter({ hasText: '上下文与运行详情' })
    await summary.click()
    const details = drawer.locator('.eng-context-details').filter({ hasText: '上下文与运行详情' })
    await details.getByText('实际生效策略', { exact: true }).waitFor()
    assert.ok((await details.innerText()).includes('兼容保护（自适应未生效）'))
    assert.ok((await details.innerText()).includes('回退原因'))
    await details.getByText('整理历史（2 条，含之前运行）', { exact: true }).click()
    const content = await details.innerText()
    assert.ok(content.includes('独立验证') && content.includes('fixture-flash') && content.includes('角色未记录'))
    assert.ok(content.includes('104,844 → 71,107 字符') && content.includes('180,000 → 140,000 输入 token'))
    assert.ok(content.indexOf('fixture-flash') < content.indexOf('角色未记录'))
    for (const size of [[1280, 840], [860, 600]]) for (const theme of ['light', 'dark']) {
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setMinimumSize(1, 1); w.setContentSize(...size) }, size)
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size)
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      await details.getByText('整理历史（2 条，含之前运行）', { exact: true }).scrollIntoViewIfNeeded()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      assert.ok(await drawer.evaluate(e => e.scrollWidth <= e.clientWidth + 1))
      const file = path.join(output, `${size.join('x')}-${theme}.png`)
      await page.screenshot({ path: file, animations: 'disabled' }); screenshots.push(file)
      if (size[0] === 860) {
        const latest = details.getByText(/2026\/10\/13.*fixture-flash/)
        await latest.scrollIntoViewIfNeeded()
        const historyFile = path.join(output, `${size.join('x')}-${theme}-history.png`)
        await page.screenshot({ path: historyFile, animations: 'disabled' }); screenshots.push(historyFile)
      }
    }
    await summary.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
    assert.ok(await details.evaluate(e => e.open))
    const state = await page.evaluate(() => window.desktop.engineering.state())
    assert.equal(state.projects[0].activity, null); assert.equal(state.projects[0].features[0].stage, 'blocked')
    const display = await app.evaluate(() => global.__coprojerTestDisplay)
    assert.ok(display.windows.every(w => !w.initiallyVisible && w.displayId === display.selection.targetId))
    await app.close(); app = undefined
    const capabilities = { contextWindowTokens: 256000, maxOutputTokens: 32768, outputParameter: 'max_tokens', windowAccounting: 'input-plus-output', reasoningAccounting: 'included-in-output' }
    ctx.service.store.data.models.push({ ...ctx.service.store.data.models[0], id: 'declared-fixture', model: 'declared-fixture', capabilities })
    ctx.service.prepareRuntimeHandoff('p', 'f', { action: 'switch', modelId: 'declared-fixture', executionModels: Object.fromEntries(['developer', 'reviewer', 'diagnoser', 'preparer'].map(role => [role, 'declared-fixture'])) })
    const resume = structuredClone(ctx.service.store.data.executionCheckpoints[JSON.stringify(['p', 'f'])])
    try { await ctx.service.agentLoop(ctx.project, ctx.feature, ctx.service.executionAgent(ctx.feature, 'reviewer', 'p'), '', new AbortController().signal, { role: 'reviewer', resume }) } catch (e) { if (e !== stop) throw e }
    ctx.service.store.save()
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: process.cwd(), env })
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: '继续开发 ' + ctx.project.name, exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '开发执行', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: ctx.feature.title, exact: true }).click()
    const adaptiveDrawer = page.getByRole('dialog', { name: ctx.feature.title, exact: true })
    await adaptiveDrawer.getByRole('tab', { name: '日志', exact: true }).click()
    await adaptiveDrawer.locator('.eng-context-details > summary').filter({ hasText: '上下文与运行详情' }).click()
    const adaptiveDetails = adaptiveDrawer.locator('.eng-context-details').filter({ hasText: '上下文与运行详情' })
    const adaptiveText = await adaptiveDetails.innerText()
    assert.ok(adaptiveText.includes('自适应（已生效）') && adaptiveText.includes('256,000') && adaptiveText.includes('197,632'))
    assert.ok(!adaptiveText.includes('回退原因'))
    await adaptiveDetails.getByText('实际生效策略', { exact: true }).scrollIntoViewIfNeeded()
    const adaptiveFile = path.join(output, 'adaptive-effective.png')
    await page.screenshot({ path: adaptiveFile, animations: 'disabled' }); screenshots.push(adaptiveFile)
    assert.deepEqual(errors, [])
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ status: 'passed', display, screenshots, errors, adaptiveEffectiveAfterMigration: true, businessExecutionStarted: false }, null, 2))
    console.log('PASS real isolated Electron context policy, fallback, history units, keyboard and four layouts')
  } catch (e) { if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }); await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText()) } throw e }
  finally { if (app) await app.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
