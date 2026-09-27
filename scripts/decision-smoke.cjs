const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { startRoundtableProvider } = require('./fixtures/roundtable-provider.cjs')
async function waitFor(fn, label) {
  const until = Date.now() + 15000
  while (Date.now() < until) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 60))
  }
  throw Error('Timeout: ' + label)
}
async function closePanel(window) {
  try {
    await window.getByRole('button', { name: '关闭窗口', exact: true }).click({ noWaitAfter: true })
  } catch (error) {
    // Native panel close can destroy the page before Playwright finishes the click.
    if (!window.isClosed()) throw error
  }
  await waitFor(() => window.isClosed(), 'native panel closed')
}
;(async () => {
  const output = path.resolve('output/playwright')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'decision-profile-'))
  const parent = await fs.mkdtemp(path.join(output, 'decision-project-'))
  const provider = await startRoundtableProvider()
  provider.control.decisions = 'main'
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let app, page, pid
  const errors = []
  const call = (method, ...args) =>
    page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), {
      method,
      args,
    })
  const project = async () => (await call('state')).projects.find((p) => p.id === pid)
  const idle = () => waitFor(async () => !(await project()).activity, 'idle')
  const pending = () =>
    waitFor(
      async () => (await project()).decisions?.some((d) => d.status === 'pending'),
      'decision card',
    )
  const card = () => page.getByRole('region', { name: '待决卡' })
  const screenshot = (name) =>
    page.screenshot({ path: path.join(output, name), scale: 'css', animations: 'disabled' })
  async function launch() {
    app = await electron.launch({ args: ['.'], env })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    if (pid) await page.getByRole('button', { name: '继续开发 设备协作方案', exact: true }).click()
    await page.emulateMedia({ reducedMotion: 'reduce' })
  }
  try {
    await launch()
    const models = []
    for (const name of ['产品模型', '架构模型'])
      models.push(
        await call('saveModel', {
          id: '',
          name,
          model: name,
          baseUrl: provider.baseUrl,
          protocol: name === '产品模型' ? 'responses' : 'chat',
          apiKey: '',
        }),
      )
    pid = await call('createProject', {
      name: '设备协作方案',
      brief: '讨论多端设备产品，遇到取舍即时交给人工，边讨论边整理功能图。',
      parent,
      modelId: models[0].id,
    })
    await page.getByRole('button', { name: '继续开发 设备协作方案', exact: true }).click()
    const config = {
      participants: models.map((m, i) => ({ modelId: m.id, role: i ? '架构评审' : '产品负责人' })),
      passes: 1,
    }
    await call('roundtableTurn', pid, 'DECISION_ORIGINAL：先讨论设备状态和离线策略。', config)
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await pending()
    let p = await project()
    assert.equal(p.roundtable.status, 'awaiting-decision')
    assert.equal(
      p.features.length,
      1,
      'features update during the first participant, before human input',
    )
    assert.equal(p.targets.length, 4)
    assert.equal(p.decisions.length, 1)
    assert.equal(
      p.chat.at(-1).status,
      'complete',
      'model output is finished while awaiting a person',
    )
    assert.ok(!provider.control.requests.some((r) => r.model === '架构模型'))
    const first = p.decisions[0]
    await card().getByRole('heading', { name: first.question }).waitFor()
    await page.locator('.smm-node').filter({ hasText: '设备状态' }).waitFor()
    const count = provider.control.requests.length
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(
      provider.control.requests.length,
      count,
      'no model requests while waiting for a person',
    )
    await screenshot('decision-live-light.png')
    await card().getByRole('button', { name: '收起决策卡' }).click()
    await page.getByRole('button', { name: '1 项待你决定' }).click()
    await card().getByRole('heading', { name: first.question }).waitFor()
    const opened = app.waitForEvent('window')
    await page.evaluate((id) => window.desktop.openResearchPanel(id, 'map', 'web'), pid)
    const graph = await opened
    await graph.locator('.smm-node').filter({ hasText: '设备状态' }).waitFor()
    await closePanel(graph)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 600))
    await page.waitForFunction(() => innerWidth === 860 && innerHeight === 600)
    await waitFor(
      () =>
        page.locator('.mindmap-canvas').evaluate((el) => {
          const canvas = el.getBoundingClientRect()
          return [...el.querySelectorAll('.smm-node')].every((node) => {
            const box = node.getBoundingClientRect()
            return (
              box.left >= canvas.left - 1 &&
              box.right <= canvas.right + 1 &&
              box.top >= canvas.top - 1 &&
              box.bottom <= canvas.bottom + 1
            )
          })
        }),
      'graph fits compact canvas after resize',
    )
    await screenshot('decision-live-compact.png')
    assert.equal(await page.locator('.prototype-opinion').count(), 0, 'resolve pending decisions before asking for design preferences')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    const submitBox = await card().getByRole('button', { name: '提交并继续' }).boundingBox()
    assert.ok(submitBox && submitBox.y + submitBox.height <= 600)
    await page.getByRole('button', { name: '切换主题' }).click()
    await screenshot('decision-live-dark.png')
    await page.getByRole('button', { name: '切换主题' }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 840))
    const messageCount = (await project()).chat.length
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('fs')
      const rename = fs.renameSync
      fs.renameSync = () => {
        fs.renameSync = rename
        const error = new Error('simulated storage failure')
        error.code = 'EIO'
        throw error
      }
    })
    await assert.rejects(call('answerDecision', pid, first.id, { defer: true }), /未能保存决定/)
    assert.equal((await project()).decisions[0].status, 'pending')
    assert.equal((await project()).chat.length, messageCount)
    // Windows can briefly deny replacement while another process opens the file.
    // Exercise the real atomic save path, in this isolated Electron process only.
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('fs')
      const rename = fs.renameSync
      let remaining = 3
      fs.renameSync = (from, to) => {
        if (String(to).endsWith('engineering-v1.json') && remaining-- > 0) {
          const error = new Error('simulated temporary file lock')
          error.code = 'EPERM'
          throw error
        }
        fs.renameSync = rename
        return rename(from, to)
      }
    })
    await card().getByRole('button', { name: '后面再说', exact: true }).click()
    await waitFor(async () => (await project()).decisions.length === 2, 'next participant decision')
    p = await project()
    assert.equal(p.decisions[0].status, 'resolved')
    assert.equal(p.decisions[0].resolvedBy, '架构模型')
    assert.match(p.decisions[0].answer, /后面再说/)
    assert.equal(p.decisions[1].status, 'pending')
    assert.ok(p.features.some((f) => f.title === '离线缓存'))
    await page.locator('.smm-node').filter({ hasText: '离线缓存' }).waitFor()
    await card()
      .getByRole('radio', { name: /仅内部人员/ })
      .check()
    await card().getByLabel('决策补充想法').fill('CHOICE_NOTE：先给两家试点使用，暂不开放注册。')
    await card().getByRole('button', { name: '提交并继续' }).click()
    await idle()
    p = await project()
    assert.equal(p.roundtable.status, 'awaiting-human', p.roundtable.error)
    // Rapid revisions plus layout changes must not leave duplicate SVG nodes.
    const cachedFeature = p.features.find((f) => f.title === '离线缓存')
    for (let revision = 0; revision < 10; revision++) {
      await call('saveFeature', pid, cachedFeature.id, {
        ...cachedFeature,
        module: revision % 2 ? '设备管理' : '实时状态',
        criteria: [`缓存验收 ${revision}`],
      })
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 840),
        revision % 2 ? 1280 : 1260,
      )
      await new Promise((r) => setTimeout(r, 70))
    }
    await waitFor(
      async () => (await page.locator('.smm-node').filter({ hasText: '离线缓存' }).count()) === 1,
      'single feature node after rapid revisions',
    )
    assert.match(p.decisions[1].answer, /仅内部人员[\s\S]*CHOICE_NOTE/)
    assert.ok(JSON.stringify(provider.control.requests.at(-1)).includes('CHOICE_NOTE'))
    assert.ok(!p.requirementsBaseline)
    await assert.rejects(call('answerDecision', pid, first.id, { defer: true }), /已经处理/)
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(p.root, '.coprojer/DECISIONS.json'), 'utf8')),
      p.decisions,
    )
    await page.getByText('决策记录 · 2 项', { exact: true }).click()
    await page.getByText('模型已给出建议 · 产品负责人 · 第 1 轮', { exact: true }).waitFor()
    await screenshot('decision-history.png')

    provider.control.decisions = 'recovery'
    await call('roundtableTurn', pid, '验证暂停和重启后处理卡片。', config)
    await pending()
    await card().getByRole('button', { name: '停止圆桌' }).click()
    await idle()
    p = await project()
    assert.equal(p.roundtable.status, 'stopped')
    await assert.rejects(call('roundtableTurn', pid, '不能绕过卡片', config), /先处理待决卡/)
    await assert.rejects(
      call('answerDecision', pid, p.decisions.at(-1).id, { choice: 99 }),
      /有效选项/,
    )
    await card().getByLabel('决策补充想法').fill('CUSTOM_ONLY：离线保留 48 小时，存储不够时提示。')
    await card().getByRole('button', { name: '提交并继续' }).click()
    await waitFor(async () => (await project()).decisions.length === 4, 'second recovery card')
    assert.equal((await project()).roundtable.cursor, 1)
    await card()
      .getByRole('radio', { name: /仅内部人员/ })
      .check()
    await card().getByLabel('决策补充想法').fill('RESTART_DRAFT：内部试点优先。')
    await app.close()
    app = null
    await launch()
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    p = await project()
    assert.equal(p.roundtable.status, 'stopped')
    assert.equal(p.decisions.at(-1).status, 'pending')
    await card().getByLabel('决策补充想法').waitFor()
    assert.equal(
      await card()
        .getByRole('radio', { name: /仅内部人员/ })
        .isChecked(),
      true,
    )
    assert.equal(
      await card().getByLabel('决策补充想法').inputValue(),
      'RESTART_DRAFT：内部试点优先。',
    )
    const before = provider.control.requests.length
    await card().getByRole('button', { name: '提交并继续' }).click()
    await idle()
    p = await project()
    assert.equal(p.roundtable.status, 'awaiting-human', p.roundtable.error)
    assert.equal(
      provider.control.requests[before].model,
      '架构模型',
      'resume at interrupted participant',
    )
    assert.ok(p.decisions.every((d) => d.status !== 'pending'))
    assert.ok(JSON.stringify(provider.control.requests.at(-1)).includes('CUSTOM_ONLY'))
    assert.ok(JSON.stringify(provider.control.requests.at(-1)).includes('RESTART_DRAFT'))
    assert.deepEqual(errors, [])
    console.log(
      'PASS: incremental participant graph updates, one-at-a-time live decision cards, waiting without requests, defer to another model, choice and free text, native graph, compact/light/dark, validation, stop/resume, restart with pending card and draft, original reasoning continuation',
    )
  } catch (e) {
    if (page) await screenshot('decision-failure.png').catch(() => {})
    throw e
  } finally {
    if (app) await app.close()
    await provider.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
