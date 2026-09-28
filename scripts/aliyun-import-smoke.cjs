const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

async function main() {
  const output = resolve('output/playwright/aliyun-import'); await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'profile-')), errors = [], captures = []
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
  let desktop, page
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const state = () => invoke('state')
  const launch = async () => {
    desktop = await electron.launch({ args: ['.', '--disable-gpu'], env, timeout: 30000 })
    page = await desktop.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', e => errors.push(e.message)); await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    await desktop.evaluate(({ shell }) => {
      const realFetch = globalThis.fetch
      globalThis.__aliyunRequests = []; globalThis.__aliyunLinks = []; globalThis.__holdAliyun = false
      globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init)
        globalThis.__aliyunRequests.push({ url: String(url), method: init.method || 'GET' })
        if (String(url) === 'https://dashscope.aliyuncs.com/compatible-mode/v1/models') {
          if (init.headers.Authorization !== 'Bearer sk-aliyun-ui-fixture-secret') return new Response('not authorized', { status: 401 })
          return Response.json({ data: ['qwen3.7-flash', 'qwen-plus', 'qwen3-coder-plus', 'qwen-expired', 'qwen-empty', 'qwen-stop-off', 'qwen-image', 'text-embedding-v4'].map(id => ({ id })) })
        }
        if (String(url).startsWith('https://bailian-cs.console.aliyun.com/cli/api.json?')) {
          if (init.headers.Authorization !== 'Bearer console-ui-fixture-token') return new Response('not authorized', { status: 403 })
          const params = JSON.parse(new URLSearchParams(init.body).get('params'))
          const models = Object.values(params.Data).find(value => Array.isArray(value?.models)).models
          const data = params.Api.endsWith('queryFreeTierQuota')
            ? { freeTierQuotas: models.map(model => ({ model, quotaStatus: 'VALID', quotaInitTotal: 1000000, quotaTotal: model === 'qwen-empty' ? 0 : 800000, quotaValidityPeriod: model === 'qwen-expired' ? Date.now() - 1000 : Date.now() + 86400000 * 30 })) }
            : { freeTierOnlyStatuses: models.map(model => ({ model, freeTierOnly: model !== 'qwen-stop-off' })) }
          return Response.json({ data: { DataV2: { data: { data } } } })
        }
        throw Error('Unexpected outbound request in isolated Aliyun fixture')
      }
      shell.openExternal = async url => {
        globalThis.__aliyunLinks.push(url)
        if (url.startsWith('https://bailian.console.aliyun.com/console-login?')) {
          globalThis.__aliyunLogin = url
          if (globalThis.__holdAliyun) return
          const target = 'http://' + new URL(url).searchParams.get('notice')
          const response = await realFetch(target, { method: 'POST', headers: { origin: 'https://bailian.console.aliyun.com', 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'console-ui-fixture-token', console_region: 'cn-beijing', console_site: 'domestic' }) })
          if (!response.ok) throw Error('Callback failed')
          await response.text()
        }
      }
    })
  }
  const screenshot = async (name, width, height, theme = 'light') => {
    await desktop.evaluate(({ BrowserWindow }, { width, height }) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setSize(width, height) }, { width, height })
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const file = name + '-' + theme + '-' + width + '.png'
    const png = await page.screenshot({ path: join(output, file), animations: 'disabled', scale: 'css' })
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height], 'capture matches requested layout size')
    captures.push({ file, width, height, maximized: false })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page overflow')
    const dialog = page.getByRole('dialog', { name: '阿里云快速导入', exact: true })
    if (await dialog.count()) {
      assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'dialog overflow')
      const box = await dialog.getByRole('button', { name: '一键导入并装配', exact: true }).boundingBox()
      assert.ok(box && box.y + box.height <= height, 'import remains reachable')
    }
  }
  const tutorial = async name => {
    const { width, height } = await desktop.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.maximize()
      return screen.getDisplayMatching(win.getBounds()).workAreaSize
    })
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const file = name + '-maximized.png'
    const png = await page.screenshot({ path: join(output, file), animations: 'disabled', scale: 'css' })
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height], 'tutorial captures the full maximized window')
    captures.push({ file, width, height, maximized: true })
    assert.ok(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
  }
  try {
    await launch()
    const original = await state()
    await page.getByRole('button', { name: '模型连接', exact: true }).click()
    await screenshot('entry', 1280, 840); await screenshot('entry', 860, 600)
    const open = async () => { await page.getByRole('button', { name: '阿里云快速导入', exact: true }).click(); return page.getByRole('dialog', { name: '阿里云快速导入', exact: true }) }
    let dialog = await open()
    await dialog.getByRole('button', { name: '注册 / 查看免费额度', exact: true }).click()
    assert.ok((await desktop.evaluate(() => globalThis.__aliyunLinks)).includes('https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota'))
    await tutorial('01-key-entry')
    await dialog.locator('input[type=password]').fill('sk-aliyun-ui-fixture-secret')
    await dialog.getByRole('button', { name: '识别模型', exact: true }).click()
    await dialog.getByRole('heading', { name: '对话候选 · 6 个', exact: true }).waitFor()
    assert.equal(await dialog.locator('input[type=password]').inputValue(), '')
    assert.ok(await dialog.getByRole('button', { name: '一键导入并装配', exact: true }).isDisabled())
    assert.equal((await state()).models.length, 0)
    await dialog.getByRole('button', { name: '登录并扫描免费额度', exact: true }).click()
    await dialog.getByText(/上次扫描：/).waitFor()
    for (const model of ['qwen-expired', 'qwen-empty', 'qwen-stop-off']) assert.ok(await dialog.getByLabel('导入 ' + model, { exact: true }).isDisabled())
    assert.ok(await dialog.getByLabel('导入 qwen3.7-flash', { exact: true }).isChecked())
    assert.ok(await dialog.getByRole('button', { name: '一键导入并装配', exact: true }).isDisabled())
    await dialog.getByLabel('我确认刚登录的账户与此 Key 属于同一阿里云账号', { exact: true }).check()
    await dialog.getByRole('heading', { name: '免费额度', exact: true }).scrollIntoViewIfNeeded()
    await tutorial('02-free-quota')
    await screenshot('quota', 1280, 840); await screenshot('quota', 860, 600); await screenshot('quota', 860, 600, 'dark')
    await dialog.getByRole('region', { name: '阿里云装配预览' }).scrollIntoViewIfNeeded()
    await tutorial('03-assembly-preview')
    await dialog.getByRole('button', { name: '一键导入并装配', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const imported = await state()
    assert.equal(imported.models.length, 3); assert.ok(imported.models.every(m => m.hasKey && m.name === m.model))
    assert.ok(imported.agents.every(a => a.modelId)); assert.deepEqual(imported.skills, original.skills)
    assert.equal(imported.models.find(m => m.id === imported.defaultAssistantModelId).model, 'qwen3.7-flash')
    await tutorial('04-imported-models')
    const disk = await fs.readFile(join(profile, 'engineering-v1.json'), 'utf8')
    assert.ok(!disk.includes('sk-aliyun-ui-fixture-secret') && !disk.includes('console-ui-fixture-token'))
    dialog = await open()
    await dialog.locator('input[type=password]').fill('sk-aliyun-ui-fixture-secret'); await dialog.getByRole('button', { name: '识别模型', exact: true }).click()
    await dialog.getByRole('heading', { name: '对话候选 · 6 个', exact: true }).waitFor()
    await dialog.getByLabel('仅选择有免费额度且已开启“用完即停”的型号', { exact: true }).uncheck()
    await dialog.getByText('当前为普通导入：不保证后续调用免费，费用遵循阿里云账户设置。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '一键导入并装配', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual((await state()).models, imported.models); assert.deepEqual((await state()).agents, imported.agents)
    dialog = await open()
    await dialog.locator('input[type=password]').fill('sk-aliyun-ui-fixture-secret'); await dialog.getByRole('button', { name: '识别模型', exact: true }).click()
    await dialog.getByRole('heading', { name: '对话候选 · 6 个', exact: true }).waitFor()
    await dialog.locator('input[type=password]').fill('sk-other-account-changed')
    assert.equal(await dialog.getByRole('heading', { name: '对话候选 · 6 个', exact: true }).count(), 0, 'changed key invalidates preview')
    await dialog.locator('input[type=password]').fill('sk-aliyun-ui-fixture-secret'); await dialog.getByRole('button', { name: '识别模型', exact: true }).click()
    await dialog.getByRole('heading', { name: '对话候选 · 6 个', exact: true }).waitFor()
    await desktop.evaluate(() => { globalThis.__holdAliyun = true })
    await dialog.getByRole('button', { name: '登录并扫描免费额度', exact: true }).click()
    await dialog.getByText(/正在等待浏览器授权/).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual((await state()).models, imported.models)
    const requests = await desktop.evaluate(() => globalThis.__aliyunRequests)
    assert.ok(requests.every(r => r.url.endsWith('/models') || r.url.includes('/cli/api.json?')))
    await desktop.close(); desktop = null; await launch()
    const restored = await state()
    assert.deepEqual(restored.models, imported.models); assert.deepEqual(restored.agents, imported.agents)
    assert.equal(restored.defaultAssistantModelId, imported.defaultAssistantModelId)
    assert.deepEqual(errors, [])
    await fs.writeFile(join(output, 'evidence.json'), JSON.stringify({ profile, requests, verified: ['key discovery', 'console callback', 'free quota filters', 'same-account acknowledgement', 'assembly preview', 'encrypted storage', 'same-key reuse', 'preserved skills and bindings', 'key change invalidates preview', 'cancel authorization', 'restart', '1280x840', '860x600', 'dark', 'maximized tutorial captures', 'zero inference requests'] }, null, 2))
    await fs.writeFile(join(output, 'screenshots.json'), JSON.stringify(captures, null, 2))
    console.log('PASS: real Electron Aliyun key/quota/assembly flow, preserved data, restart, cancel, both sizes/themes and maximized screenshots; only controlled service fixtures')
  } catch (error) {
    if (page) { await fs.writeFile(join(output, 'failure.txt'), String(error) + '\n' + await page.locator('body').ariaSnapshot()); await page.screenshot({ path: join(output, 'failure.png') }) }
    throw error
  } finally { if (desktop) await desktop.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
