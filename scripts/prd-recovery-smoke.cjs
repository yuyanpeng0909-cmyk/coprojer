require('./test-display.cjs').install()
const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { startProvider } = require('./fixtures/engineering-provider.cjs')

async function main() {
  const output = resolve('output/playwright/prd-recovery')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(join(output, 'profile-'))
  const parent = await fs.mkdtemp(join(output, 'projects-'))
  const provider = await startProvider()
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let desktop
  try {
    desktop = await electron.launch({ args: ['.'], env })
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    const { id: modelId } = await invoke('saveModel', { id: '', protocol: 'chat', baseUrl: provider.baseUrl, model: 'fixture', apiKey: '' })
    const pid = await invoke('createProject', { name: 'PRD 恢复回归', parent, brief: '先验收记账界面，再整理需求。', modelId })
    const project = async () => (await invoke('state')).projects.find(p => p.id === pid)
    const idle = async () => {
      for (let i = 0; i < 500; i++) {
        const p = await project()
        if (!p.activity && !p.designActivity) return
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      throw new Error('Project did not settle')
    }
    await invoke('saveFeature', pid, null, { title: '记录收支', module: '账目', description: '保存金额', criteria: ['可新增收支'], scope: 'discussion', dependencies: [], developerId: 'developer', reviewerId: 'reviewer' })
    await invoke('submitPrototypePreferences', pid, '简洁浅色记账界面')
    await idle()
    const prototypeId = (await project()).prototypes[0].id
    // Accepted prototype + failed automatic PRD is the reported real project state.
    provider.control.skipPrdRead = true
    await assert.rejects(invoke('acceptPrototypeAndPreparePrd', pid, prototypeId), /未完整读取已确认原型/)
    await idle()
    assert.equal((await project()).prd.status, 'error')
    await page.getByRole('button', { name: '继续开发 PRD 恢复回归', exact: true }).click()
    await page.getByRole('button', { name: '需求与功能图', exact: true }).click()
    await page.getByRole('button', { name: '确认完整需求', exact: true }).click()
    const spec = page.getByRole('region', { name: '需求与规格审阅' })
    await spec.waitFor()
    assert.equal(await spec.getByRole('button', { name: '确认并保存基线', exact: true }).isDisabled(), true, 'failed PRD must block confirmation before IPC')
    const retry = spec.getByRole('button', { name: '根据已确认原型生成 PRD', exact: true })
    await retry.waitFor()
    provider.control.skipPrdRead = false
    for (const [width, height] of [[1280, 840], [860, 600]]) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
      assert.ok(await retry.isVisible())
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      assert.deepEqual(viewport, { width, height })
      await page.screenshot({ path: join(output, `recovery-${width}.png`), animations: 'disabled', scale: 'css' })
    }
    await retry.click()
    await idle()
    await spec.getByRole('button', { name: '确认并保存基线', exact: true }).waitFor()
    assert.equal((await project()).prd.status, 'review')
    assert.equal((await project()).prototypeBriefs[''].prototypeId, prototypeId)
    await spec.getByRole('button', { name: '确认并保存基线', exact: true }).click()
    await page.getByText('已确认基线', { exact: true }).waitFor()
    assert.equal((await project()).prd.status, 'confirmed')
    assert.deepEqual((await project()).requirementsBaseline.prototypeIds, [prototypeId])
    const display = await desktop.evaluate(() => global.__coprojerTestDisplay)
    assert.ok(display.selection)
    assert.ok(display.windows.every(w => !w.initiallyVisible && w.displayId === display.selection.targetId))
    assert.ok(display.events.every(e => e.displayId === display.selection.targetId))
    await fs.writeFile(join(output, 'display.json'), JSON.stringify(display, null, 2))
    assert.deepEqual(errors, [])
    console.log('PASS: failed PRD recovered inside review, existing prototype preserved, explicit baseline confirmation, both layouts')
  } finally { if (desktop) await desktop.close(); await provider.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
