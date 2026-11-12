import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { commandGuard } from './files'

export interface PreviewProcess {
  child: ChildProcess
  stopped: Promise<void>
  readonly stopping: boolean
  readonly failure: Error | undefined
  stop(): Promise<void>
  dispose(): void
}

export async function startPreviewProcess(root: string, command: { executable: string; args: string[] }, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<PreviewProcess> {
  const windows = process.platform === 'win32'
  const nonce = randomUUID(), directory = join(root, '.runtime', 'coprojer-previews', nonce)
  const proofPath = join(directory, 'guard.json')
  let executable = command.executable, args = command.args
  if (windows) {
    mkdirSync(directory, { recursive: true })
    executable = await commandGuard(directory)
    // A preview has no tool deadline. EOF on the owner's pipe ends its job.
    args = [command.executable, root, '0', proofPath, nonce, ...command.args]
  }
  signal.throwIfAborted()
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin!.on('error', () => {})
  if (!windows) child.stdin!.end()
  let stopping = false, failure: Error | undefined, closed = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const stopped = new Promise<void>((resolve, reject) => {
    child.on('error', error => { failure = error })
    child.on('exit', () => {
      if (!windows) {
        try { killGroup('SIGKILL') } catch (error) { failure = error as Error }
      }
    })
    child.on('close', () => {
      closed = true
      if (escalation) clearTimeout(escalation)
      try {
        if (failure) throw failure
        if (windows) {
          const proof = JSON.parse(readFileSync(proofPath, 'utf8'))
          if (proof.version !== 1 || proof.nonce !== nonce || proof.containment !== 'windows-job-list-v1' ||
            proof.stoppedConfirmed !== true || proof.activeProcesses !== 0 || !Number.isInteger(proof.code))
            throw new Error('缺少有效的预览进程树停止凭证。')
        } else if (child.pid) {
          try { process.kill(-child.pid, 0); throw new Error('预览进程组仍在运行。') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        }
        resolve()
      } catch (error) {
        failure = new Error('未能确认预览进程树已停止：' + (error instanceof Error ? error.message : String(error)))
        reject(failure)
      }
    })
  })
  // The service observes this result; avoid an unhandled rejection during launch.
  void stopped.catch(() => {})
  const dispose = () => {
    if (stopping || closed) return
    stopping = true
    if (windows) child.stdin!.end()
    else {
      try { killGroup('SIGTERM') } catch (error) { failure = error as Error }
    }
    escalation = setTimeout(() => {
      if (closed) return
      if (windows) child.kill()
      else { try { killGroup('SIGKILL') } catch (error) { failure = error as Error } }
    }, 10000)
    escalation.unref()
  }
  return {
    child, stopped,
    get stopping() { return stopping },
    get failure() { return failure },
    dispose,
    async stop() {
      dispose()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([stopped, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('停止预览进程树超时，未确认停止；请检查预览状态。')), 12000)
        })])
      } finally { if (timer) clearTimeout(timer) }
    },
  }
}
