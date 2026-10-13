import type { ExecutionCheckpoint } from './execution'
import { assertProtocolHistory } from './protocol-history'
import { validateCapabilities } from './model-profile'
import { assertContinuity } from './context-continuity'

export const isReceiptCheckpoint = (value?: ExecutionCheckpoint): boolean => value?.version === 3 || value?.version === 4

/** Unknown records stay readable in storage, but must never initiate work. */
export function assertSupportedCheckpoint(value: ExecutionCheckpoint): void {
  if (value.version === undefined && value.manifest === undefined) return // supported legacy complete-round format
  const manifest = value.manifest
  const unsupported = () => { throw new Error('检查点或运行清单版本未知/记录不完整；原记录保留供诊断，禁止自动执行。') }
  if (![2, 3, 4].includes(value.version ?? 0) || !manifest || manifest.version !== 1 || manifest.profile?.version !== 1) return unsupported()
  const versions = manifest.versions
  if (!versions || versions.harness !== 'runtime-v1' || !['prepared-request-v1', 'prepared-request-v2'].includes(versions.context) ||
    !['engineering-tools-v1', 'engineering-tools-v2', 'engineering-tools-v3'].includes(versions.tools) || versions.permissions !== 'engineering-roles-v1' ||
    versions.result !== value.role + '-v1' || versions.checkpoint !== (isReceiptCheckpoint(value) ? 'receipts-group-v1' : 'complete-round-v2')) return unsupported()
  if (value.version === 4 && (!value.continuity || value.continuity.version !== 1 || typeof value.continuity.sourceIdentity !== 'string' || typeof value.continuity.inputBaselineHash !== 'string')) return unsupported()
  if (value.continuity) assertContinuity(value.continuity)
  if (!Array.isArray(value.messages) || !Array.isArray(value.commands) || !Number.isSafeInteger(manifest.taskRevision) ||
    typeof manifest.id !== 'string' || typeof manifest.environment !== 'string' || !manifest.model || !manifest.profile.identity ||
    !['chat', 'responses', 'anthropic'].includes(manifest.model.protocol) || manifest.credentialRef !== manifest.model.connectionId) return unsupported()
  for (const key of ['connectionId', 'baseUrl', 'model', 'protocol'] as const)
    if (typeof manifest.model[key] !== 'string' || manifest.model[key] !== manifest.profile.identity[key]) return unsupported()
  if (value.lastSequence !== undefined && (!Number.isSafeInteger(value.lastSequence) || value.lastSequence < 0)) return unsupported()
  validateCapabilities(manifest.profile.declared, manifest.model.protocol)
  assertProtocolHistory(value.messages, manifest.model.protocol)
  if (value.pending) {
    const group = value.pending
    if (!isReceiptCheckpoint(value) || group.version !== 1 || typeof group.id !== 'string' || !Number.isSafeInteger(group.step) || group.step < 0 ||
      group.assistant?.role !== 'assistant' || !group.assistant.calls?.length || !Array.isArray(group.logicalIds) ||
      group.logicalIds.length !== group.assistant.calls.length || group.logicalIds.some(id => typeof id !== 'string' || !id) || new Set(group.logicalIds).size !== group.logicalIds.length) return unsupported()
    assertProtocolHistory([...value.messages, group.assistant, ...group.assistant.calls.map(call => ({ role: 'tool' as const, callId: call.id, content: '' }))], manifest.model.protocol)
    if (group.readPlan) {
      const plan = group.readPlan
      if (plan.version !== 1 || ![1, 2, 4].includes(plan.concurrency) || !Array.isArray(plan.resources) || !Array.isArray(plan.outputLimits) ||
        plan.resources.length !== group.logicalIds.length || plan.outputLimits.length !== group.logicalIds.length ||
        plan.outputLimits.some(n => !Number.isSafeInteger(n) || n < 800) || plan.outputLimits.reduce((a,b) => a+b, 0) > 24000 ||
        plan.resources.some(r => !r || typeof r.path !== 'string' || !['file', 'tree'].includes(r.kind) || !/^[a-f0-9]{64}$/.test(r.version))) return unsupported()
    }
  }
}
