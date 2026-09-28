const assert = require('node:assert/strict'), fs = require('node:fs/promises'), http = require('node:http')
const { join, resolve } = require('node:path'), { _electron: electron } = require('playwright')
async function main() {
  const output = resolve('output/playwright/onboarding'); await fs.mkdir(output, { recursive: true })
  const sandbox = await fs.mkdtemp(join(output, 'fixture-')), profile = join(sandbox, 'profile'), parent = join(sandbox, 'projects')
  await fs.mkdir(parent)
  let desktop, page, requests = 0, fail = false
  const errors = [], layouts = []
  const server = http.createServer(async (req, res) => {
    requests++
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (fail) { res.writeHead(401); res.end('fixture credential rejected'); return }
    const tool = body.messages.findLast(m => m.role === 'tool')
    const message = body.tools?.length ? { role: 'assistant', content: '', tool_calls: [{ id: 'probe', type: 'function', function: { name: 'connection_probe', arguments: '{}' } }] }
      : { role: 'assistant', content: tool ? tool.content : '连接成功' }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model, choices: [{ message }] }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const state = () => invoke('state')
  const until = async (predicate, label) => { const deadline = Date.now() + 15000; while (!await predicate()) { if (Date.now() > deadline) throw Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 80)) } }
  const open = async () => { await page.getByRole('navigation', { name: '项目管理导航', exact: true }).getByRole('button', { name: '新手入门', exact: true }).click(); await page.getByRole('heading', { name: '新手入门', exact: true }).waitFor() }
  const launch = async () => {
    desktop = await electron.launch({ args: ['.', '--disable-gpu'], cwd: resolve('.'), env, timeout: 30000 })
    page = await desktop.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message))
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
  }
  const shot = name => page.screenshot({ path: join(output, name + '.png'), animations: 'disabled', scale: 'css' })
  try {
    await launch()
    await page.getByRole('region', { name: '新手入门进度卡' }).waitFor(); assert.equal(requests, 0)
    await open()
    assert.equal(await page.locator('[data-onboarding-step]').count(), 11)
    await page.getByRole('button', { name: '稍后继续', exact: true }).click()
    await page.getByRole('button', { name: '继续引导', exact: true }).waitFor()
    assert.equal((await state()).onboarding.paused, true)
    await page.getByRole('button', { name: '继续引导', exact: true }).click()
    await page.locator('[data-onboarding-step="connection"]').getByRole('button', { name: '打开模型连接', exact: true }).click()
    await page.getByLabel('当前页面入门指引').waitFor()
    await page.locator('.eng-model-import-actions').getByRole('button').last().click()
    const modelDialog = page.getByRole('dialog', { name: '新增模型', exact: true })
    await modelDialog.getByLabel('服务地址 Base URL', { exact: true }).fill('http://127.0.0.1:' + server.address().port + '/v1')
    await modelDialog.getByPlaceholder('填写或选择模型 ID').fill('onboarding-fixture')
    await modelDialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await modelDialog.getByText(/连接成功/).waitFor()
    await modelDialog.getByRole('button', { name: '保存模型', exact: true }).click(); await modelDialog.waitFor({ state: 'hidden' })
    const model = (await state()).models[0]; assert.equal(model.checks.connection.status, 'passed', 'test before save must persist')
    const settings = page.getByRole('region', { name: '默认通用助手模型设置' })
    await settings.getByLabel('默认通用助手模型', { exact: true }).selectOption(model.id)
    await settings.getByRole('button', { name: '保存默认模型', exact: true }).click()
    await until(async () => (await state()).defaultAssistantModelId === model.id, 'assistant default')
    await open()
    const beforeNavigation = requests
    await page.locator('[data-onboarding-step="team"]').getByRole('button', { name: '检查开发能力', exact: true }).click()
    await until(async () => (await state()).models[0].checks?.capabilities?.status === 'passed', 'capability receipt')
    assert.equal(requests, beforeNavigation + 2)
    await page.getByRole('button', { name: '新建入门项目', exact: true }).click()
    await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, parent)
    const projectDialog = page.getByRole('dialog', { name: '新建工程项目', exact: true })
    await projectDialog.getByLabel('项目名称', { exact: true }).fill('我的入门项目')
    await projectDialog.getByLabel('项目目标', { exact: true }).fill('记录我的每日阅读，保存书名与读书笔记。')
    await projectDialog.getByRole('button', { name: '选择位置', exact: true }).click()
    await page.waitForFunction(folder => document.querySelector('input[placeholder="选择父目录"]')?.value === folder, parent)
    await projectDialog.getByRole('button', { name: '创建工程', exact: true }).click(); await projectDialog.waitFor({ state: 'hidden' })
    const project = (await state()).projects[0]
    await until(async () => (await state()).onboarding?.projectId === project.id, 'tracked project')
    await page.getByLabel('当前页面入门指引').waitFor()
    await open()
    assert.equal(await page.getByLabel('入门项目', { exact: true }).inputValue(), project.id)
    const afterSetup = requests
    for (const step of ['discussion', 'prototype', 'specification', 'plans', 'development', 'verification', 'acceptance']) {
      await page.locator('[data-onboarding-step="' + step + '"]').locator('.onboarding-step-action').click()
      await page.getByLabel('当前页面入门指引').waitFor()
      assert.equal(requests, afterSetup, 'guidance navigation must not call a model')
      await open()
    }
    for (const [width, height] of [[1280, 840], [860, 600]]) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click()
        await page.locator('.onboarding-page').evaluate(e => { e.scrollTop = 0 })
        const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, pageOverflow: document.querySelector('.onboarding-page').scrollWidth > document.querySelector('.onboarding-page').clientWidth, scrollable: document.querySelector('.onboarding-page').scrollHeight > document.querySelector('.onboarding-page').clientHeight }))
        assert.equal(layout.overflow, false); assert.equal(layout.pageOverflow, false); assert.equal(layout.scrollable, true)
        layouts.push({ theme, ...layout }); await shot('guide-' + theme + '-' + width)
      }
    }
    await page.getByRole('button', { name: '返回项目管理', exact: true }).click()
    await page.getByRole('button', { name: '展开入门进度', exact: true }).click()
    await page.getByRole('button', { name: '收起入门进度', exact: true }).click()
    await page.getByRole('button', { name: '展开入门进度', exact: true }).waitFor()
    await shot('home-collapsed-860')
    await open(); await page.getByRole('button', { name: '稍后继续', exact: true }).click()
    await desktop.close(); desktop = null; await launch()
    assert.equal((await state()).onboarding.projectId, project.id)
    assert.equal((await state()).onboarding.paused, true)
    assert.equal((await state()).models[0].checks.capabilities.status, 'passed')
    await page.getByRole('button', { name: '展开入门进度', exact: true }).waitFor()
    await open(); await page.getByRole('button', { name: '继续引导', exact: true }).click()
    const current = (await state()).models[0]
    await invoke('saveModel', { ...current, model: 'onboarding-updated', checks: current.checks })
    assert.equal((await state()).models[0].checks, undefined, 'client cannot forge checks after edit')
    await page.locator('[data-onboarding-step="team"]').getByText('待完成', { exact: true }).waitFor()
    fail = true
    await page.getByRole('button', { name: '测试助手连接', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal((await state()).models[0].checks.connection.status, 'failed'); fail = false
    await page.getByRole('button', { name: '测试助手连接', exact: true }).click()
    await until(async () => (await state()).models[0].checks.connection.status === 'passed', 'retry success')
    await invoke('updateProjectMetadata', project.id, { archived: true })
    await page.getByText('原项目已归档或不存在。选择其他项目即可继续，已有工程不受影响。').waitFor()
    await shot('missing-project-1280')
    assert.deepEqual(errors, [])
    await fs.writeFile(join(output, 'verification.json'), JSON.stringify({ errors, layouts, requests, tests: ['offline entry', 'test before save', 'capability check', 'real project creation', 'all-stage navigation without execution', 'pause/restart', 'credential invalidation', 'failed test retry', 'archive recovery'], profile }, null, 2))
    console.log('Onboarding Electron checks passed: ' + JSON.stringify({ layouts, requests, errors }))
  } finally { await desktop?.close(); await new Promise(r => server.close(r)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
