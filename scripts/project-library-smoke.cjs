const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const http = require('node:http')

async function main() {
  const output = resolve('output/playwright/project-library')
  await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(join(output, 'fixture-')), profile = join(sandbox, 'profile')
  await fs.mkdir(profile)
  const feature = (id, title, stage, extra = {}) => ({
    id, title, stage, module: '核心能力', scope: 'current', description: title, criteria: ['用户可完成操作'],
    dependencies: [], plan: '复用现有模块，补齐数据处理并验证。',
    tasks: [{ id: `task-${id}`, title: '实现并验证', done: false }],
    developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, feedback: '',
    results: stage === 'acceptance' || stage === 'done' ? [{ criterion: '用户可完成操作', passed: true, evidence: '隔离测试已验证' }] : [], ...extra,
  })
  const project = (id, name, brief, features, extra = {}) => ({
    id, name, brief, features, root: join(sandbox, id), createdAt: '2026-09-25T08:00:00.000Z',
    discussionModelId: '', activity: null, previewUrl: null, chat: [], context: [], changes: [], prototypes: [],
    events: [{ id: `event-${id}`, kind: 'project', message: '已保存工程资料', at: '2026-09-27T08:00:00.000Z' }], ...extra,
  })
  const projects = [
    project('ledger', '个人记账', '管理收支与月度预算，数据保存在本地。', [
      feature('export', '账目导出', 'solution'), feature('budget', '月度预算', 'solution'),
      feature('later', '以后再做的统计', 'acceptance', { scope: 'later' }),
      feature('empty-plan', '尚未生成方案', 'solution', { plan: '', tasks: [] }),
    ]),
    project('focus', '番茄钟助手', '帮助个人安排专注与休息，记录每日完成情况。', [
      feature('notification', '休息通知', 'blocked', { feedback: '系统通知验证未通过，请检查运行记录。' }),
      feature('timer', '专注计时', 'acceptance'),
    ]),
    project('portfolio', '个人作品集', '整理项目经历并展示开发成果。', []),
    project('archived', '历史工具', '已完成的工具项目，保留交付记录。', [feature('old', '原始功能', 'done')], { archivedAt: '2026-09-26T08:00:00.000Z' }),
  ]
  // Check classification from saved state without requiring model or network activity.
  const ts = require('typescript'), syncFs = require('node:fs'), path = require('node:path')
  const cache = new Map()
  const load = file => {
    file = resolve(file)
    if (cache.has(file)) return cache.get(file)
    const api = {}; cache.set(file, api)
    const code = ts.transpileModule(syncFs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    new Function('exports', 'require', code)(api, name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name))
    return api
  }
  const { projectAttention, projectContinuation, lastProjectActivity } = load('src/renderer/src/engineering/project-library.ts')
  const fixture = project('state', '状态分类', '', [])
  assert.equal(projectContinuation({ ...fixture, features: [feature('draft', '讨论中', 'requirements', { scope: 'discussion' })] }).destination.view, 'map')
  assert.equal(projectAttention({ ...fixture, prd: { status: 'review' }, features: [feature('req', '需求', 'requirements')] })[0].destination.view, 'specification')
  assert.equal(projectAttention({ ...fixture, prototypeBriefs: { '': { status: 'review' } } })[0].destination.researchTab, 'prototype')
  assert.equal(projectAttention({ ...fixture, prd: { status: 'error', error: '生成失败' } })[0].kind, 'failure')
  assert.equal(projectAttention({ ...fixture, features: [feature('failed', '方案失败', 'solution', { planGenerationError: '生成失败' })] })[0].kind, 'failure')
  assert.equal(projectAttention({ ...fixture, features: [feature('real', '当前功能', 'ready'), feature('old', '历史记录，已合并至 real', 'blocked')] }).length, 0)
  assert.equal(projectAttention(projects[3]).length, 0)
  assert.equal(lastProjectActivity({ ...fixture, events: [...fixture.events, { id: 'metadata', kind: 'project-management', at: '2099-01-01' }] }), fixture.events[0].at)
  for (const p of projects) { await fs.mkdir(p.root); await fs.writeFile(join(p.root, 'source-marker.txt'), `ORIGINAL_${p.id}`) }
  await fs.writeFile(join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, models: [], agents: [], projects }))
  const provider = http.createServer(request => request.resume())
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let desktop, page
  const errors = [], layoutChecks = []
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const state = () => invoke('state')
  const current = async id => (await state()).projects.find(project => project.id === id)
  const row = name => page.getByRole('article', { name, exact: true })
  const home = () => page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
  const back = async () => { await page.getByRole('button', { name: '返回项目管理', exact: true }).click(); await home() }
  const shot = name => page.screenshot({ path: join(output, name + '.png'), animations: 'disabled', scale: 'css' })
  const menu = async name => { await row(name).getByRole('button', { name: `项目操作 ${name}`, exact: true }).click(); return page.getByRole('menu', { name: `项目操作 ${name}`, exact: true }) }
  const waitProject = async (id, field, value) => page.waitForFunction(async ({ id, field, value }) => (await window.desktop.engineering.state()).projects.find(p => p.id === id)?.[field] === value, { id, field, value })
  async function launch() {
    desktop = await electron.launch({ args: ['.', '--disable-gpu'], cwd: resolve('.'), env, timeout: 30000 })
    page = await desktop.firstWindow(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' }); await home()
    await row('个人记账').waitFor()
  }
  try {
    await launch()
    const before = (await state()).projects
    assert.equal(await page.locator('.project-manager-row').count(), 3)
    assert.equal(await row('历史工具').count(), 0)
    const attention = page.getByRole('region', { name: '跨项目待处理事项' })
    await attention.getByRole('heading', { name: '待你处理 4', exact: true }).waitFor()
    assert.equal(await page.locator('.project-attention-row').count(), 3)
    assert.equal(await attention.getByText('以后再做的统计', { exact: true }).count(), 0)
    assert.equal(await attention.getByText('尚未生成方案', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '展开全部 4 项', exact: true }).click()
    assert.equal(await page.locator('.project-attention-row').count(), 4)
    await page.getByRole('button', { name: '收起待处理事项', exact: true }).click()
    for (const [projectName, title, detail, tab] of [
      ['番茄钟助手', '执行需要处理', '休息通知', '日志'],
      ['番茄钟助手', '功能待验收', '专注计时', '验收'],
      ['个人记账', '方案待确认', '账目导出', '方案'],
    ]) {
      await page.getByRole('button', { name: `${projectName}：${title}，${detail}`, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: detail, exact: true })
      await dialog.waitFor()
      assert.equal(await dialog.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true')
      await page.keyboard.press('Escape'); await back()
    }
    assert.deepEqual((await state()).projects, before, 'cross-project attention navigation must not confirm or run work')
    await row('个人记账').getByRole('button', { name: '继续开发 个人记账', exact: true }).click()
    await page.getByRole('heading', { name: '方案与任务', exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    await back()
    await row('个人记账').getByRole('button', { name: '置顶项目 个人记账', exact: true }).click()
    await waitProject('ledger', 'pinned', true)
    await page.getByLabel('项目排序').selectOption('name')
    assert.equal(await page.locator('.project-manager-title h2').first().innerText(), '个人记账')
    await page.getByLabel('项目排序').selectOption('activity')
    for (const [width, height] of [[1280, 840], [860, 600]]) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click()
        await page.locator('.eng-project-content').evaluate(element => { element.scrollTop = 0 })
        await shot(`library-${theme}-${width}`)
        const checks = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, docOverflow: document.documentElement.scrollWidth > innerWidth, mainOverflow: document.querySelector('.studio-main').scrollWidth > document.querySelector('.studio-main').clientWidth, contentOverflow: document.querySelector('.eng-project-content').scrollWidth > document.querySelector('.eng-project-content').clientWidth }))
        assert.equal(checks.docOverflow || checks.mainOverflow || checks.contentOverflow, false)
        const resume = await row('个人记账').getByRole('button', { name: '继续开发 个人记账', exact: true }).boundingBox()
        assert.ok(resume.y + resume.height <= height - 22, 'continue action remains visible in the first viewport')
        layoutChecks.push({ theme, ...checks })
      }
    }
    if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByRole('button', { name: '切换主题', exact: true }).click()
    const popup = await menu('个人记账')
    const bounds = await popup.boundingBox()
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600, 'menu stays inside a compact viewport')
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '归档项目')
    await page.keyboard.press('Escape')
    assert.equal(await row('个人记账').getByRole('button', { name: '项目操作 个人记账', exact: true }).evaluate(element => element === document.activeElement), true)
    await (await menu('个人记账')).getByRole('menuitem', { name: '重命名', exact: true }).click()
    const rename = page.getByRole('dialog', { name: '重命名项目', exact: true })
    await rename.getByLabel('项目名称').fill('   ')
    assert.equal(await rename.getByRole('button', { name: '保存名称', exact: true }).isDisabled(), true)
    await rename.getByLabel('项目名称').fill('家庭记账')
    await shot('rename-860')
    await rename.getByRole('button', { name: '保存名称', exact: true }).click()
    await rename.waitFor({ state: 'hidden' }); await row('家庭记账').waitFor()
    assert.equal((await current('ledger')).root, projects[0].root)
    assert.equal(await fs.readFile(join(projects[0].root, 'source-marker.txt'), 'utf8'), 'ORIGINAL_ledger')
    await desktop.evaluate(({ shell }) => { globalThis.__projectLibraryOpened = []; shell.openPath = async value => { globalThis.__projectLibraryOpened.push(value); return '' } })
    await row('家庭记账').getByRole('button', { name: '打开项目目录 家庭记账', exact: true }).click()
    assert.deepEqual(await desktop.evaluate(() => globalThis.__projectLibraryOpened), [projects[0].root])
    await (await menu('家庭记账')).getByRole('menuitem', { name: '归档项目', exact: true }).click()
    await row('家庭记账').waitFor({ state: 'hidden' })
    assert.ok((await current('ledger')).archivedAt)
    assert.equal(await page.getByRole('region', { name: '跨项目待处理事项' }).getByText('账目导出', { exact: true }).count(), 0)
    await page.getByRole('tab', { name: '已归档 2', exact: true }).click()
    await row('家庭记账').waitFor(); await row('历史工具').waitFor()
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'project scrolling must not move the window title bar')
    await shot('archived-860')
    await row('家庭记账').getByRole('button', { name: '恢复项目 家庭记账', exact: true }).click()
    await row('家庭记账').waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: '活跃项目 3', exact: true }).click()
    await row('家庭记账').waitFor()
    assert.equal((await current('ledger')).pinned, true)
    assert.deepEqual((await current('ledger')).features, before[0].features)
    const beforeInvalid = await current('ledger')
    for (const input of [{ name: '' }, { name: 'a'.repeat(81) }, { pinned: 'yes' }, { archived: 1 }, { root: 'changed' }, { name: 'should-not-apply', archived: 'yes' }]) {
      await assert.rejects(invoke('updateProjectMetadata', 'ledger', input))
    }
    assert.deepEqual(await current('ledger'), beforeInvalid, 'invalid metadata must not partially mutate saved projects')
    const model = await invoke('saveModel', { id: '', name: '隔离执行服务', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'fixture', protocol: 'chat', apiKey: '' })
    await invoke('setProjectModel', 'portfolio', model.id)
    await invoke('discuss', 'portfolio', '保持执行以验证归档保护')
    await assert.rejects(invoke('updateProjectMetadata', 'portfolio', { archived: true }), /执行或预览/)
    assert.ok((await current('portfolio')).activity)
    assert.equal(await (await menu('个人作品集')).getByRole('menuitem', { name: '执行或预览中，暂不能归档', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    await invoke('stop', 'portfolio')
    await waitProject('portfolio', 'activity', null)
    await desktop.close(); desktop = null
    desktop = await electron.launch({ args: ['.', '--disable-gpu'], cwd: resolve('.'), env, timeout: 30000 })
    page = await desktop.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await home()
    await row('家庭记账').waitFor()
    assert.equal(await page.locator('.project-manager-title h2').first().innerText(), '家庭记账')
    assert.equal((await current('ledger')).pinned, true)
    assert.equal((await current('ledger')).archivedAt, null)
    assert.equal((await current('ledger')).root, projects[0].root)
    assert.ok((await current('archived')).archivedAt)
    assert.deepEqual((await current('ledger')).features, before[0].features)
    assert.deepEqual(errors, [])
    await fs.writeFile(join(output, 'verification.json'), JSON.stringify({ passed: true, layoutChecks, rendererErrors: errors, checks: ['actionable attention only', 'no transition from navigation', 'explicit destination tabs', 'resume to current phase', 'pin and sorting', 'rename preserves root and files', 'native folder bridge', 'archive and restore', 'active-operation guard', 'runtime payload validation', 'restart persistence', 'menu keyboard and compact bounds'] }, null, 2))
    console.log('PASS: actionable cross-project tasks, correct destinations, pin/rename/archive/restore persistence, folder bridge, safe active-operation guard, original files preserved, light/dark and both sizes.')
  } catch (error) {
    if (page && !page.isClosed()) await shot('failure').catch(() => {})
    throw error
  } finally {
    if (desktop) await desktop.close()
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
