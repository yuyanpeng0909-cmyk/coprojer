import type { VerificationEvidenceKind } from './engineering'

export interface EvidenceRecord {
  id?: string
  command: string
  code: number
  sourceFingerprint?: string
  taskRevision?: number
  contractFingerprint?: string
  environmentFingerprint?: string
  legacyScopeBinding?: { ruleVersion: 'validated-checkpoint-v1'; checkpointFingerprint: string; environment: 'unknown' }
  evidenceKind?: VerificationEvidenceKind
  evidenceKinds?: VerificationEvidenceKind[]
}
export interface EvidenceScope {
  sourceFingerprint?: string
  taskRevision?: number
  contractFingerprint?: string
  environmentFingerprint?: string
}
export type EvidenceDisposition = 'current' | 'superseded' | 'stale' | 'history' | 'insufficient'
export function evidenceKinds(value: EvidenceRecord): VerificationEvidenceKind[] {
  const kinds = [...new Set([value.evidenceKind, ...(value.evidenceKinds ?? [])].filter((v): v is VerificationEvidenceKind =>
    ['unit', 'mock', 'application', 'desktop', 'duration', 'history', 'inspection'].includes(v as string)))]
  return kinds.includes('history') ? ['history'] : kinds
}
export function supersedesEvidence(later: EvidenceRecord, earlier: EvidenceRecord): boolean {
  return earlier.code !== 0 && later.code === 0 && !!earlier.sourceFingerprint && later.sourceFingerprint === earlier.sourceFingerprint &&
    later.command === earlier.command && later.taskRevision === earlier.taskRevision && later.contractFingerprint === earlier.contractFingerprint &&
    later.environmentFingerprint === earlier.environmentFingerprint && !evidenceKinds(later).includes('history') &&
    evidenceKinds(earlier).every(kind => evidenceKinds(later).includes(kind))
}
export function classifyEvidence<T extends EvidenceRecord>(records: T[], scope: EvidenceScope = {}): { record: T; disposition: EvidenceDisposition; supersededBy?: string }[] {
  return records.map((record, index) => {
    if (evidenceKinds(record).includes('history')) return { record, disposition: 'history' }
    const replacement = records.slice(index + 1).find(later => supersedesEvidence(later, record))
    if (replacement) return { record, disposition: 'superseded', supersededBy: replacement.id }
    if (Object.entries(scope).some(([key, value]) => value !== undefined && value !== record[key as keyof EvidenceScope] &&
      !(key === 'environmentFingerprint' && record.legacyScopeBinding?.ruleVersion === 'validated-checkpoint-v1' &&
        !evidenceKinds(record).some(kind => ['application', 'desktop', 'duration'].includes(kind)))))
      return { record, disposition: 'stale' }
    if (!record.sourceFingerprint) return { record, disposition: 'insufficient' }
    return { record, disposition: 'current' }
  })
}
