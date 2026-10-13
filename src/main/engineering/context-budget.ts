import { createHash } from 'node:crypto'
import type { ContextDecision, ContextGrowthState, ContextPolicy, ModelProfile, RequestBudget, TokenCalibration } from '../../shared/model-profile'

export const defaultContextPolicy: ContextPolicy = { version: 2, mode: 'legacy', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 }
export function validateContextPolicy(value: unknown): ContextPolicy | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上下文策略必须为对象。')
  const p = value as ContextPolicy
  if (Object.keys(p).some(k => !['version', 'mode', 'triggerScope', 'autoCompactTokenLimit', 'compactor', 'horizonRounds'].includes(k)) ||
    p.version !== 2 || !['legacy', 'shadow', 'adaptive'].includes(p.mode) || !['total', 'body_after_prefix'].includes(p.triggerScope) ||
    !['portable', 'responses-native'].includes(p.compactor) || !Number.isInteger(p.horizonRounds) || p.horizonRounds < 2 || p.horizonRounds > 12 ||
    p.autoCompactTokenLimit !== undefined && (!Number.isSafeInteger(p.autoCompactTokenLimit) || p.autoCompactTokenLimit < 1)) throw new Error('上下文策略字段或额度无效。')
  return structuredClone(p)
}
export const measurementIdentity = (p: ModelProfile) => createHash('sha256').update(JSON.stringify([p.identity, p.declared, 'context-token-v2'])).digest('hex')
const calibrations = new Map<string, TokenCalibration>()
const exactCounts = new Map<string, number>()
const boundedSet = <T>(map: Map<string, T>, key: string, value: T, max: number) => {
  map.delete(key); map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value!)
}
const countKey = (identity: string, payload: string) => identity + ':' + createHash('sha256').update(payload).digest('hex')
export function rememberInputCount(profile: ModelProfile, payload: string, tokens: number): void {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('供应商 token 计数无效。')
  boundedSet(exactCounts, countKey(measurementIdentity(profile), payload), tokens, 128)
}
export function restoreCalibration(value?: TokenCalibration): void {
  if (value?.identity && Array.isArray(value.samples) && value.samples.every(s => Number.isSafeInteger(s.bytes) && s.bytes > 0 && Number.isSafeInteger(s.tokens) && s.tokens >= 0))
    boundedSet(calibrations, value.identity, { identity: value.identity, samples: value.samples.slice(-32) }, 64)
}
export const calibrationSnapshot = (identity: string) => structuredClone(calibrations.get(identity))
export function observeInputUsage(budget: RequestBudget, inputTokens: number | undefined): void {
  if (!budget.measurementIdentity || !Number.isSafeInteger(inputTokens) || inputTokens! < 0 || !budget.requestBytes) return
  const prior = calibrations.get(budget.measurementIdentity)
  restoreCalibration({ identity: budget.measurementIdentity, samples: [...(prior?.samples ?? []), { bytes: budget.requestBytes, tokens: inputTokens! }].slice(-32) })
}
export function measureInput(payload: string, profile: ModelProfile): Pick<RequestBudget, 'estimatedInputTokens' | 'estimateMethod' | 'measurementIdentity'> {
  const identity = measurementIdentity(profile), exact = exactCounts.get(countKey(identity, payload)), bytes = Buffer.byteLength(payload)
  if (exact !== undefined) return { estimatedInputTokens: exact, estimateMethod: 'provider-count-v1', measurementIdentity: identity }
  const samples = calibrations.get(identity)?.samples ?? []
  if (samples.length >= 8) {
    // Use the worst observed ratio, not an average which hides underestimation.
    const ratio = Math.max(...samples.map(s => s.tokens / s.bytes))
    return { estimatedInputTokens: Math.ceil(bytes * Math.max(ratio * 1.15, 0.1)) + 256, estimateMethod: 'usage-calibrated-v1', measurementIdentity: identity }
  }
  return { estimatedInputTokens: bytes + 256, estimateMethod: 'utf8-upper-bound-v1', measurementIdentity: identity }
}
export function contextDecision(budget: RequestBudget, state: ContextGrowthState, prefix: number, body: number, nextGrowth?: number): ContextDecision {
  const c = budget.contextWindowTokens!, b = budget.inputLimit!, policy = budget.policy ?? defaultContextPolicy
  const samples = state.samples.filter(n => Number.isFinite(n) && n >= 0).slice(-12).sort((a, b) => a - b)
  const observedGrowth = samples.length >= 3 ? samples[Math.max(0, Math.ceil(samples.length * .9) - 1)] : Math.max(4000, c * .03)
  // Historical bursts are a forecast, not mandatory content in the next input.
  // A single forecast must not exceed the multi-round headroom ceiling below:
  // cold-start byte estimates plus long reasoning can otherwise make even a
  // fully archived history impossible to resume. Keep raw samples and preserve
  // any explicit next-round requirement; actual input still passes hard checks.
  const g = Math.min(observedGrowth, Math.floor(b * .5))
  const growth = Math.ceil(Math.max(g, nextGrowth ?? 0))
  const bodyLimit = Math.max(0, Math.min(policy.triggerScope === 'body_after_prefix' ? policy.autoCompactTokenLimit ?? Math.max(0, c * .75 - prefix) : Math.max(0, c * .75 - prefix), b - prefix - growth))
  const trigger = Math.max(0, policy.triggerScope === 'total' ? Math.min(policy.autoCompactTokenLimit ?? c * .75, b - growth) : prefix + bodyLimit)
  const headroom = Math.ceil(Math.min(b * .5, Math.max(b * .1, (policy.horizonRounds - 1) * g + growth)))
  const input = budget.estimatedInputTokens, hard = input > b, predicted = input + growth > b
  const soft = policy.triggerScope === 'total' ? input >= trigger : body >= bodyLimit
  const waiting = soft && state.rearmGrowth !== undefined && body < state.rearmGrowth
  const reason = hard ? 'hard-limit' : predicted ? 'predicted-capacity' : waiting ? 'rearm-wait' : soft ? 'soft-limit' : 'within-budget'
  return { reason, input, prefix, body, hardLimit: b, trigger, bodyLimit, growth, observedGrowth, headroom, target: Math.max(0, Math.floor(trigger - headroom)), shouldCompact: hard || predicted || soft && !waiting }
}
