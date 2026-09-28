const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const sync = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createHash } = require('node:crypto')
async function main() {
  const output = path.resolve('output/playwright/verification-preparation')
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'profile-')), root = await fs.mkdtemp(path.join(output, 'project-'))
  await fs.writeFile(path.join(root, 'value.cjs'), 'exports.sum=(a,b)=>a+b')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'preparation-ui-fixture', scripts: {} }))
  const criterion = '实际加法断言', external = '外部目标设备的桌面输入'
  const feature = { id: 'f', title: '自动准备与独立复验', description: '隔离短时回归', module: '核心', scope: 'current', stage: 'blocked', verificationPending: true,
    criteria: [criterion, external], plan: '补齐测试后独立检查', tasks: [{ id: 't', title: '检查', done: false }], dependencies: [], developerId: 'developer', reviewerId: 'reviewer', revision: 1, repairRound: 0,
    results: [criterion, external].map(criterion => ({ criterion, passed: false, status: 'unverified', evidence: '等待验证条件' })), feedback: '' }
  const project = { id: 'p', name: '验证准备回归', root, brief: '自动准备实际脚本', createdAt: new Date().toISOString(), features: [feature], context: [], chat: [], events: [], changes: [], prototypes: [], agentRuns: [], activity: null, previewUrl: null }
  const held = new Map(), entered = new Set()
  const gate = phase => {
    if (entered.has(phase)) return Promise.resolve()
    entered.add(phase)
    return new Promise(resolve => held.set(phase, resolve))
  }
  const release = phase => { held.get(phase)?.(); held.delete(phase) }
  let actualCalls = 0
  const server = http.createServer(async (req, res) => {
    try {
      let input = ''; for await (const chunk of req) input += chunk
      const body = JSON.parse(input), system = body.messages.find(m => m.role === 'system')?.content || ''
      const history = body.messages.filter(m => m.role === 'tool')
      let text = '', calls = []
      const call = (name, args) => calls.push({ id: 'tool-' + Math.random(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
      if (system.includes('VERIFICATION_DIAGNOSIS')) {
        await gate('diagnosing')
        if (!history.length) call('list_files', {})
        else text = JSON.stringify({ gaps: [
          { criterion, disposition: 'automatic', reason: '项目只有 value.cjs，尚缺真实断言脚本。', nextStep: '创建 tests/verify.cjs，验证真实业务模块。' },
          { criterion: external, disposition: 'external', reason: '本机没有目标设备及桌面输入驱动，回调测试无法提供所需证据。', nextStep: '在目标设备提交对应源码版本的真实桌面交互记录。' },
        ] })
      } else if (system.includes('VERIFICATION_PREPARATION')) {
        await gate('preparing')
        if (!history.length) call('write_file', { path: 'tests/verify.cjs', content: "const assert=require('node:assert/strict'); assert.equal(require('../value.cjs').sum(2,3),5); console.log('UI_REAL_CHECK_PASSED');" })
        else text = JSON.stringify({ status: 'ready', summary: '已生成保留实际断言的检查脚本。', nextStep: '独立验证运行 node tests/verify.cjs。' })
      } else if (system.includes('你是 Coprojer 的开发智能体')) throw Error('Continue verification must not rerun development')
      else {
        const hasScript = sync.existsSync(path.join(root, 'tests/verify.cjs'))
        if (hasScript && !history.length) { await gate('rechecking'); actualCalls++; call('run_command', { program: 'node', args: ['tests/verify.cjs'], evidenceKind: 'unit' }) }
        else {
          const passed = history.some(m => m.content.includes('UI_REAL_CHECK_PASSED'))
          text = JSON.stringify({ summary: '真实断言和外部条件分开', results: [
            { criterion, passed, status: passed ? 'passed' : 'unverified', evidence: passed ? '实际运行 tests/verify.cjs，断言输出 UI_REAL_CHECK_PASSED。' : '缺少项目内检查脚本。', evidenceKind: 'unit', commandIds: passed ? ['check-1'] : [] },
            { criterion: external, passed: false, status: 'unverified', evidence: '缺少目标设备和桌面输入，尚未实测。' },
          ] })
        }
      }
      if (res.destroyed) return
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (text) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
      calls.forEach((call, index) => res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ ...call, index }] } }] }) + '\n\n'))
      res.end('data: [DONE]\n\n')
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await fs.writeFile(path.join(profile, 'engineering-v1.json'), JSON.stringify({ version: 1, projects: [project], agents: [], models: [{ id: 'fixture', name: 'fixture', model: 'fixture', protocol: 'chat', baseUrl: 'http://127.0.0.1:' + server.address().port, cipher: '' }] }))
  const env = { ...process.env, COPROJER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app, page
  const errors = []
  const state = () => page.evaluate(() => window.desktop.engineering.state())
  const current = async () => (await state()).projects[0]
  async function open() {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: path.resolve('.'), env })
    page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.emulateMedia({ reducedMotion: 'reduce' }); page.on('pageerror', e => errors.push(e.message))
    await page.getByRole('button', { name: '继续开发 验证准备回归', exact: true }).click()
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: '独立验证', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: feature.title, exact: true }).click()
  }
  const drawer = () => page.getByRole('dialog', { name: feature.title, exact: true })
  async function capture(name) {
    for (const size of [[1280, 840], [860, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size)
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      const panel = drawer().getByRole('region', { name: '验证条件准备' })
      assert.equal(await panel.locator('pre').count(), 0, 'no internal JSON dumped into main interface')
      await panel.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }))
      const heading = await panel.getByRole('status').boundingBox()
      assert.ok(heading && heading.y >= 0 && heading.y + heading.height <= size[1], 'phase heading stays in the layout screenshot')
      await page.screenshot({ path: path.join(output, name + '-' + size.join('x') + '.png'), animations: 'disabled' })
    }
  }
  try {
    await open()
    await drawer().getByRole('button', { name: '继续验证', exact: true }).click()
    for (const [phase, label] of [['diagnosing', '分析验证缺口'], ['preparing', '准备验证条件'], ['rechecking', '重新独立验证']]) {
      await drawer().getByRole('status').filter({ hasText: label }).waitFor()
      await capture(phase)
      release(phase)
    }
    await drawer().getByRole('status').filter({ hasText: '待补验证' }).waitFor()
    await drawer().getByRole('tab', { name: '验收', exact: true }).click()
    await drawer().locator('.eng-results .passed').waitFor()
    assert.match(await drawer().locator('.eng-results .unverified').innerText(), /外部目标设备/)
    assert.equal(await drawer().getByRole('button', { name: '验收通过', exact: true }).count(), 0)
    assert.equal((await current()).features[0].repairRound, 0)
    assert.equal((await current()).features[0].verificationPreparation.round, 1)
    assert.equal(actualCalls, 1)
    await capture('remaining')
    await drawer().getByText('已完成的准备与实际结果', { exact: true }).click()
    await drawer().getByText('新增检查资料：tests/verify.cjs', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: feature.title, exact: true }).click()
    await page.screenshot({ path: path.join(output, 'remaining-dark-860.png'), animations: 'disabled' })
    await app.close(); app = null
    await open()
    await drawer().getByRole('status').filter({ hasText: '待补验证' }).waitFor()
    await drawer().getByRole('button', { name: '继续验证', exact: true }).click()
    for (let i = 0; i < 150 && (await current()).activity; i++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await current()).activity, null)
    assert.equal((await current()).features[0].verificationPreparation.round, 1)
    assert.equal(actualCalls, 2, 'restart requires real independent re-execution')
    assert.deepEqual(errors, [])
    const fingerprintFiles = ['src/main/engineering/service.ts', 'src/main/engineering/files.ts', 'src/main/engineering/execution.ts', 'src/main/engineering/verification.ts', 'src/main/engineering/command-supervisor.ts', 'src/renderer/src/engineering/VerificationProgress.tsx', 'out/main/index.js', 'out/renderer/index.html']
    const fingerprints = Object.fromEntries(fingerprintFiles.map(file => [file, createHash('sha256').update(sync.readFileSync(file)).digest('hex')]))
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify({ date: new Date().toISOString(), actualChecks: actualCalls, layouts: ['1280x840', '860x600'], fixture: 'local deterministic model; real Electron UI and Node command', stages: ['diagnosing', 'preparing', 'rechecking', 'blocked'], fingerprints, checks: (await current()).features[0].verificationChecks, errors }, null, 2))
    console.log('PASS: real Electron stages, automatically generated/executed script, external blocker, restart, dark theme, keyboard and two layouts')
  } finally {
    for (const phase of held.keys()) release(phase)
    if (app) await app.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 }); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
