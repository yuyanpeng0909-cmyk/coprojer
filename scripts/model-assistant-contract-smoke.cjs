const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

async function main() {
  const output = resolve('output/playwright/model-assistant-contract')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'profile-'))
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const desktop = await electron.launch({ args: ['.', '--disable-gpu'], env })
  let page
  const errors = []
  try {
    page = await desktop.firstWindow()
    page.setDefaultTimeout(5000)
    page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    const before = await page.evaluate(async () => {
      await window.desktop.engineering.saveModel({ id: 'fixture', model: 'test-contract', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'chat', apiKey: '' })
      await window.desktop.engineering.setDefaultAssistantModel('fixture')
      return window.desktop.engineering.state()
    })
    const valid = {
      id: 'contract-plan', policy: 'quality', caveat: '隔离测试：没有可比较证据。',
      choices: before.agents.filter(a => !a.ownerProjectId).map(a => ({ agentId: a.id, previousModelId: a.modelId, modelId: a.modelId, reason: '保留当前绑定。', category: 'coding', supported: false })),
      evidence: [{ category: 'coding', url: 'https://arena.ai/leaderboard/text/coding', fetchedAt: new Date().toISOString(), status: 'unavailable', note: '隔离测试的不可用来源。', candidates: [{ connectionId: 'fixture', model: 'test-contract', match: 'unmatched', pareto: 'unknown' }] }],
    }
    const usage = { connectionId: 'fixture', connectionName: 'test-contract', requestedModel: 'test-contract', reportedModels: ['test-contract'], startedAt: new Date().toISOString() }
    const legacy = { id: 'legacy-plan', usage, choices: valid.choices.map(({ category, supported, ...choice }) => choice), caveat: '旧进程返回的推荐方案。' }
    await desktop.evaluate(({ ipcMain }, state) => {
      globalThis.__recommendationReply = null
      globalThis.__recommendationCalls = 0
      globalThis.__recommendationApplies = 0
      ipcMain.removeHandler('engineering:invoke')
      ipcMain.handle('engineering:invoke', (_, method) => {
        if (method === 'state') return state
        if (method === 'recommendAgentModels') { globalThis.__recommendationCalls++; return globalThis.__recommendationReply }
        if (method === 'applyAgentModels') globalThis.__recommendationApplies++
        throw new Error('Unexpected fixture operation: ' + method)
      })
    }, before)
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('button', { name: '模型配置助手', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '模型配置助手', exact: true })
    const recommend = dialog.getByRole('button', { name: '一键推荐模型', exact: true })
    for (const [name, reply] of [
      ['legacy response without evidence', legacy],
      ['empty response', null],
      ['non-array choices', { ...valid, choices: {} }],
      ['missing candidates', { ...valid, evidence: [{ ...valid.evidence[0], candidates: undefined }] }],
      ['invalid score votes', { ...valid, evidence: [{ ...valid.evidence[0], candidates: [{ ...valid.evidence[0].candidates[0], score: { model: 'test-contract', score: 1500, rank: 1, preliminary: false } }] }] }],
      ['invalid usage receipt', { ...valid, usage: { ...usage, reportedModels: undefined } }],
    ]) {
      await desktop.evaluate((_, reply) => { globalThis.__recommendationReply = reply }, reply)
      await recommend.click()
      await dialog.getByRole('alert').filter({ hasText: /推荐结果不完整|推荐结果格式/ }).waitFor()
      assert.deepEqual(errors, [], name + ' must not crash the renderer')
      assert.equal(await dialog.getByRole('button', { name: '一键应用模型配置', exact: true }).count(), 0)
      assert.ok(await recommend.isEnabled(), name + ' must allow retry')
      console.log('PASS: ' + name)
    }
    for (const [width, height, theme] of [[1280, 840, 'light'], [860, 600, 'light'], [1280, 840, 'dark'], [860, 600, 'dark']]) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
      await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height])
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      await dialog.getByRole('alert').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, 'recovery-' + theme + '-' + width + '.png') })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    }
    await desktop.evaluate((_, reply) => { globalThis.__recommendationReply = reply }, valid)
    await recommend.click()
    await dialog.getByRole('heading', { name: '本次榜单证据', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('alert').count(), 0)
    assert.ok(await dialog.getByRole('button', { name: '一键应用模型配置', exact: true }).isDisabled())
    await dialog.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '模型配置助手', exact: true }).click()
    await recommend.waitFor()
    assert.deepEqual(errors, [])
    assert.equal(await desktop.evaluate(() => globalThis.__recommendationApplies), 0)
    assert.deepEqual(await page.evaluate(() => window.desktop.engineering.state()), before)
    console.log('PASS: error recovery, valid retry, reopen, unchanged settings, and both sizes/themes')
  } catch (error) {
    if (page && !page.isClosed()) {
      await fs.writeFile(join(output, 'failure.json'), JSON.stringify({ errors, text: await page.locator('body').innerText() }, null, 2))
      await page.screenshot({ path: join(output, 'failure.png') })
    }
    console.error('Renderer errors:', errors)
    throw error
  } finally { await desktop.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
