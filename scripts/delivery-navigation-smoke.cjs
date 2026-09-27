const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
async function main() {
  const output = resolve('output/playwright/delivery-navigation')
  await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(join(output, 'fixture-'))
  const profile = join(sandbox, 'profile')
  await fs.mkdir(profile)
  const feature = (id, stage, extra = {}) => ({
    id, title: id, stage, module: '导航回归', scope: 'current', description: `${id}：保留行为说明、异常边界与验收依据。`,
    criteria: ['点击只查看对应资料', '不会自动执行或验收'], dependencies: [], plan: '实现方案',
    tasks: [{ id: `task-${id}`, title: '实现与验证', done: false }],
    developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0,
    results: ['acceptance', 'done'].includes(stage) ? [{ criterion: '点击只查看对应资料', passed: true, evidence: '隔离测试证据' }] : [], feedback: '', ...extra,
  })
  const project = (id, features) => ({
    id, name: id, root: sandbox, brief: '交付阶段导航回归', createdAt: new Date().toISOString(),
    discussionModelId: '', activity: null, previewUrl: null, features, chat: [], context: [], events: [], changes: [], prototypes: [],
    requirementsDocument: '# 需求范围\n点击仅浏览，不改变交付状态。\n\n## 行为规则\n' + '每项功能保留独立的验收标准。\n\n'.repeat(12) + '```md\n# 代码中的伪标题\n```\n\n## 行为规则\n异常情况需要明确提示。',
  })
  const projects = [
    project('待开发项目', [feature('正式功能', 'ready'), feature('旧记录', 'blocked', { title: '旧功能（历史记录，已合并至 official）' }), feature('official', 'ready')]),
    project('混合阶段项目', [feature('排队功能', 'ready'), feature('方案功能', 'solution'), feature('开发功能', 'developing'), feature('验证功能', 'verifying'), feature('待验收功能', 'acceptance'), feature('暂缓功能', 'requirements', { scope: 'later' })]),
    project('已交付项目', [feature('已验收功能', 'done')]), project('空项目', []),
  ]
  projects[0].executionPlan = { id: 'queue', status: 'planned', featureIds: ['旧记录', '正式功能', 'official'], orderedFeatureIds: ['旧记录', '正式功能', 'official'], currentIndex: 0, rationale: '回归用顺序', at: projects[0].createdAt }
  projects[1].targets = [
    { id: 'desktop', name: '桌面客户端', kind: 'desktop', directory: 'desktop', responsibility: '提供计时交互', contracts: '读取共享计时状态' },
    { id: 'reports', name: '统计服务', kind: 'backend', directory: 'reports', responsibility: '提供统计', contracts: '按日期返回记录' },
    { id: 'empty-target', name: '待规划服务', kind: 'backend', directory: 'planned', responsibility: '等待细化范围', contracts: '待补充' },
  ]
  projects[1].features.forEach((feature, index) => { feature.targetId = index < 4 ? 'desktop' : 'reports' })
  const shared = {}
  const compiled = require('typescript').transpileModule(await fs.readFile(resolve('src/shared/engineering.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS } })
  new Function('exports', compiled.outputText)(shared)
  projects[2].requirementsBaseline = { id: 'confirmed-baseline', at: projects[2].createdAt, messageCount: 0, fingerprint: shared.requirementsFingerprint(projects[2]) }
  await fs.writeFile(join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, models: [], agents: [], projects }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const desktop = await electron.launch({ args: ['.', '--disable-gpu'], cwd: resolve('.'), env })
  const page = await desktop.firstWindow()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const state = () => page.evaluate(() => window.desktop.engineering.state())
  const select = async id => { await page.getByLabel('切换工程项目').selectOption(id); await page.getByRole('heading', { name: '工作台', exact: true }).waitFor() }
  const stage = label => page.locator('.sidebar-lifecycle').getByRole('button', { name: label, exact: true })
  const navigate = async label => {
    await stage(label).click()
    assert.equal(await page.getByRole('dialog').count(), 0, `${label}: no automatic feature selection`)
    assert.equal(await stage(label).getAttribute('aria-current'), 'page')
  }
  const openFeature = async (title, tab) => {
    const trigger = page.locator('.delivery-table').getByRole('button', { name: title, exact: true })
    await trigger.click()
    const drawer = page.getByRole('dialog', { name: title, exact: true })
    await drawer.waitFor()
    assert.equal(await drawer.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true')
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
  }
  const toc = page.getByRole('navigation', { name: '需求目录', exact: true })
  const openToc = async () => { if (!await toc.isVisible()) await page.getByRole('button', { name: '目录', exact: true }).click() }
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    await page.getByRole('button', { name: '继续开发 待开发项目', exact: true }).click()
    const before = (await state()).projects
    for (const [width, height] of [[1280, 840], [860, 600]]) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      await select('待开发项目')
      assert.equal(await page.locator('.sidebar-lifecycle ol > li').count(), 7)
      await page.getByRole('button', { name: '智能体', exact: true }).click()
      await navigate('开发执行')
      await page.getByRole('heading', { name: '当前没有功能正在执行' }).waitFor()
      assert.equal(await page.locator('.delivery-table tbody tr').count(), 2)
      assert.doesNotMatch(await page.locator('.delivery-queue').innerText(), /历史记录/)
      assert.equal(await stage('开发执行').locator('.lifecycle-count').innerText(), '2')
      assert.match(await page.locator('.statusbar').innerText(), /2 个本期功能/)
      await page.screenshot({ path: join(output, `development-${width}.png`), animations: 'disabled' })
      await openFeature('正式功能', '日志')
      await page.getByRole('button', { name: '查看历史合并记录（1）', exact: true }).click()
      await page.locator('.delivery-history').getByText('旧功能（历史记录，已合并至 official）', { exact: true }).waitFor()
      await navigate('独立验证')
      await page.getByRole('heading', { name: '本阶段暂无记录' }).waitFor()
      await select('混合阶段项目')
      for (const [label, title, tab, count] of [['方案与任务', '方案功能', '方案', 5], ['开发执行', '开发功能', '日志', 4], ['独立验证', '验证功能', '验收', 3], ['成果验收', '待验收功能', '验收', 1]]) {
        await navigate(label)
        assert.equal(await page.locator('.delivery-table tbody tr').count(), count)
        await openFeature(title, tab)
      }
      await page.screenshot({ path: join(output, `acceptance-${width}.png`), animations: 'disabled' })
      await navigate('方案与任务')
      await page.getByLabel('搜索阶段功能').fill('方案功能')
      assert.equal(await page.locator('.delivery-table tbody tr').count(), 1)
      await page.getByLabel('搜索阶段功能').fill('')
      await page.getByLabel('筛选交付状态').selectOption('ready')
      assert.equal(await page.locator('.delivery-table tbody tr').count(), 1)
      await navigate('需求讨论')
      assert.equal(await page.getByRole('tab', { name: '需求', exact: true }).getAttribute('aria-selected'), 'true')
      await navigate('原型设计')
      assert.equal(await page.getByRole('tablist', { name: '需求工作区子模块' }).getByRole('tab', { name: '原型', exact: true }).getAttribute('aria-selected'), 'true')
      await navigate('需求与规格')
      const review = page.getByRole('region', { name: '需求与规格审阅' })
      await review.waitFor()
      await openToc()
      await toc.getByRole('button', { name: '收起子项目目录：桌面客户端', exact: true }).click()
      assert.equal(await toc.getByRole('button', { name: '方案功能', exact: true }).isVisible(), false)
      await toc.getByRole('button', { name: '展开子项目目录：桌面客户端', exact: true }).click()
      await toc.getByRole('button', { name: '定位子项目：桌面客户端', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.activeElement.id === 'spec-scope-target-desktop')
      await openToc()
      await toc.getByRole('button', { name: '定位模块：桌面客户端 / 导航回归', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.activeElement.id.startsWith('spec-scope-target-desktop-module-'))
      await openToc()
      assert.equal(await toc.getByRole('button', { name: '定位模块：桌面客户端 / 导航回归', exact: true, includeHidden: true }).getAttribute('aria-current'), 'location')
      await page.screenshot({ path: join(output, `module-location-${width}.png`), animations: 'disabled' })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.locator('.specification-body').evaluate(element => { element.scrollTop = 0 })
      await page.waitForFunction(() => document.querySelector('.specification-toc button[aria-current=location]')?.textContent === '项目目标与范围')
      await openToc()
      await toc.getByLabel('搜索需求目录').fill('待规划服务')
      await toc.getByRole('button', { name: '定位子项目：待规划服务', exact: true }).click()
      await page.waitForFunction(() => document.activeElement.id === 'spec-scope-target-empty-target')
      assert.match(await page.locator('#spec-scope-target-empty-target').innerText(), /尚无功能规格/)
      await page.screenshot({ path: join(output, `empty-target-${width}.png`), animations: 'disabled' })
      await openToc()
      await toc.getByLabel('搜索需求目录').fill('导航回归')
      assert.equal(await toc.getByRole('button', { name: /^定位模块：/ }).count(), 2)
      await toc.getByLabel('搜索需求目录').fill('')
      assert.equal(await toc.getByRole('button', { name: '行为规则', exact: true }).count(), 2)
      assert.equal(await toc.getByRole('button', { name: '代码中的伪标题', exact: true }).count(), 0)
      await toc.getByRole('button', { name: '行为规则', exact: true }).last().click()
      await page.waitForFunction(() => document.activeElement.textContent === '行为规则')
      await openToc()
      await toc.getByLabel('搜索需求目录').fill('方案功能')
      assert.equal(await toc.locator('.specification-toc-feature').count(), 1)
      await toc.getByRole('button', { name: '方案功能', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.activeElement.id === 'spec-feature-方案功能')
      const checked = review.getByLabel('已核对：方案功能', { exact: true })
      await checked.check()
      await page.getByRole('button', { name: '继续讨论', exact: true }).click()
      await page.getByRole('button', { name: '确认完整需求', exact: true }).click()
      assert.equal(await checked.isChecked(), true)
      assert.equal((await state()).projects.find(p => p.id === '混合阶段项目').requirementsBaseline, undefined)
      for (const name of ['确认并保存基线', '确认需求并准备方案']) {
        const b = await review.getByRole('button', { name, exact: true }).boundingBox()
        assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= width + 1 && b.y + b.height <= height + 1, `${name} stays in ${width} x ${height}: ${JSON.stringify(b)}`)
      }
      await openToc()
      await page.screenshot({ path: join(output, `requirements-${width}.png`), animations: 'disabled' })
      await select('已交付项目')
      await stage('需求与规格').focus()
      await page.keyboard.press('Enter')
      await page.getByText('已确认基线', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: '确认并保存基线', exact: true }).count(), 0)
      await navigate('成果验收')
      await openFeature('已验收功能', '验收')
      await select('空项目')
      for (const label of ['方案与任务', '开发执行', '独立验证', '成果验收']) { await navigate(label); await page.getByRole('heading', { name: '本阶段暂无记录' }).waitFor() }
      await navigate('需求与规格')
      assert.equal(await page.getByRole('button', { name: '确认并保存基线', exact: true }).isDisabled(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: no page overflow`)
    }
    await select('混合阶段项目')
    await page.getByRole('button', { name: '切换主题' }).click()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    await navigate('需求与规格')
    await openToc()
    await page.screenshot({ path: join(output, 'requirements-dark-860.png'), animations: 'disabled' })
    assert.deepEqual((await state()).projects, before, 'navigation and reading marks must not mutate project data')
    await page.evaluate(async () => { const p = (await window.desktop.engineering.state()).projects.find(p => p.id === '混合阶段项目'); await window.desktop.engineering.saveRequirementsDocument(p.id, p.requirementsDocument + '\n新增修订', p.requirementsDocument) })
    await page.getByText('需求或讨论已变化。当前保留你正在审阅的版本，刷新后才能确认。').waitFor()
    assert.equal(await page.getByRole('button', { name: '确认并保存基线', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '刷新审阅内容', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '确认并保存基线', exact: true }).isEnabled(), true)
    assert.equal(await page.getByLabel('已核对：方案功能', { exact: true }).isChecked(), false)
    assert.deepEqual(errors, [])
    console.log('PASS: seven overviews, explicit selection, history exclusion, searchable TOC, keyboard, reading marks, stale protection, two Electron sizes and dark theme')
  } catch (error) {
    await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {})
    console.error((await page.locator('body').innerText()).slice(0, 7000))
    console.error(errors)
    throw error
  } finally { await desktop.close(); await fs.rm(sandbox, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
