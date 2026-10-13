require('./test-display.cjs').install()
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { _electron: electron } = require('playwright')

async function main() {
  const output = path.resolve('output/playwright/agent-instructions')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'profile-'))
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const customText = '负责前端设计，原型开发等UI设计。'
  const roles = ['planner', 'designer', 'developer', 'reviewer']
  const names = ['需求与架构', '交互与原型', '全栈开发', '独立测试']
  const texts = ['整理需求与任务依赖，准备可执行方案，保留人工确认。', '根据需求制作可交互原型，保留页面与状态的交接依据。', '实现已确认需求，复用项目公共内容，修改后运行必要检查。', '独立检查实际代码，运行测试并逐项核对验收标准。不要仅复述开发者的完成声明。']
  await fs.writeFile(path.join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, projects: [], models: [], agents: [
    ...roles.map((role, i) => ({ id: role, role, name: names[i], modelId: '', instructions: texts[i] })),
    { id: 'custom', role: 'developer', name: '原型设计智能体', modelId: '', instructions: customText },
  ] }))
  let app, page
  const errors = [], screenshots = []
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  async function launch() {
    app = await electron.launch({ args: ['.', '--disable-gpu'], env, cwd: process.cwd() })
    page = await app.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', e => errors.push(e.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    const display = await app.evaluate(() => global.__coprojerTestDisplay)
    assert.ok(display.windows.every(w => !w.initiallyVisible && w.displayId === display.selection.targetId))
    console.log('Display:', JSON.stringify(display.selection))
  }
  async function capture(name, width, height, theme = 'light') {
    await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setMinimumSize(1, 1); w.setContentSize(size.width, size.height) }, { width, height })
    await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal window overflow')
    const open = page.locator('dialog[open]')
    if (await open.count()) {
      await open.getByRole('textbox', { name: '工作要求', exact: true }).scrollIntoViewIfNeeded()
      assert.ok(await open.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no horizontal dialog overflow')
      assert.ok(await open.getByRole('button', { name: '保存智能体', exact: true }).evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }), 'save remains reachable')
    }
    const file = path.join(output, `${name}-${width}-${theme}.png`)
    await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file)
  }
  try {
    await launch()
    await invoke('saveModel', { id: 'fixture', name: 'fixture', model: 'fixture', protocol: 'chat', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' })
    await invoke('updateOnboarding', { hintsHidden: true, cardCollapsed: true })
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('heading', { name: '共享智能体模板' }).waitFor()
    assert.equal(await page.locator('.eng-agent-card').count(), 5)
    const state = await invoke('state')
    const upgraded = state.agents.find(a => a.id === 'custom').instructions
    assert.ok(upgraded.includes(customText) && upgraded.includes('【交付与完成标准】'))
    await capture('cards', 1280, 840)
    await capture('cards', 860, 600, 'dark')
    const custom = page.locator('.eng-agent-card').filter({ has: page.getByRole('heading', { name: '原型设计智能体', exact: true }) })
    await custom.getByRole('button', { name: '配置', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '配置智能体' })
    assert.equal(await dialog.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(), upgraded)
    await capture('requirements', 1280, 840)
    await capture('requirements', 860, 600, 'dark')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '新增智能体', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '新增智能体' })
    const requirements = dialog.getByRole('textbox', { name: '工作要求', exact: true })
    assert.ok((await requirements.inputValue()).includes('正式工程'))
    await dialog.locator('select').first().selectOption('reviewer')
    assert.ok((await requirements.inputValue()).includes('预期与实际结果'))
    await requirements.fill('只负责本项目的接口验证。')
    await dialog.locator('select').first().selectOption('developer')
    assert.equal(await requirements.inputValue(), '只负责本项目的接口验证。', 'changing the role keeps custom draft text')
    await dialog.locator('input').first().fill('专项成员')
    await dialog.getByRole('button', { name: '保存智能体', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await app.close(); app = undefined
    await launch()
    const restarted = await invoke('state')
    assert.equal(restarted.agents.find(a => a.id === 'custom').instructions, upgraded)
    assert.equal(restarted.agents.find(a => a.name === '专项成员').instructions, '只负责本项目的接口验证。')
    assert.deepEqual(errors, [])
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ status: 'passed', checks: ['legacy and custom upgrade in Electron', 'full configuration text', 'compact card summaries', 'new member role presets', 'custom draft preservation', 'save and restart persistence', '1280x840 light and 860x600 dark'], screenshots, profile }, null, 2))
    console.log('PASS isolated Electron agent instructions smoke')
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') })
    console.error('Renderer errors:', errors)
    throw error
  } finally { if (app) await app.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
