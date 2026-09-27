const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { startRoundtableProvider } = require('./fixtures/roundtable-provider.cjs')
async function waitFor(fn, label) {
  const until = Date.now() + 20000
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
    // A native window can disappear while Playwright is completing the click.
    // That is the expected outcome for this control, not a test failure.
    if (!window.isClosed()) throw error
  }
  await waitFor(() => window.isClosed(), 'native panel closed')
}
;(async () => {
  const output = path.resolve('output/playwright'),
    profile = await fs.mkdtemp(path.join(output, 'roundtable-profile-')),
    parent = await fs.mkdtemp(path.join(output, 'roundtable-project-'))
  const provider = await startRoundtableProvider(),
    env = { ...process.env, COPROJER_USER_DATA: profile }
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
  const screenshot = (name) =>
    page.screenshot({ path: path.join(output, name), scale: 'css', animations: 'disabled' })
  async function launch() {
    app = await electron.launch({ args: ['.'], env })
    page = await app.firstWindow()
    page.setDefaultTimeout(12000)
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    if (pid) await page.getByRole('button', { name: '继续开发 多端设备平台', exact: true }).click()
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
          baseUrl: provider.baseUrl,
          model: name,
          protocol: name === '产品模型' ? 'responses' : 'chat',
          apiKey: '',
        }),
      )
    pid = await call('createProject', {
      name: '多端设备平台',
      brief: '从零设计一个含用户界面、后台、移动端与 IoT 设备的产品。',
      parent,
      modelId: models[0].id,
    })
    await page.getByRole('button', { name: '继续开发 多端设备平台', exact: true }).click()
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await page.getByRole('button', { name: '圆桌讨论', exact: true }).click()
    const configDialog = page.getByRole('dialog', { name: '配置圆桌会议' })
    await configDialog.getByRole('checkbox', { name: '产品模型', exact: true }).check()
    await configDialog.getByRole('checkbox', { name: '架构模型', exact: true }).check()
    await configDialog.getByRole('button', { name: '使用此配置' }).click()
    provider.control.hold = true
    await page
      .getByLabel('需求讨论内容')
      .fill('FIRST_ROUND_MARKER：先由大家讨论完整多端方案，然后交给我。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await waitFor(() => provider.control.waiting.length > 0, 'streaming roundtable')
    assert.equal((await project()).roundtable.status, 'running')
    await page.getByText('第 1 轮 · 提出方案 · 产品负责人 / 主持人', { exact: true }).waitFor()
    await screenshot('roundtable-streaming.png')
    provider.release()
    await idle()
    let p = await project()
    assert.equal(p.roundtable.status, 'awaiting-human', p.roundtable.error)
    const synthesis = provider.control.requests.find((r) =>
      (r.instructions || '').includes('你是本轮圆桌主持人'),
    )
    const sharedHistory = synthesis.input
    assert.ok(sharedHistory.every((item) => item.role !== 'assistant'))
    assert.ok(sharedHistory.some((item) => item.content.includes('架构模型 的意见')))
    assert.ok(sharedHistory.some((item) => item.content.includes('历史 AI 发言')))
    const continuation = provider.control.requests.find((r) =>
      r.input?.some((item) => item.type === 'function_call_output'),
    )
    assert.ok(continuation.input.some((item) => item.role === 'assistant'))
    assert.ok(
      continuation.input.some(
        (item) =>
          item.type === 'reasoning' &&
          item.content.some(
            (part) =>
              part.type === 'reasoning_text' &&
              part.text === '先核对端边界，再检查各端功能和接口。',
          ),
      ),
    )
    assert.equal(p.targets.length, 4)
    assert.equal(p.features.length, 4)
    assert.ok(p.features.every((f) => f.targetId && f.stage === 'requirements'))
    assert.equal(
      p.chat.filter(
        (c) => c.purpose === 'roundtable' && c.role === 'assistant' && c.speaker !== '主持人汇总',
      ).length,
      4,
    )
    assert.equal(p.features.filter((f) => f.title === '设备状态').length, 2)
    assert.ok(
      provider.control.requests.some(
        (r) =>
          (r.instructions || r.messages[0].content).includes('针对其他参会者') &&
          JSON.stringify(r).includes('产品模型 的意见'),
      ),
    )
    assert.ok(!p.requirementsBaseline)
    await assert.rejects(
      call('saveTargets', pid, [{ ...p.targets[0], directory: '../outside' }]),
      /相对目录/,
    )
    await assert.rejects(
      call('roundtableTurn', pid, '无效配置', {
        participants: [
          { modelId: models[0].id, role: 'A' },
          { modelId: models[0].id, role: 'B' },
        ],
        passes: 1,
      }),
      /只能入会一次/,
    )
    assert.equal((await project()).roundtable.round, 1)
    assert.equal((await project()).targets.length, 4)
    const count = provider.control.requests.length
    await new Promise((r) => setTimeout(r, 350))
    assert.equal(provider.control.requests.length, count)
    await page.getByRole('button', { name: '子项目子模块' }).click()
    await page.getByRole('heading', { name: '用户前端', exact: true }).waitFor()
    await screenshot('roundtable-targets-light.png')
    let opened = app.waitForEvent('window')
    await page
      .locator('.target-card')
      .filter({ has: page.getByRole('heading', { name: '用户前端', exact: true }) })
      .getByRole('button', { name: '功能窗口' })
      .click()
    const webWindow = await opened
    await webWindow.locator('.smm-node').filter({ hasText: '设备状态' }).waitFor()
    assert.equal(await webWindow.locator('.smm-node').filter({ hasText: '设备接口' }).count(), 0)
    opened = app.waitForEvent('window')
    await page
      .locator('.target-card')
      .filter({ has: page.getByRole('heading', { name: '后台服务', exact: true }) })
      .getByRole('button', { name: '功能窗口' })
      .click()
    const apiWindow = await opened
    await apiWindow.locator('.smm-node').filter({ hasText: '设备接口' }).waitFor()
    assert.equal(await apiWindow.locator('.smm-node').filter({ hasText: '设备状态' }).count(), 0)
    assert.equal((await webWindow.evaluate(() => window.desktop.researchPanel())).targetId, 'web')
    assert.equal((await apiWindow.evaluate(() => window.desktop.researchPanel())).targetId, 'api')
    await closePanel(apiWindow)
    await closePanel(webWindow)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 600))
    await page.waitForFunction(() => innerWidth === 860 && innerHeight === 600)
    await screenshot('roundtable-targets-compact.png')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.getByRole('button', { name: '切换主题' }).click()
    await screenshot('roundtable-targets-dark.png')
    await page.getByRole('button', { name: '切换主题' }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 840))
    await page.getByRole('button', { name: '需求子模块' }).click()
    await page
      .getByLabel('需求讨论内容')
      .fill('HUMAN_FEEDBACK_MARKER：移动端保留，离线缓存限定为 24 小时，请各位继续讨论。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await waitFor(async () => (await project()).roundtable.round === 2, 'second round')
    await idle()
    p = await project()
    assert.equal(p.roundtable.status, 'awaiting-human')
    assert.equal(p.features.length, 4)
    const request = provider.control.requests.at(-1)
    assert.ok(JSON.stringify(request).includes('FIRST_ROUND_MARKER'))
    assert.ok(JSON.stringify(request).includes('HUMAN_FEEDBACK_MARKER'))
    for (const brief of Object.values((await project()).prototypeBriefs || {}).filter(b => p.targets.some(t => t.id === b.targetId && ['web', 'admin', 'mobile', 'desktop'].includes(t.kind)))) {
      await call('submitPrototypePreferences', pid, '清晰的业务布局，按此端需求呈现主要信息。', brief.targetId)
      await waitFor(async () => !(await project()).designActivity, 'review prototype')
      await call('acceptPrototypeAndPreparePrd', pid, (await project()).prototypes.at(-1).id)
    }
    await page.getByRole('button', { name: '审阅完整方案' }).click()
    const review = page.getByRole('region', { name: '需求与规格审阅' })
    await review.waitFor()
    // Prototype approval can update the PRD after this review snapshot opens.
    // Explicitly refresh the review, as a person must, before confirming it.
    await waitFor(async () => {
      if (await review.locator('.specification-warning').isVisible())
        await review.getByRole('button', { name: '刷新审阅内容', exact: true }).click()
      return await review.getByRole('button', { name: '确认并保存基线', exact: true }).isEnabled()
    }, 'latest requirement review ready')
    assert.equal(await review.locator('.specification-target').count(), 4)
    await review.getByRole('button', { name: '确认并保存基线' }).click()
    await waitFor(
      async () => (await project()).roundtable.status === 'confirmed',
      'human confirmation',
    )
    p = await project()
    assert.ok(p.context.some((c) => c.title === '已确认的多端项目边界'))
    assert.ok(p.features.every((f) => f.stage === 'solution'))
    await call('generatePrototype', pid, '为用户前端设计设备页', models[0].id, 'web')
    await waitFor(async () => !(await project()).designActivity, 'target prototype')
    assert.equal((await project()).prototypes.at(-1).targetId, 'web')
    opened = app.waitForEvent('window')
    await page.evaluate((id) => window.desktop.openResearchPanel(id, 'prototype', 'web'), pid)
    const webPrototype = await opened
    await webPrototype
      .frameLocator('iframe')
      .getByRole('heading', { name: '子项目专属原型' })
      .waitFor()
    opened = app.waitForEvent('window')
    await page.evaluate((id) => window.desktop.openResearchPanel(id, 'prototype', 'api'), pid)
    const apiPrototype = await opened
    await apiPrototype.getByText('这里将展示你的原型', { exact: true }).waitFor()
    assert.equal(await apiPrototype.locator('iframe').count(), 0)
    await closePanel(webPrototype)
    await closePanel(apiPrototype)
    await call('reopenProjectRequirements', pid)
    const config = {
      participants: models.map((m, i) => ({ modelId: m.id, role: i ? '架构评审' : '产品主持' })),
      passes: 1,
    }
    provider.control.hold = true
    await call('roundtableTurn', pid, '测试停止圆桌', config)
    await waitFor(() => provider.control.waiting.length > 0, 'held round')
    await call('stop', pid)
    await idle()
    assert.equal((await project()).roundtable.status, 'stopped')
    provider.release()
    provider.control.fail = true
    await call('roundtableTurn', pid, '测试模型失败', config)
    await idle()
    assert.equal((await project()).roundtable.status, 'error')
    provider.control.fail = false
    assert.ok((await project()).chat.some((c) => c.status === 'stopped'))
    assert.ok((await project()).chat.some((c) => c.status === 'error'))
    provider.control.hold = true
    await call('roundtableTurn', pid, '重启恢复中的圆桌', config)
    await waitFor(() => provider.control.waiting.length > 0, 'restart during roundtable')
    const before = (await project()).chat.length
    await app.close()
    app = null
    provider.release()
    await launch()
    assert.equal((await project()).chat.length, before)
    assert.equal((await project()).targets.length, 4)
    assert.equal((await project()).roundtable.status, 'stopped')
    await call('roundtableTurn', pid, 'RESTART_FEEDBACK_MARKER：保留此前讨论，继续汇总。', config)
    await idle()
    assert.equal((await project()).roundtable.status, 'awaiting-human')
    const resumedRequest = JSON.stringify(provider.control.requests.at(-1))
    assert.ok(resumedRequest.includes('FIRST_ROUND_MARKER'))
    assert.ok(resumedRequest.includes('HUMAN_FEEDBACK_MARKER'))
    assert.ok(resumedRequest.includes('RESTART_FEEDBACK_MARKER'))
    assert.deepEqual(errors, [])
    console.log(
      'PASS: strict Responses thinking history and native tool continuation, mixed-model proposal/review/synthesis, human feedback and confirmation, 4 project scopes and windows, scoped prototype, stop/error, restart and resume, both layouts/themes',
    )
  } catch (e) {
    if (page) await screenshot('roundtable-failure.png').catch(() => {})
    throw e
  } finally {
    if (app) await app.close()
    await provider.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
