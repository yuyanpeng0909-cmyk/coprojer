const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const http = require('node:http')
const { _electron: electron } = require('playwright')

async function main() {
  const output = resolve('output/playwright/model-names')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'profile-'))
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'qwen3.7-flash' }, { id: 'glm-5.3' }] }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1'
  const oldModels = ['legacy', 'same-model'].map(id => ({ id, name: '旧别名-' + id, model: 'glm-5.3', baseUrl, protocol: 'chat', hasKey: false, cipher: '' }))
  const statePath = join(profile, 'engineering-v1.json')
  await fs.writeFile(statePath, JSON.stringify({ version: 1, models: oldModels, agents: [], projects: [], defaultAssistantModelId: 'legacy' }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE
  let desktop, page
  const errors = []
  const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const state = () => invoke('state')
  const launch = async () => {
    desktop = await electron.launch({ args: ['.', '--disable-gpu'], env, timeout: 30000 })
    page = await desktop.firstWindow(); page.setDefaultTimeout(10000)
    page.on('pageerror', e => errors.push(e.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
  }
  const screenshot = async (name, width, height, theme = 'light') => {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.screenshot({ path: join(output, name + '-' + theme + '-' + width + '.png'), animations: 'disabled', scale: 'css' })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page overflow')
    for (const dialog of await page.locator('dialog[open]').all()) {
      assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'dialog overflow')
      const box = await dialog.getByRole('button', { name: '保存模型', exact: true }).boundingBox()
      assert.ok(box && box.y + box.height <= height, 'save must be reachable')
    }
  }
  try {
    await launch()
    const before = await state()
    await page.getByRole('button', { name: '模型连接', exact: true }).click()
    assert.deepEqual(await page.locator('.eng-model-card h3').allTextContents(), ['glm-5.3', 'glm-5.3'])
    assert.equal(await page.locator('.eng-model-card p').count(), 0, 'do not repeat the ID')
    assert.equal(await page.getByText(/旧别名/).count(), 0)
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).models, oldModels, 'do not rewrite legacy connections on load')
    const defaultSelect = page.getByLabel('默认通用助手模型', { exact: true })
    assert.equal(await defaultSelect.locator('option[value="legacy"]').textContent(), 'glm-5.3')

    await page.getByRole('button', { name: '新增模型', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '新增模型', exact: true })
    assert.equal(await dialog.getByLabel('显示名称').count(), 0)
    await dialog.getByLabel('服务地址 Base URL').fill(baseUrl)
    await dialog.getByRole('button', { name: '获取列表', exact: true }).click()
    await dialog.getByText('获取到 2 个模型，可在模型标识中选择。').waitFor()
    await dialog.getByRole('button', { name: '保存模型', exact: true }).click()
    await dialog.getByText('请填写模型标识。', { exact: true }).waitFor()
    await dialog.getByPlaceholder('填写或选择模型 ID').fill('qwen3.7-flash')
    await screenshot('new-model', 1280, 840); await screenshot('new-model', 860, 600)
    await dialog.getByRole('button', { name: '保存模型', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const added = (await state()).models.find(m => m.model === 'qwen3.7-flash')
    assert.equal(added.name, added.model)
    await screenshot('connections', 1280, 840); await screenshot('connections', 860, 600)

    await page.locator('.eng-model-card').first().getByRole('button', { name: '编辑', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '编辑模型', exact: true })
    assert.equal(await dialog.getByLabel('显示名称').count(), 0)
    await screenshot('edit-model', 860, 600)
    // Model IDs already allow 200 characters; removal of aliases must not impose the old 100-character name limit.
    const longId = 'provider/' + 'long-model-'.repeat(12) + '20260927'
    await dialog.getByPlaceholder('填写或选择模型 ID').fill(longId)
    await dialog.getByRole('button', { name: '保存模型', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const after = await state(), edited = after.models.find(m => m.id === 'legacy')
    assert.equal(edited.name, longId); assert.equal(edited.model, longId)
    assert.equal(edited.baseUrl, baseUrl); assert.equal(edited.protocol, 'chat')
    assert.equal(after.defaultAssistantModelId, 'legacy')
    assert.deepEqual(after.agents, before.agents); assert.deepEqual(after.skills, before.skills)
    assert.deepEqual(after.projects, before.projects)
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).models.find(m => m.id === 'same-model'), oldModels[1])
    assert.equal(after.models.length, 3, 'same-name connections must stay separate')
    await screenshot('models', 1280, 840); await screenshot('models', 860, 600); await screenshot('models', 860, 600, 'dark')
    // A source reused with the same model ID remains the same connection.
    assert.equal((await invoke('saveModel', { id: '', model: 'glm-5.3', reuseConnectionId: 'same-model', baseUrl, protocol: 'chat' })).id, 'same-model')

    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.locator('.eng-agent-card').first().getByRole('button', { name: '配置', exact: true }).click()
    const agentDialog = page.getByRole('dialog', { name: '配置智能体', exact: true })
    await agentDialog.getByLabel('智能体名称').fill('我的规划助手')
    assert.equal(await agentDialog.getByLabel('使用模型').locator('option[value="legacy"]').textContent(), longId)
    await agentDialog.getByRole('button', { name: '保存智能体', exact: true }).click()
    await agentDialog.waitFor({ state: 'hidden' }); await page.getByRole('heading', { name: '我的规划助手', exact: true }).waitFor()
    const renamed = (await state()).agents.find(a => a.id === before.agents[0].id)
    assert.deepEqual(renamed, { ...before.agents[0], name: '我的规划助手' })
    await desktop.close(); desktop = null; await launch()
    assert.equal((await state()).models.find(m => m.id === 'legacy').model, longId)
    assert.equal((await state()).agents.find(a => a.id === renamed.id).name, '我的规划助手')
    assert.equal((await state()).defaultAssistantModelId, 'legacy')
    await page.getByRole('button', { name: '模型连接', exact: true }).click()
    assert.equal(await page.getByText(/旧别名/).count(), 0)
    assert.deepEqual(errors, [])
    await fs.writeFile(join(output, 'evidence.json'), JSON.stringify({ profile, checks: ['legacy aliases hidden without migration', 'same-model connections preserved', 'create without name', 'catalog before model selection', 'missing-ID error', 'edit stable binding', 'long model ID', 'agent name still editable', 'restart persistence', '1280x840', '860x600', 'dark'] }, null, 2))
    console.log('PASS: model IDs replace aliases; create/edit/catalog, legacy data, bindings, agent names, restart and both layouts')
  } catch (error) {
    if (page) { await fs.writeFile(join(output, 'failure.txt'), String(error) + '\n' + await page.locator('body').ariaSnapshot()); await page.screenshot({ path: join(output, 'failure.png') }) }
    throw error
  } finally {
    if (desktop) await desktop.close()
    await new Promise(r => server.close(r))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
