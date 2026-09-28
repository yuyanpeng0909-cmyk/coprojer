require('./test-display.cjs').install()
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { _electron: electron } = require('playwright')
const output = path.resolve('output/playwright/model-traffic')
async function main() {
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'profile-'))
  const network = [], pageErrors = [], screenshots = [], displayEvidence = []
  let held, app, page
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    network.push({ path: req.url, model: body.model, stream: body.stream })
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'chat-fixture' }] })); return }
    if (body.model === 'limited-fixture') { res.writeHead(429); res.end('fixture-secret-key provider limit'); return }
    if (body.model === 'slow-fixture') { held = res; return }
    const protocol = req.url.endsWith('/messages') ? 'anthropic' : req.url.endsWith('/responses') ? 'responses' : 'chat'
    const usage = body.model === 'unknown-fixture' ? undefined : protocol === 'chat' ? { prompt_tokens: 128, completion_tokens: 32, total_tokens: 160 } : protocol === 'responses' ? { input_tokens: 256, output_tokens: 64, total_tokens: 320 } : { input_tokens: 64, cache_read_input_tokens: 32, cache_creation_input_tokens: 16, output_tokens: 16 }
    const result = protocol === 'chat' ? { model: body.model, usage, choices: [{ message: { content: '连接成功' } }] } : protocol === 'responses' ? { model: body.model, usage, output: [{ type: 'message', content: [{ type: 'output_text', text: '连接成功' }] }] } : { model: body.model, usage, content: [{ type: 'text', text: '连接成功' }] }
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return }
    const events = protocol === 'chat' ? [{ model: body.model, choices: [{ delta: { content: '连接成功' }, finish_reason: 'stop' }] }, { choices: [], usage }, '[DONE]'] : protocol === 'responses' ? [{ type: 'response.completed', response: result }] : [{ type: 'message_start', message: { model: body.model, usage: { ...usage, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '连接成功' } }, { type: 'message_delta', usage: { output_tokens: 16 } }, { type: 'message_stop' }]
    res.setHeader('content-type', 'text/event-stream')
    res.end(events.map(e => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1'
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  async function launch() {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: path.resolve('.'), env })
    page = await app.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    await page.getByRole('button', { name: '模型连接', exact: true }).click()
    await page.getByRole('tab', { name: '流量监控', exact: true }).click()
    await page.getByTestId('traffic-requests').waitFor()
  }
  async function displayCheck() {
    const evidence = await app.evaluate(() => global.__coprojerTestDisplay)
    assert.ok(evidence.selection)
    for (const w of evidence.windows) { assert.equal(w.initiallyVisible, false); assert.equal(w.displayId, evidence.selection.targetId) }
    for (const e of evidence.events) assert.equal(e.displayId, evidence.selection.targetId)
    displayEvidence.push(evidence)
  }
  async function capture(name, width, height, theme = 'light') {
    await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setMinimumSize(1, 1); w.setContentSize(size.width, size.height) }, { width, height })
    await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.querySelector('.eng-settings').scrollTop = 0 }, theme)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'document overflow')
    assert.ok(await page.locator('.eng-traffic').evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'monitor overflow')
    const file = path.join(output, name + '-' + width + 'x' + height + '-' + theme + '.png')
    await page.screenshot({ path: file, animations: 'disabled', scale: 'css' }); screenshots.push(file)
  }
  try {
    await launch()
    await page.getByText('尚未接入模型，请先在「连接配置」中添加。', { exact: true }).waitFor()
    const configs = [['chat', 'chat-fixture'], ['responses', 'responses-fixture'], ['anthropic', 'anthropic-fixture'], ['chat', 'unknown-fixture'], ['chat', 'limited-fixture'], ['chat', 'slow-fixture'], ['chat', 'chat-fixture']]
    const models = []
    for (const [protocol, model] of configs) models.push(await invoke('saveModel', { id: '', model, baseUrl, protocol, apiKey: 'fixture-secret-key' }))
    for (const m of models.slice(0, 5)) {
      if (m.model === 'limited-fixture') await assert.rejects(invoke('testModel', m), /429/)
      else assert.match(await invoke('testModel', m), /连接成功/)
    }
    await invoke('listModels', models[0])
    const session = await invoke('createAssistantSession')
    const pending = invoke('sendAssistantMessage', '隔离的取消测试', models[5].id, session.id)
    await page.waitForFunction(async () => (await window.desktop.engineering.modelTraffic()).totals.running === 1)
    await invoke('stopAssistantMessage', session.id)
    await pending
    if (held) held.destroy()
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="traffic-requests"]')?.textContent === '6')
    const data = await invoke('modelTraffic')
    assert.equal(data.totals.requests, 6); assert.equal(data.totals.totalTokens, 608)
    assert.equal(data.totals.usageReported, 3); assert.equal(data.totals.failed, 1); assert.equal(data.totals.cancelled, 1)
    assert.equal(data.models.find(m => m.id === models[6].id).totals.requests, 0, 'duplicate model names remain isolated')
    const duplicateOptions = (await page.getByRole('combobox', { name: '模型连接', exact: true }).locator('option').allTextContents()).filter(text => text.includes('chat-fixture'))
    assert.equal(duplicateOptions.length, 2); assert.equal(new Set(duplicateOptions).size, 2, 'same model and endpoint can be distinguished in the selector')
    assert.equal(data.recent.find(r => r.connectionId === models[0].id).purpose, 'test')
    await page.getByLabel('统计时间', { exact: true }).selectOption('7d')
    await page.getByRole('combobox', { name: '模型连接', exact: true }).selectOption(models[1].id)
    await page.waitForFunction(() => document.querySelector('[data-testid="traffic-tokens"]')?.textContent === '320')
    await page.getByRole('combobox', { name: '模型连接', exact: true }).selectOption('')
    await page.getByLabel('统计时间', { exact: true }).selectOption('today')
    await page.waitForFunction(() => document.querySelector('[data-testid="traffic-tokens"]')?.textContent === '608')
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1280, 840], [860, 600]]) await capture('monitor', width, height, theme)
    await page.evaluate(() => document.documentElement.dataset.theme = 'light')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await page.waitForFunction(() => innerWidth > 1280)
    await page.screenshot({ path: path.join(output, 'monitor-maximized.png'), animations: 'disabled', scale: 'css' })
    screenshots.push(path.join(output, 'monitor-maximized.png'))
    await page.getByRole('heading', { name: '最近调用', exact: true }).evaluate(el => el.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: path.join(output, 'monitor-requests-maximized.png'), animations: 'disabled', scale: 'css' })
    screenshots.push(path.join(output, 'monitor-requests-maximized.png'))
    await displayCheck()
    await app.close(); app = undefined
    await launch()
    assert.equal((await invoke('modelTraffic')).totals.requests, 6)
    assert.equal((await invoke('modelTraffic')).totals.totalTokens, 608)
    await page.getByRole('tab', { name: '流量监控', exact: true }).focus()
    await page.keyboard.press('ArrowLeft')
    await page.getByRole('tab', { name: '连接配置', exact: true }).waitFor()
    assert.equal(await page.getByRole('tab', { name: '连接配置', exact: true }).getAttribute('aria-selected'), 'true')
    await page.keyboard.press('ArrowRight')
    await page.getByTestId('traffic-tokens').waitFor()
    await invoke('testModel', models[0])
    await page.waitForFunction(() => document.querySelector('[data-testid="traffic-requests"]')?.textContent === '7', undefined, { timeout: 10000 })
    assert.equal((await invoke('modelTraffic')).totals.totalTokens, 768, 'polling refreshes real calls without a manual refresh')
    await displayCheck()
    assert.deepEqual(pageErrors, [])
    const disk = await fs.readFile(path.join(profile, 'model-traffic-v1.json'), 'utf8')
    assert.ok(!disk.includes('fixture-secret-key')); assert.ok(!disk.includes('隔离的取消测试'))
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, mockProviders: true, network, screenshotTotals: data.totals, finalTotals: (await invoke('modelTraffic')).totals, screenshots, displayEvidence, pageErrors }, null, 2))
    console.log('PASS: real Electron monitor, three protocol HTTP/SSE fixtures, existing connections, cancellation, unknown tokens, filters, duplicate names, restart, automatic polling, keyboard tabs, light/dark at both sizes, display routing, no renderer errors')
  } finally {
    if (held) held.destroy()
    if (app) await app.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (path.dirname(profile) === output) await fs.rm(profile, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
