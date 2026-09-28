import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ModelConfig } from '../../shared/engineering'
import type { ModelTrafficSnapshot, TokenUsage, TrafficQuery, TrafficRequest, TrafficTotals, TrafficWindow } from '../../shared/model-traffic'

const RETENTION_DAYS = 30, RECORD_LIMIT = 10_000, DAY = 86_400_000
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

export interface TrafficObservation { usage?: TokenUsage; httpStatus?: number }
export interface TrafficRecorder {
  start(connection: Pick<ModelConfig, 'id' | 'model' | 'protocol'>, purpose: TrafficRequest['purpose']): {
    observe(update: TrafficObservation): void
    finish(status: 'succeeded' | 'failed' | 'cancelled', errorKind?: TrafficRequest['errorKind']): void
  }
}
interface TrafficFile { version: 1; enabledAt: string; truncatedBefore?: string; requests: TrafficRequest[] }

export class ModelTrafficMonitor implements TrafficRecorder {
  private data: TrafficFile
  private storageError?: string
  private writable = true
  constructor(private path: string, private clock = Date.now) {
    this.data = { version: 1, enabledAt: new Date(clock()).toISOString(), requests: [] }
    try {
      if (existsSync(path)) {
        const saved = JSON.parse(readFileSync(path, 'utf8'))
        if (saved.version !== 1 || !Number.isFinite(Date.parse(saved.enabledAt)) || !Array.isArray(saved.requests) || saved.requests.some((r: TrafficRequest) => !r || typeof r.id !== 'string' || typeof r.connectionId !== 'string' || typeof r.model !== 'string' || !Number.isFinite(Date.parse(r.startedAt)) || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.status))) throw new Error('invalid traffic file')
        this.data = saved
        for (const request of this.data.requests) if (request.status === 'running') {
          request.status = 'interrupted'
          // Exit time is unknown; do not invent duration or completion time.
        }
      }
      this.prune()
      this.persist()
    } catch {
      this.writable = false
      this.storageError = '历史监控文件无法读取，原文件已保留；本次仅显示内存记录。'
    }
  }
  private prune(): boolean {
    const previousLength = this.data.requests.length
    const cutoff = this.clock() - RETENTION_DAYS * DAY
    this.data.requests = this.data.requests.filter(r => r.status === 'running' || Date.parse(r.startedAt) >= cutoff)
    const completed = this.data.requests.filter(r => r.status !== 'running')
    if (completed.length > RECORD_LIMIT) {
      const removed = completed.slice(0, completed.length - RECORD_LIMIT)
      this.data.truncatedBefore = removed.at(-1)!.startedAt
      const ids = new Set(removed.map(r => r.id))
      this.data.requests = this.data.requests.filter(r => !ids.has(r.id))
    }
    return this.data.requests.length !== previousLength
  }
  private persist(): void {
    if (!this.writable) return
    try {
      writeFileSync(this.path + '.tmp', JSON.stringify(this.data), { mode: 0o600 })
      renameSync(this.path + '.tmp', this.path)
      this.storageError = undefined
    } catch {
      this.storageError = '监控记录暂未保存到磁盘，当前仍可查看；模型调用不受影响。'
    }
  }
  start(connection: Pick<ModelConfig, 'id' | 'model' | 'protocol'>, purpose: TrafficRequest['purpose']) {
    const started = this.clock()
    const request: TrafficRequest = { id: randomUUID(), connectionId: connection.id, model: connection.model, protocol: connection.protocol, purpose, startedAt: new Date(started).toISOString(), status: 'running' }
    this.data.requests.push(request)
    this.prune(); this.persist()
    let finished = false
    return {
      observe: (update: TrafficObservation) => {
        if (finished) return
        if (update.httpStatus !== undefined) request.httpStatus = update.httpStatus
        if (update.usage) for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'] as const) {
          const value = count(update.usage[key])
          if (value !== undefined) request[key] = value
        }
      },
      finish: (status: 'succeeded' | 'failed' | 'cancelled', errorKind?: TrafficRequest['errorKind']) => {
        if (finished) return
        finished = true
        request.status = status; request.finishedAt = new Date(this.clock()).toISOString()
        request.durationMs = Math.max(0, this.clock() - started)
        if (status === 'failed') request.errorKind = request.httpStatus === 429 ? 'rate-limit' : [401, 403].includes(request.httpStatus ?? 0) ? 'auth' : (request.httpStatus ?? 0) >= 500 ? 'server' : errorKind ?? 'response'
        this.prune(); this.persist()
      },
    }
  }
  snapshot(models: ModelConfig[], query: TrafficQuery = {}): ModelTrafficSnapshot {
    const window: TrafficWindow = query.window ?? 'today'
    if (!['today', '24h', '7d', '30d'].includes(window) || query.connectionId !== undefined && typeof query.connectionId !== 'string') throw new Error('监控筛选条件无效。')
    if (this.prune()) this.persist()
    const now = this.clock(), midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const from = window === 'today' ? +midnight : now - (window === '24h' ? 1 : window === '7d' ? 7 : 30) * DAY
    const selectedModels = models.filter(m => !query.connectionId || m.id === query.connectionId)
    const ids = new Set(selectedModels.map(m => m.id))
    const all = this.data.requests.filter(r => ids.has(r.connectionId))
    const requests = all.filter(r => Date.parse(r.startedAt) >= from)
    const totals = (rows: TrafficRequest[], lifetime: TrafficRequest[]): TrafficTotals => {
      const succeeded = rows.filter(r => r.status === 'succeeded')
      const tokenSum = (key: keyof TokenUsage) => { const known = rows.filter(r => r[key] !== undefined); return known.length ? known.reduce((sum, r) => sum + (r[key] ?? 0), 0) : null }
      return { requests: rows.length, succeeded: succeeded.length, failed: rows.filter(r => r.status === 'failed').length, cancelled: rows.filter(r => r.status === 'cancelled').length, interrupted: rows.filter(r => r.status === 'interrupted').length, running: lifetime.filter(r => r.status === 'running').length,
        inputTokens: tokenSum('inputTokens'), outputTokens: tokenSum('outputTokens'), totalTokens: tokenSum('totalTokens'), usageReported: rows.filter(r => r.totalTokens !== undefined).length,
        averageDurationMs: succeeded.length ? succeeded.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / succeeded.length : null, rpm: lifetime.filter(r => Date.parse(r.startedAt) > now - 60_000).length }
    }
    const bucketCount = window === 'today' || window === '24h' ? 24 : window === '7d' ? 7 : 30
    const bucketMs = window === 'today' || window === '24h' ? 3_600_000 : DAY
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ start: new Date(from + i * bucketMs).toISOString(), requests: 0, failed: 0 }))
    for (const r of requests) { const i = Math.min(bucketCount - 1, Math.floor((Date.parse(r.startedAt) - from) / bucketMs)); if (buckets[i]) { buckets[i].requests++; if (r.status === 'failed') buckets[i].failed++ } }
    return { capturedAt: new Date(now).toISOString(), enabledAt: this.data.enabledAt, from: new Date(from).toISOString(), window, retentionDays: RETENTION_DAYS, recordLimit: RECORD_LIMIT, truncatedBefore: this.data.truncatedBefore, storageError: this.storageError, totals: totals(requests, all),
      models: selectedModels.map(({ id, model, baseUrl, protocol }) => ({ id, model, baseUrl, protocol, totals: totals(requests.filter(r => r.connectionId === id), all.filter(r => r.connectionId === id)) })), buckets, recent: requests.slice(-50).reverse().map(r => ({ ...r })) }
  }
}
