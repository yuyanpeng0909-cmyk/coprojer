const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { startResearchProvider } = require('./fixtures/research-provider.cjs')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, label) {
  const until = Date.now() + 20000
  while (Date.now() < until) {
    if (await fn()) return
    await delay(60)
  }
  throw Error('Timed out: ' + label)
}
async function main() {
  const output = resolve('output/playwright')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'research-profile-')),
    parent = await fs.mkdtemp(join(output, 'research-projects-'))
  const provider = await startResearchProvider(),
    env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let desktop, page, pid
  const errors = []
  const invoke = (method, ...args) =>
    page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), {
      method,
      args,
    })
  const project = async () => (await invoke('state')).projects.find((p) => p.id === pid)
  const idle = () => waitFor(async () => !(await project()).activity, 'discussion idle')
  const screenshot = (name) =>
    page.screenshot({ path: join(output, name), animations: 'disabled', scale: 'css' })
  async function launch() {
    desktop = await electron.launch({ args: ['.'], env })
    page = await desktop.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor()
    await page.emulateMedia({ reducedMotion: 'reduce' })
  }
  try {
    await launch()
    const models = {}
    for (const protocol of ['chat', 'anthropic', 'responses'])
      models[protocol] = await invoke('saveModel', {
        id: '',
        name: `流式 ${protocol}`,
        baseUrl: provider.baseUrl,
        model: `stream-${protocol}`,
        protocol,
        apiKey: '',
      })
    const designer = await invoke('saveModel', {
      id: '',
      name: '原型设计 AI',
      baseUrl: provider.baseUrl,
      model: 'designer',
      protocol: 'chat',
      apiKey: '',
    })
    pid = await invoke('createProject', {
      name: '轻记 · 产品需求空间',
      parent,
      brief:
        '为个人开发者设计一个简洁的本地记账应用。先讨论完整需求、数据归属和主要操作，再共同探索界面。',
      modelId: models.chat.id,
    })
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await screenshot('research-empty-light.png')
    provider.control.holdFinal = true
    await page
      .getByLabel('需求讨论内容')
      .fill('最早的原始想法：FIRST_HISTORY_MARKER；记录收支和本地数据归属。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await waitFor(
      async () => (await project()).chat.some((c) => c.status === 'streaming' && c.reasoning),
      'live reasoning',
    )
    await waitFor(
      async () =>
        (await project()).features.length === 3 && provider.control.waitingFinal.length > 0,
      'map updates before final reply completes',
    )
    assert.ok((await project()).activity)
    await page.locator('.smm-node').filter({ hasText: '收支记录' }).waitFor()
    await page.locator('.message-detail.reasoning').first().locator('summary').click()
    await page.locator('.message-detail.tool').first().locator('summary').click()
    await screenshot('research-streaming-light.png')
    provider.releaseFinal()
    await idle()
    let p = await project()
    assert.ok(p.chat.some((c) => c.reasoning))
    assert.ok(
      p.chat.some((c) =>
        c.tools?.some((t) => t.name === 'update_features' && t.status === 'complete'),
      ),
    )
    assert.match(p.requirementsDocument, /非功能要求/)
    assert.ok(
      p.chat.some((c) =>
        c.tools?.some((t) => t.name === 'update_requirements' && t.status === 'complete'),
      ),
    )
    assert.ok(p.features.every((f) => f.stage === 'requirements'))
    assert.equal(p.requirementsBaseline, undefined)
    console.log(
      'PASS: actual SSE text/reasoning/tool output, functional graph updates before completion, no premature workflow transition',
    )
    // Native detached window and live cross-window synchronization.
    let opened = desktop.waitForEvent('window')
    await page.getByRole('button', { name: '独立窗口打开功能图' }).click()
    let detached = await opened
    detached.on('pageerror', (e) => errors.push(e.message))
    await detached.locator('.smm-node').filter({ hasText: '收支记录' }).waitFor()
    await invoke('saveFeature', pid, p.features[0].id, { ...p.features[0], title: '快捷收支记录' })
    await detached.locator('.smm-node').filter({ hasText: '快捷收支记录' }).waitFor()
    await detached.getByRole('button', { name: '关闭窗口', exact: true }).click()
    // Native save dialogs retain explicit format choice; verify actual artifact contents.
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showSaveDialog = async (_window, options) => ({
        canceled: false,
        filePath: folder + '/' + options.defaultPath,
      })
    }, output)
    for (const format of ['svg', 'png', 'md', 'json']) {
      await page.getByLabel('功能图导出格式').selectOption(format)
      await page.getByRole('button', { name: '导出功能图', exact: true }).click()

      const file = join(output, `轻记 · 产品需求空间-功能图.${format}`)
      await waitFor(async () => {
        try {
          return (await fs.stat(file)).size > 50
        } catch {
          return false
        }
      }, 'export ' + format)
      const bytes = await fs.readFile(file)
      if (format === 'png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
      if (format === 'svg') assert.match(bytes.toString(), /<svg/)
      if (format === 'json') assert.ok(JSON.parse(bytes).children.length)
    }
    console.log(
      'PASS: native detached graph stays synchronized; SVG/PNG/Markdown/JSON export saved and validated',
    )
    provider.control.holdDesign = true
    await page.getByRole('button', { name: '设计原型', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '设计原型', exact: true })
    await dialog.getByLabel('设计模型').selectOption(designer.id)
    await dialog.getByLabel('原型设计要求').fill('设计首页，包含月度收支、最近账目和记一笔。')
    await dialog.getByRole('button', { name: '开始设计', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await waitFor(() => provider.control.waitingDesign.length > 0, 'design streaming')
    assert.equal((await project()).designActivity, true)
    const processPanel = page.getByRole('region', { name: '原型设计过程' })
    await processPanel.getByText('正在生成界面', { exact: true }).first().waitFor()
    assert.match(await processPanel.textContent(), /思考.*字符.*原型正文.*字符/)
    assert.equal(await page.locator('.research-prototype pre').count(), 0)
    assert.ok((await processPanel.boundingBox()).height < 90)
    await screenshot('design-process-light.png')
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(860, 600),
    )
    await screenshot('design-process-compact.png')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.getByRole('button', { name: '切换主题' }).click()
    await screenshot('design-process-dark.png')
    await page.getByRole('button', { name: '切换主题' }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 840),
    )
    await processPanel.getByRole('button', { name: '查看过程' }).click()
    const inspector = page.getByRole('dialog', { name: '设计过程', exact: true })
    await inspector.waitFor()
    assert.equal(await inspector.locator('pre').count(), 0)
    await inspector.locator('summary').filter({ hasText: '模型返回的思考' }).click()
    await screenshot('design-process-details.png')
    await inspector.locator('.design-output summary').click()
    await inspector.locator('.design-output pre').waitFor()
    assert.match(await inspector.locator('.design-output pre').textContent(), /doctype html/)
    await inspector.locator('.design-output summary').click()
    await inspector.locator('.design-output pre').waitFor({ state: 'detached' })
    assert.equal(await inspector.locator('.design-output pre').count(), 0)
    await page.keyboard.press('Escape')
    await inspector.waitFor({ state: 'hidden' })
    assert.equal(
      await processPanel
        .getByRole('button', { name: '查看过程' })
        .evaluate((el) => el === document.activeElement),
      true,
    )
    await page.getByLabel('需求讨论内容').fill('原型设计时，我继续补充记录场景。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await idle()
    assert.equal((await project()).designActivity, true)
    provider.releaseDesign()
    await waitFor(async () => !(await project()).designActivity, 'prototype done')
    const designEntry = (await project()).chat.find(
      (e) => e.purpose === 'design' && e.role === 'assistant',
    )
    assert.match(designEntry.designOutput, /doctype html/)
    assert.match(designEntry.designOutput, /PROTOTYPE_INTRO_MARKER/)
    assert.doesNotMatch(
      (await project()).prototypes[0].html,
      /PROTOTYPE_INTRO_MARKER|PROTOTYPE_OUTRO_MARKER|```/,
    )
    assert.ok(designEntry.updatedAt && designEntry.finishedAt)
    await processPanel.getByText('原型已就绪', { exact: true }).waitFor()
    await page
      .getByRole('tablist', { name: '右侧预览' })
      .getByRole('tab', { name: '原型', exact: true })
      .click()
    const frame = page.frameLocator('iframe[title="原型实时预览"]')
    await frame.getByRole('button', { name: '记一笔', exact: true }).click()
    await frame.getByText('已打开记账表单').waitFor()
    assert.doesNotMatch(
      await frame.locator('body').innerText(),
      /PROTOTYPE_INTRO_MARKER|PROTOTYPE_OUTRO_MARKER|```/,
    )
    assert.equal(await frame.locator('body').getAttribute('data-isolated'), 'yes')
    assert.equal(await frame.locator('body').getAttribute('data-bridge'), 'undefined')
    assert.equal(await page.locator('body').getAttribute('data-escape'), null)
    await screenshot('research-prototype-light.png')
    // Detach via the draggable grip, then export the isolated interactive prototype.
    const grip = await page.getByRole('button', { name: '拖出预览窗口' }).boundingBox()
    opened = desktop.waitForEvent('window')
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 120, { steps: 5 })
    await page.mouse.up()
    detached = await opened
    await detached.frameLocator('iframe').getByRole('button', { name: '记一笔' }).waitFor()
    assert.equal(await detached.locator('.research-prototype pre').count(), 0)
    await detached.getByRole('button', { name: '查看过程' }).click()
    await detached.getByRole('dialog', { name: '设计过程', exact: true }).waitFor()
    await detached.keyboard.press('Escape')
    await detached.getByRole('button', { name: '关闭窗口', exact: true }).click()
    await page.getByRole('button', { name: '导出原型', exact: true }).click()
    await waitFor(async () => {
      try {
        return (await fs.stat(join(output, '轻记 · 产品需求空间-原型 1.html'))).size > 500
      } catch {
        return false
      }
    }, 'prototype export')
    assert.doesNotMatch(
      await fs.readFile(join(output, '轻记 · 产品需求空间-原型 1.html'), 'utf8'),
      /PROTOTYPE_INTRO_MARKER|PROTOTYPE_OUTRO_MARKER|```/,
    )
    console.log(
      'PASS: design AI runs independently during discussion; interactive sandboxed prototype, drag-out native window, version persistence and export',
    )
    // Switching protocols must retain all messages, including older than 16 entries.
    for (let n = 0; n < 9; n++) {
      await invoke('discuss', pid, '补充历史 ' + n)
      await idle()
    }
    for (const protocol of ['anthropic', 'responses']) {
      await invoke('setProjectModel', pid, models[protocol].id)
      await invoke('discuss', pid, `请继续讨论 ${protocol}`)
      await idle()
      const req = provider.control.requests.filter((r) => r.model === `stream-${protocol}`).at(-1)
      assert.ok(JSON.stringify(req).includes('FIRST_HISTORY_MARKER'))
      assert.ok(
        (await project()).chat.some(
          (c) => c.modelId === models[protocol].id && c.tools?.some((t) => t.status === 'complete'),
        ),
      )
    }
    p = await project()
    assert.ok(p.chat.length > 20)
    await page.getByRole('button', { name: '确认完整需求', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '确认完整需求', exact: true })
    await dialog.getByRole('button', { name: '确认并保存基线', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    p = await project()
    assert.ok(p.requirementsBaseline)
    assert.ok(p.features.filter((f) => f.scope !== 'later').every((f) => f.stage === 'solution'))
    assert.ok(
      p.context.some((c) => c.title.includes('完整需求基线') && c.content.includes('数据归属')),
    )
    assert.ok(p.context.some((c) => c.content.includes('多账本先作为备选')))
    await page.getByRole('button', { name: '需求文档', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '完整需求文档', exact: true })
    await dialog
      .getByLabel('完整需求文档内容')
      .fill(p.requirementsDocument + '\n手工补充：优先支持键盘录入。')
    await dialog.getByRole('button', { name: '保存文档', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.match((await project()).requirementsDocument, /键盘录入/)
    await assert.rejects(invoke('saveRequirementsDocument', pid, '覆盖', 'stale'), /已更新/)
    const baselineId = p.requirementsBaseline.id
    await invoke('reopenProjectRequirements', pid)
    p = await project()
    assert.ok(p.features.every((f) => f.stage === 'requirements'))
    assert.ok(p.context.some((c) => c.id === baselineId))
    await assert.rejects(invoke('confirmProjectRequirements', pid, 'stale', 0), /已有更新/)
    await invoke('setProjectModel', pid, models.chat.id)
    await invoke('discuss', pid, '测试中断')
    await waitFor(
      async () => (await project()).chat.at(-1).text.includes('部分响应'),
      'partial response before stop',
    )
    await invoke('stop', pid)
    await idle()
    assert.equal((await project()).chat.at(-1).status, 'stopped')
    assert.match((await project()).chat.at(-1).text, /部分响应/)
    assert.match(
      await fs.readFile(join(p.root, '.coprojer/DISCUSSION.md'), 'utf8'),
      /FIRST_HISTORY_MARKER/,
    )
    assert.ok(
      JSON.parse(await fs.readFile(join(p.root, '.coprojer/PROTOTYPES.json'), 'utf8')).length,
    )
    console.log(
      'PASS: all three streaming protocols, signed/encrypted tool continuation, full cross-model history, whole-project baseline, revision and stop preserving partial output',
    )
    await page.getByRole('button', { name: '原型子模块' }).click()
    provider.control.holdDesign = true
    await invoke('generatePrototype', pid, '再设计一版，用于验证停止保留过程', designer.id)
    await waitFor(() => provider.control.waitingDesign.length > 0, 'second design streaming')
    await processPanel.getByText('正在生成界面', { exact: true }).waitFor()
    await screenshot('prototype-updating-full.png')
    assert.equal(await page.locator('.research-prototype pre').count(), 0)
    assert.ok((await page.locator('iframe[title="原型实时预览"]').boundingBox()).height > 350)
    await page.getByRole('button', { name: '停止原型生成' }).click()
    await waitFor(async () => !(await project()).designActivity, 'design stopped')
    assert.equal((await project()).chat.at(-1).status, 'stopped')
    assert.match((await project()).chat.at(-1).text, /doctype html/)
    assert.equal((await project()).prototypes.length, 1)
    await processPanel.getByText('设计已停止', { exact: true }).waitFor()
    await processPanel.getByRole('button', { name: '查看过程' }).click()
    await page.getByLabel('设计过程记录').selectOption(designEntry.id)
    await inspector.getByText('原型已就绪', { exact: true }).waitFor()
    assert.match(await inspector.textContent(), /已校验并保存原型版本/)
    await page.keyboard.press('Escape')
    provider.releaseDesign()
    provider.control.invalidDesign = true
    await invoke('generatePrototype', pid, '验证无效原型的错误反馈', designer.id)
    await waitFor(async () => !(await project()).designActivity, 'invalid prototype rejected')
    await processPanel.getByText('设计未完成', { exact: true }).waitFor()
    await processPanel.getByRole('button', { name: '查看过程' }).click()
    await inspector.getByRole('alert').filter({ hasText: '未返回完整 HTML' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal((await project()).prototypes.length, 1)
    assert.match((await project()).chat.at(-1).designOutput, /没有完整原型/)
    provider.control.invalidDesign = false
    console.log(
      'PASS: live design process in both layouts/themes, persistent raw output, stop preserves previous prototype and history remains inspectable',
    )
    await page.getByRole('button', { name: '功能图子模块' }).click()
    await screenshot('research-map-full.png')
    await page.getByRole('button', { name: '需求子模块' }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(860, 600),
    )
    await page
      .getByRole('tablist', { name: '右侧预览' })
      .getByRole('tab', { name: '功能图', exact: true })
      .click()
    await screenshot('research-compact.png')
    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      window: innerWidth,
      split: document.querySelector('.research-split').getBoundingClientRect().width,
      chat: document.querySelector('.research-conversation').getBoundingClientRect().width,
      preview: document.querySelector('.research-preview').getBoundingClientRect().width,
      compose: document.querySelector('.research-composer').getBoundingClientRect().bottom,
      height: innerHeight,
    }))
    assert.equal(dimensions.document, dimensions.window)
    assert.ok(dimensions.chat + dimensions.preview <= dimensions.split)
    assert.ok(dimensions.compose < dimensions.height)
    await page.getByRole('button', { name: '切换主题' }).click()
    await screenshot('research-dark-compact.png')
    const savedCount = (await project()).chat.length
    await desktop.close()
    desktop = null
    // Older versions saved the entire reply. Reopening must clean the preview without rewriting history.
    const diskPath = join(profile, 'engineering-v1.json')
    const disk = JSON.parse(await fs.readFile(diskPath, 'utf8'))
    disk.projects.find((p) => p.id === pid).prototypes[0].html = designEntry.designOutput
    await fs.writeFile(diskPath, JSON.stringify(disk))
    await launch()
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await page.getByRole('button', { name: '原型子模块' }).click()
    const legacyFrame = page.frameLocator('iframe[title="原型实时预览"]')
    await legacyFrame.getByRole('button', { name: '记一笔' }).click()
    assert.doesNotMatch(
      await legacyFrame.locator('body').innerText(),
      /PROTOTYPE_INTRO_MARKER|PROTOTYPE_OUTRO_MARKER|```/,
    )
    assert.match((await project()).prototypes[0].html, /PROTOTYPE_INTRO_MARKER/)
    assert.equal((await project()).chat.length, savedCount)
    assert.equal((await project()).prototypes.length, 1)
    assert.match(
      (await project()).chat.find((e) => e.id === designEntry.id).designOutput,
      /doctype html/,
    )
    assert.deepEqual(provider.control.errors, [])
    assert.deepEqual(errors, [])
    console.log(
      'PASS: real Electron 1280×840 / 860×600 layouts, dark theme, restart retaining history/prototype/baseline; no renderer errors',
    )
  } catch (e) {
    if (page) await screenshot('research-failure.png').catch(() => {})
    throw e
  } finally {
    if (desktop) await desktop.close()
    await provider.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
