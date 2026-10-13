import { randomUUID } from 'node:crypto'
import type { ExecutionCheckpoint } from './execution'
import type { ExecutionManifest, ModelProfile } from '../../shared/model-profile'
import type { ModelMessage } from './model'
import type { ReceiptJournal, ToolReceipt } from './receipt-ledger'
import { receiptIntentHash, sealReceipt, validateReceiptRecord } from './receipt-ledger'
import { assertSupportedCheckpoint, isReceiptCheckpoint } from './checkpoint-version'
import { assertCompleteToolRounds, assertProtocolHistory } from './protocol-history'
import { RecoveryRequired } from './reliability'

/** Converts only canonical facts; the caller retains the complete original record. */
export function portableHistory(messages: ModelMessage[], target: ModelProfile): ModelMessage[] {
  if (!Array.isArray(messages) || messages.some(m => !m || !['user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string'))
    throw new RecoveryRequired('旧历史字段不完整，保留原件，不能迁移。')
  assertCompleteToolRounds(messages)
  return messages.map(message => {
    const m = structuredClone(message), origin = m.origin
    if (m.responseItems?.length) assertProtocolHistory([m, ...(m.calls ?? []).map(c => ({ role: 'tool' as const, callId: c.id, content: '' }))], 'responses')
    if (m.anthropicBlocks?.length) assertProtocolHistory([m, ...(m.calls ?? []).map(c => ({ role: 'tool' as const, callId: c.id, content: '' }))], 'anthropic')
    const native = m.responseItems?.length || m.anthropicBlocks?.length || m.reasoning
    if (native && !m.content && !m.calls?.length) throw new RecoveryRequired('历史只有原生状态，缺少可确认的规范内容；保留原件等待核对。')
    const compatible = origin?.nativeCompatibilityKey && origin.nativeCompatibilityKey === target.declared.nativeCompatibilityKey &&
      (['connectionId', 'baseUrl', 'model', 'protocol'] as const).every(k => origin.identity[k] === target.identity[k])
    if (!compatible) { delete m.reasoning; delete m.responseItems; delete m.anthropicBlocks }
    return m
  })
}

export function closeHandoffGroup(checkpoint: ExecutionCheckpoint, journal: ReceiptJournal | undefined,
  scope: { projectId: string; featureId: string; agentId: string; permissions: string[] }): { checkpoint: ExecutionCheckpoint; journal?: ReceiptJournal } {
  assertSupportedCheckpoint(checkpoint)
  const next = structuredClone(checkpoint), group = next.pending
  if (!group) { assertCompleteToolRounds(next.messages); return { checkpoint: next, journal } }
  if (!isReceiptCheckpoint(next) || !next.manifest) throw new RecoveryRequired('旧部分工具记录缺少可核对的调用身份，保留原件，不能迁移。')
  const copy: ReceiptJournal = structuredClone(journal ?? { version: 1, receipts: {} })
  let sequence = Math.max(next.lastSequence ?? 0, ...next.messages.map(m => m.sequence ?? 0), group.assistant.sequence ?? 0)
  next.messages.push(group.assistant)
  for (const [index, call] of group.assistant.calls!.entries()) {
    const logicalId = group.logicalIds[index]
    let record = copy.receipts[logicalId]
    if (record) {
      validateReceiptRecord(record)
      if (record.groupId !== group.id || record.manifestId !== next.manifest!.id || record.providerCallId !== call.id || record.tool !== call.name ||
        record.projectId !== scope.projectId || record.scopeId !== scope.featureId || record.agentId !== scope.agentId || record.role !== next.role || record.taskRevision !== next.manifest!.taskRevision ||
        (record.strategy === 'not-started-v1' ? record.skippedArguments !== call.arguments : JSON.stringify(record.args) !== JSON.stringify(JSON.parse(call.arguments))))
        throw new RecoveryRequired('旧工具组与回执不一致，禁止换模。')
      if (!record.result) {
        if (record.status !== 'prepared' || record.attempts !== 0) throw new RecoveryRequired('旧调用仍待核对，不能换模或重放。')
        record = { ...record, strategy: 'not-started-v1', args: {}, skippedArguments: call.arguments,
          file: undefined, command: undefined, effects: [], status: 'cancelled', reason: '用户显式续接，取消尚未启动的旧调用。', updatedAt: new Date().toISOString(), applied: true,
          result: { output: '未启动：显式续接取消旧队列，没有执行本调用。', status: 'cancelled', changed: false } }
        record.intentHash = receiptIntentHash(record); record = sealReceipt(record)
        copy.receipts[logicalId] = record
      }
    } else {
      const at = new Date().toISOString()
      record = { version: 1, logicalId, providerCallId: call.id, groupId: group.id, manifestId: next.manifest!.id,
        projectId: scope.projectId, scopeId: scope.featureId, agentId: scope.agentId, role: next.role, schemaVersion: next.manifest!.versions.tools,
        permissions: scope.permissions, args: {}, skippedArguments: call.arguments, taskRevision: next.manifest!.taskRevision,
        resourceVersion: next.sourceFingerprint, strategy: 'not-started-v1', tool: call.name, status: 'cancelled', at, updatedAt: at,
        attempts: 0, effects: [], applied: true, intentHash: '', reason: '用户显式续接，取消尚未启动的旧调用。',
        result: { output: '未启动：显式续接取消旧队列，没有执行本调用。', status: 'cancelled', changed: false } }
      record.intentHash = receiptIntentHash(record); record = sealReceipt(record); copy.receipts[logicalId] = record
    }
    validateReceiptRecord(record)
    next.messages.push({ role: 'tool', content: record.result!.output, callId: call.id, sequence: ++sequence })
  }
  next.lastSequence = sequence; next.steps = group.step + 1
  delete next.pending; delete next.pendingSources
  assertCompleteToolRounds(next.messages)
  return { checkpoint: next, journal: copy }
}

export function handoffManifest(profile: ModelProfile, role: ExecutionCheckpoint['role'], revision: number,
  environment: string, tools: string, reasoning: ExecutionManifest['parameters']['reasoning']): ExecutionManifest {
  return { version: 1, id: randomUUID(), at: new Date().toISOString(), taskRevision: revision, model: profile.identity,
    credentialRef: profile.identity.connectionId, parameters: { reasoning }, profile,
    versions: { harness: 'runtime-v1', context: 'prepared-request-v1', tools, permissions: 'engineering-roles-v1', result: role + '-v1', checkpoint: 'receipts-group-v1' },
    environment, upstreamVersion: null }
}
