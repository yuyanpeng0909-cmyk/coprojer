const { fs, path, assert, sandbox, load, fixture, EngineeringService } = require('./fixtures/verification-runtime.cjs')
const { spawn } = require('node:child_process')
const { runCommand } = load('src/main/engineering/files.ts')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(predicate, label) {
  for (let i = 0; i < 120; i++) { if (await predicate()) return; await wait(100) }
  throw Error('Timed out: ' + label)
}
async function main() {
  const ctx = fixture(), file = path.join(ctx.root, '.runtime/test-pid.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(path.join(ctx.root, 'tests/long-test.cjs'), "require('node:fs').writeFileSync('.runtime/test-pid.json',JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)")
  const controller = new AbortController()
  const execution = runCommand(ctx.root, 'node', ['tests/long-test.cjs'], 30, controller.signal, () => {}, true)
  await until(() => fs.existsSync(file), 'test started')
  let pid = JSON.parse(fs.readFileSync(file)).pid
  controller.abort()
  assert.equal((await execution).code, -1)
  await until(() => !alive(pid), 'cancelled test terminated')
  assert.equal(fs.readdirSync(path.join(ctx.root, '.runtime/coprojer-checks')).length, 0)
  console.log('PASS: cancellation kills owned test process and cleans isolated user data')
  fs.unlinkSync(file)
  const helper = path.resolve('scripts/fixtures/verification-runtime.cjs')
  const code = 'const r=require(' + JSON.stringify(helper) + '); const c=r.load("src/main/engineering/files.ts"); c.runCommand(process.argv[1],"node",["tests/long-test.cjs"],30,new AbortController().signal,()=>{},true).finally(()=>r.fs.rmSync(r.sandbox,{recursive:true,force:true}));'
  const host = spawn(process.execPath, ['-e', code, ctx.root], { cwd: path.resolve('.'), stdio: 'ignore', windowsHide: true })
  try {
    await until(() => fs.existsSync(file), 'crash fixture started')
    pid = JSON.parse(fs.readFileSync(file)).pid
    host.kill() // Kill only the owning host, deliberately leave helper alive.
    await until(() => !alive(pid), 'parent-death lease kills test')
    new EngineeringService() // Recovery cleans only registered, no-longer-live runs.
    try { await until(() => { new EngineeringService(); return fs.readdirSync(path.join(ctx.root, '.runtime/coprojer-checks')).length === 0 }, 'orphan user data cleaned') }
    catch (error) { console.error('Remaining run data:', fs.readdirSync(path.join(ctx.root, '.runtime/coprojer-checks'), { recursive: true })); throw error }
    console.log('PASS: abrupt host exit closes lifetime lease and terminates its test process without killing unrelated processes')
  } finally { if (host.exitCode === null) host.kill() }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }))
