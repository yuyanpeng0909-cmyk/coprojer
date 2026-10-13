// Serialized to an isolated Node helper. The stdin pipe is a lifetime lease:
// closing/crashing the owning app terminates only this helper's child tree.
// Do not capture imports or module variables in this function.
declare const commandResources: typeof import('./command-resources').commandResources
export function commandSupervisor(): void {
  const { spawn, spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const { writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
  const config = JSON.parse(process.argv[2])
  if (config.durable) {
    const fs = require('node:fs') as typeof import('node:fs'), path = require('node:path') as typeof import('node:path')
    const { StringDecoder } = require('node:string_decoder') as typeof import('node:string_decoder')
    const hash = (value: string | Buffer) => require('node:crypto').createHash('sha256').update(value).digest('hex') as string
    const started = process.hrtime.bigint(), at = new Date().toISOString(), directory = config.durable.directory
    const save = (name: string, value: unknown) => {
      const target = path.join(directory, name), temp = target + '.tmp'
      fs.writeFileSync(temp, JSON.stringify({ ...(value as object), integrity: hash(JSON.stringify(value)) }), { mode: 0o600 }); const fd = fs.openSync(temp, 'r+')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }; fs.renameSync(temp, target)
    }
    const identity = { version: 1, runId: config.durable.runId, nonce: config.durable.nonce, root: config.root, supervisorPid: process.pid, startedAt: at }
    let output = '', bytes = 0, totalBytes = 0, complete = true, reason = '', finished = false, closed = false, pending = '', stopConfirmed = false
    let secrets: string[] = [], outputFailure = ''
    const redact = (value: string) => { for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]'); return value.replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]') }
    let child: import('node:child_process').ChildProcessWithoutNullStreams
    let timer: ReturnType<typeof setTimeout>, stopTimer: ReturnType<typeof setTimeout> | undefined
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
    process.stdout.on('error', () => {}); process.stderr.on('error', () => {})
    const finish = (code: number | null, stoppedConfirmed: boolean) => {
      if (finished) return
      finished = true; clearTimeout(timer); clearTimeout(stopTimer)
      pending += stdout.end() + stderr.end(); flush(true)
      if (outputFailure) { stoppedConfirmed = false; reason ||= outputFailure }
      let resources: ReturnType<typeof commandResources> | undefined
      try { resources = commandResources(config.root)
        for (const key of Object.keys(resources.texts)) resources.texts[key] = redact(resources.texts[key])
        for (const key of Object.keys(resources.protected)) resources.protected[key] = redact(resources.protected[key])
        if (Buffer.byteLength(JSON.stringify(resources)) > 8_000_000) throw new Error('效果快照超过8MB保存上限。')
      }
      catch (error) { stoppedConfirmed = false; reason += ' 文件效果快照未完成：' + String(error) }
      try { save('result.json', { ...identity, childPid: child?.pid, finishedAt: new Date().toISOString(), durationMs: Math.ceil(Number(process.hrtime.bigint() - started) / 1e6),
        status: !stoppedConfirmed ? 'uncertain' : reason ? 'cancelled' : code === 0 ? 'completed' : 'failed', code: reason || !stoppedConfirmed ? -1 : code ?? -1,
        output, reason: redact(reason), stoppedConfirmed, resources, rawOutput: { file: 'output.log', bytes, totalBytes, complete, sha256: hash(fs.readFileSync(path.join(directory, 'output.log'))) } }) }
      catch (error) { process.stderr.write('Durable result save failed: ' + String(error)); process.exit(126) }
      process.exit(reason || !stoppedConfirmed ? 125 : code ?? 1)
    }
    const stop = (why: string) => {
      if (finished || reason) return
      reason = why
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') child.stdin.end()
        else { try { process.kill(-child.pid, 'SIGKILL'); stopConfirmed = true } catch { /* no reliable stop proof */ } }
      }
      stopTimer = setTimeout(() => { if (process.platform === 'win32') child?.kill(); finish(null, closed && stopConfirmed) }, 12000)
    }
    const flush = (final = false) => {
      let cut = final ? pending.length : Math.max(0, pending.length - Math.max(128, ...secrets.map(s => s.length + 1)))
      if (!final) {
        for (const secret of secrets) { const index = pending.lastIndexOf(secret, cut); if (index >= 0 && index < cut && index + secret.length > cut) cut = index }
        for (const match of pending.matchAll(/\bsk-[a-zA-Z0-9_-]*/g)) if (match.index! < cut && match.index! + match[0].length >= cut) cut = match.index!
      }
      if (cut && /[\uD800-\uDBFF]/.test(pending[cut - 1])) cut--
      const value = redact(pending.slice(0, cut)); pending = pending.slice(cut); output = (output + value).slice(-24000)
      const buffer = Buffer.from(value), permitted = Math.max(0, config.durable.maxOutputBytes - bytes), part = buffer.subarray(0, permitted)
      if (part.length < buffer.length) complete = false
      try {
        if (part.length) { const fd = fs.openSync(path.join(directory, 'output.log'), 'a', 0o600); try { fs.writeSync(fd, part); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }; bytes += part.length }
      } catch (error) { complete = false; outputFailure = '原始输出保存失败：' + String(error); stop(outputFailure) }
    }
    const append = (chunk: Buffer, decoder: import('node:string_decoder').StringDecoder, stream: NodeJS.WriteStream) => {
      totalBytes += chunk.length; pending += decoder.write(chunk); flush()
      if (!stream.destroyed) stream.write(chunk)
    }
    const launch = () => { try {
      save('launch.json', identity)
      fs.writeFileSync(path.join(directory, 'output.log'), '', { mode: 0o600 })
      let executable = config.executable, args = config.args
      if (process.platform === 'win32') {
        args = [executable, config.root, String(config.timeoutMs), path.join(directory, 'guard.json.proof'), config.durable.nonce, ...args]
        executable = config.guard
      }
      child = spawn(executable, args, { cwd: config.root, env: process.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.on('error', () => {})
      if (process.platform !== 'win32') child.stdin.end()
      child.stdout.on('data', (chunk: Buffer) => append(chunk, stdout, process.stdout)); child.stderr.on('data', (chunk: Buffer) => append(chunk, stderr, process.stderr))
      child.on('error', error => { reason ||= '启动失败：' + error.message; finish(-1, false) })
      child.on('close', code => {
        closed = true
        if (process.platform === 'win32') {
          try {
            const proof = JSON.parse(fs.readFileSync(path.join(directory, 'guard.json.proof'), 'utf8'))
            stopConfirmed = proof.version === 1 && proof.nonce === config.durable.nonce && proof.containment === 'windows-job-list-v1' && proof.stoppedConfirmed === true && proof.activeProcesses === 0 && Number.isInteger(proof.code)
            if (proof.cancelled) reason ||= '受控命令已取消或超时。'
            code = proof.code
          } catch { reason ||= '缺少 Windows Job Object 树停止凭证。' }
        } else {
          // A process group is narrower than a Windows Job. Detached external work is not covered.
          try { process.kill(-child.pid!, 'SIGKILL') } catch { /* query below is authoritative */ }
          try { process.kill(-child.pid!, 0); stopConfirmed = false } catch (error) { stopConfirmed = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        }
        finish(code, stopConfirmed)
      })
      save('launch.json', { ...identity, childPid: child.pid })
      process.stdin.on('end', () => stop('所有者退出或取消，已停止受控进程树。'))
      // Windows anonymous pipes may signal ECONNRESET/close on abrupt owner exit.
      process.stdin.on('error', () => stop('所有者管道中断，正在停止受控进程树。'))
      process.stdin.on('close', () => stop('所有者管道关闭，正在停止受控进程树。'))
      process.on('SIGTERM', () => stop('监督进程收到停止请求。')); process.on('SIGINT', () => stop('监督进程收到停止请求。'))
      timer = setTimeout(() => stop('单工具运行超时。'), config.timeoutMs)
    } catch (error) { stop('进程意图或启动记录保存失败：' + String(error)); if (!child!) finish(-1, true) } }
    let input = '', launched = false
    process.stdin.setEncoding('utf8'); process.stdin.resume()
    process.stdin.on('data', (chunk: string) => { if (launched) return; input += chunk; if (!input.includes('\n')) return
      try { secrets = JSON.parse(input.slice(0, input.indexOf('\n'))).secrets; if (!Array.isArray(secrets) || secrets.some(s => typeof s !== 'string')) throw new Error('invalid redaction keys'); launched = true; launch() }
      catch { process.exit(126) }
    })
    process.stdin.on('end', () => { if (!launched) process.exit(126) })
    return
  }
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
