const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { randomUUID } = require('node:crypto')
const assert = require('node:assert/strict')
// Windows-only isolated integration regression. Other platforms are skipped,
// not reported as passing this native Job Object lifecycle coverage.
if (process.platform !== 'win32') {
  console.log('SKIP: preview lifecycle integration requires Windows')
  process.exit(0)
}
// The outer process bounds cleanup even if a
// synchronous stop or inherited pipe prevents the service host from settling.
const mode = process.argv[2] || 'all'
const evidence = path.resolve('.runtime/preview-lifecycle')
fs.mkdirSync(evidence, { recursive: true })
const reportPath = path.join(evidence, 'preview-lifecycle-' + mode + '-' + Date.now() + '.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } }
const errorData = e => e ? { name: e.name, message: e.message, code: e.code } : null
async function requestUrl(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(450) }); return { reachable: true, status: response.status, body: await response.json() } }
  catch (error) { return { reachable: false, error: errorData(error) } }
}
function npmAncestor(listenerPid, ownerPid) {
  // Do not inspect command lines, environments, or unrelated process data.
  // Return only the ancestry of the nonce-confirmed listener, ending at the
  // ChildProcess created by this fixture's actual preview startup.
  const source = String.raw`
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class PreviewParents {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Entry { public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h,ref Entry e);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr h,ref Entry e);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static string[] Chain(uint pid,uint owner) { var all=new Dictionary<uint,Entry>(); var h=CreateToolhelp32Snapshot(2,0); if(h==new IntPtr(-1)) throw new Exception("snapshot failed"); try { var e=new Entry();e.size=(uint)Marshal.SizeOf(e);if(Process32FirstW(h,ref e))do{all[e.pid]=e;}while(Process32NextW(h,ref e)); }finally{CloseHandle(h);}var result=new List<string>(); for(int i=0;i<8;i++){Entry e;if(!all.TryGetValue(pid,out e))throw new Exception("owned ancestor missing");result.Add(e.pid+"|"+e.parent+"|"+e.name);if(e.pid==owner)return result.ToArray();pid=e.parent;}throw new Exception("owned ancestor bound exceeded"); }
}`
  const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n" + source + "\n'@; [PreviewParents]::Chain(" + listenerPid + ',' + ownerPid + ')'
  const result = cp.spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 6000 })
  assert.equal(result.status, 0, 'read only the owned preview ancestry: ' + (result.error?.message || result.stderr))
  const chain = result.stdout.trim().split(/\r?\n/).map(line => { const [pid, parent, name] = line.split('|'); return { pid: Number(pid), parent: Number(parent), name } })
  assert.equal(chain[0].pid, listenerPid)
  assert.match(chain[1].name, /^cmd\.exe$/i, 'fixture npm script uses the Windows command shell')
  assert.match(chain[2].name, /^node\.exe$/i, 'the command shell is owned by the real npm Node process')
  assert.equal(chain.at(-1).pid, ownerPid)
  return { pid: chain[2].pid, chain }
}

if (mode === 'all') {
  ;(async () => {
    for (const item of ['normal', 'root-exit', 'restart', 'dispose', 'ready-cancel', 'owner-exit']) {
      const child = cp.spawn(process.execPath, [__filename, item], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit' })
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      assert.equal(code, 0, item + ' lifecycle regression failed; cleanup is not a passing assertion')
      console.log('PASS: preview lifecycle ' + item)
    }
  })().catch(error => { console.error(error); process.exitCode = 1 })
} else if (!process.argv.includes('--worker')) {
  if (!['normal', 'root-exit', 'restart', 'dispose', 'ready-cancel', 'owner-exit'].includes(mode)) throw new Error('Unknown regression mode')
  if (fs.existsSync(reportPath)) throw new Error('Refusing to overwrite evidence: ' + reportPath)
  const report = { startedAt: new Date().toISOString(), mode, purpose: 'Real isolated preview lifecycle regression; cleanup never establishes success', events: [], guardFired: false }
  const owned = new Set()
  let ownerExitReady, ownerExitValidation = Promise.resolve()
  const child = cp.spawn(process.execPath, [__filename, mode, '--worker'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.on('message', message => {
    report.events.push(message)
    if (message.kind === 'owned-root' || message.kind === 'owned-listener') owned.add(message.pid)
    if (message.kind === 'root-exit' || message.kind === 'listener-stopped') owned.delete(message.pid)
    if (message.kind === 'result') report.result = message.value
    if (message.kind === 'owner-exit-ready') ownerExitReady = message
    save()
  })
  const timer = setTimeout(() => {
    report.guardFired = true
    report.guardCleanup = []
    for (const pid of [...owned, child.pid]) {
      if (!pid || !alive(pid)) continue
      const result = cp.spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, encoding: 'utf8', timeout: 2500 })
      report.guardCleanup.push({ pid, status: result.status, error: errorData(result.error) })
    }
    save()
  }, 20000)
  child.on('error', error => { report.workerError = errorData(error); save() })
  child.on('exit', () => {
    if (mode !== 'owner-exit') return
    ownerExitValidation = (async () => {
      if (!ownerExitReady) { report.ownerExitFailure = 'host exited before ownership was established'; return }
      const { listener, url } = ownerExitReady
      let http, end = Date.now() + 3000
      do { http = await requestUrl(url); if (!http.reachable && !alive(listener.pid)) break; await sleep(40) } while (Date.now() < end)
      report.ownerExit = { listenerAlive: alive(listener.pid), http }
      if (report.ownerExit.listenerAlive || http.reachable) {
        report.ownerExitFailure = 'owner exit must stop the real listener and HTTP origin before cleanup'
        if (http.body?.nonce === listener.nonce && http.body?.pid === listener.pid) {
          process.kill(listener.pid); report.ownerExitCleanup = { pid: listener.pid, nonceRechecked: true }
        }
      }
      save()
    })().catch(error => { report.ownerExitFailure = error.stack; save() })
  })
  child.on('close', async (code, signal) => {
    await ownerExitValidation
    clearTimeout(timer); report.workerCode = code; report.workerSignal = signal; report.endedAt = new Date().toISOString(); save()
    console.log(JSON.stringify({ reportPath, workerCode: code, guardFired: report.guardFired, result: report.result }))
    process.exitCode = report.guardFired || report.ownerExitFailure || code ? 1 : 0
  })
} else {
  const report = { mode, startedAt: new Date().toISOString(), node: process.version, taskkills: [], events: [], cleanup: [] }
  const send = (kind, data = {}) => { const event = { kind, at: new Date().toISOString(), ...data }; report.events.push(event); process.send?.(event) }
  const originalSpawn = cp.spawn, originalSpawnSync = cp.spawnSync
  const originalFetch = global.fetch
  let rootChild, listener, ctx, url, rootExited = false, rootClosed = false, cleanupPhase = false
  let pendingStart, startOutcome, releaseReadyResponse, readyTimer
  cp.spawn = function (...args) {
    const child = originalSpawn.apply(this, args)
    if (ctx && args[2]?.cwd === ctx.root && args[1]?.some(value => /npm-cli\.js$/.test(value))) {
      rootChild = child
      rootExited = false; rootClosed = false
      send('owned-root', { pid: child.pid, executable: args[0], args: args[1] })
      child.once('exit', (code, signal) => { rootExited = true; send('root-exit', { pid: child.pid, code, signal }) })
      child.once('close', (code, signal) => { rootClosed = true; send('root-close', { pid: child.pid, code, signal }) })
    }
    return child
  }
  cp.spawnSync = function (...args) {
    if (!/^taskkill(?:\.exe)?$/i.test(args[0])) return originalSpawnSync.apply(this, args)
    const at = new Date().toISOString(), started = Date.now()
    send('taskkill-start', { args: args[1], cleanupPhase })
    const result = originalSpawnSync.apply(this, args)
    const entry = { at, args: args[1], cleanupPhase, elapsedMs: Date.now() - started, status: result.status, signal: result.signal, error: errorData(result.error), originalStdio: args[2]?.stdio }
    report.taskkills.push(entry); send('taskkill-result', entry)
    return result
  }
  async function request() {
    return requestUrl(url)
  }
  ;(async () => {
    try {
      const runtime = require(path.resolve('scripts/fixtures/verification-runtime.cjs'))
      ctx = runtime.fixture(); report.sandbox = runtime.sandbox; report.projectRoot = ctx.root
      const nonce = randomUUID()
      fs.writeFileSync(path.join(ctx.root, 'package.json'), JSON.stringify({ name: 'preview-lifecycle-owned-fixture', private: true, scripts: { dev: 'node server.cjs' } }))
      fs.writeFileSync(path.join(ctx.root, 'server.cjs'), `const http=require('node:http'),fs=require('node:fs');const args=process.argv.slice(2);const own={nonce:${JSON.stringify(nonce)},pid:process.pid,ppid:process.ppid,port:Number(args[3])};fs.writeFileSync('listener.json',JSON.stringify(own));http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(own))}).listen(own.port,args[1]);setTimeout(()=>{fs.writeFileSync('listener-guard-fired.json',JSON.stringify({at:new Date().toISOString()}));process.exit(124)},14000);`)
      if (mode === 'ready-cancel') {
        let observedReady, responseHeld = false
        const ready = new Promise(resolve => { observedReady = resolve })
        const hold = new Promise(resolve => { releaseReadyResponse = resolve })
        global.fetch = async function (...args) {
          const response = await originalFetch.apply(this, args)
          if (!responseHeld && String(args[0]) === 'http://127.0.0.1:' + ctx.project.previewPort && response.ok) {
            responseHeld = true; url = String(args[0])
            report.heldReadyResponse = { at: new Date().toISOString(), status: response.status, signalWasPassedUnchanged: true }
            observedReady()
            await hold
          }
          return response
        }
        pendingStart = ctx.service.startPreview(ctx.project.id, 'dev').then(
          value => { startOutcome = { status: 'fulfilled', value } },
          error => { startOutcome = { status: 'rejected', error: errorData(error) } },
        )
        await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('No actual readiness response within 10 seconds')), 10000) })])
        clearTimeout(readyTimer)
        assert.equal(startOutcome, undefined, 'startup remains pending while its real readiness response is held')
      } else url = await ctx.service.startPreview(ctx.project.id, 'dev')
      if (!rootChild) throw new Error('Actual npm root was not observed')
      listener = JSON.parse(fs.readFileSync(path.join(ctx.root, 'listener.json'), 'utf8'))
      if (listener.nonce !== nonce || !Number.isSafeInteger(listener.pid)) throw new Error('Listener ownership mismatch')
      send('owned-listener', listener)
      report.beforeStop = { url, rootPid: rootChild.pid, rootExited, rootClosed, rootAlive: alive(rootChild.pid), listenerAlive: alive(listener.pid), http: await request() }
      if (report.beforeStop.http.body?.nonce !== nonce) throw new Error('HTTP ownership mismatch')
      if (mode === 'owner-exit') {
        // Deliberately skip service.dispose(): this is the application-owner
        // lifetime boundary, not ordinary manual stop or test finally cleanup.
        process.send({ kind: 'owner-exit-ready', at: new Date().toISOString(), listener, url }, () => process.exit(0))
        return await new Promise(() => {})
      }
      if (mode === 'root-exit') {
        report.controlledFault = 'Terminate only the confirmed npm root before stopPreview; this is not attribution of the original failure'
        report.npmRoot = npmAncestor(listener.pid, rootChild.pid)
        process.kill(report.npmRoot.pid)
        const end = Date.now() + 1500
        while (alive(report.npmRoot.pid) && Date.now() < end) await sleep(25)
        report.afterControlledRootExit = { npmAlive: alive(report.npmRoot.pid), rootExited, rootClosed, rootAlive: alive(rootChild.pid), listenerAlive: alive(listener.pid), http: await request() }
        assert.equal(report.afterControlledRootExit.npmAlive, false, 'the controlled npm root really exits before stopPreview')
      }
      send(mode === 'dispose' ? 'dispose-call' : 'stop-preview-call')
      if (mode === 'dispose') await ctx.service.dispose()
      else await ctx.service.stopPreview(ctx.project.id)
      send(mode === 'dispose' ? 'dispose-return' : 'stop-preview-return')
      if (mode === 'ready-cancel') {
        assert.equal(startOutcome, undefined, 'stop completes while the original startup response is still held')
        assert.equal(ctx.project.previewUrl, null)
        report.releasedReadyResponseAt = new Date().toISOString()
        releaseReadyResponse()
        await pendingStart
        report.startOutcome = startOutcome
        assert.equal(startOutcome.status, 'rejected', 'a cancelled startup must reject even when its held real response was HTTP 200')
      }
      let http, end = Date.now() + 2000
      do { http = await request(); if (!http.reachable && !alive(listener.pid) && rootClosed) break; await sleep(40) } while (Date.now() < end)
      report.afterStop = { rootExited, rootClosed, rootAlive: alive(rootChild.pid), listenerAlive: alive(listener.pid), http, previewUrl: ctx.project.previewUrl }
      report.stopped = !report.afterStop.listenerAlive && !http.reachable && rootClosed
      if (report.stopped) send('listener-stopped', { pid: listener.pid })
      assert.equal(report.afterStop.listenerAlive, false, 'the real preview listener stops before cleanup')
      assert.equal(http.reachable, false, 'the same preview URL stops serving before cleanup')
      assert.equal(rootClosed, true, 'the original root releases inherited stdout/stderr before cleanup')
      if (mode !== 'dispose') assert.equal(ctx.project.previewUrl, null)
      if (mode === 'restart') {
        const firstUrl = url, firstPid = listener.pid
        url = await ctx.service.startPreview(ctx.project.id, 'dev')
        listener = JSON.parse(fs.readFileSync(path.join(ctx.root, 'listener.json'), 'utf8'))
        assert.equal(listener.nonce, nonce)
        send('owned-listener', listener)
        const response = await request()
        report.restart = { firstUrl, url, firstPid, listener, http: response }
        assert.equal(url, firstUrl, 'restart retains the exact origin')
        assert.equal(response.body?.nonce, nonce, 'restarted response belongs to this fixture')
        assert.equal(response.body?.pid, listener.pid, 'restarted response comes from the newly observed listener')
        await ctx.service.stopPreview(ctx.project.id)
        end = Date.now() + 2000
        do { http = await request(); if (!http.reachable && !alive(listener.pid) && rootClosed) break; await sleep(40) } while (Date.now() < end)
        report.restart.afterStop = { listenerAlive: alive(listener.pid), rootClosed, http }
        assert.equal(alive(listener.pid), false, 'restarted listener also stops before cleanup')
        assert.equal(http.reachable, false)
        assert.equal(rootClosed, true)
        send('listener-stopped', { pid: listener.pid })
      }
    } catch (error) { report.failure = error.stack; process.exitCode = 1 }
    finally {
      cleanupPhase = true
      clearTimeout(readyTimer)
      releaseReadyResponse?.()
      global.fetch = originalFetch
      // Every cleanup PID was observed from this exact fixture; cleanup is never a passing assertion.
      if (rootChild && !rootExited && alive(rootChild.pid)) {
        const result = cp.spawnSync('taskkill', ['/pid', String(rootChild.pid), '/t', '/f'], { windowsHide: true, timeout: 2500, encoding: 'utf8' })
        report.cleanup.push({ kind: 'owned-root-tree', pid: rootChild.pid, status: result.status, error: errorData(result.error) })
      }
      if (listener && alive(listener.pid)) {
        const evidence = await request()
        if (evidence.body?.nonce === listener.nonce && evidence.body?.pid === listener.pid) {
          process.kill(listener.pid); report.cleanup.push({ kind: 'nonce-confirmed-owned-listener', pid: listener.pid })
        } else { report.cleanup.push({ kind: 'ownership-recheck-failed-await-listener-self-guard', pid: listener.pid }); process.exitCode = 1 }
      }
      const end = Date.now() + 2000
      while (rootChild && !rootClosed && Date.now() < end) await sleep(25)
      if (listener && !alive(listener.pid)) send('listener-stopped', { pid: listener.pid })
      if (ctx) {
        report.listenerGuardFired = fs.existsSync(path.join(ctx.root, 'listener-guard-fired.json'))
        ctx.service.dispose()
      }
      cp.spawn = originalSpawn; cp.spawnSync = originalSpawnSync
      report.endedAt = new Date().toISOString()
      if (!report.stopped || report.listenerGuardFired || report.cleanup.length) process.exitCode = 1
      process.send?.({ kind: 'result', at: new Date().toISOString(), value: report })
      process.disconnect?.()
    }
  })()
}
