import { boundMessages, lastHistorySequence } from './context'
import { assertPreparedCapacity, assertPreparedMeasurement, ContextBudgetError, ModelContextLimitError, ModelTransportError } from './model'
import { setTimeout as delay } from 'node:timers/promises'
import type { ModelMessage, ModelReply, PreparedModelRequest } from './model'
import type { ContextCompactionRecord, ContextGrowthState } from '../../shared/model-profile'
import type { ContextContinuity } from './context-continuity'
import { calibrationSnapshot, contextDecision, restoreCalibration } from './context-budget'
import { canonicalHistoryHash, assertContinuity } from './context-continuity'
import { nativeIdentity, prepareNativeWindow, type NativeContextPorts } from './responses-compaction'
import { requestBudget } from './model-profile'

export interface ContextRequestPorts {
  native?: NativeContextPorts
  prepare(messages: ModelMessage[]): PreparedModelRequest
  verify?(prepared: PreparedModelRequest, signal: AbortSignal): Promise<PreparedModelRequest>
  send(prepared: PreparedModelRequest, signal: AbortSignal, onUsage: (usage: import('../../shared/model-traffic').TokenUsage) => void): Promise<ModelReply>
  assertCurrent(): void
  receivedReply?(reply: ModelReply): void
  commit(messages: ModelMessage[], continuity?: ContextContinuity): void
  archive(content: string, label: string): string
  event(kind: string, message: string): void
  compaction?(record: ContextCompactionRecord): void
  request?(request: PreparedModelRequest, status: 'prepared' | 'completed' | 'failed', reply?: ModelReply): void
  usage?(request: PreparedModelRequest, usage: import('../../shared/model-traffic').TokenUsage): void
}
export async function requestWithContext(messages: ModelMessage[], ports: ContextRequestPorts, signal: AbortSignal,
  options: { continuity?: ContextContinuity; userHistory?: 'all' | 'latest'; protectedUserSequence?: number; provenance?: { taskRevision: number; sources: string[] } } = {}): Promise<ModelReply> {
  const originalContinuity = options.continuity
  const continuity = originalContinuity ? structuredClone(originalContinuity) : undefined
  if (continuity) assertContinuity(continuity)
  if (continuity?.calibration && !calibrationSnapshot(continuity.calibration.identity)) restoreCalibration(continuity.calibration)
  let prepared = ports.prepare(messages), counts = 0
  const nativeKey = continuity ? nativeIdentity(prepared, continuity.sourceIdentity) : ''
  let nativeWindow = continuity?.nativeWindow
  let nativeOutput: Record<string, unknown>[] | undefined
  if (nativeWindow) {
    const canonical = messages.filter(m => (m.sequence ?? 0) <= nativeWindow!.throughSequence)
    if (prepared.budget.adaptive && prepared.budget.policy?.compactor === 'responses-native' && nativeWindow.identity === nativeKey &&
      nativeWindow.version === 1 && nativeWindow.canonicalHash === canonicalHistoryHash(canonical) && ports.native) nativeOutput = ports.native.read(nativeWindow.reference, nativeKey)
    else { nativeWindow = undefined; if (continuity) continuity.nativeWindow = undefined }
  }
  const prepare = (items: ModelMessage[]) => nativeWindow && nativeOutput ? prepareNativeWindow(ports.prepare(items.filter(m => (m.sequence ?? Infinity) > nativeWindow!.throughSequence)), nativeOutput) : ports.prepare(items)
  const verified = new Map<string, PreparedModelRequest>()
  const verify = async (p: PreparedModelRequest) => {
    if (verified.has(p.hash)) return verified.get(p.hash)!
    if (p.budget.adaptive && ports.verify && p.profile.declared.tokenCounting === 'responses' && p.budget.estimateMethod !== 'provider-count-v1') {
      if (counts >= (prepared.budget.policy?.compactor === 'responses-native' ? 4 : 2)) throw new ContextBudgetError('本轮计数复核次数已用完，原始进度保留。')
      counts++; const hash = p.hash; p = await ports.verify(p, signal); ports.assertCurrent()
      if (p.hash !== hash) throw new ContextBudgetError('计数期间请求身份发生变化，未提交候选。')
      verified.set(p.hash, p)
    }
    return p
  }
  const id = prepared.budget.measurementIdentity ?? 'legacy'
  let state: ContextGrowthState = continuity?.growth?.identity === id ? structuredClone(continuity.growth) :
    { identity: id, samples: [], throughSequence: lastHistorySequence(messages), prefixThroughSequence: 0, epoch: 0 }
  const newItems = messages.filter(m => (m.sequence ?? 0) > state.throughSequence)
  const countParts = (items: ModelMessage[], p: PreparedModelRequest) => {
    if (!items.length) return 0
    const encoded = ports.prepare(items).budget, empty = ports.prepare([]).budget
    // Measure protocol bytes, not duplicated canonical/native fields or ciphertext.
    const tokens = p.opaqueWindow ? Math.max(0, encoded.estimatedInputTokens - empty.estimatedInputTokens) :
      Math.ceil(Math.max(0, encoded.requestBytes - empty.requestBytes) * p.budget.estimatedInputTokens / Math.max(1, p.budget.requestBytes))
    return Math.min(p.budget.estimatedInputTokens, tokens)
  }
  if (newItems.length) state.samples = [...state.samples, countParts(newItems, prepared)].slice(-12)
  state.throughSequence = lastHistorySequence(messages)
  const persist = (candidate: ModelMessage[], nextState = state) => {
    const next = continuity ? { ...continuity, growth: nextState, calibration: calibrationSnapshot(id) } : undefined
    ports.assertCurrent(); ports.commit(candidate, next)
    if (continuity && next) { Object.assign(continuity, next); Object.assign(originalContinuity!, next) }
    state = nextState
  }
  let legacyLimit = Math.min(144000, ports.prepare([]).budget.requestCharacters + 46000)
  for (let attempt = 0; attempt < 2; attempt++) {
    ports.assertCurrent(); signal.throwIfAborted()
    prepared = await verify(prepare(messages))
    assertPreparedMeasurement(prepared)
    const adaptive = prepared.budget.adaptive
    const tail = messages.filter(m => m.sequence !== undefined && m.sequence > state.prefixThroughSequence)
    const body = nativeWindow ? Math.max(0, prepared.budget.estimatedInputTokens - nativeWindow.inputTokens) : countParts(tail, prepared), prefix = Math.max(0, prepared.budget.estimatedInputTokens - body)
    const decision = adaptive ? contextDecision(prepared.budget, state, prefix, body) : undefined
    if (decision) prepared = Object.freeze({ ...prepared, budget: { ...prepared.budget, decision } })
    const legacyOverflow = prepared.budget.contextWindowTokens !== undefined && prepared.budget.estimatedTotalTokens > prepared.budget.contextWindowTokens
    const legacyTokenLimit = legacyOverflow ? Math.max(0, Math.floor(prepared.budget.requestCharacters * (prepared.budget.inputLimit ?? 0) / Math.max(1, prepared.budget.estimatedInputTokens) * .9)) : legacyLimit
    const target = adaptive ? attempt ? Math.min(decision!.target, prepared.budget.estimatedInputTokens * .6) : decision!.target : Math.min(legacyLimit, legacyTokenLimit)
    const shouldCompact = adaptive ? decision!.shouldCompact || attempt > 0 : true
    if (shouldCompact) {
      let nativeCommitted = false
      if (adaptive && continuity && ports.native && prepared.budget.policy?.compactor === 'responses-native' && continuity.nativeDisabledIdentity !== nativeKey &&
        prepared.budget.estimatedInputTokens <= decision!.hardLimit && !attempt) {
        let nativeCandidate: { output: Record<string, unknown>[]; checked: PreparedModelRequest } | undefined
        try {
          const output = await ports.native.compact(prepared, signal)
          ports.assertCurrent()
          const checked = await verify(prepareNativeWindow(ports.prepare([]), output))
          assertPreparedCapacity(checked)
          if (checked.budget.estimateMethod !== 'provider-count-v1') throw new ContextBudgetError('原生窗口缺少可靠 token 计数。')
          const after = checked.budget.estimatedInputTokens
          if (after + decision!.growth > checked.budget.inputLimit!) throw new ContextBudgetError('原生窗口没有下一工作回合的空间。')
          nativeCandidate = { output, checked }
        } catch (error) {
          if (signal.aborted) throw error
          continuity.nativeDisabledIdentity = nativeKey
          persist(messages)
          ports.event('context-native-fallback', '原生压缩未提交，使用规范历史恢复：' + String(error))
        }
        if (nativeCandidate) {
          const { output, checked } = nativeCandidate, after = checked.budget.estimatedInputTokens
          const reference = ports.native.write(output, nativeKey)
          const window = { version: 1 as const, identity: nativeKey, reference, throughSequence: lastHistorySequence(messages), canonicalHash: canonicalHistoryHash(messages), inputTokens: after }
          const next = { ...state, epoch: state.epoch + 1, prefixThroughSequence: window.throughSequence, lastAttemptHash: prepared.hash, compactedInput: after,
            rearmGrowth: after >= decision!.trigger ? Math.min(decision!.headroom, Math.max(0, decision!.hardLimit - after - decision!.growth)) : undefined }
          const candidateContinuity = { ...continuity, nativeWindow: window, growth: next, calibration: calibrationSnapshot(id) }
          ports.assertCurrent(); ports.commit(messages, candidateContinuity)
          Object.assign(continuity, candidateContinuity); Object.assign(originalContinuity!, candidateContinuity); nativeWindow = window; nativeOutput = output; state = next; nativeCommitted = true
          ports.compaction?.({ at: new Date().toISOString(), reason: decision!.reason, epoch: next.epoch, before: prepared.budget.estimatedInputTokens, after, method: 'responses-native', decision, unit: 'tokens' })
          prepared = checked
        }
      }
      if (!nativeCommitted) {
      if (nativeWindow) { nativeWindow = undefined; nativeOutput = undefined; if (continuity) continuity.nativeWindow = undefined; prepared = await verify(ports.prepare(messages)) }
      const originalHash = prepared.hash
      const currentInput = adaptive ? prepared.budget.estimatedInputTokens : prepared.budget.requestCharacters
      const measure = (items: ModelMessage[]) => { const b = ports.prepare(items).budget; return adaptive ? b.estimatedInputTokens : b.requestCharacters }
      const saving = adaptive ? Math.max(2000, 2 * decision!.growth) : 0
      const bounds = { measure, userHistory: options.userHistory, protectedUserSequence: options.protectedUserSequence, provenance: options.provenance, preferRecent: !!adaptive }
      let selected: number | undefined
      for (const limit of [...new Set(adaptive ? [target, Math.min(currentInput - saving, Math.max(target, decision!.hardLimit - decision!.growth)), Math.max(target, decision!.hardLimit - decision!.growth), decision!.hardLimit] : [target])]) {
        try {
          const preview = structuredClone(messages)
          const previewResult = boundMessages(preview, Math.max(0, Math.floor(limit)), { ...bounds, archive: () => 'artifact:00000000-0000-0000-0000-000000000000' })
          if (previewResult.compacted && currentInput - measure(preview) >= (decision?.reason === 'hard-limit' || decision?.reason === 'predicted-capacity' || attempt ? 0 : saving)) { selected = limit; break }
        } catch (error) { if (!(error instanceof ContextBudgetError) || !adaptive) throw error }
      }
      if (selected !== undefined && state.lastAttemptHash !== originalHash) {
        const candidate = structuredClone(messages)
        const result = boundMessages(candidate, Math.max(0, Math.floor(selected)), { ...bounds, archive: raw => ports.archive(raw, '完整历史原文') })
        if (result.compacted) {
          // Validate the final archive-bearing payload before committing or replacing the active view.
          const checked = await verify(ports.prepare(candidate))
          assertPreparedCapacity(checked)
          const after = adaptive ? checked.budget.estimatedInputTokens : checked.budget.requestCharacters
          const next = { ...state, epoch: state.epoch + 1, prefixThroughSequence: lastHistorySequence(messages), lastAttemptHash: originalHash,
            compactedInput: after, rearmGrowth: decision && after >= decision.trigger ? Math.min(decision.headroom, Math.max(0, decision.hardLimit - after - decision.growth)) : undefined }
          if (adaptive && after + contextDecision(checked.budget, next, after, 0).growth > checked.budget.inputLimit!)
            throw new ContextBudgetError('压缩候选无法保留下一工作回合空间，原始视图保留。')
          persist(candidate, next)
          messages.splice(0, messages.length, ...candidate)
          prepared = checked
          const record: ContextCompactionRecord = { at: new Date().toISOString(), reason: attempt ? '供应商容量拒绝后恢复一次' : decision?.reason ?? 'legacy', epoch: state.epoch, unit: adaptive ? 'tokens' : 'characters',
            before: currentInput, after, decision, method: prepared.budget.estimateMethod, archiveId: 'archiveId' in result ? result.archiveId : undefined }
          ports.compaction?.(record)
          ports.event('context-compaction', `已归档完整回合，${adaptive ? '输入 token（计量值）' : '请求字符'} ${currentInput} → ${after}；${record.reason}`)
        }
      }
      }
    }
    prepared = await verify(prepare(messages))
    assertPreparedCapacity(prepared)
    if (nativeWindow && prepared.budget.estimateMethod !== 'provider-count-v1') throw new ContextBudgetError('不透明原生窗口必须通过可靠计数。')
    const finalBody = nativeWindow ? Math.max(0, prepared.budget.estimatedInputTokens - nativeWindow.inputTokens) : countParts(messages.filter(m => (m.sequence ?? 0) > state.prefixThroughSequence), prepared)
    const finalDecision = adaptive ? contextDecision(prepared.budget, state, Math.max(0, prepared.budget.estimatedInputTokens - finalBody), finalBody) : undefined
    if (finalDecision && prepared.budget.estimatedInputTokens + finalDecision.growth > finalDecision.hardLimit)
      throw new ContextBudgetError('必要内容虽未超出窗口，但无法保留下一工作回合空间；进度已保存，请缩小单次输入或输出。')
    if (finalDecision) prepared = Object.freeze({ ...prepared, budget: { ...prepared.budget, decision: finalDecision } })
    if (prepared.budget.policy?.mode === 'shadow') {
      const shadow = requestBudget(prepared.payload, { ...prepared.profile, declared: { ...prepared.profile.declared, contextPolicy: { ...prepared.budget.policy, mode: 'adaptive' } } }, prepared.budget.reserves.outputSource === 'policy-estimate' ? undefined : prepared.budget.reserves.outputTokens)
      if (shadow.adaptive) prepared = Object.freeze({ ...prepared, budget: { ...prepared.budget, shadowDecision: contextDecision(shadow, state, 0, shadow.estimatedInputTokens) } })
    }
    persist(messages)
    let requestPending = false
    try {
      let reply: ModelReply
      // Retry only a failed inference before any HTTP response. A returned tool
      // group is never replayed here; each send still reserves budget and records
      // its own traffic. Keep the prepared payload and committed history exact.
      for (let retry = 0; ; retry++) {
        signal.throwIfAborted(); ports.assertCurrent(); assertPreparedCapacity(prepared)
        ports.request?.(prepared, 'prepared'); requestPending = true
        try {
          reply = await ports.send(prepared, signal, usage => ports.usage?.(prepared, usage))
          break
        } catch (error) {
          ports.request?.(prepared, 'failed'); requestPending = false
          if (signal.aborted || !(error instanceof ModelTransportError) || !error.retryable) throw error
          if (retry >= 2) {
            ports.event('model-retry-exhausted', '模型连接连续失败，2 次自动重试已用完；断点和已完成工具已保留，可稍后继续。')
            throw error
          }
          const waitMs = 1000 * (retry + 1)
          ports.event('model-retry', `模型连接中断（${error.codes.join(', ')}），${waitMs / 1000} 秒后重试当前请求（${retry + 1}/2）；保留断点，不重放已完成工具。`)
          await delay(waitMs, undefined, { signal })
        }
      }
      ports.receivedReply?.(reply)
      ports.assertCurrent(); ports.request?.(prepared, 'completed', reply)
      if (continuity) { continuity.calibration = calibrationSnapshot(id); originalContinuity!.calibration = continuity.calibration }
      return { ...reply, origin: { identity: structuredClone(prepared.profile.identity), nativeCompatibilityKey: prepared.profile.declared.nativeCompatibilityKey, nativeScope: prepared.nativeScope } }
    } catch (error) {
      if (requestPending) ports.request?.(prepared, 'failed')
      if (!(error instanceof ModelContextLimitError) || attempt || signal.aborted) throw error
      legacyLimit = Math.floor(prepared.budget.requestCharacters * .6)
      ports.event('context-capacity-retry', '容量不足，保留已执行工具结果并恢复一次。')
    }
  }
  throw new ContextBudgetError('上下文容量仍不足，原始进度已保存。')
}
