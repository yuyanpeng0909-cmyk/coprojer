import type { ToolReceiptView } from '../../shared/runtime-receipt'
import { ReliabilityFailure, RecoveryRequired, EffectUncertain } from './reliability'
import { receiptToolVersions } from './tool-contract'
import { createHash } from 'node:crypto'
import { assertCommandResult } from './command-effects'

export interface ReceiptResult { output: string; sourceVersion?: string; changed?: boolean; effects?: string[]; status?: 'completed' | 'failed' | 'cancelled'; command?: import('./command-effects').CommandOutcome }
export interface ToolReceipt extends ToolReceiptView {
  version: 1
  providerCallId: string
  groupId: string
  manifestId: string
  projectId: string
  scopeId: string
  agentId: string
  role: string
  schemaVersion: string
  permissions: string[]
  args: Record<string, unknown>
  resourceVersion: string
  strategy: 'readonly-v1' | 'file-v1' | 'command-v1' | 'not-started-v1'
  result?: ReceiptResult
  file?: import('./file-effects').FileEffect
  command?: import('./command-effects').CommandEffect
  preparationAttemptId?: string
  intentHash: string
  resultHash?: string
  skippedArguments?: string
}
export interface ReceiptJournal { version: 1; receipts: Record<string, ToolReceipt> }
export interface ReceiptHost {
  load(): ReceiptJournal | undefined
  save(journal: ReceiptJournal): void
}
export function receiptIntentHash(record: Omit<ToolReceipt, 'intentHash'> | ToolReceipt): string {
  const keys = ['version', 'logicalId', 'providerCallId', 'groupId', 'manifestId', 'projectId', 'scopeId', 'agentId', 'role', 'schemaVersion', 'permissions', 'args', 'resourceVersion', 'strategy', 'tool', 'taskRevision', 'file', 'command', 'preparationAttemptId', 'skippedArguments'] as const
  return createHash('sha256').update(JSON.stringify(keys.map(key => record[key]))).digest('hex')
}
export function sealReceipt(record: ToolReceipt): ToolReceipt {
  return { ...record, resultHash: record.result ? createHash('sha256').update(JSON.stringify([record.intentHash, record.status, record.result, record.effects])).digest('hex') : undefined }
}
export function validateReceiptRecord(record: ToolReceipt): void {
  if (!record || record.version !== 1 || !receiptToolVersions.includes(record.schemaVersion) ||
    ['logicalId', 'providerCallId', 'groupId', 'manifestId', 'projectId', 'scopeId', 'agentId', 'role', 'tool', 'resourceVersion', 'at', 'updatedAt'].some(key => typeof (record as any)[key] !== 'string' || !(record as any)[key]) ||
    !['developer', 'reviewer', 'preparer', 'diagnoser', 'planner', 'designer'].includes(record.role) || !Number.isSafeInteger(record.taskRevision) ||
    !record.args || typeof record.args !== 'object' || Array.isArray(record.args) || !Array.isArray(record.permissions) || record.strategy !== 'not-started-v1' && !record.permissions.includes(record.tool) ||
    !['readonly-v1', 'file-v1', 'command-v1', 'not-started-v1'].includes(record.strategy) || !['prepared', 'running', 'completed', 'failed', 'cancelled', 'uncertain'].includes(record.status) ||
    !Number.isSafeInteger(record.attempts) || record.attempts < 0 || !Array.isArray(record.effects) || record.effects.some(x => typeof x !== 'string') || typeof record.applied !== 'boolean' ||
    record.result && typeof record.result.output !== 'string' || ['completed', 'failed', 'cancelled'].includes(record.status) && !record.result)
    throw new RecoveryRequired('调用回执版本、身份或内容不完整，保留原件核对，禁止应用或执行。')
  if (record.intentHash !== receiptIntentHash(record)) throw new RecoveryRequired('调用意图完整性校验不一致；原记录保留，禁止补登记或执行。')
  if (record.result && record.resultHash !== sealReceipt(record).resultHash) throw new RecoveryRequired('调用结果完整性校验不一致；禁止补登记或执行。')
  if (record.strategy === 'command-v1' && record.result) assertCommandResult(record)
  if (record.strategy === 'not-started-v1' && (typeof record.skippedArguments !== 'string' || record.attempts !== 0 || record.status !== 'cancelled' || record.file || record.command || record.effects.length || record.result?.status !== 'cancelled'))
    throw new RecoveryRequired('未启动调用的取消记录不一致。')
  if (record.schemaVersion === 'engineering-tools-v2' && ['patch_file', 'read_file_lines', 'search_files'].includes(record.tool)) throw new RecoveryRequired('旧工具合同不支持新增工具。')
  if (record.strategy === 'readonly-v1' && !['read_skill', 'read_context', 'read_file', 'read_file_lines', 'search_files', 'list_files'].includes(record.tool) ||
    record.strategy === 'file-v1' && (!['write_file', 'patch_file'].includes(record.tool) || !['developer', 'preparer'].includes(record.role)) ||
    record.strategy === 'command-v1' && record.tool !== 'run_command') throw new RecoveryRequired('调用回执恢复策略与工具或角色不一致。')
}
/** One host writer; persist before dispatch and before returning an outcome. */
export class ReceiptLedger {
  constructor(private host: ReceiptHost) {}
  private journal(): ReceiptJournal {
    const journal = this.host.load() ?? { version: 1, receipts: {} }
    if (journal.version !== 1 || !journal.receipts || typeof journal.receipts !== 'object' || Array.isArray(journal.receipts) || Object.getPrototypeOf(journal.receipts) !== Object.prototype)
      throw new RecoveryRequired('调用回执版本未知或账本损坏，保留原件；需兼容读取器核对。')
    return journal
  }
  get(id: string): ToolReceipt | undefined { const record = this.journal().receipts[id]; if (record) { validateReceiptRecord(record); if (record.logicalId !== id) throw new RecoveryRequired('回执键与逻辑身份不一致。') } return record }
  all(): ToolReceipt[] { return Object.keys(this.journal().receipts).map(id => this.get(id)!) }
  put(receipt: ToolReceipt): void {
    validateReceiptRecord(receipt)
    const journal = { ...this.journal(), receipts: { ...this.journal().receipts, [receipt.logicalId]: receipt } }
    try { this.host.save(journal) } catch (cause) { throw new ReliabilityFailure('调用记录保存失败；已停止新动作，请恢复存储后核对现场。', { cause }) }
  }
  async execute(intent: ToolReceipt, authorize: () => void, work: () => Promise<ReceiptResult>, reconcile?: (record: ToolReceipt) => Promise<ToolReceipt>): Promise<ReceiptResult> {
    let record = this.get(intent.logicalId)
    if (record) {
      const identity = ['version', 'logicalId', 'tool', 'providerCallId', 'groupId', 'manifestId', 'projectId', 'scopeId', 'agentId', 'role', 'schemaVersion', 'strategy', 'taskRevision'] as const
      if (identity.some(key => record![key] !== intent[key]) || JSON.stringify(record.args) !== JSON.stringify(intent.args) ||
        !['prepared', 'running', 'completed', 'failed', 'cancelled', 'uncertain'].includes(record.status) || !Number.isSafeInteger(record.attempts) || record.attempts < 0 ||
        !Array.isArray(record.effects) || !Array.isArray(record.permissions) || typeof record.applied !== 'boolean' ||
        record.result && (typeof record.result.output !== 'string' || record.result.sourceVersion !== undefined && typeof record.result.sourceVersion !== 'string' || record.result.changed !== undefined && typeof record.result.changed !== 'boolean'))
        throw new RecoveryRequired('逻辑调用身份或回执版本与保存意图不一致，禁止重放。')
      if (['completed', 'failed', 'cancelled'].includes(record.status) && !record.result) throw new RecoveryRequired('终结回执缺少结果，禁止自动重放。')
      if (record.result && ['completed', 'failed', 'cancelled'].includes(record.status)) return record.result
      if (record.strategy !== 'readonly-v1' && record.status !== 'prepared') {
        if (!reconcile) throw new RecoveryRequired('操作效果尚未核对，不能自动重跑：' + record.tool)
        record = await reconcile(record); this.put(record)
        if (record.result && ['completed', 'failed', 'cancelled'].includes(record.status)) return record.result
        throw new RecoveryRequired(record.reason ?? '操作效果不能确认，请核对后再继续。')
      }
    } else {
      this.put(intent); record = intent
    }
    authorize()
    record = { ...record, status: 'running', attempts: record.attempts + 1, updatedAt: new Date().toISOString() }
    this.put(record)
    let result: ReceiptResult, status: ToolReceipt['status'] = 'completed', reason: string | undefined
    try { result = await work() } catch (error) {
      if (error instanceof EffectUncertain) {
        this.put(reconcile && record.command ? await reconcile(record) : { ...record, status: 'uncertain', reason: error.message, updatedAt: new Date().toISOString(), nextStep: '核对操作的实际效果，不能默认重跑。' })
        throw new RecoveryRequired(error.message)
      }
      if (error instanceof ReliabilityFailure) throw error
      status = 'failed'; reason = error instanceof Error ? error.message : String(error)
      result = { output: '工具错误：' + reason }
    }
    this.put(sealReceipt({ ...record, result, status: result.status ?? status, reason, effects: result.effects ?? record.effects, updatedAt: new Date().toISOString(), nextStep: undefined }))
    return result
  }
}
