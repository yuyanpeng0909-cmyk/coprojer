require('./test-display.cjs').install()
const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { provider } = require('./fixtures/context-runtime-provider.cjs')

async function main() {
  const output = path.resolve('output/playwright/execution-budget-recovery')
  await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(path.join(output, 'isolated-'))
  const profile = path.join(sandbox, 'profile'), root = path.join(sandbox, 'project')
  await fs.mkdir(profile); await fs.mkdir(path.join(root, 'tests'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'budget-recovery-fixture', private: true }))
  await fs.writeFile(path.join(root, 'tests/check.cjs'), "require('node:assert/strict').equal(2+3,5); console.log('ACTUAL_BUDGET_RECOVERY_CHECK')")
  const at = new Date().toISOString(), used = { requests: 72, tools: 225, activeMs: 3600182 }
  const budget = { version: 1, policy: 'runtime-budget-v1', historical: { kind: 'exact', requests: 0, tools: 0, activeMs: 0 },
    used, limits: { requests: 512, tools: 2048, activeMs: 3600000 }, enabledAt: at, timeAccounting: 'active-reservation-ms-v1', adjustments: [] }
  const feature = { id: 'f', title: '工程化与自动化测试', description: '隔离额度恢复', module: '核心', scope: 'current', stage: 'blocked', verificationPending: true,
    criteria: ['实际加法检查'], plan: '独立验证现有实现', tasks: [{ id: 't', title: '检查', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer',
    revision: 1, repairRound: 0, results: [], feedback: '', runtimeBudget: budget }
  const project = { id: 'p', name: '额度恢复隔离项目', root, brief: '停止后从执行记录恢复', createdAt: at, features: [feature], context: [], chat: [],
    events: [{ id: 'stop', at, kind: 'stopped', featureId: 'f', message: '任务累计活动时间额度已用完，已停止新动作；实际收尾耗时已计入。' }],
    changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
  const server = await provider((_request, n) => n === 1
    ? { text: '', calls: [{ id: 'verify', name: 'run_command', arguments: JSON.stringify({ program: 'node', args: ['tests/check.cjs'], evidenceKind: 'unit' }) }] }
    : { text: JSON.stringify({ results: [{ criterion: feature.criteria[0], status: 'passed', passed: true, evidence: '实际命令检查通过', evidenceKind: 'unit', commandIds: ['check-1'] }] }), calls: [] })
  await fs.writeFile(path.join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, projects: [project], agents: [], models: [{ id: 'fixture', name: 'fixture', model: 'fixture', protocol: 'chat', baseUrl: server.url, cipher: '' }] }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app; const errors = []
  try {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: process.cwd(), env })
    const page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '继续开发 ' + project.name, exact: true }).click()
    await page.getByRole('button', { name: '执行记录', exact: true }).click()
    const recovery = page.locator('.eng-background-problem').getByRole('button', { name: '处理暂停', exact: true })
    assert.equal(await recovery.count(), 1, '执行记录页必须有进入对应功能的恢复入口，不能仍然跳回执行记录')
    await recovery.click()
    const drawer = page.getByRole('dialog', { name: feature.title, exact: true })
    await drawer.getByRole('button', { name: '调整额度后继续验证', exact: true }).click()
    assert.equal(server.requests.length, 0, '额度不足时不得开始模型请求')
    const minutes = drawer.getByLabel('活动分钟总额度', { exact: true })
    assert.equal(await minutes.inputValue(), '60.01', '毫秒收尾超额须向上取整到有效的分钟输入步长')
    assert.equal(await minutes.evaluate(el => el.validity.valid), true)
    await drawer.getByLabel('调整原因', { exact: true }).fill('隔离回归：继续验证已有成果')
    await drawer.getByLabel('模型请求总额度', { exact: true }).fill(String(used.requests))
    await drawer.getByRole('button', { name: '保存额度', exact: true }).click()
    await drawer.getByRole('alert').filter({ hasText: '模型请求额度已用完' }).waitFor()
    assert.equal(server.requests.length, 0)
    await drawer.getByLabel('模型请求总额度', { exact: true }).fill('512')
    await minutes.fill('90')
    await drawer.getByRole('button', { name: '调整额度后继续验证', exact: true }).click()
    assert.equal(await minutes.inputValue(), '90', '再次定位额度设置不得覆盖未保存的输入')
    for (const size of [[1280, 840], [860, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size)
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size)
      await minutes.scrollIntoViewIfNeeded()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      assert.ok(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth + 1))
      await page.screenshot({ path: path.join(output, 'adjust-' + size.join('x') + '.png'), animations: 'disabled' })
    }
    await drawer.getByRole('button', { name: '保存额度', exact: true }).click()
    await drawer.getByRole('button', { name: '继续验证', exact: true }).waitFor()
    const saved = await page.evaluate(async () => (await window.desktop.engineering.state()).projects[0].features[0])
    assert.deepEqual(saved.runtimeBudget.used, used, '保存额度不能清空累计消耗')
    assert.equal(saved.runtimeBudget.limits.activeMs, 5400000)
    assert.equal(saved.runtimeBudget.adjustments.length, 1)
    assert.equal(server.requests.length, 0, '保存额度本身不自动开始运行')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await recovery.click()
    await drawer.getByText('任务累计额度 · 已启用', { exact: true }).click()
    await drawer.getByRole('button', { name: '调整任务总额度', exact: true }).click()
    await minutes.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'adjust-dark-860x600.png'), animations: 'disabled' })
    await drawer.getByRole('button', { name: '取消调整', exact: true }).click()
    await drawer.getByRole('tab', { name: '验收', exact: true }).click()
    await drawer.getByRole('tab', { name: '日志', exact: true }).click()
    assert.equal(await drawer.getByLabel('活动分钟总额度', { exact: true }).count(), 0, '切换页签不得重新触发已经处理的编辑请求')
    const resume = drawer.getByRole('button', { name: '继续验证', exact: true })
    await resume.focus(); assert.ok(await resume.evaluate(el => el === document.activeElement))
    await page.screenshot({ path: path.join(output, 'ready-dark-860x600.png'), animations: 'disabled' })
    await page.keyboard.press('Enter')
    const deadline = Date.now() + 30000
    while (true) {
      const p = await page.evaluate(async () => (await window.desktop.engineering.state()).projects[0])
      if (!p.activity && p.features[0].stage === 'acceptance') break
      assert.ok(Date.now() < deadline, '独立验证应结束并进入待验收：' + p.events.at(-1)?.message)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const state = await page.evaluate(() => window.desktop.engineering.state()), current = state.projects[0].features[0]
    assert.equal(current.runtimeBudget.used.requests, used.requests + 2)
    assert.equal(current.runtimeBudget.used.tools, used.tools + 1)
    assert.equal(current.repairRound, 0)
    assert.equal(server.requests.length, 2)
    assert.ok(server.requests.every(r => r.system.includes('你是 Coprojer 的验证智能体')))
    const display = await app.evaluate(() => global.__coprojerTestDisplay)
    assert.ok(display.windows.every(w => !w.initiallyVisible && w.displayId === display.selection.targetId))
    assert.ok(display.events.every(e => e.displayId === display.selection.targetId))
    assert.deepEqual(errors, []); assert.deepEqual(server.errors, [])
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ at, level: 'isolated real Electron + controlled HTTP + actual command', display, before: budget, after: current.runtimeBudget, stage: current.stage, requests: server.requests.length, errors }, null, 2))
    console.log('PASS: execution-log recovery, valid budget form, guarded continuation, persisted usage, independent verification, keyboard, themes and both sizes')
  } catch (error) {
    if (app) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText()).catch(() => {}) }
    throw error
  } finally { if (app) await app.close(); await server.close(); await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 3 }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
