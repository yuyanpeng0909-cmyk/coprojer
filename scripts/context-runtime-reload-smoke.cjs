require('./test-display.cjs').install()
const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
const wait = async (fn, label) => { const end = Date.now() + 30000; while (!await fn()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 50)) } }
async function main() {
  const output = path.resolve('output/playwright/context-runtime/m3'); await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(path.join(output, 'isolated-')), profile = path.join(sandbox, 'profile'), root = path.join(sandbox, 'project')
  await fs.mkdir(profile); await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-context-reload', private: true }))
  for (let i = 0; i < 10; i++) await fs.writeFile(path.join(root, 'material-' + i + '.txt'), 'RELOAD_ORIGINAL_' + i + '原'.repeat(5980))
  const feature = { id: 'f', title: '规划上下文恢复', description: '实际隔离窗口', module: '核心', scope: 'current', stage: 'solution', criteria: ['人工确认方案'], plan: '', tasks: [], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [], feedback: '' }
  const project = { id: 'p', name: '上下文恢复验收', root, brief: '隔离项目', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
  const chat = Array.from({ length: 24 }, (_, i) => [{ id: 'u' + i, role: 'user', text: 'ORIGINAL_CHAT_' + i + '问'.repeat(4000), at: new Date().toISOString(), status: 'complete' }, { id: 'a' + i, role: 'assistant', text: '原回复'.repeat(2000), at: new Date().toISOString(), status: 'complete' }]).flat()
  let releasePlan, releaseAssistant, planRequests = 0, assistantRequests = 0
  const server = await provider(async req => {
    if (req.system.includes('GENERAL_ASSISTANT')) { assistantRequests++; await new Promise(r => { releaseAssistant = r }); return { text: '重载后助手回复完成', calls: [] } }
    planRequests++
    if (planRequests === 1) return { text: '', calls: Array.from({ length: 10 }, (_, i) => ({ id: 'read-' + i, name: 'read_file', arguments: JSON.stringify({ path: 'material-' + i + '.txt' }) })) }
    await new Promise(r => { releasePlan = r }); return { text: JSON.stringify({ plan: '重载后的待确认方案', tasks: ['人工确认'] }), calls: [] }
  })
  await fs.writeFile(path.join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, projects: [project], agents: [], models: [{ id: 'fixture', name: 'fixture', model: 'fixture', protocol: 'chat', baseUrl: server.url, cipher: '' }], defaultAssistantModelId: 'fixture', assistant: { version: 1, activeSessionId: 's', sessions: [{ id: 's', title: '恢复会话', projectId: 'p', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), draft: '', modelId: '', scrollTop: 0, pinned: false, archived: false, messages: chat }], memories: [], plans: [], dismissedHints: [] } }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app, page; const errors = []
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const disk = () => JSON.parse(sync.readFileSync(path.join(profile, 'engineering-v1.json'), 'utf8'))
  const openFeature = async () => {
    if (await page.getByRole('button', { name: '继续开发 ' + project.name, exact: true }).count()) await page.getByRole('button', { name: '继续开发 ' + project.name, exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '方案与任务', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: feature.title, exact: true }).click()
    const drawer = page.getByRole('dialog', { name: feature.title, exact: true }); await drawer.getByRole('tab', { name: '日志', exact: true }).click()
    return drawer
  }
  try {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: process.cwd(), env }); page = await app.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', e => errors.push(e.message)); await page.emulateMedia({ reducedMotion: 'reduce' })
    await invoke('generatePlan', 'p', 'f'); await wait(() => !!releasePlan, 'planning held after compaction')
    let drawer = await openFeature(); await drawer.locator('.eng-context-details > summary').filter({ hasText: /^上下文与运行详情/ }).click()
    await drawer.getByText('请求体', { exact: true }).waitFor()
    const starts = disk().projects[0].events.filter(e => e.kind === 'start').length
    await page.reload(); drawer = await openFeature(); await drawer.locator('.eng-context-details > summary').filter({ hasText: /^上下文与运行详情/ }).click()
    await drawer.getByText('请求体', { exact: true }).waitFor(); assert.equal(planRequests, 2); assert.equal(disk().projects[0].events.filter(e => e.kind === 'start').length, starts)
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('engineering:invoke')
      global.__contextQuery = { drop: true, dropped: 0, duplicate: 0, reused: 0, saved: null }
      ipcMain.removeHandler('engineering:invoke')
      ipcMain.handle('engineering:invoke', async (event, method, args) => {
        const fault = global.__contextQuery
        if (method === 'state' && fault.drop) { fault.dropped++; throw new Error('isolated query temporarily unavailable') }
        if (method === 'state' && fault.duplicate > 0) { fault.duplicate--; fault.reused++; return fault.saved }
        const value = await original(event, method, args)
        if (method === 'state') fault.saved = value
        return value
      })
    })
    await wait(() => app.evaluate(() => global.__contextQuery.dropped >= 2), 'dropped queries observed')
    releasePlan(); await wait(() => disk().projects[0].features[0].contextRuntime.status === 'completed', 'durable planning completion')
    await app.evaluate(() => { global.__contextQuery.drop = false })
    await drawer.getByText('上下文与运行详情 · 本轮已返回', { exact: true }).waitFor()
    await page.getByText('isolated query temporarily unavailable', { exact: true }).waitFor({ state: 'detached' })
    assert.equal(planRequests, 2); assert.equal(disk().projects[0].features[0].stage, 'solution')
    assert.equal(disk().projects[0].features[0].revision, 2)
    await drawer.getByText(/当前修订 2 \/ 本次运行修订 1/).waitFor()
    for (const size of [[1280, 840], [860, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size)
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size)
      const summary = drawer.locator('.eng-context-details > summary').filter({ hasText: /^上下文与运行详情/ }); await summary.focus(); assert.ok(await summary.evaluate(el => document.activeElement === el))
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(output, 'planning-' + size.join('x') + '.png'), animations: 'disabled' })
    }
    await drawer.getByRole('button', { name: '查看归档 1', exact: true }).click()
    await drawer.getByLabel('归档分页').getByText(/完整归档/).waitFor(); await drawer.getByRole('button', { name: '下一页原文', exact: true }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '通用助手', exact: true }).click()
    let panel = page.getByRole('dialog', { name: '通用助手', exact: true })
    await panel.getByLabel('消息', { exact: true }).fill('LATEST_RELOAD_QUESTION')
    await panel.getByRole('button', { name: '发送', exact: true }).click()
    await wait(() => !!releaseAssistant, 'assistant request held')
    await page.reload(); await page.getByRole('button', { name: '通用助手', exact: true }).click(); panel = page.getByRole('dialog', { name: '通用助手', exact: true })
    await panel.locator('.eng-context-details > summary').filter({ hasText: /^上下文与运行详情/ }).click(); await panel.getByText('请求体', { exact: true }).waitFor()
    await app.evaluate(() => { global.__contextQuery.duplicate = 3 })
    releaseAssistant(); await wait(() => disk().assistant.sessions[0].messages.at(-1).status === 'complete', 'assistant durable completion')
    await panel.getByText('上下文与运行详情 · 本轮已返回', { exact: true }).waitFor(); assert.equal(assistantRequests, 1)
    assert.equal(disk().assistant.sessions[0].messages.length, 50); assert.equal(disk().projects[0].changes.length, 0)
    await panel.getByRole('button', { name: '查看归档 1', exact: true }).click(); await panel.getByLabel('归档分页').getByText(/完整归档/).waitFor()
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await page.screenshot({ path: path.join(output, 'assistant-dark-860x600.png'), animations: 'disabled' })
    const state = await invoke('state'), display = await app.evaluate(() => global.__coprojerTestDisplay), query = await app.evaluate(() => ({ dropped: global.__contextQuery.dropped, repeated: global.__contextQuery.reused }))
    assert.ok(query.dropped >= 2); assert.equal(query.repeated, 3)
    assert.ok(display.windows.every(w => !w.initiallyVisible && w.displayId === display.selection.targetId)); assert.deepEqual(server.errors, []); assert.deepEqual(errors, [])
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ level: 'actual isolated Electron renderer reload, HTTP/SSE and durable disk state', display, query, planRequests, assistantRequests, starts, state }, null, 2))
    await panel.locator('summary[aria-label="会话更多操作"]').click(); await panel.getByRole('button', { name: '清空当前对话', exact: true }).click(); await panel.getByRole('button', { name: '确认清空', exact: true }).click()
    await wait(() => disk().assistant.sessions[0].messages.length === 0, 'cleared chat'); await panel.locator('.eng-context-details > summary').filter({ hasText: /^上下文与运行详情/ }).waitFor({ state: 'detached' })
    console.log('PASS: actual renderer reload, dropped queries/repeated snapshots, persistent details and archive paging, no repeated starts, isolated planning/assistant, both sizes/theme/focus and clear-chat boundary')
  } catch (error) { if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText()).catch(() => {}) } throw error }
  finally { releasePlan?.(); releaseAssistant?.(); if (app) await app.close(); await server.close(); await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 3 }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
