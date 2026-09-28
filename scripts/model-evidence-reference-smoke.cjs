const assert = require('node:assert/strict'), fs = require('node:fs/promises'), { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright'), { aaHtml } = require('./fixtures/aa.cjs'), { arenaHtml, categories } = require('./fixtures/arena.cjs')
async function main() {
  const output = resolve('output/playwright/model-evidence-reference'); await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'profile-')), env = { ...process.env, COPROJER_USER_DATA: profile }, errors = [], captures = []
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await electron.launch({ args: ['.', '--disable-gpu'], env })
    const page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    const fixtures = Object.fromEntries(Object.entries(categories).map(([url, category]) => [url, arenaHtml(category, [
      { model: 'glm-5.3-max', score: 1500, input: 1, output: 3 },
      { model: 'glm-5.3-high', score: 1450, input: 1, output: 3 },
      { model: 'glm-5.3-flash', score: 1400, input: .1, output: .3 },
      { model: 'qwen3.7-flash-thinking', score: 1300, input: .1, output: .3 },
    ])]))
    await app.evaluate(({ shell }, fixtures) => {
      globalThis.__openedSources = []; globalThis.__sourceFailure = false; globalThis.__evidenceRequests = []
      shell.openExternal = async url => { if (globalThis.__sourceFailure) throw Error('fixture browser failure'); globalThis.__openedSources.push(url) }
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url); globalThis.__evidenceRequests.push(u)
        if (u.startsWith('https://arena.ai/')) return new Response(fixtures.arena[new URL(u).pathname], { headers: { 'content-type': 'text/html' } })
        if (u.startsWith('https://artificialanalysis.ai/')) return new Response(fixtures.aa, { headers: { 'content-type': 'text/html' } })
        throw Error('Unexpected model or network request in reference-only test')
      }
    }, { arena: fixtures, aa: aaHtml() })
    const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
    await invoke('saveModel', { id: 'glm', model: 'glm-5.3', protocol: 'chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'isolated-fixture-key' })
    await invoke('saveModel', { id: 'flash', model: 'glm-5.3-flash', protocol: 'chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'isolated-fixture-key' })
    await invoke('saveModel', { id: 'qwen', model: 'qwen3.7-flash', protocol: 'chat', baseUrl: 'https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'isolated-fixture-key' })
    await invoke('setDefaultAssistantModel', 'glm')
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('button', { name: '模型配置助手', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '模型配置助手', exact: true })
    for (const select of await dialog.locator('.eng-model-capabilities select').all()) await select.selectOption('frontend')
    const before = await invoke('state')
    await dialog.getByRole('button', { name: '一键推荐模型', exact: true }).click()
    await dialog.getByRole('heading', { name: /模型分配预览/ }).waitFor()
    const source = dialog.locator('.eng-model-evidence > details').first(); await source.locator('summary').first().click()
    await source.getByRole('link', { name: '查看 Arena 来源', exact: true }).click()
    for (let n = 0; n < 30 && !(await app.evaluate(() => globalThis.__openedSources.length)); n++) await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(await app.evaluate(() => globalThis.__openedSources), ['https://arena.ai/leaderboard/code/webdev/frontend'], 'clicking the Arena source must reach the system browser')
    assert.equal(app.windows().length, 1, 'source click must not create an Electron window')
    const glmRow = source.locator('tbody tr').first()
    assert.match(await glmRow.innerText(), /近似参考 · 非精确匹配/)
    assert.equal(await glmRow.locator('.eng-evidence-references a').first().innerText(), 'glm-5.3-max')
    assert.match(await glmRow.innerText(), /不参与自动推荐或 Pareto/)
    const alternatives = glmRow.getByText('其他近似条目（1）', { exact: true })
    await alternatives.click(); assert.ok(await glmRow.getByRole('link', { name: 'glm-5.3-high', exact: true }).isVisible()); await alternatives.click()
    assert.equal(await glmRow.locator('td').last().innerText(), '不判定')
    assert.ok(await dialog.getByRole('button', { name: '一键应用模型配置', exact: true }).isDisabled())
    const link = source.getByRole('link', { name: '查看 Arena 来源', exact: true })
    await app.evaluate(() => { globalThis.__sourceFailure = true }); await link.click()
    await source.getByRole('alert').filter({ hasText: '未能打开系统浏览器' }).waitFor()
    assert.equal(await source.getByRole('alert').locator('span').innerText(), 'https://arena.ai/leaderboard/code/webdev/frontend')
    await app.evaluate(() => { globalThis.__sourceFailure = false }); await link.focus(); await page.keyboard.press('Enter')
    await source.getByRole('alert').waitFor({ state: 'hidden' })
    await glmRow.getByRole('link', { name: 'glm-5.3-max', exact: true }).click()
    const aa = dialog.locator('.eng-model-evidence > details').nth(1); await aa.locator('summary').first().click()
    await aa.getByRole('link', { name: '查看 Artificial Analysis 来源', exact: true }).click()
    await aa.getByRole('link', { name: '对应档位条目', exact: true }).first().click()
    assert.ok((await app.evaluate(() => globalThis.__openedSources)).includes('https://artificialanalysis.ai/models/glm-5-3'))
    await assert.rejects(invoke('openModelEvidenceSource', 'javascript:alert(1)'), /已核实/)
    assert.equal(app.windows().length, 1)
    async function capture(name, width, height, theme, maximized = false) {
      if (maximized) ({ width, height } = await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; w.maximize(); return screen.getDisplayMatching(w.getBounds()).workAreaSize }))
      else await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(size.width, size.height) }, { width, height })
      await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height })
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      await source.evaluate(element => element.scrollIntoView({ block: 'start' }))
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1))
      const file = join(output, name + '-' + theme + '-' + width + 'x' + height + '.png'); await page.screenshot({ path: file }); captures.push({ file, width, height, theme, maximized })
    }
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1280, 840], [860, 600]]) await capture('nearby-evidence', width, height, theme)
    await capture('source-reference-maximized', 0, 0, 'light', true)
    assert.deepEqual((await invoke('state')).agents, before.agents)
    assert.deepEqual((await invoke('state')).skills, before.skills)
    assert.deepEqual(errors, [])
    await fs.writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, captures, errors }, null, 2))
    console.log('PASS: Arena and AA source clicks, entry links, browser failure and keyboard retry, fuzzy warnings, allocation exclusion, saved data preserved; four layouts and maximized screenshot')
  } finally { await app?.close(); await fs.rm(profile, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
