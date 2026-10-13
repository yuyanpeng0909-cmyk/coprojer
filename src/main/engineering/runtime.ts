import { assertCompleteToolRounds, boundMessages, lastHistorySequence, hasArchivedHistory } from './context'
import type { TokenUsage } from '../../shared/model-traffic'
import { assertPreparedCapacity, ContextBudgetError, ModelContextLimitError, type ModelMessage, type ModelReply, type ToolCall, type ToolDefinition, type PreparedModelRequest } from './model'
import { ExecutionProgress, readRequestKey, type ExecutionProgressState } from './execution-progress'
import { parseToolArguments } from './tool-contract'
import { ReadRegistry, type ReadCoverage } from './read-registry'
import { randomUUID } from 'node:crypto'
import { ReliabilityFailure } from './reliability'
import type { ContextContinuity } from './context-continuity'
import { requestWithContext } from './context-request'

export interface PendingToolGroup {
  version: 1
  id: string
  step: number
  assistant: ModelMessage
  logicalIds: string[]
  readPlan?: ReadGroupPlan
}
export interface ReadGroupPlan {
  version: 1
  concurrency: 1 | 2 | 4
  outputLimits: number[]
  resources: { path: string; kind: 'file' | 'tree'; version: string }[]
}

/** Portable orchestration state. Business objects and host credentials stay outside. */
export interface RuntimeSnapshot {
  version: 2 | 3
  continuity?: ContextContinuity
  lastSequence: number
  messages: ModelMessage[]
  steps: number
  progress: ExecutionProgressState
  reads: ReadCoverage[]
}
export interface RuntimePorts {
  model: {
    native?: import('./responses-compaction').NativeContextPorts
    prepare(prompt: string, messages: ModelMessage[], tools: ToolDefinition[]): PreparedModelRequest
    verify?(request: PreparedModelRequest, signal: AbortSignal): Promise<PreparedModelRequest>
    send(request: { prepared: PreparedModelRequest; prompt: string; messages: ModelMessage[]; tools: ToolDefinition[]; onUsage(usage: TokenUsage): void }, signal: AbortSignal): Promise<ModelReply>
  }
  workspace: {
    assertCurrent(): void
    preparePrompt(prompt: string, toolNames: string[], context: { reads: ReadCoverage[]; progress: ExecutionProgressState }): string
    receivedReply(reply: ModelReply): void
    provenance?(reads: ReadCoverage[]): { taskRevision: number; sources: string[] }
    readScope?: string
  }
  tools: {
    planGroup?(calls: ToolCall[], signal: AbortSignal): Promise<ReadGroupPlan | undefined>
    checkGroup?(calls: ToolCall[], plan: ReadGroupPlan, signal: AbortSignal): Promise<void>
    execute(call: ToolCall, args: Record<string, any>, step: number, signal: AbortSignal, identity?: { logicalId: string; groupId: string }): Promise<{ output: string; sourceVersion?: string; changed?: boolean; stopGroup?: string }>
    skip?(call: ToolCall, reason: string, identity: { logicalId: string; groupId: string }): { output: string }
    isFatal(error: unknown): boolean
    visible(name: string, output: string): string
    redact(value: string): string
    received(call: ToolCall, output: string, identity?: { logicalId: string; groupId: string }): void
  }
  records: {
    save(snapshot: RuntimeSnapshot): void
    invalidate(): void
    prepareGroup?(snapshot: RuntimeSnapshot, group: PendingToolGroup): void
    event(kind: string, message: string): void
    request?(request: PreparedModelRequest, status: 'prepared' | 'completed' | 'failed', reply?: ModelReply): void
    usage?(request: PreparedModelRequest, usage: TokenUsage): void
    budget?(request: PreparedModelRequest): void
    compaction?(record: import('../../shared/model-profile').ContextCompactionRecord): void
  }
  artifacts: { write(content: string, label: string): string }
}
export interface RuntimeContract {
  inspect(text: string): 'complete' | 'incomplete' | 'invalid'
  repairInstruction: string
  conclusionInstruction: string
  canFinish(): boolean
  incompleteSourcesMessage?: string
}
export interface RuntimeInput {
  continuity?: ContextContinuity
  instructions: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
  stepLimit: number
  startStep: number
  savedSteps: number
  lastSequence?: number
  progress?: ExecutionProgressState
  reads?: ReadCoverage[]
  maxCalls?: number
  userHistory?: 'all' | 'latest'
  pending?: PendingToolGroup
  stepPrompt(step: number): string
  stepLabel(step: number): string
  conclusionLabel: string
  replyKind: string
  contract: RuntimeContract
}
export type RunOutcome =
  | { status: 'completed'; reply: ModelReply }
  | { status: 'paused'; reason: string; kind: 'progress' | 'budget' }
  | { status: 'cancelled' | 'failed'; error: unknown }

/** The engineering entry and non-desktop hosts run this same model/tool loop. */
export async function runRuntime(input: RuntimeInput, ports: RuntimePorts, signal: AbortSignal): Promise<RunOutcome> {
  const messages = input.messages, progress = new ExecutionProgress(input.progress)
  const reads = new ReadRegistry(input.reads)
  let sequence = Math.max(input.lastSequence ?? 0, lastHistorySequence(messages))
  for (const message of messages) message.sequence ??= ++sequence
  const protectedUserSequence = input.userHistory === 'latest' ? messages.filter(m => m.role === 'user').at(-1)?.sequence : undefined
  let steps = input.savedSteps
  const save = () => {
    ports.workspace.assertCurrent()
    ports.records.save({ version: input.continuity ? 3 : 2, continuity: input.continuity, lastSequence: sequence, messages, steps, progress: progress.snapshot(), reads: reads.snapshot() })
  }
  const request = async (prompt: string, history = messages, tools = input.tools) => {
    ports.workspace.assertCurrent()
    prompt = ports.workspace.preparePrompt(prompt, tools.map(t => t.name), { reads: reads.snapshot(), progress: progress.snapshot() })
    assertCompleteToolRounds(history)
    save()
    ports.records.budget?.(ports.model.prepare(prompt, history, tools))
    const requestContinuity = history === messages ? input.continuity : input.continuity ? structuredClone(input.continuity) : undefined
    const reply = await requestWithContext(history, {
      native: history === messages ? ports.model.native : undefined,
      prepare: items => ports.model.prepare(prompt, items, tools), verify: ports.model.verify,
      send: (prepared, requestSignal, onUsage) => ports.model.send({ prepared, prompt, messages: history, tools, onUsage }, requestSignal),
      assertCurrent: ports.workspace.assertCurrent,
      receivedReply: ports.workspace.receivedReply,
      commit: (candidate, continuity) => ports.records.save({ version: input.continuity ? 3 : 2, continuity: history === messages ? continuity : input.continuity, lastSequence: sequence,
        messages: history === messages ? candidate : messages, steps, progress: progress.snapshot(), reads: reads.snapshot() }),
      archive: ports.artifacts.write, event: ports.records.event, request: ports.records.request, usage: ports.records.usage, compaction: ports.records.compaction,
    }, signal, { continuity: requestContinuity, userHistory: input.userHistory, protectedUserSequence, provenance: ports.workspace.provenance?.(reads.snapshot()) })
    return reply
  }
  const appendReply = (reply: ModelReply) => messages.push({ sequence: ++sequence, role: 'assistant', content: reply.text, calls: reply.calls,
    origin: reply.origin, reasoning: reply.reasoning, responseItems: reply.responseItems, anthropicBlocks: reply.anthropicBlocks })
  const evictedRead = (call: ToolCall) => {
    if (!['read_context', 'read_file', 'read_file_lines', 'search_files', 'read_skill', 'list_files'].includes(call.name) || !hasArchivedHistory(messages)) return false
    const key = readRequestKey(call.name, call.arguments), answered = new Set(messages.filter(m => m.role === 'tool').map(m => m.callId))
    return !messages.some(message => message.calls?.some(prior => answered.has(prior.id) && readRequestKey(prior.name, prior.arguments) === key))
  }
  const finish = (reply: ModelReply): RunOutcome => {
    ports.workspace.assertCurrent()
    if (!input.contract.canFinish()) throw new Error(input.contract.incompleteSourcesMessage ?? '必需资料尚未完整读取，不能提交结果。')
    const last = messages.at(-1)
    if (last?.role !== 'assistant' || last.content !== reply.text || last.calls?.length) appendReply(reply)
    if (input.continuity) input.continuity.completedReply = structuredClone(reply)
    save()
    return { status: 'completed', reply }
  }
  const executeGroup = async (group: PendingToolGroup) => {
      if (group.readPlan) return executeReadGroup(group)
      let stopped: string | undefined
      for (const [index, call] of (group.assistant.calls ?? []).entries()) {
        signal.throwIfAborted()
        ports.workspace.assertCurrent()
        let result: { output: string; sourceVersion?: string; changed?: boolean; stopGroup?: string }
        try {
          if (stopped) {
            if (!ports.tools.skip) throw new ReliabilityFailure('缺少取消排队调用的可靠记录端口。')
            result = ports.tools.skip(call, stopped, { logicalId: group.logicalIds[index], groupId: group.id })
          } else {
          const definition = input.tools.find(t => t.name === call.name)
          if (!definition) throw new Error('当前角色不可使用此工具。')
          const args = parseToolArguments(definition, call.arguments)
          result = await ports.tools.execute(call, args, group.step, signal, { logicalId: group.logicalIds[index], groupId: group.id })
          reads.observe(call.name, args, result.output, ports.workspace.readScope ?? 'host-scoped')
          stopped = result.stopGroup
          }
        } catch (error) {
          if (error instanceof ReliabilityFailure || ports.tools.isFatal(error)) throw error
          result = { output: '工具错误：' + (error instanceof Error ? error.message : String(error)) }
        }
        const output = ports.tools.redact(result.output)
        progress.observe(call.name, call.arguments, output, result.sourceVersion ?? '', result.changed ?? false, evictedRead(call))
        let visible = ports.tools.visible(call.name, output)
        if (visible !== output) {
          try {
            const id = ports.artifacts.write(output, '工具结果 ' + call.name)
            visible = visible.replace(/\[工具输出已截断[^\]]*\]/, '[工具结果已归档：read_context id=' + id + '，按 nextOffset/version 分页读取；不要重新执行命令获取日志。]')
          } catch (error) {
            visible = '[归档不可用，以下仅为部分输出：' + ports.tools.redact(String(error)) + ']\n' + visible
            ports.records.event('archive-warning', String(error))
          }
        }
        messages.push({ sequence: ++sequence, role: 'tool', content: visible, callId: call.id })
        ports.records.event('tool-result', output)
        ports.tools.received(call, output, { logicalId: group.logicalIds[index], groupId: group.id })
        ports.workspace.assertCurrent()
      }
      steps = group.step + 1; save()
      return stopped
  }
  const executeReadGroup = async (group: PendingToolGroup): Promise<undefined> => {
    const calls = group.assistant.calls!, plan = group.readPlan!
    if (!ports.tools.checkGroup || plan.version !== 1 || ![1, 2, 4].includes(plan.concurrency) ||
      plan.resources.length !== calls.length || plan.outputLimits.length !== calls.length ||
      plan.outputLimits.some(n => !Number.isSafeInteger(n) || n < 800) || plan.outputLimits.reduce((a,b) => a+b, 0) > 24000)
      throw new ReliabilityFailure('只读组计划不完整，保留记录并停止执行。')
    await ports.tools.checkGroup(calls, plan, signal)
    const workerSignal = signal
    const results: { output: string; sourceVersion?: string; changed?: boolean }[] = new Array(calls.length)
    let next = 0, failed = false, failure: unknown
    const worker = async () => {
      while (!failed && next < calls.length) {
        const index = next++, call = calls[index]
        try {
          workerSignal.throwIfAborted(); ports.workspace.assertCurrent()
          await ports.tools.checkGroup!(calls, plan, workerSignal)
          workerSignal.throwIfAborted(); ports.workspace.assertCurrent()
          if (failed) return
          const definition = input.tools.find(t => t.name === call.name)
          if (!definition) throw new ReliabilityFailure('待恢复读取工具已无当前角色权限。')
          const args = parseToolArguments(definition, call.arguments)
          results[index] = await ports.tools.execute(call, args, group.step, workerSignal, { logicalId: group.logicalIds[index], groupId: group.id })
          ports.records.event('tool-result', ports.tools.redact(results[index].output))
          workerSignal.throwIfAborted(); ports.workspace.assertCurrent()
        } catch (error) {
          if (workerSignal.aborted || error instanceof ReliabilityFailure || ports.tools.isFatal(error)) {
            // Stop dispatching; already authorized reads finish and retain their
            // receipts. The external cancellation signal still cancels real I/O.
            if (!failed) { failed = true; failure = error }
            return
          }
          results[index] = { output: '工具错误：' + (error instanceof Error ? error.message : String(error)) }
        }
      }
    }
    await Promise.allSettled(Array.from({ length: Math.min(plan.concurrency, calls.length) }, worker))
    if (failed) throw failure
    signal.throwIfAborted(); ports.workspace.assertCurrent()
    await ports.tools.checkGroup(calls, plan, signal)
    for (const [index, call] of calls.entries()) {
      const result = results[index], output = ports.tools.redact(result.output), limit = plan.outputLimits[index]
      let visible = output
      if (visible.length > limit) {
        let artifact: string | undefined, archiveError: string | undefined
        try { artifact = ports.artifacts.write(output, '只读工具组结果 ' + call.name) }
        catch (error) { archiveError = ports.tools.redact(String(error)); ports.records.event('archive-warning', archiveError) }
        try {
          const page = JSON.parse(output)
          if (typeof page.content === 'string' && Number.isSafeInteger(page.offset)) {
            const partial = { ...page, content: '', partial: true, artifact, archiveError, nextOffset: page.offset }
            const length = Math.max(0, Math.floor((limit - JSON.stringify(partial).length - 100) / 6))
            partial.content = page.content.slice(0, length); partial.nextOffset = page.offset + partial.content.length
            visible = JSON.stringify(partial)
          } else {
            const partial = { scope: page.scope, query: page.query, scanned: page.scanned, complete: false, truncated: true, artifact, archiveError,
              matches: [] as unknown[], versions: {} as Record<string, string> }
            for (const match of page.matches ?? []) {
              const candidate = { ...partial, matches: [...partial.matches, match], versions: { ...partial.versions, [match.path]: match.version } }
              if (JSON.stringify(candidate).length > limit) break
              partial.matches = candidate.matches; partial.versions = candidate.versions
            }
            visible = JSON.stringify(partial)
          }
        } catch { visible = JSON.stringify({ partial: true, artifact, archiveError, preview: output.slice(0, Math.floor(limit / 8)) }) }
        if (visible.length > limit) throw new ReliabilityFailure('只读组显示额度不足，完整回执已保留，停止提交。')
      }
      reads.observe(call.name, parseToolArguments(input.tools.find(t => t.name === call.name)!, call.arguments), visible, ports.workspace.readScope ?? 'host-scoped')
      progress.observe(call.name, call.arguments, output, result.sourceVersion ?? '', false, evictedRead(call))
      messages.push({ sequence: ++sequence, role: 'tool', content: visible, callId: call.id })
      ports.tools.received(call, output, { logicalId: group.logicalIds[index], groupId: group.id })
    }
    steps = group.step + 1; save()
    return undefined
  }
  try {
    let start = input.startStep
    if (input.pending) {
      const group = input.pending
      if (group.version !== 1 || !group.assistant.calls?.length || group.logicalIds.length !== group.assistant.calls.length || new Set(group.logicalIds).size !== group.logicalIds.length)
        throw new ReliabilityFailure('待恢复工具组记录不完整，禁止执行。')
      messages.push(group.assistant); sequence = Math.max(sequence, group.assistant.sequence ?? 0)
      await executeGroup(group)
      start = Math.max(start, group.step + 1)
      if (progress.pauseReason) return { status: 'paused', kind: 'progress', reason: progress.pauseReason }
    }
    for (let step = start; step < input.stepLimit; step++) {
      signal.throwIfAborted()
      ports.records.event('model', input.stepLabel(step))
      steps = step
      const reply = await request(input.instructions + input.stepPrompt(step) + (progress.warning ? '\n' + progress.warning : ''))
      signal.throwIfAborted()
      if (reply.text) ports.records.event(input.replyKind, reply.text)
      appendReply(reply)
      if (!reply.calls.length) {
        const status = input.contract.inspect(reply.text)
        if (status === 'incomplete') {
          steps = step + 1; save()
          return { status: 'paused', kind: 'progress', reason: '报告明确未完成，仍有待处理工作' }
        }
        if (status === 'invalid') {
          ports.records.event('verification-report-format', '结论格式不完整，基于已有记录整理一次结构化报告，不再执行工具。')
          const corrected = await request(input.instructions, [...messages, { role: 'user',
            content: input.contract.repairInstruction + '刚才的回复格式不完整；只整理已有事实，不编造通过，也不要增加测试要求。此回合不提供工具。' }], [])
          signal.throwIfAborted()
          const correctedStatus = corrected.calls.length ? 'invalid' : input.contract.inspect(corrected.text)
          if (correctedStatus !== 'invalid') {
            ports.records.event(input.replyKind, corrected.text)
            if (correctedStatus === 'incomplete') {
              save(); return { status: 'paused', kind: 'progress', reason: '报告仍未完成，已保留事实和进度' }
            }
            return finish(corrected)
          }
          steps = step + 1; save()
          return { status: 'paused', kind: 'progress', reason: '报告格式整理一次后仍无效；已保存事实和检查证据，不进入业务代码修复' }
        }
        return finish(reply)
      }
      if (input.maxCalls !== undefined && reply.calls.length > input.maxCalls) throw new Error('本轮工具调用超过允许上限，已停止，避免无界批量执行。')
      const group: PendingToolGroup = { version: 1, id: randomUUID(), step, assistant: messages.at(-1)!, logicalIds: reply.calls.map(() => randomUUID()) }
      group.readPlan = await ports.tools.planGroup?.(reply.calls, signal)
      if (ports.records.prepareGroup) ports.records.prepareGroup({ version: input.continuity ? 3 : 2, continuity: input.continuity, lastSequence: sequence - 1, messages: messages.slice(0, -1), steps,
        progress: progress.snapshot(), reads: reads.snapshot() }, group)
      else ports.records.invalidate()
      const stopped = await executeGroup(group)
      if (stopped) return { status: 'paused', kind: 'progress', reason: stopped }
      if (progress.pauseReason) return { status: 'paused', kind: 'progress', reason: progress.pauseReason }
      if (progress.warning) ports.records.event('execution-warning', progress.warning)
    }
    steps = input.stepLimit; save()
    signal.throwIfAborted()
    ports.records.event('model', input.conclusionLabel)
    const conclusion = await request(input.instructions, [...messages, { role: 'user', content: input.contract.conclusionInstruction }], [])
    signal.throwIfAborted()
    if (conclusion.text.trim() && !conclusion.calls.length && input.contract.canFinish() && input.contract.inspect(conclusion.text) === 'complete') {
      ports.records.event(input.replyKind, conclusion.text)
      return finish(conclusion)
    }
    if (conclusion.text.trim() && !conclusion.calls.length) {
      appendReply(conclusion); ports.records.event(input.replyKind, conclusion.text); save()
    }
    return { status: 'paused', kind: 'budget', reason: '本次工作步数已用完，尚未形成完整结论' }
  } catch (error) {
    return { status: signal.aborted ? 'cancelled' : 'failed', error }
  }
}
