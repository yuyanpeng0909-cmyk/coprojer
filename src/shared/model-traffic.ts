import type { ModelConfig, Protocol } from './engineering'

export type TrafficWindow = 'today' | '24h' | '7d' | '30d'
export type TrafficStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** Preserve unknown usage; cache and reasoning counts are not extra output. */
export function tokenUsage(protocol: Protocol, usage: any): TokenUsage {
  if (!usage || typeof usage !== 'object') return {}
  let inputTokens = count(protocol === 'chat' ? usage.prompt_tokens : usage.input_tokens)
  const outputTokens = count(protocol === 'chat' ? usage.completion_tokens : usage.output_tokens)
  const cachedInputTokens = count(protocol === 'chat' ? usage.prompt_tokens_details?.cached_tokens : protocol === 'responses' ? usage.input_tokens_details?.cached_tokens : usage.cache_read_input_tokens)
  // Anthropic input_tokens excludes both cache creation and cache reads.
  if (protocol === 'anthropic' && inputTokens !== undefined) inputTokens += (count(usage.cache_creation_input_tokens) ?? 0) + (cachedInputTokens ?? 0)
  const totalTokens = count(usage.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  const reasoningTokens = count(protocol === 'chat' ? usage.completion_tokens_details?.reasoning_tokens : usage.output_tokens_details?.reasoning_tokens)
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens }
}
export interface TrafficRequest extends TokenUsage {
  id: string
  connectionId: string
  model: string
  protocol: Protocol
  purpose: 'inference' | 'test'
  startedAt: string
  finishedAt?: string
  durationMs?: number
  status: TrafficStatus
  httpStatus?: number
  errorKind?: 'rate-limit' | 'auth' | 'server' | 'network' | 'timeout' | 'response'
}
export interface TrafficTotals {
  requests: number
  succeeded: number
  failed: number
  cancelled: number
  interrupted: number
  running: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  usageReported: number
  averageDurationMs: number | null
  rpm: number
}
export interface TrafficQuery { window?: TrafficWindow; connectionId?: string }
export interface ModelTrafficSnapshot {
  capturedAt: string
  enabledAt: string
  from: string
  window: TrafficWindow
  retentionDays: number
  recordLimit: number
  truncatedBefore?: string
  storageError?: string
  totals: TrafficTotals
  models: (Pick<ModelConfig, 'id' | 'model' | 'baseUrl' | 'protocol'> & { totals: TrafficTotals })[]
  buckets: { start: string; requests: number; failed: number }[]
  recent: TrafficRequest[]
}
