require('./test-display.cjs').install()
const { _electron: electron } = require('playwright'), fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
async function main() {
  const output = path.resolve('output/playwright/context-runtime/m5'); await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(path.join(output, 'isolated-')), profile = path.join(sandbox, 'profile'), root = path.join(sandbox, 'project')
  await fs.mkdir(profile); await fs.mkdir(root); await fs.writeFile(path.join(root, 'value.cjs'), 'exports.value=5')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'migration-ui-fixture', private: true }))
  const feature = { id: 'f', title: '旧任务迁移与换模', description: '隔离 Electron', runtimePolicy: 'legacy', module: '核心', scope: 'current', stage: 'ready', criteria: ['保留可信状态'], plan: '读取隔离文件后暂停', tasks: [{ id: 't', title: '核对并续接', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '' }
  const project = { id: 'p', name: '迁移续接 UI 验证', root, brief: '隔离测试', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
  const server = await provider((_req, n) => n === 1 ? { text: '', calls: [{ id: 'read-once', name: 'read_file', arguments: JSON.stringify({ path: 'value.cjs' }) }] }
    : { text: JSON.stringify({ status: 'incomplete', summary: '已保留进度', nextStep: '人工核对' }), calls: [] })
  await fs.writeFile(path.join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, projects: [project], agents: [], models: [
    { id: 'fixture', name: 'fixture', model: 'fixture', protocol: 'chat', baseUrl: server.url, cipher: '' },
    { id: 'target', name: 'target', model: 'target', protocol: 'responses', baseUrl: server.url, cipher: '', capabilities: { toolCalling: true } },
  ] }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app; const errors = []
  try {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: process.cwd(), env }); const page = await app.firstWindow()
    page.setDefaultTimeout(25000); page.on('pageerror', e => errors.push(e.message)); await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '继续开发 ' + project.name, exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '开发执行', exact: true }).click()
    const open = async () => { await page.locator('.delivery-table').getByRole('button', { name: feature.title, exact: true }).click(); await page.getByRole('dialog', { name: feature.title, exact: true }).getByRole('tab', { name: '日志', exact: true }).click() }
    await open(); let drawer = page.getByRole('dialog', { name: feature.title, exact: true })
    await drawer.getByRole('button', { name: '开始开发', exact: true }).click()
    await page.waitForFunction(async () => { const p = (await window.desktop.engineering.state()).projects[0]; return !p.activity && p.features[0].stage === 'blocked' })
    assert.equal(server.requests.length, 2)
    if (!(await drawer.isVisible())) await open()
    await drawer.getByText('任务迁移与换模 · 旧运行策略', { exact: true }).click()
    const migrate = drawer.getByRole('button', { name: '核对并迁移旧任务', exact: true }); await migrate.click({ trial: true }); await migrate.focus()
    assert.ok(await migrate.evaluate(el => el === document.activeElement)); await page.keyboard.press('Enter')
    await drawer.getByText('任务迁移与换模 · 可靠执行已启用', { exact: true }).waitFor()
    assert.equal(server.requests.length, 2)
    await drawer.getByLabel('本功能续接连接').selectOption('target')
    await drawer.getByRole('button', { name: '保存续接模型', exact: true }).click()
    await drawer.getByText('续接记录与原件（2）', { exact: true }).click()
    await drawer.getByRole('button', { name: '查看续接原件', exact: true }).first().click()
    await drawer.getByLabel('续接原件分页').waitFor(); assert.match(await drawer.getByLabel('续接原件分页').innerText(), /checkpoint|旧完整|read-once/)
    await drawer.getByText('任务累计额度 · 待明确授予', { exact: true }).click()
    await drawer.getByRole('button', { name: '调整任务总额度', exact: true }).click()
    await drawer.getByLabel('模型请求总额度').fill('4'); await drawer.getByLabel('工具调用总额度').fill('4'); await drawer.getByLabel('活动分钟总额度').fill('1')
    await drawer.getByLabel('调整原因').fill('隔离迁移后明确授予有限额度'); await drawer.getByRole('button', { name: '保存额度', exact: true }).click()
    assert.equal(server.requests.length, 2)
    await drawer.getByRole('button', { name: '继续执行', exact: true }).click()
    await page.waitForFunction(async () => { const p = (await window.desktop.engineering.state()).projects[0]; return !p.activity && p.features[0].runtimeBudget.used.requests === 1 })
    assert.equal(server.requests.length, 3); assert.equal(server.requests[2].protocol, 'responses')
    await page.reload(); await page.getByRole('button', { name: '继续开发 ' + project.name, exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '开发执行', exact: true }).click(); await open()
    drawer = page.getByRole('dialog', { name: feature.title, exact: true })
    await drawer.getByText('任务迁移与换模 · 可靠执行已启用', { exact: true }).click()
    await drawer.getByText('续接记录与原件（2）', { exact: true }).click()
    for (const [width, height] of [[1280, 840], [860, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await drawer.getByText('任务迁移与换模 · 可靠执行已启用', { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, `migration-${width}x${height}.png`), animations: 'disabled' })
    }
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '切换主题', exact: true }).click(); await open()
    await drawer.getByText('任务迁移与换模 · 可靠执行已启用', { exact: true }).click()
    await page.screenshot({ path: path.join(output, 'migration-dark-860x600.png'), animations: 'disabled' })
    const state = await page.evaluate(() => window.desktop.engineering.state()), f = state.projects[0].features[0], display = await app.evaluate(() => global.__coprojerTestDisplay)
    assert.equal(f.runtimeHandoffs.length, 2); assert.equal(f.runtimeBudget.historical.kind, 'unknown'); assert.equal(f.runtimeBudget.used.requests, 1); assert.equal(f.runtimeBudget.used.tools, 0)
    assert.equal(f.stage, 'blocked'); assert.equal(server.requests.length, 3); assert.deepEqual(errors, [])
    assert.ok(display.windows.every(w => !w.initiallyVisible && w.displayId === display.selection.targetId)); assert.ok(display.events.every(e => e.displayId === display.selection.targetId))
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), level: 'real isolated Electron + HTTP/SSE', display, feature: f, requests: server.requests, errors }, null, 2))
    console.log('PASS: UI legacy migration, feature-scoped model selection, original read, explicit allowance, portable Responses continuation, renderer reload, both layouts/themes and focus')
  } catch (error) {
    if (app) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText()).catch(() => {}) }
    throw error
  } finally { if (app) await app.close(); await server.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
