// Opt-in real-provider integration: only a copied project/profile is executed.
// No credential is printed, no acceptance is submitted, original sources stay unchanged.
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright'), assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '..')
const source = path.resolve(process.env.COPROJER_POMODORO_SOURCE || path.join(repo, 'examples/pomodoro'))
const output = path.join(repo, '.runtime/pomodoro-live-verification')
async function fingerprints(root) {
  const result = {}
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.runtime', 'dist', '.coprojer'].includes(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else result[path.relative(root, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex')
    }
  }
  await walk(root); return result
}
async function main() {
  const captureOnly = process.argv.includes('--capture')
  assert.ok(process.argv.includes('--live') || captureOnly, 'Real-provider run requires explicit --live')
  await fs.mkdir(output, { recursive: true })
  const resumeArg = process.argv.indexOf('--resume'), resumed = resumeArg >= 0
  assert.ok(!captureOnly || resumed, 'capture uses an existing isolated result')
  const run = resumed ? path.resolve(process.argv[resumeArg + 1] || '') : await fs.mkdtemp(path.join(output, 'run-'))
  assert.ok(path.dirname(run) === output && path.basename(run).startsWith('run-'), 'resume only an isolated live run')
  const root = path.join(run, 'project'), profile = path.join(run, 'profile')
  if (!resumed) { await fs.mkdir(root); await fs.mkdir(profile) }
  const realRun = await fs.realpath(run)
  assert.equal(path.dirname(realRun), await fs.realpath(output), 'run must not redirect outside the isolated output')
  assert.equal(await fs.realpath(root), path.join(realRun, 'project'), 'project must not redirect to user files')
  assert.equal(await fs.realpath(profile), path.join(realRun, 'profile'), 'profile must not redirect to user data')
  // Chromium's encrypted key material is profile-scoped. Preserve the user's
  // encrypted Local State in the isolated profile; never decrypt or log keys.
  const localState = path.join(process.env.APPDATA, 'Coprojer-dev/Local State')
  if (!captureOnly && sync.existsSync(localState)) await fs.copyFile(localState, path.join(profile, 'Local State'))
  const original = await fingerprints(source)
  if (!resumed) {
    const copied = spawnSync('robocopy', [source, root, '/E', '/XD', '.coprojer', '.runtime', '.git', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, encoding: 'utf8' })
    assert.ok(copied.status < 8, 'copy project including isolated dependencies: ' + copied.stderr)
  }
  const originalData = JSON.parse(await fs.readFile(path.join(process.env.APPDATA, 'Coprojer-dev/engineering-v1.json'), 'utf8'))
  const data = resumed ? JSON.parse(await fs.readFile(path.join(profile, 'engineering-v1.json'), 'utf8')) : originalData
  const project = data.projects.find(p => path.resolve(p.root) === (resumed ? root : source))
  assert.ok(project, 'existing Pomodoro project')
  const previousResult = resumed && sync.existsSync(path.join(run, 'result.json'))
    ? JSON.parse(await fs.readFile(path.join(run, 'result.json'), 'utf8')) : null
  const recordedFeature = previousResult && project.features.find(f => previousResult.featureId
    ? f.id === previousResult.featureId
    : f.criteria.length > 0 && f.criteria.length === previousResult.results?.length &&
      f.criteria.every(criterion => previousResult.results.some(r => r.criterion === criterion)))
  assert.ok(!captureOnly || recordedFeature, 'capture the exact previously tested feature, not another blocked feature')
  const feature = recordedFeature || project.features.find(f => f.stage === 'blocked' && f.verificationPending)
  assert.ok(feature, 'pending verification feature')
  if (previousResult?.originalSource) assert.deepEqual(original, previousResult.originalSource, 'original sources still match the real-run baseline')
  assert.ok(!project.activity, 'resume only after the isolated run has stopped')
  if (!resumed) {
    project.root = root; project.previewUrl = null
    data.projects = [project]; data.executionCheckpoints = {}; data.assistant = undefined; data.assistantChat = []; data.skillSearches = {}
  } else if (!captureOnly) {
    for (const m of data.models) m.cipher = originalData.models.find(original => original.id === m.id)?.cipher || ''
    if (sync.existsSync(path.join(run, 'result.json'))) await fs.copyFile(path.join(run, 'result.json'), path.join(run, 'result-before-resume-' + Date.now() + '.json'))
  }
  // A policy/UI review gets its own redacted profile. It must not mutate the
  // original real-run checkpoint or need a copy of Chromium encryption keys.
  const runtimeProfile = captureOnly ? await fs.mkdtemp(path.join(run, 'capture-profile-')) : profile
  if (captureOnly) data.models = data.models.map(({ cipher, ...m }) => ({ ...m, cipher: '' }))
  await fs.writeFile(path.join(runtimeProfile, 'engineering-v1.json'), JSON.stringify(data))
  const initialEvents = new Set(project.events.map(e => e.id)), errors = []
  const env = { ...process.env, COPROJER_USER_DATA: runtimeProfile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  let app, page
  try {
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: repo, env })
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message))
    await app.evaluate(() => {
      const originalFetch = globalThis.fetch; globalThis.__liveRequests = []
      globalThis.fetch = async (url, init) => {
        let body; try { body = JSON.parse(init?.body) } catch {}
        if (body?.model) globalThis.__liveRequests.push({ at: new Date().toISOString(), model: body.model,
          tools: (body.tools || []).map(t => t.function?.name || t.name), bytes: String(init.body).length,
          phase: JSON.stringify(body.messages?.filter(m => m.role === 'system') || body.instructions || '').includes('VERIFICATION_DIAGNOSIS') ? 'diagnoser' : JSON.stringify(body).includes('VERIFICATION_PREPARATION') ? 'preparer' : 'reviewer' })
        return originalFetch(url, init)
      }
    })
    const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.desktop.engineering[method](...args), { method, args })
    await page.getByRole('button', { name: '继续开发 ' + project.name, exact: true }).click()
    if (!captureOnly) await invoke('runFeature', project.id, feature.id, true)
    const printed = new Set(initialEvents), deadline = Date.now() + 15 * 60_000
    let timedOut = false
    let current
    do {
      await new Promise(r => setTimeout(r, 1500))
      current = (await invoke('state')).projects.find(p => p.id === project.id)
      for (const event of current.events.filter(e => !printed.has(e.id))) {
        printed.add(event.id)
        if (['model', 'tool', 'verification', 'verification-diagnosis', 'verification-preparation', 'verification-blocked', 'acceptance', 'error', 'stopped'].includes(event.kind))
          console.log(event.at + ' ' + event.kind + ': ' + event.message.slice(0, 220))
      }
      if (Date.now() > deadline && current.activity && !timedOut) { timedOut = true; await invoke('stop', project.id) }
    } while (current.activity)
    const result = current.features.find(f => f.id === feature.id)
    const requests = await app.evaluate(() => globalThis.__liveRequests)
    if (captureOnly) {
      assert.equal(requests.length, 0, 'policy review must not call a model')
      assert.deepEqual(result.verificationChecks, feature.verificationChecks, 'policy review must not rerun or replace real commands')
    }
    const resultFile = captureOnly ? 'result-policy-reviewed.json' : 'result.json'
    await fs.writeFile(path.join(run, resultFile), JSON.stringify({ date: new Date().toISOString(), originalRoot: source, testedRoot: root, captureOnly,
      projectId: project.id, featureId: feature.id,
      stage: result.stage, repairRound: result.repairRound, resumed, timedOut, results: result.results, preparation: result.verificationPreparation,
      commands: result.verificationChecks, feedback: result.feedback, requests, errors,
      events: current.events.filter(e => !initialEvents.has(e.id)), originalSource: original, originalUnchanged: JSON.stringify(original) === JSON.stringify(await fingerprints(source)) }, null, 2))
    await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify({ run, result: path.join(run, resultFile) }))
    if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await page.locator('.sidebar-lifecycle').getByRole('button', { name: result.stage === 'acceptance' ? '成果验收' : '独立验证', exact: true }).click()
    await page.locator('.delivery-table').getByRole('button', { name: feature.title, exact: true }).click()
    await page.getByRole('dialog').getByRole('tab', { name: '验收', exact: true }).click()
    if (result.verificationChecks?.some(c => c.code !== 0) && !result.verificationPending && result.verificationPreparation?.phase === 'blocked')
      assert.ok(await page.getByRole('dialog').getByText('实际检查未通过：', { exact: false }).isVisible(), 'actual failure is visible above missing conditions')
    await page.screenshot({ path: path.join(run, 'result-maximized.png') })
    const layouts = []
    for (const size of [[1280, 840], [860, 600]]) {
      await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setContentSize(...size) }, size)
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow')
      await page.screenshot({ path: path.join(run, 'result-' + size.join('x') + '.png') })
      layouts.push({ width: size[0], height: size[1], horizontalOverflow: false })
    }
    assert.deepEqual(await fingerprints(source), original, 'original target project remains unchanged')
    assert.equal(result.repairRound, feature.repairRound, 'no business repair requested')
    assert.deepEqual(errors, [])
    await fs.writeFile(path.join(run, 'ui-result.json'), JSON.stringify({ date: new Date().toISOString(), captureOnly,
      featureId: feature.id, stage: result.stage, requests: requests.length, layouts, errors, originalUnchanged: true }, null, 2))
    console.log(JSON.stringify({ run, stage: result.stage, statuses: result.results.map(r => ({ criterion: r.criterion, status: r.status })), requests: requests.length, originalUnchanged: true }))
    if (!captureOnly) assert.equal(result.stage, 'acceptance', 'all required independent verification must pass before final human acceptance')
  } finally {
    if (app) await app.close()
    // The persistent proof is redacted; remove the copied encrypted credentials.
    const file = path.join(runtimeProfile, 'engineering-v1.json')
    if (sync.existsSync(file)) { const saved = JSON.parse(await fs.readFile(file, 'utf8')); saved.models = saved.models.map(({ cipher, ...m }) => ({ ...m, cipher: '' })); await fs.writeFile(file, JSON.stringify(saved)) }
    if (!captureOnly) await fs.rm(path.join(profile, 'Local State'), { force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
