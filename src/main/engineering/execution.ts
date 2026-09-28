import type { ModelMessage } from './model'
import type { ExecutionProgressState } from './execution-progress'
import type { VerificationEvidenceKind, VerificationStatus, RuntimeMeasurement } from '../../shared/engineering'

export type ExecutionRole = 'developer' | 'reviewer' | 'diagnoser' | 'preparer'
export const preparationRoundLimit = 2
export const diagnosisStepLimit = 6
export const preparationStepLimit = 12

export function commandEvidenceKinds(value: { evidenceKind?: unknown; evidenceKinds?: unknown }): VerificationEvidenceKind[] {
  const supplied = [value.evidenceKind, ...(Array.isArray(value.evidenceKinds) ? value.evidenceKinds : [])]
  const kinds = [...new Set(supplied.filter((v): v is VerificationEvidenceKind =>
    ['unit', 'mock', 'application', 'desktop', 'duration', 'history', 'inspection'].includes(v as string)))]
  // A historical record cannot be promoted by attaching additional labels.
  return kinds.includes('history') ? ['history'] : kinds
}

export function verificationStatus(
  item: { passed?: unknown; status?: unknown; evidence?: unknown } | undefined,
  validChecks: boolean,
): VerificationStatus {
  if (item?.passed === false && item.status === 'failed' && typeof item.evidence === 'string' && item.evidence.trim()) return 'failed'
  if (!validChecks || typeof item?.evidence !== 'string' || !item.evidence.trim()) return 'unverified'
  if (item.passed === false && item.status === 'unverified') return 'unverified'
  if (item.passed === true && (item.status === undefined || item.status === 'passed')) return 'passed'
  return item.passed === false && item.status !== 'unverified' ? 'failed' : 'unverified'
}

export const executionStepLimit = 36
export interface CommandEvidence {
  id?: string
  at?: string
  sourceFingerprint?: string
  durationMs?: number
  measurements?: RuntimeMeasurement[]
  runId?: string
  evidenceKind?: VerificationEvidenceKind
  evidenceKinds?: VerificationEvidenceKind[]
  failureKind?: 'condition' | 'check'
  code: number
  output: string
  isTest: boolean
  command: string
}
// Main-process state only. Saved at a completed tool-round boundary, never
// halfway through side effects. It is not part of the renderer's project model.
export interface ExecutionCheckpoint {
  role: ExecutionRole
  fingerprint: string
  sourceFingerprint: string
  round: number
  development: string
  messages: ModelMessage[]
  commands: CommandEvidence[]
  prototypeReadUntil: number
  steps?: number
  environmentFingerprint?: string
  progress?: ExecutionProgressState
}
export const executionKey = (projectId: string, featureId: string) => JSON.stringify([projectId, featureId])
export class ExecutionBudgetPause extends Error {
  constructor(role: ExecutionRole) {
    const limit = role === 'diagnoser' ? diagnosisStepLimit : role === 'preparer' ? preparationStepLimit : executionStepLimit
    const label = role === 'diagnoser' ? '缺口诊断' : role === 'preparer' ? '验证准备' : role === 'reviewer' ? '验证' : '开发'
    super(`${label}已完成本次 ${limit} 步，尚未形成完整结论，已暂停并保存执行进度。继续执行将从当前阶段接续；工程或任务变化时会重新检查。`)
    this.name = 'ExecutionBudgetPause'
  }
}
