const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { startResearchProvider } = require('./fixtures/research-provider.cjs')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const output = resolve('output/playwright')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'design-lifecycle-profile-'))
  const parent = await fs.mkdtemp(join(output, 'design-lifecycle-project-'))
  const provider = await startResearchProvider()
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let desktop, page, pid
  const invoke = (method, ...args) => page.evaluate(
    ({ method, args }) => window.desktop.engineering[method](...args), { method, args })
  const project = async () => (await invoke('state')).projects.find((p) => p.id === pid)
  const wait = async (fn) => {
    const until = Date.now() + 15000
    while (Date.now() < until) { if (await fn()) return; await delay(50) }
    throw Error('Design lifecycle condition timed out')
  }
  const launch = async () => {
    desktop = await electron.launch({ args: ['.'], env })
    page = await desktop.firstWindow()
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
  }
  try {
    await launch()
    const model = await invoke('saveModel', {
      id: '', name: 'Lifecycle fixture', baseUrl: provider.baseUrl,
      model: 'designer', protocol: 'chat', apiKey: '',
    })
    pid = await invoke('createProject', { name: 'Design lifecycle', parent, brief: '本地原型测试', modelId: model.id })
    const start = async () => {
      provider.control.holdDesign = true
      await invoke('generatePrototype', pid, '生成完整交互原型', model.id)
      await wait(() => provider.control.waitingDesign.length > 0)
      await wait(async () => (await project()).chat.at(-1).text.length > 0)
    }
    await start()
    await invoke('stopDesign', pid)
    await wait(async () => !(await project()).designActivity)
    let p = await project()
    assert.equal(p.chat.at(-1).status, 'stopped')
    assert.match(p.chat.at(-1).error, /主动停止/)
    assert.equal((p.prototypes || []).length, 0)
    assert.ok((p.chat.at(-1).text.length + (p.chat.at(-1).reasoning || '').length) > 0)
    provider.releaseDesign()
    await start()
    const interrupted = (await project()).chat.at(-1)
    await desktop.close()
    desktop = null
    const disk = JSON.parse(await fs.readFile(join(profile, 'engineering-v1.json'), 'utf8'))
    p = disk.projects.find((p) => p.id === pid)
    const saved = p.chat.find((e) => e.id === interrupted.id)
    assert.equal(saved.status, 'stopped')
    assert.match(saved.error, /应用退出/)
    assert.ok((saved.text.length + (saved.reasoning || '').length) > 0)
    assert.equal(p.designActivity, false)
    provider.releaseDesign()
    await launch()
    assert.match((await project()).chat.at(-1).error, /应用退出/)
    await invoke('generatePrototype', pid, '重新生成完整交互原型', model.id)
    await wait(async () => !(await project()).designActivity)
    p = await project()
    assert.equal(p.chat.at(-1).status, 'complete')
    assert.equal(p.prototypes.length, 1)
    assert.match(p.prototypes[0].html, /<\/html>$/)
    assert.equal(p.chat.find((e) => e.id === interrupted.id).text, saved.text)
    console.log('PASS: explicit stop, quit checkpoint, restart cause, retained partial output, full prototype retry')
  } finally {
    if (desktop) await desktop.close()
    await provider.close()
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
