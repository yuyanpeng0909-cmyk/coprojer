const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')

async function main() {
  const output = resolve('output/playwright/project-manager')
  await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(join(output, 'fixture-'))
  const profile = join(sandbox, 'profile'), parent = join(sandbox, 'projects')
  await fs.mkdir(parent)
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let desktop, page
  const errors = [], measurements = []
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const home = () => page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
  const enter = name => page.getByRole('button', { name: `继续开发 ${name}`, exact: true }).click()
  const back = () => page.getByRole('button', { name: '返回项目管理', exact: true }).click()
  const shot = name => page.screenshot({ path: join(output, name + '.png'), animations: 'disabled', scale: 'css' })
  async function launch() {
    desktop = await electron.launch({ args: ['.', '--disable-gpu'], cwd: resolve('.'), env, timeout: 30000 })
    page = await desktop.firstWindow()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await home()
  }
  async function create(name) {
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建工程项目', exact: true })
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, parent)
    await dialog.getByLabel('项目名称').fill(name)
    await dialog.getByRole('button', { name: '选择位置', exact: true }).click()
    await page.waitForFunction(folder => document.querySelector('input[placeholder="选择父目录"]')?.value === folder, parent)
    await dialog.getByLabel('项目目标').fill('保留需求、功能、上下文和开发记录，按需继续开发。')
    await dialog.getByRole('button', { name: '创建工程', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor()
    const project = (await invoke('state')).projects.find(item => item.name === name)
    assert.equal(await page.getByLabel('切换工程项目').inputValue(), project.id)
    return project
  }
  try {
    await launch()
    await page.getByRole('button', { name: '创建项目', exact: true }).waitFor()
    assert.equal(await page.getByRole('navigation', { name: '项目导航', exact: true }).count(), 0)
    await shot('empty-light-1280')
    const first = await create('个人记账')
    await invoke('saveContext', first.id, null, '接续开发说明', 'PROJECT_MANAGER_PRESERVE_MARKER')
    await invoke('saveFeature', first.id, null, { title: '账目保存', module: '本地数据', description: '保留已有账目', criteria: ['数据可恢复'], scope: 'discussion', developerId: 'developer', reviewerId: 'reviewer', dependencies: [] })
    await back()
    await home()
    const secondId = await invoke('createProject', { name: '番茄钟助手', parent, brief: '管理专注计时和休息提醒。', modelId: '' })
    await page.getByRole('button', { name: '继续开发 番茄钟助手', exact: true }).waitFor()
    await home() // Background state updates must never select a project.
    const longName = '多端协作平台与历史需求实现验证记录'.repeat(3)
    await invoke('createProject', { name: longName, parent, brief: '验证超长名称、工程路径和项目目标在紧凑窗口中仍然可读。'.repeat(4), modelId: '' })
    await page.waitForFunction(() => document.querySelectorAll('.project-manager-row').length === 3)
    const before = (await invoke('state')).projects
    await page.getByLabel('搜索项目', { exact: true }).fill('番茄钟')
    assert.equal(await page.locator('.project-manager-row').count(), 1)
    await page.getByLabel('搜索项目', { exact: true }).fill('不存在的项目')
    await page.getByRole('heading', { name: '没有匹配的项目', exact: true }).waitFor()
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await page.getByLabel('项目排序').selectOption('name')
    assert.deepEqual(await page.locator('.project-manager-title h2').allTextContents(), before.map(p => p.name).sort((a, b) => a.localeCompare(b, 'zh-CN')))
    await page.getByLabel('项目排序').selectOption('created')
    assert.deepEqual(await page.locator('.project-manager-title h2').allTextContents(), [...before].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(p => p.name))
    await page.getByLabel('项目排序').selectOption('activity')
    for (const [width, height] of [[1280, 840], [860, 600]]) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click()
        await shot(`projects-${theme}-${width}`)
        const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth, mainOverflow: document.querySelector('.studio-main').scrollWidth > document.querySelector('.studio-main').clientWidth, contentOverflow: document.querySelector('.eng-project-content').scrollWidth > document.querySelector('.eng-project-content').clientWidth }))
        assert.equal(layout.width, width)
        assert.equal(layout.height, height)
        assert.equal(layout.scroll, width)
        assert.equal(layout.mainOverflow, false)
        assert.equal(layout.contentOverflow, false)
        measurements.push({ theme, ...layout })
      }
    }
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await page.getByRole('button', { name: `继续开发 ${first.name}`, exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: '需求与功能图', exact: true }).waitFor()
    await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
    await back()
    await home()
    await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
    for (const section of ['工作台', '需求与功能图', '任务看板', '共享上下文', '执行记录', '模型连接', '智能体', '外观与偏好']) {
      await enter(first.name)
      await page.getByRole('button', { name: section, exact: true }).click()
      await back()
      await home()
    }
    assert.deepEqual((await invoke('state')).projects, before, 'navigation must preserve saved projects and execution state')
    await enter(first.name)
    await page.getByLabel('切换工程项目').selectOption(secondId)
    assert.equal(await page.getByLabel('切换工程项目').inputValue(), secondId)
    await shot('workspace-return-860')
    await page.locator('.studio-breadcrumb').getByRole('button', { name: '项目管理', exact: true }).click()
    await home()
    await page.keyboard.press('Control+k')
    const search = page.getByRole('dialog', { name: '快速查找', exact: true })
    await search.getByRole('textbox').fill(first.name)
    await search.getByRole('button', { name: new RegExp(first.name) }).click()
    assert.equal(await page.getByLabel('切换工程项目').inputValue(), first.id)
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await desktop.close(); desktop = null
    await launch()
    await page.getByRole('button', { name: `继续开发 ${first.name}`, exact: true }).waitFor()
    assert.equal(await page.getByLabel('切换工程项目').count(), 0)
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    assert.equal(await page.evaluate(() => localStorage.getItem('coprojer.studio.project')), first.id)
    // Loading the existing store fills these optional defaults; all saved content must survive.
    assert.deepEqual((await invoke('state')).projects, before.map(project => ({
      ...project, targets: project.targets || [], prototypes: project.prototypes || [], designActivity: false,
    })))
    await page.evaluate(() => localStorage.setItem('coprojer.studio.project', 'removed-project'))
    await page.reload()
    await home()
    await page.getByRole('button', { name: `继续开发 ${first.name}`, exact: true }).waitFor()
    assert.equal(await page.getByLabel('切换工程项目').count(), 0)
    await create('从项目管理新建')
    await back()
    await home()
    await page.getByRole('button', { name: '继续开发 从项目管理新建', exact: true }).waitFor()
    assert.equal((await invoke('state')).projects.length, 4)
    assert.deepEqual(errors, [])
    await fs.writeFile(join(output, 'verification.json'), JSON.stringify({ passed: true, measurements, rendererErrors: errors, checks: ['empty start', 'create through UI', 'explicit entry', 'search and sort', 'long content', 'return from all workspaces and settings', 'collapsed return', 'project switch', 'quick search', 'restart and stale selection', 'data and theme preservation'] }, null, 2))
    console.log('PASS: project management startup, create/continue/return, search/sort, restart, stale selection, saved data/theme, 1280x840 and 860x600 light/dark; no renderer errors.')
  } catch (error) {
    if (page && !page.isClosed()) await shot('failure').catch(() => {})
    throw error
  } finally {
    if (desktop) await desktop.close()
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
