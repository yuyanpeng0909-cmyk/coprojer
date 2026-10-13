import { createHash } from 'node:crypto'
import type { ContextGrowthState, TokenCalibration } from '../../shared/model-profile'
import type { Connection, ModelMessage, ModelReply } from './model'
import type { RuntimeSnapshot } from './runtime'
import { RecoveryRequired } from './reliability'

export interface RequiredReadCoverage { id: string; read: number; total: number | null; version: string }
export interface ContextContinuity {
  version: 1
  sourceIdentity: string
  inputBaselineHash: string
  requiredReads?: RequiredReadCoverage[]
  historyCursor?: { throughMessageId: string; prefixHash: string }
  growth?: ContextGrowthState
  calibration?: TokenCalibration
  continuationArtifactId?: string
  indexArtifactId?: string
  completedReply?: ModelReply
  nativeWindow?: { version: 1; identity: string; reference: string; throughSequence: number; canonicalHash: string; inputTokens: number }
  nativeDisabledIdentity?: string
  discussion?: { turnId: string; autonomousSteps: number; failedSteps: number; versions: [string, number][]; documentVersion: string;
    pending?: { entryId: string; reply: ModelReply }; completed?: boolean }
}
export const continuityHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const canonicalHistoryHash = (messages: ModelMessage[]) => continuityHash(messages.map(m => ({ role: m.role, content: m.content, sequence: m.sequence, calls: m.calls, callId: m.callId })))
export function assertContinuity(value: ContextContinuity): void {
  if (value.version !== 1) throw new RecoveryRequired('续接记录版本未知，保留原件，禁止自动执行。')
  const n = value.nativeWindow
  if (n && (n.version !== 1 || !Number.isSafeInteger(n.throughSequence) || n.throughSequence < 0 || !Number.isSafeInteger(n.inputTokens) || n.inputTokens < 0 ||
    typeof n.identity !== 'string' || !/^[a-f0-9]{64}$/.test(n.canonicalHash) || !/^opaque:[a-f0-9-]{36}:[a-f0-9]{64}$/.test(n.reference)))
    throw new RecoveryRequired('原生窗口版本或记录未知，保留原件，禁止自动执行。')
}
export function newContinuity(sourceIdentity: string, inputBaselineHash: string): ContextContinuity {
  return { version: 1, sourceIdentity, inputBaselineHash }
}
export function compatibleSnapshot(snapshot: RuntimeSnapshot | undefined, identity: string, baseline: string): snapshot is RuntimeSnapshot & { continuity: ContextContinuity } {
  if (snapshot && snapshot.version !== 2 && snapshot.version !== 3) throw new RecoveryRequired('快照版本未知，原件保留。')
  if (snapshot?.continuity) assertContinuity(snapshot.continuity)
  return !!snapshot && [2, 3].includes(snapshot.version) && snapshot.continuity?.version === 1 &&
    snapshot.continuity.sourceIdentity === identity && snapshot.continuity.inputBaselineHash === baseline
}
export function continuationDocument(snapshot: RuntimeSnapshot): string {
  const latest = snapshot.messages.filter(m => m.role === 'user' && !m.content.startsWith('[已完成工作摘要')).at(-1)
  return ['# 当前工作续接记录', '此记录由宿主生成；目标、权限和验收状态以当次宿主事实为准。',
    `已提交序列：${snapshot.lastSequence}；已执行工作步：${snapshot.steps}`,
    latest ? '## 当前请求摘录\n' + latest.content.slice(0, 2400) + (latest.content.length > 2400 ? '\n完整要求仍保留在规范历史。' : '') : '',
    '## 必读进度\n' + JSON.stringify(snapshot.continuity?.requiredReads ?? []),
    '## 已读取来源索引\n' + JSON.stringify(snapshot.reads.slice(-24).map(r => ({ sourceId: r.sourceId, scope: r.scope, version: r.version, active: r.active }))) + '\n完整索引：' + (snapshot.continuity?.indexArtifactId ?? '快照 reads'),
    '## 后续动作\n继续未读范围；旧工具细节按归档 ID 定向读取，不重新执行原命令获取日志。',
    '## 近期过程结论待核对\n' + snapshot.messages.filter(m => m.role === 'assistant' && m.content).slice(-2).map(m => m.content.slice(0, 1400)).join('\n'),
  ].filter(Boolean).join('\n\n')
}
export function historyPrefixHash(messages: { id: string; role: string; text: string; status?: string }[], through: string): string | undefined {
  const i = messages.findIndex(m => m.id === through)
  return i < 0 ? undefined : continuityHash(messages.slice(0, i + 1).map(m => [m.id, m.role, m.text, m.status]))
}
export function portableMessages(messages: ModelMessage[], connection?: Connection): ModelMessage[] {
  return messages.map(message => {
    const origin = message.origin, same = connection && origin && origin.identity.connectionId === connection.id && origin.identity.baseUrl === connection.baseUrl && origin.identity.model === connection.model && origin.identity.protocol === connection.protocol
    const opaque = /encrypted_content|redacted_thinking/.test(JSON.stringify([message.responseItems, message.anthropicBlocks]))
    if (same && (!opaque || !!origin.nativeCompatibilityKey && origin.nativeCompatibilityKey === connection!.capabilities?.nativeCompatibilityKey)) return structuredClone(message)
    if ((message.reasoning || message.responseItems?.length || message.anthropicBlocks?.length) && !message.content && !message.calls?.length)
      throw new RecoveryRequired('原生历史缺少规范内容，不能静默删除后恢复。')
    const { responseItems: _r, anthropicBlocks: _a, reasoning: _t, origin: _o, ...m } = message
    return structuredClone(m)
  })
}
