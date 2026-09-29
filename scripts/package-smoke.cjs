// Run against an actual packaged executable with a fresh, isolated profile.
const { _electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

async function main() {
  const executablePath = path.resolve(process.argv[2] || 'release/win-unpacked/Coprojer.exe')
  const output = path.resolve('.runtime/package-smoke')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'profile-'))
  const detected = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{device=$_.DeviceName;primary=$_.Primary} }) | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(detected.status, 0, 'Read Windows monitor identities before launching')
  const parsed = JSON.parse(detected.stdout), displays = Array.isArray(parsed) ? parsed : [parsed]
  const primary = displays.find(display => display.primary)
  assert.ok(primary, 'A primary display must be identified')
  // The production executable has no test-only first-window router. The project
  // permits primary fallback when first-show placement on DISPLAY1 is not assured.
  const display = { ...primary, reason: 'Packaged first-show verification uses primary fallback' }
  console.log('TEST_DISPLAY ' + JSON.stringify(display))
  const env = { ...process.env, COPROJER_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_OPTIONS
  let desktop, page, runtime
  const errors = [], checks = []
  async function launch() {
    desktop = await _electron.launch({ executablePath, args: [], env, timeout: 30000 })
    page = await desktop.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await page.getByText('桌面服务已连接', { exact: true }).waitFor()
    await page.getByRole('heading', { name: '项目管理', exact: true }).waitFor()
    runtime = await desktop.evaluate(({ app, BrowserWindow, screen }) => ({
      isPackaged: app.isPackaged, version: app.getVersion(), name: app.getName(),
      appPath: app.getAppPath(), userData: app.getPath('userData'), executable: process.execPath,
      window: BrowserWindow.getAllWindows()[0].getBounds(), primary: screen.getPrimaryDisplay().workArea,
    }))
    assert.equal(runtime.isPackaged, true)
    assert.equal(runtime.name, 'Coprojer')
    assert.equal(runtime.version, require('../package.json').version)
    assert.equal(path.resolve(runtime.userData), profile)
    assert.equal(path.resolve(runtime.executable), executablePath)
    assert.ok(runtime.appPath.endsWith('app.asar'))
    assert.ok(runtime.window.x >= runtime.primary.x && runtime.window.y >= runtime.primary.y)
    assert.ok(runtime.window.x < runtime.primary.x + runtime.primary.width)
    assert.ok(runtime.window.y < runtime.primary.y + runtime.primary.height)
  }
  try {
    await launch()
    const clean = await page.evaluate(async () => {
      const state = await window.desktop.engineering.state()
      return { models: state.models.length, projects: state.projects.length, node: typeof window.require }
    })
    assert.deepEqual(clean, { models: 0, projects: 0, node: 'undefined' })
    checks.push('Actual packaged executable starts from app.asar with no bundled user projects or model credentials')
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await page.screenshot({ path: path.join(output, 'packaged-main-maximized.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '外观与偏好', exact: true }).click()
    await page.getByRole('button', { name: '暗色', exact: true }).click()
    await desktop.close(); desktop = undefined
    await launch()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    checks.push('Preferences persist across a real packaged-process restart in the isolated profile')
    await page.getByRole('button', { name: '外观与偏好', exact: true }).click()
    await page.getByRole('button', { name: '亮色', exact: true }).click()
    assert.deepEqual(errors, [])
    checks.push('Renderer and preload bridge load without uncaught renderer errors')
    const result = { checkedAt: new Date().toISOString(), executablePath, profile, display, runtime, checks, errors }
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    if (desktop) await desktop.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
