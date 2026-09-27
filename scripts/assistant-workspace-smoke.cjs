const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const http = require('node:http')
const { _electron: electron } = require('playwright')
async function main() {
  const output = resolve('output/playwright/assistant-workspace'); await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'profile-')), requests = [], errors = [], checks = []
  let desktop, page, releaseSlow
  const fence = String.fromCharCode(96).repeat(3)
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part
      const body = JSON.parse(raw), system = body.messages[0].content, prompt = body.messages.at(-1).content
      requests.push({ model: body.model, system, prompt })
      if (body.messages.at(-1).role === 'user' && prompt.includes('追加功能隔离检查') && body.tools?.some(t => t.function?.name === 'update_features')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'scoped-feature', type: 'function', function: { name: 'update_features', arguments: JSON.stringify({ features: [{ title: '专用团队的新功能', module: '账户', description: '继续使用当前项目专用团队', criteria: ['绑定当前项目成员'] }] }) } }] } }] }))
        return
      }
      if (prompt.includes('延迟恢复测试')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ delta: { content: '已保存的部分回复。' } }] }) + '\n\n')
        await new Promise(r => { releaseSlow = r; res.on('close', r) })
        if (!res.destroyed) res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '后台回复完成。' } }] }) + '\n\ndata: [DONE]\n\n')
        return
      }
      let content
      if (system.includes('ASSISTANT_TEAM_PLAN')) {
        const input = JSON.parse(prompt)
        content = JSON.stringify({ members: input.agents.filter(a => !a.projectOwned).map((a, i) => ({ key: 'member-' + i, role: a.role, name: a.name, sourceAgentId: a.id, modelId: 'm2', reason: '结合当前职责分工使用已接入型号；具体质量和费用需在真实任务中验证。' })) })
      } else {
        content = '已根据当前配置检查。可以先打开模型连接，确认要使用的型号，再检查团队分工。\n\n' + fence + 'coprojer-actions\n' + JSON.stringify([{ kind: 'navigate', destination: 'models', label: '打开模型连接' }, { kind: 'remember', text: '配置建议优先控制成本', label: '记住成本偏好' }]) + '\n' + fence
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model + '-served', choices: [{ message: { role: 'assistant', content, tool_calls: [] } }] }))
    } catch (error) { errors.push('fixture: ' + error.message); res.writeHead(500); res.end('fixture error') }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const state = () => invoke('state')
  const until = async (predicate, label) => { const deadline = Date.now() + 25000; while (!await predicate()) { if (Date.now() > deadline) throw Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 80)) } }
  const launch = async () => {
    desktop = await electron.launch({ args: ['.', '--disable-gpu', '--no-sandbox'], env, timeout: 30000 })
    page = await desktop.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '通用助手', exact: true }).waitFor()
  }
  const assistant = () => page.getByRole('dialog', { name: '通用助手', exact: true })
  const open = async () => { await page.getByRole('button', { name: '通用助手', exact: true }).click(); await assistant().getByLabel('消息', { exact: true }).waitFor() }
  const close = async () => { await assistant().getByRole('button', { name: '关闭面板', exact: true }).click(); await assistant().waitFor({ state: 'hidden' }) }
  const shot = async (name, width, height, dark = false) => {
    await desktop.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setSize(width, height), { width, height })
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, dark)
    await page.screenshot({ path: join(output, name + '-' + width + (dark ? '-dark' : '') + '.png'), animations: 'disabled', scale: 'css' })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'document overflow: ' + name)
    const bounds = await assistant().boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.y + bounds.height <= height + 1)
    const send = assistant().getByRole('button', { name: '发送', exact: true })
    if (await send.count()) { const b = await send.boundingBox(); assert.ok(b && b.y + b.height <= height && b.x + b.width <= width, 'send reachable') }
  }
  try {
    await launch(); await open()
    assert.equal(await assistant().getAttribute('aria-modal'), 'false')
    await assistant().getByLabel('消息', { exact: true }).fill('没有连接也要保留的草稿')
    await close(); await open(); assert.equal(await assistant().getByLabel('消息', { exact: true }).inputValue(), '没有连接也要保留的草稿')
    await assistant().getByRole('button', { name: '打开模型连接', exact: true }).click()
    await page.getByRole('heading', { name: '模型连接', exact: true }).waitFor(); assert.equal(requests.length, 0)
    checks.push('nonmodal navigation and no-model guidance without model calls', 'immediate close/reopen draft')
    const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1'
    for (const id of ['m1', 'm2']) await invoke('saveModel', { id, model: id === 'm1' ? 'connected-fast' : 'connected-quality', protocol: 'chat', baseUrl, apiKey: '' })
    await invoke('setDefaultAssistantModel', 'm1')
    await until(async () => !(await assistant().getByRole('button', { name: '发送', exact: true }).isDisabled()), 'model ready')
    await shot('welcome', 1280, 840); await shot('welcome', 860, 600); await shot('welcome', 860, 600, true)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await assistant().getByLabel('消息', { exact: true }).fill('配置帮助')
    await assistant().getByRole('button', { name: '发送', exact: true }).click()
    await assistant().getByRole('button', { name: '记住成本偏好', exact: true }).waitFor()
    await assistant().getByRole('button', { name: '记住成本偏好', exact: true }).click()
    assert.equal((await state()).assistant.memories.length, 0)
    await assistant().getByRole('button', { name: '确认保存偏好', exact: true }).click()
    await until(async () => (await state()).assistant.memories.length === 1, 'confirmed memory')
    await assistant().getByRole('button', { name: '返回对话', exact: true }).click()
    await assistant().getByLabel('本次使用的通用助手模型').selectOption('m2')
    await assistant().getByLabel('消息', { exact: true }).fill('暂不发送的下一条问题')
    await close(); await open()
    assert.equal(await assistant().getByLabel('消息', { exact: true }).inputValue(), '暂不发送的下一条问题')
    assert.equal(await assistant().getByLabel('本次使用的通用助手模型').inputValue(), 'm2')
    checks.push('confirmed memory only', 'one-shot choice and draft restored')
    await assistant().getByRole('button', { name: '会话历史', exact: true }).click()
    let row = assistant().locator('.assistant-session-row').filter({ hasText: '配置帮助' })
    await row.getByRole('button', { name: '改名', exact: true }).click(); await assistant().getByLabel('会话名称').fill('配置与续聊')
    await assistant().getByRole('button', { name: '保存名称', exact: true }).click()
    row = assistant().locator('.assistant-session-row').filter({ hasText: '配置与续聊' })
    await row.getByRole('button', { name: '置顶', exact: true }).click(); await row.getByRole('button', { name: '取消置顶', exact: true }).waitFor()
    await row.getByRole('button', { name: '归档', exact: true }).click(); await assistant().locator('.assistant-filters').getByRole('button', { name: '归档', exact: true }).click()
    await assistant().getByLabel('搜索会话').fill('配置与续聊'); await row.waitFor(); await row.getByRole('button', { name: '恢复', exact: true }).click()
    await assistant().getByRole('button', { name: '最近', exact: true }).click(); await row.locator('.assistant-session-open').click()
    checks.push('rename, pin, archive, search and restore')
    const parent = await fs.mkdtemp(join(output, 'projects-'))
    const a = await invoke('createProject', { name: '助手项目 A', parent, brief: '一个简单工具的团队配置', modelId: 'm1' })
    const b = await invoke('createProject', { name: '助手项目 B', parent, brief: '另一个独立项目', modelId: 'm1' })
    const before = await state(), originalB = JSON.stringify(before.projects.find(p => p.id === b)), originalAgents = JSON.stringify(before.agents)
    const session = await invoke('createAssistantSession', a)
    await until(async () => (await assistant().locator('.assistant-scope').innerText()).includes('助手项目 A'), 'project session scope')
    await assistant().getByRole('button', { name: /^推荐智能体组合/ }).click()
    const plan = assistant().getByRole('region', { name: '团队配置方案' })
    await plan.getByRole('button', { name: '确认应用方案', exact: true }).waitFor()
    await plan.getByRole('button', { name: '添加成员', exact: true }).click()
    assert.ok(await plan.getByRole('button', { name: '确认应用方案', exact: true }).isDisabled())
    await plan.getByRole('button', { name: '保存调整', exact: true }).click()
    await until(async () => !(await plan.getByRole('button', { name: '确认应用方案', exact: true }).isDisabled()), 'edited plan saved')
    await plan.getByRole('button', { name: '确认应用方案', exact: true }).click()
    await plan.getByText(/已为「助手项目 A」应用/).waitFor()
    const after = await state(); assert.equal(JSON.stringify(after.projects.find(p => p.id === b)), originalB); assert.equal(JSON.stringify(after.agents.filter(m => !m.ownerProjectId)), originalAgents); assert.equal(after.projects.find(p => p.id === a).teamAgentIds.length, 5)
    const projectPlanner = after.agents.find(member => member.ownerProjectId === a && member.role === 'planner')
    await assert.rejects(() => invoke('configureProject', b, { plannerId: projectPlanner.id }), /项目|智能体/)
    await invoke('discuss', a, '追加功能隔离检查')
    await until(async () => (await state()).projects.find(p => p.id === a).features.some(f => f.title === '专用团队的新功能'), 'new feature uses project team')
    await until(async () => !(await state()).projects.find(p => p.id === a).activity, 'scoped discussion completes')
    const featureState = await state(), addedFeature = featureState.projects.find(p => p.id === a).features.find(f => f.title === '专用团队的新功能')
    for (const id of [addedFeature.developerId, addedFeature.reviewerId]) assert.equal(featureState.agents.find(member => member.id === id).ownerProjectId, a)
    checks.push('editable team plan', 'project-only apply, shared agents and project B unchanged; foreign project member rejected; newly discussed features retain project team')
    await assistant().getByRole('button', { name: '展开宽视图', exact: true }).click()
    await assistant().locator('.assistant-messages').evaluate(el => { el.scrollTop = 0 })
    await shot('wide-team', 1280, 840); await shot('wide-team', 860, 600); await shot('wide-team', 860, 600, true)
    await assistant().getByRole('button', { name: '收起宽视图', exact: true }).click(); await shot('side-team', 1280, 840)
    await assistant().getByLabel('消息', { exact: true }).fill('延迟恢复测试：关闭面板继续')
    await assistant().getByRole('button', { name: '发送', exact: true }).click()
    await until(async () => (await state()).assistant.sessions.find(s => s.id === session.id).messages.at(-1)?.text.includes('部分回复'), 'partial stream')
    await close(); releaseSlow()
    await until(async () => (await state()).assistant.sessions.find(s => s.id === session.id).messages.at(-1)?.status === 'complete', 'background completion')
    await open(); await assistant().getByText(/后台回复完成/).waitFor()
    await assistant().getByLabel('消息', { exact: true }).fill('延迟恢复测试：退出应用')
    await assistant().getByRole('button', { name: '发送', exact: true }).click()
    await until(async () => (await state()).assistant.sessions.find(s => s.id === session.id).messages.at(-1)?.text.includes('部分回复'), 'restart partial stream')
    await assistant().getByLabel('消息', { exact: true }).fill('重启后继续的草稿')
    const count = requests.length; await desktop.close(); desktop = null; releaseSlow?.(); await launch(); await open()
    assert.equal(requests.length, count); assert.equal(await assistant().getByLabel('消息', { exact: true }).inputValue(), '重启后继续的草稿')
    const restored = await state(); assert.equal(restored.assistant.activeSessionId, session.id); assert.equal(restored.assistant.sessions.find(s => s.id === session.id).messages.at(-1).status, 'error'); assert.equal(restored.assistant.memories.length, 1)
    await assistant().getByText(/上次回复已中断/).waitFor(); await shot('restored', 860, 600)
    checks.push('close continues response', 'restart retains partial text, draft, memory and session; no automatic replay', '1280x840 and 860x600 light/dark layouts')
    assert.deepEqual(errors, [])
    await fs.writeFile(join(output, 'evidence.json'), JSON.stringify({ profile, checks, errors, requests: requests.length }, null, 2))
    console.log('PASS: real Electron assistant workspace: ' + checks.join('; '))
  } catch (error) {
    if (page && !page.isClosed()) { await fs.writeFile(join(output, 'failure.txt'), JSON.stringify({ error: error.message, errors, snapshot: await page.locator('body').ariaSnapshot() }, null, 2)); await page.screenshot({ path: join(output, 'failure.png') }) }
    throw error
  } finally { releaseSlow?.(); if (desktop) await desktop.close(); await new Promise(r => server.close(r)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
