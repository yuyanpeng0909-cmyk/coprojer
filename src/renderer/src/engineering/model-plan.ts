import type { AgentModelPlan } from '../../../shared/engineering'
import { isModelEvidenceUrl, modelCapabilityLabels } from '../../../shared/model-evidence'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const optionalNumber = (value: unknown) => value === undefined || finite(value)
const category = (value: unknown) => text(value) && Object.hasOwn(modelCapabilityLabels, value)
const reasoning = (value: unknown) => value === undefined || record(value) && typeof value.enabled === 'boolean' && (value.effort === undefined || ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value.effort))) && optionalNumber(value.budget)
function validScore(score: unknown, source: Record<string, unknown>): boolean {
  return record(score) && text(score.model) && finite(score.score)
    && (score.metric === undefined ? source.source !== 'aa' && finite(score.rank) && finite(score.votes) : source.source === 'aa' && score.metric === source.category && isModelEvidenceUrl(score.url) && /^https:\/\/artificialanalysis[.]ai\/models\/[a-z0-9-]+$/.test(score.url))
    && typeof score.preliminary === 'boolean'
    && optionalNumber(score.lower) && optionalNumber(score.upper) && optionalNumber(score.inputPrice) && optionalNumber(score.outputPrice)
}

// A hot-reloaded renderer can still be connected to an older main process.
// Validate the IPC reply before putting it into React state: render errors do
// not reach the async request's catch handler and would unmount the workbench.
export function isAgentModelPlan(value: unknown): value is AgentModelPlan {
  if (!record(value) || !text(value.id) || !value.id || !text(value.caveat) || !['quality', 'pareto'].includes(String(value.policy))) return false
  if (!Array.isArray(value.choices) || !value.choices.length || !value.choices.every(choice =>
    record(choice) && text(choice.agentId) && text(choice.modelId) && text(choice.previousModelId)
    && text(choice.reason) && category(choice.category) && reasoning(choice.reasoning) && typeof choice.supported === 'boolean')) return false
  if (value.usage !== undefined) {
    const usage = value.usage
    if (!record(usage) || !text(usage.connectionId) || !text(usage.connectionName) || !text(usage.requestedModel)
      || !Array.isArray(usage.reportedModels) || !usage.reportedModels.every(text)) return false
  }
  return Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(source => {
    if (!record(source) || !category(source.category) || !isModelEvidenceUrl(source.url) || !text(source.fetchedAt)
      || source.updatedAt !== undefined && !text(source.updatedAt) || !text(source.note)
      || source.agentId !== undefined && !text(source.agentId) || source.source !== undefined && !['aa', 'arena'].includes(String(source.source))
      || !['fresh', 'stale', 'unavailable'].includes(String(source.status)) || !Array.isArray(source.candidates)) return false
    return source.candidates.every(candidate => {
      if (!record(candidate) || !text(candidate.connectionId) || !text(candidate.model)
        || !['exact', 'unmatched', 'ambiguous'].includes(String(candidate.match))
        || !['frontier', 'dominated', 'unknown'].includes(String(candidate.pareto))
        || ['displayName', 'query', 'matchNote'].some(key => candidate[key] !== undefined && !text(candidate[key]))) return false
      const score = candidate.score
      if (score !== undefined && !validScore(score, source)) return false
      return candidate.similar === undefined || Array.isArray(candidate.similar) && candidate.similar.length <= 3 && candidate.similar.every(reference =>
        record(reference) && isModelEvidenceUrl(reference.url) && text(reference.note) && validScore(reference.score, source)
        && new URL(reference.url).origin === new URL(source.url as string).origin)
    })
  })
}
