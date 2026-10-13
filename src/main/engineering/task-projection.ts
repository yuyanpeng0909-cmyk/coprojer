import type { Feature, Project } from '../../shared/engineering'
import { classifyEvidence, type EvidenceScope } from '../../shared/current-evidence'
import type { CommandEvidence, ExecutionRole } from './execution'

export class TaskRevisionChanged extends Error {
  constructor() { super('任务修订或基线已变化；迟到结果仅保存为历史，未推进当前任务。'); this.name = 'TaskRevisionChanged' }
}
export function taskProjection(p: Project, f: Feature, role: ExecutionRole, tools: string[], commands: CommandEvidence[],
  scope: Required<EvidenceScope>, executionRunId: string) {
  const records = classifyEvidence(commands, scope).map(({ record: c, disposition, supersededBy }) => ({
    id: c.id, command: c.command, code: c.code, disposition, supersededBy, runId: c.runId, artifactId: c.artifact?.id,
    taskRevision: c.taskRevision, sourceFingerprint: c.sourceFingerprint, durationMs: c.durationMs, output: c.output.slice(-1000),
    measurements: c.measurements, kinds: c.evidenceKinds ?? (c.evidenceKind ? [c.evidenceKind] : []),
    legacyScopeBinding: c.legacyScopeBinding,
  }))
  const evidence: NonNullable<Feature['evidenceProjection']> = { version: 1, ...scope, executionRunId, updatedAt: new Date().toISOString(), records }
  return { version: 1, projectId: p.id, taskId: f.id, taskRevision: f.revision, executionRunId,
    goal: { title: f.title, description: f.description }, criteria: [...f.criteria], phase: f.stage, attempt: f.repairRound,
    authorization: { root: p.root, role, tools: [...tools], finalAcceptance: 'user-only', protected: ['目标', '验收标准', '.coprojer', '项目外资料'] },
    baseline: { contractFingerprint: scope.contractFingerprint, baselineId: f.baselineId, prototypeId: f.prototypeId },
    handoff: {
      changes: p.changes.filter(c => c.featureId === f.id).map(c => ({ path: c.path, kind: c.before === null ? 'created' : 'modified' })),
      unfinished: f.tasks.filter(t => !t.done).map(t => ({ id: t.id, title: t.title })),
      nextStep: f.contextRuntime?.reason ?? (role === 'reviewer' ? '独立读取实际工程并执行当前验收所需检查。' : '按当前任务和有效证据继续未完成工作。'),
      originalRef: f.runtimeHandoff ? 'handoff-original:' + f.runtimeHandoff.originalId : undefined,
      independentVerification: '开发说明和迁移历史不是验证通过；验证角色必须独立读取实际工程、运行检查。',
    },
    evidence, unresolved: records.filter(r => r.disposition === 'current' && r.code !== 0).map(r => r.id),
    sources: p.context.filter(c => !c.featureId || c.featureId === f.id).map(c => ({ id: c.id, source: c.source })),
    rule: '此投影由宿主事实重建，摘要与模型说明不能改写。superseded/stale/history/insufficient 不是当前通过或当前阻塞；完整台账与原始制品仍可回查。',
  }
}
