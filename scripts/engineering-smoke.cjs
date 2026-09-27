const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { startProvider } = require('./fixtures/engineering-provider.cjs')

async function main() {
  const output = resolve('output/playwright')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'engineering-profile-'))
  const parent = await fs.mkdtemp(join(output, 'engineering-projects-'))
  const provider = await startProvider()
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const errors = []
  let desktop, page
  const invoke = (method, ...args) =>
    page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), {
      method,
      args,
    })
  const state = () => invoke('state')
  const project = async (id) => (await state()).projects.find((p) => p.id === id)
  const waitFor = async (predicate, label, timeout = 45000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    throw new Error('Timed out: ' + label)
  }
  const idle = async (id) => waitFor(async () => !(await project(id)).activity, 'project idle')
  async function launch() {
    desktop = await electron.launch({ args: ['.'], env, timeout: 30000 })
    page = await desktop.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor()
    await waitFor(async () => (await state()).agents.length === 4, 'main service')
  }
  const featureInput = (title, dependencies = []) => ({
    title,
    module: '账目管理',
    description: '可验证的小功能',
    criteria: ['金额汇总正确'],
    scope: 'current',
    dependencies,
    developerId: 'developer',
    reviewerId: 'reviewer',
  })
  const prepare = async (pid, title) => {
    const id = await invoke('saveFeature', pid, null, featureInput(title))
    await invoke('submitPrototypePreferences', pid, '保持现有记账界面，按新功能更新原型。')
    await waitFor(async () => !(await project(pid)).designActivity, 'prototype ready')
    await invoke('acceptPrototypeAndPreparePrd', pid, (await project(pid)).prototypes.at(-1).id)
    await invoke('confirmRequirements', pid, id)
    await invoke('savePlan', pid, id, '使用已有模块，运行测试。', ['实现', '测试'])
    await invoke('confirmPlan', pid, id)
    return id
  }
  try {
    await launch()
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-empty-light.png'),
    })
    await page.getByRole('button', { name: '模型连接', exact: true }).click()
    await page.getByRole('button', { name: '新增模型', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '新增模型', exact: true })
    await dialog.getByLabel('显示名称').fill('本地协议测试模型')
    await dialog.getByLabel('服务地址 Base URL').fill(provider.baseUrl)
    await dialog.getByLabel('API Key', { exact: false }).fill('coprojer-fixture-secret')
    await dialog.getByRole('button', { name: '获取列表' }).click()
    await dialog.getByText('获取到 2 个模型，可在模型标识中选择。').waitFor()
    await dialog.locator('input[list]').fill('glm-5.3-flash')
    await dialog.getByRole('button', { name: '测试连接' }).click()
    await dialog.getByText(/连接成功 · 连接成功/).waitFor()
    assert.ok(!(await dialog.innerText()).includes('coprojer-fixture-secret'))
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-add-model.png'),
    })
    await dialog.getByRole('button', { name: '保存模型' }).click()
    await dialog.waitFor({ state: 'hidden' })
    let snapshot = await state(),
      model = snapshot.models[0]
    const originalReviewer = snapshot.agents.find((a) => a.role === 'reviewer')
    assert.equal(model.hasKey, true)
    assert.ok(!('cipher' in model) && !('apiKey' in model))
    assert.ok(
      !(await fs.readFile(join(profile, 'engineering-v1.json'), 'utf8')).includes(
        'coprojer-fixture-secret',
      ),
    )
    const unsaved = {
      id: '',
      name: 'test',
      baseUrl: provider.baseUrl,
      model: 'glm-5.3-flash',
      protocol: 'chat',
      apiKey: 'invalid-test-key',
    }
    await assert.rejects(
      invoke('testModel', unsaved),
      (error) => /401/.test(error.message) && !error.message.includes('invalid-test-key'),
    )
    await assert.rejects(
      invoke('saveModel', { ...unsaved, baseUrl: 'https://example.com/v1?secret=oops' }),
      /查询参数/,
    )
    for (const protocol of ['responses', 'anthropic']) {
      const response = await invoke('testModel', {
        ...unsaved,
        apiKey: 'temporary-test-key',
        protocol,
      })
      assert.match(response, /连接成功/)
      assert.ok(!response.includes('temporary-test-key'))
    }
    console.log(
      'PASS: add-model UI, three protocol tests, encrypted keys, redacted errors, model discovery',
    )
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page
      .locator('.eng-agent-card')
      .filter({ hasText: '验证智能体' })
      .getByRole('button', { name: '配置' })
      .click()
    dialog = page.getByRole('dialog', { name: '配置智能体' })
    assert.equal(await dialog.getByRole('checkbox', { name: '修改文件' }).isDisabled(), true)
    await dialog.getByRole('checkbox', { name: '运行命令与测试' }).uncheck()
    await dialog.getByRole('button', { name: '保存智能体' }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.ok(
      !(await state()).agents.find((a) => a.role === 'reviewer').tools.includes('run_command'),
    )

    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '新建工程项目', exact: true })
    // Only replace the OS picker, preserving actual UI + preload + IPC.
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, parent)
    await dialog.getByLabel('项目名称').fill('个人记账首测')
    await dialog.getByRole('button', { name: '选择位置' }).click()
    await page.waitForFunction(
      (folder) => document.querySelector('input[placeholder="选择父目录"]')?.value === folder,
      parent,
    )
    await dialog.getByLabel('项目目标').fill('从零做一个本地个人记账网页应用，支持收支和刷新保存。')
    await dialog.getByRole('button', { name: '创建工程', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    snapshot = await state()
    const pid = snapshot.projects[0].id
    assert.deepEqual((await fs.readdir(snapshot.projects[0].root)).sort(), ['.coprojer'])
    await assert.rejects(
      invoke('createProject', { parent, name: '个人记账首测', brief: '', modelId: model.id }),
      /已存在/,
    )
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await page
      .getByRole('textbox', { name: '需求讨论内容' })
      .fill('先做收入支出记录、结余计算和本地保存。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.locator('.smm-node').filter({ hasText: '记录收支' }).waitFor()
    await idle(pid)
    let p = await project(pid),
      fid = p.features[0].id

    // A late response cannot overwrite a direct user edit.
    provider.control.hold = true
    await invoke('discuss', pid, '继续完善功能')
    await waitFor(() => provider.control.held.length > 0, 'held discussion')
    await invoke('saveFeature', pid, fid, {
      ...p.features[0],
      description: '用户最新编辑：保留两位小数，并在刷新后保存收支。',
    })
    provider.release()
    await idle(pid)
    p = await project(pid)
    assert.match(p.features[0].description, /用户最新编辑/)
    assert.ok(p.events.some((e) => /过期的模型修改/.test(e.message)))
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-map-light.png'),
    })

    await invoke('submitPrototypePreferences', pid, '简洁的记账界面，突出金额输入与结余。')
    await waitFor(async () => !(await project(pid)).designActivity, 'initial prototype ready')
    await invoke('acceptPrototypeAndPreparePrd', pid, (await project(pid)).prototypes.at(-1).id)
    await page.getByRole('button', {name:'确认完整需求',exact:true}).click()
    await page.getByRole('button', {name:'确认并保存基线',exact:true}).click()
    await page.getByRole('dialog',{name:'确认完整需求',exact:true}).waitFor({state:'hidden'})
    await waitFor(async () => (await page.locator('.smm-node').filter({ hasText: '记录收支' }).count()) === 1, 'graph redraw after confirmation')
    await page.locator('.smm-node').filter({ hasText: '记录收支' }).click()
    dialog = page.getByRole('dialog', { name: '记录收支', exact: true })
    await dialog.getByRole('button', { name: '生成实现方案', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '生成实现方案', exact: true }).click()
    await waitFor(
      async () =>
        (await project(pid)).features[0].plan.length > 0 && !(await project(pid)).activity,
      'generated plan',
    )
    await waitFor(
      async () => (await dialog.getByLabel('实现方案').inputValue()).length > 0,
      'plan UI refresh',
    )
    await assert.rejects(invoke('confirmPlan', pid, fid), /需要命令工具/)
    await invoke('saveAgent', originalReviewer)
    await dialog.getByRole('button', { name: '确认方案', exact: true }).click()
    await dialog.getByRole('button', { name: '开始开发', exact: true }).waitFor()
    await assert.rejects(invoke('saveFeature', pid, fid, featureInput('篡改目标')), /不能直接改写/)
    await assert.rejects(invoke('accept', pid, fid), /尚未通过/)
    await dialog.getByRole('button', { name: '开始开发', exact: true }).click()
    await idle(pid)
    p = await project(pid)
    assert.equal(p.features[0].stage, 'acceptance', JSON.stringify(p.events.slice(-8)))
    assert.equal(p.features[0].repairRound, 0)
    assert.ok(p.events.some((e) => e.kind === 'output' && /pass 2/.test(e.message)))
    assert.equal(p.changes.filter((c) => c.featureId === fid).length, 7)
    assert.equal(
      p.changes.find((c) => c.path === 'via-command.txt').after,
      'created by a real command',
    )
    assert.ok(p.events.some((e) => /路径不可/.test(e.message)))
    await assert.rejects(fs.access(join(parent, 'escape.txt')))
    assert.match(await fs.readFile(join(p.root, '.coprojer/FEATURES.md'), 'utf8'), /记录收支/)
    await dialog.getByRole('tab', { name: '验收', exact: true }).click()
    await dialog.getByText('能够新增收入和支出', { exact: true }).waitFor()
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-acceptance.png'),
    })
    const second = await prepare(pid, '后续统计')
    await assert.rejects(invoke('runFeature', pid, second), /验收上一项/)
    await dialog.getByRole('button', { name: '验收通过', exact: true }).click()
    await waitFor(async () => (await project(pid)).features[0].stage === 'done', 'human acceptance')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await page.locator('.feature-table-row').filter({ hasText: '后续统计' }).waitFor()
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'workspace-overview-light.png'),
    })
    await page.getByRole('button', { name: '切换主题' }).click()
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'workspace-overview-dark.png'),
    })
    await page.getByRole('button', { name: '切换主题' }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(860, 600),
    )
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'workspace-overview-compact.png'),
    })
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 840),
    )
    console.log(
      'PASS: new empty project, live feature map, stale-response guard, three gates, real code/tests, serial acceptance',
    )

    const url = await invoke('startPreview', pid, 'dev')
    assert.match(await (await fetch(url)).text(), /个人记账/)
    // Exercise the generated page in a separate Electron Chromium window.
    const nextWindow = desktop.waitForEvent('window')
    await desktop.evaluate(({ BrowserWindow }, url) => {
      const preview = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      })
      void preview.loadURL(url)
    }, url)
    const preview = await nextWindow
    await preview.waitForLoadState()
    await preview.getByLabel('金额').fill('88.5')
    await preview.getByLabel('备注').fill('测试收入')
    await preview.getByRole('button', { name: '记一笔' }).click()
    await preview.reload()
    assert.match(await preview.locator('ul').innerText(), /测试收入 88.5/)
    await preview.close()
    await invoke('stopPreview', pid)
    await waitFor(async () => {
      try {
        await fetch(url)
        return false
      } catch {
        return true
      }
    }, 'preview stopped')
    const restartedUrl = await invoke('startPreview', pid, 'dev')
    assert.equal(restartedUrl, url, 'Preview must keep its origin so localStorage persists')
    const reopenedWindow = desktop.waitForEvent('window')
    await desktop.evaluate(({ BrowserWindow }, url) => {
      const preview = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      void preview.loadURL(url)
    }, restartedUrl)
    const reopened = await reopenedWindow
    await reopened.getByRole('heading', { name: '个人记账', exact: true }).waitFor()
    assert.match(await reopened.locator('ul').innerText(), /测试收入 88.5/)
    await reopened.close()
    await invoke('stopPreview', pid)

    await page.getByRole('button', { name: '任务看板', exact: true }).click()
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-board-light.png'),
    })
    await page.getByRole('button', { name: '共享上下文', exact: true }).click()
    await page.getByRole('button', { name: '补充上下文', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑共享上下文' })
    await dialog.getByLabel('标题', { exact: true }).fill('公共金额规范')
    await dialog.getByLabel('内容', { exact: true }).fill('金额内部用分计算，展示为两位小数。')
    await dialog.getByRole('button', { name: '保存上下文' }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await page.getByRole('button', { name: '切换主题' }).click()
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-map-dark.png'),
    })
    await page.getByRole('button', { name: '切换主题' }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(860, 600),
    )
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-map-compact.png'),
    })
    const bounds = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      rect: document.querySelector('.eng-page').getBoundingClientRect().toJSON(),
      status: document.querySelector('.statusbar')?.getBoundingClientRect().top,
    }))
    assert.equal(bounds.scroll, bounds.width)
    assert.ok(bounds.rect.bottom <= 601)
    await page.getByRole('button', { name: '添加功能', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '添加功能', exact: true })
    await dialog.getByLabel('功能名称').fill('紧凑布局功能')
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: join(output, 'engineering-feature-compact.png'),
    })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 840),
    )
    console.log(
      'PASS: preview startup/shutdown, generated page persistence, shared context, light/dark and compact desktop layouts',
    )

    // The same actual tool loop works over the other two wire protocols.
    await invoke('saveModel', { ...model, protocol: 'responses', apiKey: '' })
    await invoke('runFeature', pid, second)
    await idle(pid)
    p = await project(pid)
    assert.equal(p.features.find((f) => f.id === second).stage, 'acceptance')
    await invoke('reject', pid, second, '请确认刷新后持久化')
    await invoke('saveModel', { ...model, protocol: 'anthropic', apiKey: '' })
    await invoke('runFeature', pid, second)
    await idle(pid)
    p = await project(pid)
    assert.equal(p.features.find((f) => f.id === second).stage, 'acceptance')
    await invoke('accept', pid, second)
    await invoke('saveModel', { ...model, protocol: 'chat', apiKey: '' })
    const failure = await prepare(pid, '失败修复边界')
    const beforeGuard = await project(pid)
    // Replay a persisted ready feature moved out of scope; only the isolated fixture is edited.
    await desktop.close()
    let fixture = JSON.parse(await fs.readFile(join(profile, 'engineering-v1.json'), 'utf8'))
    fixture.projects.find(p => p.id === pid).features.find(f => f.id === failure).scope = 'later'
    await fs.writeFile(join(profile, 'engineering-v1.json'), JSON.stringify(fixture))
    await launch()
    await assert.rejects(invoke('runFeature', pid, failure), /只有本期功能/)
    await desktop.close()
    fixture = JSON.parse(await fs.readFile(join(profile, 'engineering-v1.json'), 'utf8'))
    fixture.projects.find(p => p.id === pid).features.find(f => f.id === failure).scope = 'current'
    fixture.projects.find(p => p.id === pid).features.find(f => f.id === failure).title = `旧功能（历史记录，已合并至 ${second}）`
    await fs.writeFile(join(profile, 'engineering-v1.json'), JSON.stringify(fixture))
    await launch()
    await assert.rejects(invoke('runFeature', pid, failure), /已合并的历史记录/)
    await desktop.close()
    fixture = JSON.parse(await fs.readFile(join(profile, 'engineering-v1.json'), 'utf8'))
    fixture.projects.find(p => p.id === pid).features.find(f => f.id === failure).title = '失败修复边界'
    await fs.writeFile(join(profile, 'engineering-v1.json'), JSON.stringify(fixture))
    await launch()
    const displacedRoot = beforeGuard.root + '-temporarily-moved'
    await fs.rename(beforeGuard.root, displacedRoot)
    try {
      await assert.rejects(invoke('runFeature', pid, failure), /项目目录不存在/)
      assert.equal((await project(pid)).activity, beforeGuard.activity)
    } finally { await fs.rename(displacedRoot, beforeGuard.root) }
    console.log('PASS: deferred feature and missing directory rejected before model execution')
    provider.control.failing = true
    const reviewsBefore = provider.control.reviews
    await invoke('runFeature', pid, failure)
    await idle(pid)
    p = await project(pid)
    assert.equal(p.features.find((f) => f.id === failure).stage, 'blocked')
    assert.equal(p.features.find((f) => f.id === failure).repairRound, 3)
    assert.equal(provider.control.reviews - reviewsBefore, 4)
    assert.ok(p.features.find((f) => f.id === failure).results.every((r) => !r.passed))
    assert.ok(p.events.some((e) => /fail 1/.test(e.message)))
    provider.control.failing = false
    await invoke('assignAgents', pid, failure, 'developer', 'reviewer')
    await invoke('runFeature', pid, failure)
    await idle(pid)
    assert.equal((await project(pid)).features.find((f) => f.id === failure).stage, 'acceptance')
    await invoke('accept', pid, failure)
    const noEvidence = await prepare(pid, '无测试不得通过')
    provider.control.noTest = true
    await invoke('runFeature', pid, noEvidence)
    await idle(pid)
    assert.equal((await project(pid)).features.find((f) => f.id === noEvidence).stage, 'blocked')
    assert.match(
      (await project(pid)).features.find((f) => f.id === noEvidence).results[0].evidence,
      /缺少实际/,
    )
    provider.control.noTest = false
    console.log(
      'PASS: all protocol tool roundtrips, rejection/continuation, exactly three repair rounds, no-test false-pass prevention',
    )
    const agentRequests = provider.control.requests.filter(({ body }) => {
      const system =
        body.system || body.instructions ||
        (Array.isArray(body.messages) ? body.messages[0]?.content : '') || ''
      return system.includes('你是 Coprojer 的开发智能体') || system.includes('你是 Coprojer 的验证智能体')
    })
    assert.ok(agentRequests.length > 0, 'expected real developer/reviewer requests')
    assert.ok(agentRequests.every(({ body }) => body.stream === true), 'agent tool calls must use SSE streaming')
    const glmToolRequests = agentRequests.filter(
      ({ body }) =>
        Array.isArray(body.messages) &&
        Array.isArray(body.tools) &&
        body.tools.length > 0 &&
        /^glm-/i.test(body.model),
    )
    assert.ok(glmToolRequests.length > 0, 'expected GLM chat tool requests')
    assert.ok(
      glmToolRequests.some(({ body }) => body.tool_stream === true),
      'GLM chat tool streams must request incremental tool-call frames',
    )

    // Stop a pending model call, then restart the app with an interrupted disk record.
    provider.control.hold = true
    await invoke('runFeature', pid, noEvidence)
    await waitFor(() => provider.control.held.length > 0, 'held execution')
    await invoke('stop', pid)
    await idle(pid)
    assert.equal((await project(pid)).features.find((f) => f.id === noEvidence).stage, 'blocked')
    provider.release()
    const a = await invoke('saveFeature', pid, null, featureInput('依赖 A'))
    const b = await invoke('saveFeature', pid, null, featureInput('依赖 B', [a]))
    await assert.rejects(invoke('saveFeature', pid, a, featureInput('依赖 A', [b])), /循环/)
    await desktop.close()
    desktop = null
    const diskPath = join(profile, 'engineering-v1.json')
    const disk = JSON.parse(await fs.readFile(diskPath, 'utf8'))
    disk.projects[0].activity = '上次执行'
    disk.projects[0].features.find((f) => f.id === noEvidence).stage = 'developing'
    await fs.writeFile(diskPath, JSON.stringify(disk))
    await launch()
    p = await project(pid)
    assert.equal(p.activity, null)
    assert.equal(`http://127.0.0.1:${p.previewPort}`, url)
    assert.equal(p.features.find((f) => f.id === noEvidence).stage, 'blocked')
    assert.equal(p.features[0].stage, 'done')
    assert.ok(p.context.some((c) => c.title === '公共金额规范'))
    assert.ok(p.events.some((e) => e.kind === 'interrupted'))
    assert.match(await invoke('testModel', { ...model, apiKey: '' }), /连接成功/)
    assert.ok(!(await fs.readFile(diskPath, 'utf8')).includes('coprojer-fixture-secret'))
    assert.deepEqual(errors, [])
    assert.deepEqual(provider.control.errors, [])
    console.log(
      'PASS: cancellation, cyclic-dependency guard, encrypted restart, recovery without automatic replay; no renderer errors',
    )
    console.log('Engineering artifacts: ' + output)
  } catch (error) {
    if (page) {
      try {
        await page.screenshot({
          animations: 'disabled',
          scale: 'css',
          path: join(output, 'engineering-failure.png'),
        })
        await fs.writeFile(
          join(output, 'engineering-failure-state.json'),
          JSON.stringify(await state(), null, 2),
        )
      } catch {}
    }
    throw error
  } finally {
    provider.release()
    if (desktop) await desktop.close()
    await provider.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
