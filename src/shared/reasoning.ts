import type { ModelConfig } from './engineering'

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** Owned by an agent instance, never by the shared model connection. */
export interface AgentReasoning {
  enabled: boolean
  effort?: ReasoningEffort
  /** Omitted means the provider's documented maximum thinking budget. */
  budget?: number
}
export type ReasoningModel = Pick<ModelConfig, 'model' | 'baseUrl' | 'protocol'>
export interface ReasoningCapability {
  kind: 'effort' | 'budget' | 'unknown'
  canDisable: boolean
  efforts: ReasoningEffort[]
  maxBudget?: number
  adapter?: 'aliyun-chat' | 'aliyun-responses' | 'glm-chat' | 'kimi-chat'
  note: string
}
const unknown: ReasoningCapability = { kind: 'unknown', canDisable: false, efforts: [], note: '此连接的型号或协议尚无已核实的推理参数，沿用服务默认；不会发送猜测的档位。' }
export const effortLabels: Record<ReasoningEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

/** Reviewed against provider documentation on 2026-09-28. Exact host and model contracts only. */
export function reasoningCapability(model?: ReasoningModel): ReasoningCapability {
  if (!model) return unknown
  let host: string
  try { host = new URL(model.baseUrl).hostname.toLowerCase() } catch { return unknown }
  const id = model.model.toLowerCase()
  const aliyun = /^dashscope(?:-intl|-us)?[.]aliyuncs[.]com$/.test(host) || host.endsWith('.maas.aliyuncs.com')
  const effort = (efforts: ReasoningEffort[], canDisable: boolean, adapter: ReasoningCapability['adapter']): ReasoningCapability => ({ kind: 'effort', canDisable, efforts, adapter,
    note: canDisable ? '默认使用该型号支持的最高档位；设置仅作用于此智能体。' : '此型号始终推理，服务不允许关闭；默认使用最高档位。' })
  if (aliyun && model.protocol === 'chat') {
    if (['glm-5.3', 'zhipu/glm-5.3', 'zhipu/glm-5.3-flash', 'zhipu/glm-5.3-flashx', 'kimi-k3'].includes(id)) return effort(['low', 'high', 'max'], false, 'aliyun-chat')
    if (id === 'kimi/kimi-k3') return effort(['max'], false, 'aliyun-chat')
    if (['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-2.4t-a95b', 'qwen3.8-27b'].includes(id)) return effort(['low', 'medium', 'xhigh'], true, 'aliyun-chat')
    if (id === 'qwen3.7-flash') return { kind: 'budget', canDisable: true, efforts: [], maxBudget: 262144, adapter: 'aliyun-chat', note: '此型号使用思考 Token 预算，不支持 Low / High / Max 档位。默认使用最大预算；预算上限不代表每次都会用满。' }
  }
  if (aliyun && model.protocol === 'responses') {
    if (id === 'glm-5.3') return effort(['low', 'high', 'max'], false, 'aliyun-responses')
    if (['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-2.4t-a95b', 'qwen3.8-27b'].includes(id)) return effort(['low', 'medium', 'xhigh'], true, 'aliyun-responses')
    if (['deepseek-v4-flash-0731', 'deepseek-v4-pro-0813', 'deepseek-v4.1-flash'].includes(id)) return effort(['low', 'high', 'max'], true, 'aliyun-responses')
    if (['glm-5.2', 'deepseek-v4-pro', 'deepseek-v4-flash'].includes(id)) return effort(['high', 'max'], true, 'aliyun-responses')
  }
  if (model.protocol === 'chat' && ['open.bigmodel.cn', 'api.z.ai'].includes(host) && ['glm-5.3', 'glm-5.3-flash'].includes(id)) return effort(['low', 'high', 'max'], false, 'glm-chat')
  if (model.protocol === 'chat' && ['api.moonshot.cn', 'api.moonshot.ai'].includes(host) && id === 'kimi-k3') return effort(['low', 'high', 'max'], false, 'kimi-chat')
  return unknown
}

export function defaultReasoning(model?: ReasoningModel): AgentReasoning | undefined {
  const c = reasoningCapability(model)
  return c.kind === 'unknown' ? undefined : { enabled: true, ...(c.kind === 'effort' ? { effort: c.efforts.at(-1)! } : {}) }
}

/** Fail closed for invalid saved/IPC settings; never silently change the requested effort. */
export function resolveReasoning(model: ReasoningModel, input?: AgentReasoning): AgentReasoning | undefined {
  const c = reasoningCapability(model)
  if (input === undefined) return defaultReasoning(model)
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') throw new Error('智能体推理配置无效。')
  if (c.kind === 'unknown') throw new Error('此型号或协议尚未支持自定义推理设置，请使用服务默认。')
  if (!input.enabled && !c.canDisable) throw new Error('此型号始终推理，不能关闭推理。')
  if (c.kind === 'effort') {
    if (input.budget !== undefined || input.effort !== undefined && !c.efforts.includes(input.effort)) throw new Error('此型号不支持所选推理强度，请重新选择。')
    return { enabled: input.enabled, effort: input.effort ?? c.efforts.at(-1)! }
  }
  if (input.effort !== undefined || input.budget !== undefined && (!Number.isInteger(input.budget) || input.budget < 1 || input.budget > c.maxBudget!)) throw new Error('思考预算超出此型号支持的范围。')
  return { enabled: input.enabled, ...(input.budget !== undefined ? { budget: input.budget } : {}) }
}

/** Preserve compatible settings on model changes, otherwise explicitly reset to the new model's maximum. */
export function reasoningForModel(model: ReasoningModel, input?: AgentReasoning): AgentReasoning | undefined {
  try { return resolveReasoning(model, input) } catch { return defaultReasoning(model) }
}
export function reasoningLabel(model: ReasoningModel, input?: AgentReasoning): string {
  let r: AgentReasoning | undefined
  try { r = resolveReasoning(model, input) } catch { return '推理配置待调整' }
  if (!r) return '推理：服务默认'
  if (!r.enabled) return '不推理'
  return r.effort ? effortLabels[r.effort] : r.budget === undefined ? '推理 · 最大预算' : '推理 · ' + r.budget.toLocaleString('en-US') + ' tokens'
}
export function agentModelLabel(model?: ReasoningModel, input?: AgentReasoning): string {
  return model ? model.model + ' · ' + reasoningLabel(model, input) : '尚未选择模型'
}

/** Only provider parameters go here. The API model ID remains byte-for-byte unchanged. */
export function reasoningRequest(model: ReasoningModel, input?: AgentReasoning): Record<string, unknown> {
  if (input === undefined) return {}
  const r = resolveReasoning(model, input)!, c = reasoningCapability(model)
  if (c.adapter === 'aliyun-responses') return { reasoning: { effort: r.enabled ? r.effort : 'none' } }
  if (c.adapter === 'aliyun-chat') return {
    ...(c.canDisable ? { enable_thinking: r.enabled } : {}),
    ...(r.enabled && r.effort ? { reasoning_effort: r.effort } : {}),
    ...(r.enabled && c.kind === 'budget' && r.budget !== undefined ? { thinking_budget: r.budget } : {}),
  }
  if (c.adapter === 'glm-chat') return { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: r.effort }
  if (c.adapter === 'kimi-chat') return { reasoning_effort: r.effort }
  return {}
}
