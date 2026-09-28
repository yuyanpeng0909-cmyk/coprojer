// Serialized to an isolated Node helper. The stdin pipe is a lifetime lease:
// closing/crashing the owning app terminates only this helper's child tree.
// Do not capture imports or module variables in this function.
export function commandSupervisor(): void {
  const { spawn, spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const { writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
  const config = JSON.parse(process.argv[2])
  const child = spawn(config.executable, config.args, { cwd: config.root, env: process.env,
    detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] })
  let finished = false
  const stop = () => {
    if (finished) return
    finished = true
    if (child.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
    }
    try { rmSync(config.runtime, { recursive: true, force: true, maxRetries: 3 }) } catch (error) { console.error('Isolated directory cleanup failed:', error) }
    process.exit(125)
  }
  process.stdin.resume()
  process.stdin.on('end', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  const timer = setTimeout(stop, config.timeoutMs + 2000)
  child.on('error', (error: Error) => { console.error(error.message); stop() })
  child.on('exit', (code: number | null) => {
    if (finished) return
    finished = true; clearTimeout(timer)
    // Keep the real command exit code even if it closed a test window itself.
    writeFileSync(config.result, JSON.stringify({ code: code ?? -1 }))
    process.exit(code ?? 1)
  })
}
