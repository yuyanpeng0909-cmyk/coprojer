const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
async function main() {
  const output = path.resolve('output/playwright/verification-evidence')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'profile-'))
  const feature = { id: 'f', title: '托盘验证待补充', description: '保持已确认标准', module: '主界面', scope: 'current', stage: 'blocked', verificationPending: true, criteria: ['关闭窗口继续运行', 'macOS 托盘实测'], plan: '实现托盘并验证', tasks: [{ id: 't', title: '实现托盘', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0, results: [{ criterion: '关闭窗口继续运行', passed: true, status: 'passed', evidence: '隔离测试已有证据' }, { criterion: 'macOS 托盘实测', passed: false, status: 'unverified', evidence: '需在 macOS 实机检查托盘并提交记录' }], feedback: '等待 macOS 实机证据，未通过验收。' }
  const legacy = { ...feature, id: 'old', title: '历史暂停功能', verificationPending: false }
  const project = { id: 'p', name: '验证缺口回归', root: profile, brief: '保留未验证状态', createdAt: new Date().toISOString(), features: [feature, legacy], context: [], chat: [], events: [], changes: [], prototypes: [], activity: null, previewUrl: null }
  await fs.writeFile(path.join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, models: [], agents: [], projects: [project] }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app
  const errors = []
  try {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: path.resolve('.'), env })
    const page = await app.firstWindow(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '继续开发 验证缺口回归', exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '独立验证', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: legacy.title, exact: true }).click()
    await page.getByRole('dialog', { name: legacy.title, exact: true }).getByRole('button', { name: '仅重新验证', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.delivery-table').getByRole('button', { name: feature.title, exact: true }).click()
    const drawer = page.getByRole('dialog', { name: feature.title, exact: true })
    await drawer.getByRole('tab', { name: '验收', exact: true }).click()
    for (const size of [[1280, 840], [860, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size)
      await drawer.getByRole('button', { name: '继续验证', exact: true }).waitFor()
      assert.match(await drawer.locator('.eng-results .unverified').innerText(), /待补验证.*macOS/)
      assert.match(await drawer.locator('.eng-results > .eng-hint').innerText(), /不重复开发/)
      assert.equal(await drawer.getByRole('button', { name: '验收通过', exact: true }).count(), 0)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(output, 'pending-' + size.join('x') + '.png'), animations: 'disabled' })
    }
    assert.deepEqual(errors, [])
    console.log('PASS: pending evidence labels, continue-review action, acceptance gate and both Electron layouts')
  } finally { if (app) await app.close(); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
