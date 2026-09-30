const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(process.env.COPROJER_POMODORO_SOURCE || path.join(__dirname, '../examples/pomodoro'))
const output = path.resolve('.runtime/verification-evidence')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'tray-profile-'))
  await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ phase: 'focus', remainingMs: 5000, running: false, endAt: null, completedFocus: 0, cycleId: 0 }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app
  const errors = []
  try {
    app = await electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: [root, '--user-data-dir=' + profile, '--disable-gpu'], cwd: root, env })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: /▶ (开始|继续)/ }).waitFor()
    const throttled = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.backgroundThrottling)
    assert.equal(throttled, false)
    await app.evaluate(({ Tray }) => {
      const setMenu = Tray.prototype.setContextMenu, setTip = Tray.prototype.setToolTip
      Tray.prototype.setContextMenu = function(menu) { global.__testTrayMenu = menu; return setMenu.call(this, menu) }
      Tray.prototype.setToolTip = function(text) { global.__testTrayTip = text; return setTip.call(this, text) }
    })
    const initial = await page.evaluate(() => window.api.getInit())
    assert.equal(initial.state.remainingMs, 5000)
    await page.evaluate(settings => window.api.setSettings({ ...settings, notificationEnabled: false, soundEnabled: false }), initial.settings)
    await page.reload()
    await page.getByRole('button', { name: /▶ (开始|继续)/ }).click()
    await page.waitForFunction(async () => (await window.api.getInit()).state.running)
    const before = await page.evaluate(() => window.api.getInit())
    assert.equal(before.state.running, true)
    const hidden = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.close(); return { hidden: !w.isVisible(), destroyed: w.isDestroyed() } })
    assert.deepEqual(hidden, { hidden: true, destroyed: false })
    let state
    const deadline = Date.now() + 15000
    do { await delay(100); state = JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')) } while (state.phase !== 'shortBreak' && Date.now() < deadline)
    assert.equal(state.phase, 'shortBreak')
    const delayMs = state.savedAt - before.state.endAt
    assert.ok(delayMs >= 0 && delayMs < 2000, 'short smoke phase transition delay: ' + delayMs)
    await delay(1100)
    const tray = await app.evaluate(() => ({ labels: global.__testTrayMenu.items.map(item => item.label), tooltip: global.__testTrayTip }))
    assert.deepEqual(tray.labels, ['显示主界面', '暂停计时', '退出'])
    assert.match(tray.tooltip, /短休息/)
    await app.evaluate(() => global.__testTrayMenu.items[1].click())
    await delay(500)
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')).running, false)
    await app.evaluate(() => global.__testTrayMenu.items[0].click())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
    const processIds = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid))
    const closed = app.waitForEvent('close')
    await app.evaluate(() => { setTimeout(() => global.__testTrayMenu.items[2].click(), 50) })
    await closed
    app = undefined
    await delay(500)
    const surviving = processIds.filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
    assert.deepEqual(surviving, []); assert.deepEqual(errors, [])
    const evidence = { platform: process.platform, measuredPhaseMs: 5000, phaseTransitionDelayMs: delayMs, hidden, tray, survivingProcesses: surviving, rendererErrors: errors, limitations: ['Short real-time smoke, not a full 25-minute measurement', 'macOS has not been tested', 'Native menu callbacks and tooltip updates checked; OS hover/click appearance not manually inspected'] }
    await fs.writeFile(path.join(output, 'pomodoro-tray.json'), JSON.stringify(evidence, null, 2))
    console.log('PASS: native Windows close/hide, short background phase change, tray pause/show/quit; delay=' + delayMs + 'ms; not 25-minute or macOS acceptance')
  } finally { if (app) await app.close(); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
