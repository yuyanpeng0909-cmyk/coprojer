import type { ModelCapabilities, ModelProfile, RequestBudget } from '../../shared/model-profile'
import type { ModelConfig } from '../../shared/engineering'
import { reasoningCapability } from '../../shared/reasoning'
import { defaultContextPolicy, measureInput, measurementIdentity, validateContextPolicy } from './context-budget'

export function validateCapabilities(value: unknown, protocol: ModelConfig['protocol']): ModelCapabilities | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型容量声明必须为对象。')
  const input = value as Record<string, unknown>
  const allowed = ['contextWindowTokens', 'maxOutputTokens', 'outputParameter', 'windowAccounting', 'reasoningAccounting', 'extraReasoningTokens', 'toolCalling', 'usageSupported', 'nativeCompatibilityKey', 'contextPolicy', 'tokenCounting', 'nativeCompaction', 'transportByteLimit']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('模型容量声明包含未知字段。')
  for (const key of ['contextWindowTokens', 'maxOutputTokens', 'extraReasoningTokens']) if (input[key] !== undefined &&
    (!Number.isSafeInteger(input[key]) || (input[key] as number) < 1 || (input[key] as number) > 10_000_000)) throw new Error('模型容量必须为正整数 token 数。')
  for (const key of ['toolCalling', 'usageSupported']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('模型能力声明必须为布尔值。')
  if (input.windowAccounting !== undefined && !['input-plus-output', 'input-only'].includes(input.windowAccounting as string)) throw new Error('上下文窗口计量方式无效。')
  if (input.reasoningAccounting !== undefined && !['included-in-output', 'separate'].includes(input.reasoningAccounting as string)) throw new Error('推理计量方式无效。')
  if (input.reasoningAccounting === 'separate' && input.extraReasoningTokens === undefined) throw new Error('独立推理预留未知，不能按零计算；请明确声明 extraReasoningTokens。')
  const parameters = protocol === 'chat' ? ['max_tokens', 'max_completion_tokens'] : [protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']
  if (input.outputParameter !== undefined && !parameters.includes(input.outputParameter as string)) throw new Error('输出限制参数与协议不兼容。')
  if (input.nativeCompatibilityKey !== undefined && (typeof input.nativeCompatibilityKey !== 'string' || !input.nativeCompatibilityKey.trim() || input.nativeCompatibilityKey.length > 200)) throw new Error('原生兼容标识无效。')
  if (input.maxOutputTokens !== undefined && !input.outputParameter && protocol !== 'anthropic') throw new Error('声明输出上限时须明确连接支持的输出参数。')
  validateContextPolicy(input.contextPolicy)
  for (const key of ['tokenCounting', 'nativeCompaction']) if (input[key] !== undefined && (input[key] !== 'responses' || protocol !== 'responses')) throw new Error('原生计数和压缩只支持已声明能力的 Responses 连接。')
  if (input.transportByteLimit !== undefined && (!Number.isSafeInteger(input.transportByteLimit) || (input.transportByteLimit as number) < 1024 || (input.transportByteLimit as number) > 16 * 1024 * 1024)) throw new Error('传输字节上限必须为 1024 至 16777216。')
  if ((input.contextPolicy as any)?.compactor === 'responses-native' && (input.nativeCompaction !== 'responses' || input.tokenCounting !== 'responses' || !input.nativeCompatibilityKey)) throw new Error('原生压缩需要声明计数、压缩及兼容标识。')
  return structuredClone(input) as ModelCapabilities
}

export function modelProfile(connection: Pick<ModelConfig, 'id' | 'baseUrl' | 'model' | 'protocol' | 'capabilities' | 'checks'>): ModelProfile {
  const declared = validateCapabilities(connection.capabilities, connection.protocol) ?? {}
  return {
    version: 1, identity: { connectionId: connection.id, baseUrl: connection.baseUrl, model: connection.model, protocol: connection.protocol },
    declared, documentation: [], connectionVerification: connection.checks ? structuredClone(connection.checks) : null,
    reasoning: reasoningCapability(connection),
    unknown: ['contextWindowTokens', 'maxOutputTokens', 'windowAccounting', 'reasoningAccounting', 'toolCalling', 'usageSupported', 'nativeCompatibilityKey']
      .filter(key => declared[key as keyof ModelCapabilities] === undefined),
  }
}

// Inspect only protocol content, never arbitrary tool arguments or JSON text.
function requiresProviderCount(payload: string, protocol: ModelConfig['protocol']): boolean {
  const body = JSON.parse(payload)
  const textContent = (content: unknown): boolean => typeof content === 'string' || content == null || Array.isArray(content) && content.every(block =>
    block && ['text', 'input_text', 'output_text', 'summary_text', 'refusal'].includes(block.type) && !block.encrypted_content)
  if (protocol === 'responses') return !Array.isArray(body.input) || body.input.some((item: any) => {
    if (item.encrypted_content) return true
    if (item.type === 'function_call') return typeof item.arguments !== 'string'
    if (item.type === 'function_call_output') return !textContent(item.output)
    if (item.type === 'reasoning') return !textContent(item.summary) || item.content !== undefined && !textContent(item.content)
    return item.type !== undefined && item.type !== 'message' || !textContent(item.content)
  })
  if (protocol === 'anthropic') return body.messages.some((message: any) => typeof message.content !== 'string' && (!Array.isArray(message.content) || message.content.some((block: any) => {
    if (block.type === 'tool_use') return false
    if (block.type === 'tool_result') return !textContent(block.content)
    return !['text', 'thinking'].includes(block.type) || !!block.encrypted_content
  })))
  return body.messages.some((message: any) => !textContent(message.content) || !!message.audio)
}

export function requestBudget(payload: string, profile: ModelProfile, actualOutputLimit?: number): RequestBudget {
  const declaration = profile.declared, bytes = Buffer.byteLength(payload)
  const policy = declaration.contextPolicy ?? defaultContextPolicy
  const known = declaration.contextWindowTokens !== undefined && declaration.windowAccounting !== undefined && declaration.reasoningAccounting !== undefined && actualOutputLimit !== undefined
  const adaptive = policy.mode === 'adaptive' && known
  const measurement = adaptive ? measureInput(payload, profile) : { estimatedInputTokens: Math.ceil(bytes / 3), estimateMethod: 'utf8-bytes-divided-by-3-v1' as const, measurementIdentity: measurementIdentity(profile) }
  const { estimatedInputTokens } = measurement
  const outputTokens = actualOutputLimit ?? declaration.maxOutputTokens ?? 8192
  const extraReasoningTokens = declaration.reasoningAccounting === 'separate' ? declaration.extraReasoningTokens : declaration.reasoningAccounting === 'included-in-output' ? 0 : undefined
  const safetyTokens = adaptive ? Math.max(4000, measurement.estimateMethod === 'provider-count-v1' ? Math.ceil(declaration.contextWindowTokens! / 16000) * 1000 : Math.ceil(declaration.contextWindowTokens! * .1)) : Math.max(256, Math.ceil(estimatedInputTokens * 0.1))
  const reserved = safetyTokens + (declaration.windowAccounting === 'input-only' ? 0 : outputTokens + (extraReasoningTokens ?? 0))
  return {
    requestCharacters: payload.length, requestBytes: bytes, ...measurement, policy, adaptive,
    requiresProviderCount: adaptive && requiresProviderCount(payload, profile.identity.protocol),
    fallbackReason: policy.mode === 'adaptive' && !known ? '窗口、输出限制或计量规则不完整，继续使用兼容保护。' : undefined,
    inputLimit: declaration.contextWindowTokens === undefined ? undefined : declaration.contextWindowTokens - reserved,
    contextWindowTokens: declaration.contextWindowTokens,
    reserves: { outputTokens, extraReasoningTokens, safetyTokens,
      outputSource: declaration.maxOutputTokens !== undefined ? 'declared' : actualOutputLimit !== undefined ? 'adapter-default' : 'policy-estimate',
      accountingKnown: declaration.windowAccounting !== undefined && declaration.reasoningAccounting !== undefined &&
        (declaration.reasoningAccounting !== 'separate' || declaration.extraReasoningTokens !== undefined) },
    estimatedTotalTokens: estimatedInputTokens + reserved,
    characterLimit: adaptive ? Number.MAX_SAFE_INTEGER : 160000, byteLimit: Math.min(adaptive ? 16 * 1024 * 1024 : 640000, declaration.transportByteLimit ?? Infinity),
  }
}
