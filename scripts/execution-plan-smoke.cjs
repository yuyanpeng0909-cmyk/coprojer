const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const http = require('node:http')

async function main() {
  const output = resolve('output/playwright/execution-plan')
  await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(join(output, 'fixture-'))
  const profile = join(sandbox, 'profile')
  const projectRoot = join(sandbox, 'project')
  await fs.mkdir(profile)
  await fs.mkdir(projectRoot)
  const ids = Array.from({ length: 7 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
  const selected = ids.slice(0, 5)
  const feature = (id, title, dependencies = [], stage = 'ready') => ({
    id, title, dependencies, stage, scope: 'current', module: '桌面',
    description: title, criteria: ['功能可用'], plan: '复用现有模块并验证',
    tasks: [{ id: `task-${id}`, title: '实现与验证', done: false }],
    developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '',
  })
  const project = {
    id: 'execution-fixture', name: '执行规划回归', root: projectRoot, brief: '验证执行规划容错',
    createdAt: new Date().toISOString(), discussionModelId: 'fixture', activity: null, previewUrl: null,
    features: [feature(ids[0], '周期提醒', [ids[5]]), feature(ids[1], '主题切换'),
      feature(ids[2], '数据统计', [ids[3]]), feature(ids[3], '最小化到托盘'),
      feature(ids[4], '开机自启', [ids[3]]), feature(ids[5], '计时核心', [], 'done'),
      feature(ids[6], '未选择的设置', [], 'solution')],
    chat: [], context: [], events: [], changes: [], prototypes: [],
  }
  const fallbackOrder = [ids[0], ids[1], ids[3], ids[2], ids[4]]
  const modelOrder = [ids[3], ids[4], ids[2], ids[1], ids[0]]
  let mode = 'missing', calls = [], held
  const fixtureErrors = []
  const provider = http.createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      calls.push(body)
      if (mode === 'http-error') { response.writeHead(503).end('fixture unavailable'); return }
      const input = JSON.parse(body.messages[1].content)
      assert.deepEqual(input.features.map(f => f.id), selected)
      let order = selected.slice(0, 4)
      if (mode === 'duplicate') order = [...selected.slice(0, 4), ids[0]]
      if (mode === 'foreign') order = [...selected.slice(0, 4), ids[6]]
      if (mode === 'dependency') order = selected
      if (mode === 'valid' || mode === 'hold' || mode === 'repair' && calls.length === 2) order = modelOrder
      let content = JSON.stringify({ orderedFeatureIds: order, rationale: '托盘基础先行，再安排相关功能。' })
      if (mode === 'malformed') content = '无法生成 JSON'
      if (mode === 'shape') content = JSON.stringify({ orderedFeatureIds: [null], rationale: '' })
      if (mode === 'hold') await new Promise(resolve => { held = resolve })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    } catch (error) { fixtureErrors.push(error.message); response.writeHead(500).end('fixture failed') }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${provider.address().port}`
  const cycles = ['cycle', 'self', 'missing-dependency', 'unselected-dependency'].map(kind => {
    const copy = structuredClone(project)
    copy.id = kind
    copy.name = kind
    if (kind === 'cycle') { copy.features[0].dependencies = [ids[1]]; copy.features[1].dependencies = [ids[0]] }
    if (kind === 'self') copy.features[0].dependencies = [ids[0]]
    if (kind === 'missing-dependency') copy.features[0].dependencies = ['missing']
    if (kind === 'unselected-dependency') copy.features[0].dependencies = [ids[6]]
    return copy
  })
  await fs.writeFile(join(profile, 'engineering-v1.json'), JSON.stringify({
    version: 1, models: [{ id: 'fixture', name: '本地规划夹具', model: 'fixture', protocol: 'chat', baseUrl, cipher: '' }],
    agents: [], projects: [project, ...cycles],
  }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let desktop, page
  const errors = []
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const current = async () => (await invoke('state')).projects.find(p => p.id === project.id)
  const launch = async () => {
    desktop = await electron.launch({ args: ['.', '--disable-gpu'], cwd: resolve('.'), env, timeout: 30000 })
    page = await desktop.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    await page.getByRole('button', { name: '继续开发 执行规划回归', exact: true }).click()
  }
  const verifyPlan = async (plan, order) => {
    assert.deepEqual(plan.featureIds, selected)
    assert.deepEqual(plan.orderedFeatureIds, order)
    assert.equal(plan.status, 'planned')
    assert.equal(plan.currentIndex, 0)
    const p = await current()
    assert.equal(p.activity, null)
    assert.ok(p.features.filter(f => selected.includes(f.id)).every(f => f.stage === 'ready'))
    assert.equal(p.changes.length, 0)
  }
  try {
    await launch()
    // Reproduce the reported five-feature mismatch through the real UI, preload, IPC and model adapter.
    await page.getByRole('button', { name: '任务看板', exact: true }).click()
    const solutionMenu = page.getByRole('button', { name: '方案确认批量操作', exact: true })
    const readyMenu = page.getByRole('button', { name: '待开发批量操作', exact: true })
    assert.equal(await page.getByRole('button', { name: '需求讨论批量操作', exact: true }).isDisabled(), true)
    assert.equal(await page.locator('.eng-board-summary .eng-board-batch-trigger').count(), 0)
    assert.equal(await page.locator('.eng-board-summary-actions, .eng-board-batch-actions').count(), 0)
    await solutionMenu.click()
    assert.equal(await page.getByRole('menuitem', { name: '批量生成方案', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await solutionMenu.evaluate(el => document.activeElement === el), true)
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    assert.equal(await page.getByRole('menuitem', { name: '全选当前方案', exact: true }).evaluate(el => document.activeElement === el), true)
    await page.keyboard.press('Enter')
    assert.equal(await page.getByRole('checkbox', { name: '选择批量方案：未选择的设置', exact: true }).isChecked(), true)
    await solutionMenu.click()
    assert.equal(await page.getByRole('menuitem', { name: '确认已生成方案', exact: true }).isDisabled(), false)
    await page.getByRole('menuitem', { name: '取消全选', exact: true }).click()
    assert.equal(await page.getByRole('checkbox', { name: '选择批量方案：未选择的设置', exact: true }).isChecked(), false)
    const checkboxes = page.locator('input[aria-label^="选择执行方案："]')
    assert.equal(await checkboxes.count(), 5)
    await readyMenu.click()
    await page.getByRole('menuitem', { name: '全选待开发方案', exact: true }).click()
    for (const box of await checkboxes.all()) assert.equal(await box.isChecked(), true)
    await readyMenu.click()
    await page.getByRole('menuitem', { name: 'LLM 规划执行', exact: true }).click()
    await page.waitForFunction(async id => {
      const p = (await window.desktop.engineering.state()).projects.find(p => p.id === id)
      return !p.activity && p.events.some(e => e.kind === 'plan' || e.kind === 'error')
    }, project.id, { timeout: 7000 })
    let plan = (await current()).executionPlan
    assert.ok(plan, (await current()).events.map(e => e.message).join(' / '))
    await page.locator('[data-testid="execution-plan"]').waitFor({ timeout: 7000 })
    await verifyPlan(plan, fallbackOrder)
    assert.equal(calls.length, 2)
    assert.match(plan.rationale, /本地.*依赖|依赖.*本地/)
    assert.match(await page.locator('[data-testid="execution-plan"]').innerText(), /规划理由/)
    for (const [width, height] of [[1280, 840], [860, 600]]) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await page.screenshot({ path: join(output, `fallback-${width}.png`), animations: 'disabled', scale: 'css' })
      await readyMenu.click()
      assert.ok(await page.getByRole('menuitem', { name: '开始执行计划', exact: true }).isVisible())
      const popup = page.getByRole('menu', { name: '待开发批量操作', exact: true })
      const bounds = await popup.boundingBox()
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height)
      await page.screenshot({ path: join(output, `batch-ready-${width}.png`), animations: 'disabled', scale: 'css' })
      await page.keyboard.press('Escape')
      await solutionMenu.click()
      await page.screenshot({ path: join(output, `batch-solution-${width}.png`), animations: 'disabled', scale: 'css' })
      await page.getByRole('heading', { name: '任务看板', exact: true }).click()
      assert.equal(await page.getByRole('menu', { name: '方案确认批量操作', exact: true }).count(), 0)
    }
    for (const invalid of ['duplicate', 'foreign', 'dependency', 'malformed', 'shape']) {
      mode = invalid; calls = []
      plan = await invoke('planExecution', project.id, selected)
      await verifyPlan(plan, fallbackOrder)
      assert.equal(calls.length, 2, invalid)
    }
    mode = 'repair'; calls = []
    plan = await invoke('planExecution', project.id, selected)
    await verifyPlan(plan, modelOrder)
    assert.equal(calls.length, 2)
    assert.deepEqual(JSON.parse(calls[1].messages.at(-1).content).allowedFeatureIds, selected)
    assert.match(plan.rationale, /托盘基础先行/)
    mode = 'valid'; calls = []
    plan = await invoke('planExecution', project.id, selected)
    await verifyPlan(plan, modelOrder)
    assert.equal(calls.length, 1)
    const savedPlanId = plan.id
    mode = 'http-error'; calls = []
    await assert.rejects(invoke('planExecution', project.id, selected), /503/)
    assert.equal(calls.length, 1)
    assert.equal((await current()).executionPlan.id, savedPlanId)
    calls = []
    for (const kind of ['cycle', 'self']) await assert.rejects(invoke('planExecution', kind, selected), /循环/)
    await assert.rejects(invoke('planExecution', 'missing-dependency', selected), /不存在/)
    await assert.rejects(invoke('planExecution', 'unselected-dependency', selected), /一并选择/)
    assert.equal(calls.length, 0)
    mode = 'hold'; calls = []
    const pending = invoke('planExecution', project.id, selected).then(() => null, error => error)
    const deadline = Date.now() + 5000
    while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(held)
    await invoke('stop', project.id)
    held()
    assert.ok(await pending, 'stopped planning must reject')
    assert.equal((await current()).executionPlan.id, savedPlanId)
    await desktop.close()
    desktop = undefined
    await launch()
    await verifyPlan((await current()).executionPlan, modelOrder)
    assert.equal((await current()).executionPlan.id, savedPlanId)
    await page.getByRole('button', { name: '任务看板', exact: true }).click()
    await page.getByRole('button', { name: '方案确认批量操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '全选当前方案', exact: true }).click()
    await page.getByRole('button', { name: '方案确认批量操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '确认已生成方案', exact: true }).click()
    await page.waitForFunction(async id => (await window.desktop.engineering.state()).projects.find(p => p.id === id).features.find(f => f.title === '未选择的设置').stage === 'ready', project.id)
    assert.equal(await page.getByRole('button', { name: '方案确认批量操作', exact: true }).isDisabled(), true)
    assert.deepEqual(errors, [])
    assert.deepEqual(fixtureErrors, [])
    console.log('PASS: column-header batch menus, selection and confirmation, keyboard and light-dismiss interaction, execution-plan repair and persistence, cancellation and dependencies, and layouts at 1280x840 / 860x600')
  } finally {
    held?.()
    if (desktop) await desktop.close()
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
