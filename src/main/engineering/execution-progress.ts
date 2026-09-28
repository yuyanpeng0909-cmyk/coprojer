import { createHash } from 'node:crypto'

export interface ExecutionProgressState {
  seen: string[]
  failures: [string, number][]
  repeated: number
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

// Store hashes, not another copy of the growing tool history. Compare outcomes
// as well as arguments so new file versions/pages remain useful evidence.
export class ExecutionProgress {
  private seen: Set<string>
  private failures: Map<string, number>
  private repeated: number
  warning = ''
  pauseReason = ''

  constructor(state?: ExecutionProgressState) {
    this.seen = new Set(state?.seen?.slice(-128) ?? [])
    this.failures = new Map(state?.failures?.slice(-64) ?? [])
    this.repeated = state?.repeated ?? 0
  }

  observe(name: string, argumentsText: string, output: string, sourceVersion: string, changed: boolean): void {
    this.warning = ''; this.pauseReason = ''
    if (changed) { this.seen.clear(); this.failures.clear(); this.repeated = 0; return }
    let args: unknown = argumentsText, result: unknown = output
    try { args = JSON.parse(argumentsText) } catch { /* malformed calls still have a repeatable identity */ }
    let failed = output.startsWith('工具错误：')
    try {
      const parsed = JSON.parse(output)
      if (name === 'run_command') {
        // Run ids, elapsed time and evidence ids are different on every retry.
        result = { code: parsed.code, output: parsed.output }
        failed ||= parsed.code !== 0
      } else result = parsed
    } catch { /* text tool results are valid */ }
    const key = createHash('sha256').update(JSON.stringify(canonical([name, args, result, sourceVersion]))).digest('hex')
    this.repeated = this.seen.has(key) ? this.repeated + 1 : 0
    this.seen.add(key)
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!)
    if (failed) this.failures.set(key, (this.failures.get(key) ?? 0) + 1)
    if (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value!)
    const failures = failed ? this.failures.get(key)! : 0
    if (failures >= 3) this.pauseReason = '同一工具请求在工程未变化时重复失败 3 次'
    else if (this.repeated >= 5) this.pauseReason = '连续 5 次重复工具调用没有得到新信息或产生实际修改'
    else if (failures === 2 || this.repeated === 2) this.warning = '检测到重复无进展：复用已读结果，改变诊断方法；不要重复同一失败命令。若无法推进，明确返回未完成并说明阻塞。'
  }

  snapshot(): ExecutionProgressState {
    return { seen: [...this.seen], failures: [...this.failures], repeated: this.repeated }
  }
}

export class ExecutionProgressPause extends Error {
  constructor(reason: string) {
    super(reason + '，已暂停并保存完整工具回合与执行进度。请针对阻塞调整方案后继续，不会自动进入下一阶段。')
    this.name = 'ExecutionProgressPause'
  }
}
