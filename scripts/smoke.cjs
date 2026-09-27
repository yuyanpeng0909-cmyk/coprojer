const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const { mkdtemp, mkdir } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
async function main() {
  const output = resolve('output/playwright')
  await mkdir(output, { recursive: true })
  const userData = await mkdtemp(join(output, 'studio-profile-')),
    parent = await mkdtemp(join(output, 'studio-projects-'))
  const env = { ...process.env, COPROJER_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  let desktop, page
  const errors = []
  const invoke = (method, ...args) =>
    page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), {
      method,
      args,
    })
  async function launch() {
    desktop = await electron.launch({ args: ['.'], env, timeout: 30000 })
    page = await desktop.firstWindow()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByText('桌面服务已连接', { exact: true }).waitFor()
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor()
  }
  const shot = (name) =>
    page.screenshot({ path: join(output, name), scale: 'css', animations: 'disabled' })
  try {
    await launch()
    for (const name of [
      '开始',
      '全部任务',
      '工作总览',
      '项目管理',
      '资源库',
      '消息中心',
      '组件实验室',
    ])
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0)
    assert.equal(await page.getByRole('navigation', { name: '项目导航' }).count(), 1)
    assert.deepEqual(
      await page.evaluate(() => ({
        node: typeof window.require,
        bridge: Object.keys(window.desktop).sort(),
      })),
      { node: 'undefined', bridge: ['engineering', 'getAppInfo', 'openResearchPanel', 'researchPanel', 'saveArtifact', 'selectFolder', 'windowControl'] },
    )
    const duplicate = spawnSync(require('electron'), ['.'], {
      env,
      timeout: 10000,
      windowsHide: true,
      stdio: 'ignore',
    })
    assert.equal(duplicate.status, 0)
    await shot('studio-welcome.png')
    const legacy = {
      tasks: [
        { id: 'preserved', title: '历史笔记', body: '请保留原始数据', createdAt: '2026-09-12' },
      ],
      folder: 'C:/legacy-project',
      theme: 'light',
      extra: 'preserved',
    }
    await page.evaluate(
      (value) => localStorage.setItem('coprojer.workspace.v1', JSON.stringify(value)),
      legacy,
    )
    await page.getByRole('button', { name: '外观与偏好', exact: true }).click()
    await page.getByRole('button', { name: '暗色', exact: true }).click()
    await page.getByRole('button', { name: '强调色：雾蓝' }).click()
    await page.getByRole('combobox', { name: '界面密度' }).selectOption('comfortable')
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem('coprojer.workspace.v1'))),
      { ...legacy, theme: 'dark' },
    )
    await desktop.close()
    desktop = null
    await launch()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    assert.equal(await page.locator('html').getAttribute('data-accent'), 'blue')
    assert.equal(await page.locator('html').getAttribute('data-density'), 'comfortable')
    await page.getByRole('button', { name: '外观与偏好', exact: true }).click()
    await page.getByRole('button', { name: '亮色', exact: true }).click()
    await page.getByRole('button', { name: '强调色：黑白' }).click()
    await page.getByRole('combobox', { name: '界面密度' }).selectOption('compact')
    await shot('studio-preferences.png')
    await page.keyboard.press('Control+n')
    let dialog = page.getByRole('dialog', { name: '新建工程项目' })
    await dialog.waitFor()
    await page.keyboard.press('Control+n')
    assert.equal(await page.locator('dialog[open]').count(), 1)
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, parent)
    await dialog.getByLabel('项目名称').fill('工程工作台验证')
    await dialog.getByRole('button', { name: '选择位置' }).click()
    // The native folder picker resolves asynchronously; wait for the form to
    // receive its value before editing another field or submitting.
    await page.waitForFunction(
      (folder) => document.querySelector('input[placeholder="选择父目录"]')?.value === folder,
      parent,
    )
    await dialog.getByLabel('项目目标').fill('验证以功能交付为中心的工程工作台。')
    await dialog.getByRole('button', { name: '创建工程', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const model = await invoke('saveModel', {
      id: '',
      name: '本地配置测试',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'test-only',
      protocol: 'chat',
      apiKey: '',
    })
    const pid = (await invoke('state')).projects[0].id
    await invoke('setProjectModel', pid, model.id)
    const add = (title, scope) =>
      invoke('saveFeature', pid, null, {
        title,
        module: '工程协作',
        description: '保留完整交付依据',
        criteria: ['结果可验证'],
        scope,
        developerId: 'developer',
        reviewerId: 'reviewer',
        dependencies: [],
      })
    const a = await add('共享上下文索引', 'current')
    await assert.rejects(invoke('confirmRequirements', pid, a), /验收原型/)
    const b = await add('需求版本记录', 'discussion')
    await add('后续统计模块', 'later')
    await page.waitForFunction(
      () => document.querySelectorAll('.feature-table-row').length === 3,
    )
    assert.equal(await page.locator('.feature-table-row').count(), 3)
    await page.getByRole('textbox', { name: '搜索功能', exact: true }).fill('版本')
    assert.equal(await page.locator('.feature-table-row').count(), 1)
    await page.getByRole('textbox', { name: '搜索功能', exact: true }).fill('无匹配项')
    await page.getByText('没有符合条件的功能', { exact: true }).waitFor()
    await page.getByRole('textbox', { name: '搜索功能', exact: true }).fill('')
    await page.getByRole('combobox', { name: '筛选功能范围' }).selectOption('later')
    assert.equal(await page.locator('.feature-table-row').count(), 1)
    await page.getByRole('combobox', { name: '筛选功能范围' }).selectOption('all')
    await shot('studio-dashboard.png')
    await page.keyboard.press('Control+k')
    dialog = page.getByRole('dialog', { name: '快速查找' })
    await dialog.getByRole('textbox', { name: '查找工作区或功能' }).fill('需求版本')
    await dialog.getByRole('button', { name: /需求版本记录/ }).click()
    dialog = page.getByRole('dialog', { name: '需求版本记录', exact: true })
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '任务看板', exact: true }).click()
    await page.locator('.eng-board-card').filter({ hasText: '需求版本记录' }).waitFor()
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(860, 600),
    )
    await shot('studio-dashboard-compact.png')
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      await page.evaluate(() => innerWidth),
    )
    await page.getByRole('button', { name: '收起侧边栏' }).click()
    assert.ok((await page.locator('.studio-sidebar').boundingBox()).width < 70)
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await page.getByRole('textbox', { name: '需求讨论内容' }).waitFor()
    await shot('studio-map-collapsed.png')
    await page.getByRole('button', { name: '展开侧边栏' }).click()
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await page.getByRole('button', { name: '切换主题' }).click()
    await shot('studio-dashboard-dark-compact.png')
    await desktop.close()
    desktop = null
    await launch()
    assert.equal(await page.getByRole('combobox', { name: '切换工程项目' }).inputValue(), pid)
    assert.equal((await invoke('state')).projects[0].features.length, 3)
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('coprojer.workspace.v1')).tasks[0].id,
      ),
      'preserved',
    )
    assert.deepEqual(errors, [])
    console.log(
      'PASS: dedicated workbench, demo removal, native bridge, single instance, project creation, real feature lists/search, quick navigation, preferences and legacy data preservation, restart, dark/compact layouts; no renderer errors.',
    )
  } catch (e) {
    if (page)
      try {
        await shot('studio-failure.png')
      } catch {}
    throw e
  } finally {
    if (desktop) await desktop.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
