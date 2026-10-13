import type { ModelInput, Protocol } from '../../shared/engineering'
import { createHash, randomUUID } from 'node:crypto'
import type { ModelProfile, RequestBudget } from '../../shared/model-profile'
import type { TokenUsage } from '../../shared/model-traffic'
import { modelProfile, requestBudget } from './model-profile'
import { observeInputUsage, rememberInputCount } from './context-budget'
import { assertProtocolHistory } from './protocol-history'
import { reasoningRequest, type AgentReasoning } from '../../shared/reasoning'
import { readModelStream, type DeltaListener } from './stream'
import { tokenUsage } from '../../shared/model-traffic'
import type { TrafficRecorder, TrafficObservation } from './model-traffic'
export class ContextBudgetError extends Error { name = 'ContextBudgetError' }

export class ModelTransportError extends Error {
  readonly name = 'ModelTransportError'
  constructor(message: string, readonly codes: string[], readonly beforeResponse: boolean) { super(message) }
  get retryable(): boolean {
    return this.beforeResponse && this.codes.some(code => ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
      'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code))
  }
}

export class ModelContextLimitError extends ContextBudgetError {
  constructor(message: string, readonly requestCharacters?: number, readonly limit?: number) {
    super(message)
    this.name = 'ModelContextLimitError'
  }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}
export interface ToolCall {
  id: string
  name: string
  arguments: string
}
export interface ModelMessage {
  origin?: { identity: ModelProfile['identity']; nativeCompatibilityKey?: string; nativeScope?: string }
  /** Local history identity; protocol encoders never send it as a provider field. */
  sequence?: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  calls?: ToolCall[]
  callId?: string
  reasoning?: string
  responseItems?: Record<string, unknown>[]
  anthropicBlocks?: Record<string, unknown>[]
}
export interface ModelReply {
  origin?: ModelMessage['origin']
  text: string
  model?: string
  calls: ToolCall[]
  reasoning?: string
  responseItems?: Record<string, unknown>[]
  anthropicBlocks?: Record<string, unknown>[]
  usage?: TokenUsage
  responseId?: string
}
export interface PreparedModelRequest {
  readonly opaqueWindow?: boolean
  readonly nativeScope?: string
  readonly version: 1
  readonly protocol: Protocol
  readonly model: string
  readonly path: string
  readonly payload: string
  readonly hash: string
  readonly stream: boolean
  readonly profile: ModelProfile
  readonly budget: RequestBudget
}
function executableReply(reply: ModelReply): ModelReply {
  const ids = new Set<string>()
  for (const call of reply.calls) {
    if (!call.id || typeof call.id !== 'string' || ids.has(call.id) || typeof call.name !== 'string' || !call.name || typeof call.arguments !== 'string')
      throw new Error('模型工具调用标识重复或字段不完整，本轮工具未执行。')
    ids.add(call.id)
    try {
      const args = JSON.parse(call.arguments)
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error()
    } catch { throw new Error('模型工具调用参数不是完整 JSON 对象，本轮工具未执行。') }
  }
  return reply
}
export type Connection = ModelInput & { name: string; apiKey: string; nativeScope?: string; requestTimeoutMs?: number; reasoning?: AgentReasoning; traffic?: TrafficRecorder; trafficPurpose?: 'inference' | 'test'; onRequest?: () => void; onResponse?: (update: TrafficObservation) => void; onOperation?: (operation: import('../../shared/model-profile').ContextOperation) => void }

export function normalizedBase(value: string): string {
  const url = new URL(value.trim())
  if (url.username || url.password || url.search || url.hash)
    throw new Error('服务地址不能包含用户名、密码、查询参数或锚点。')
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('远程模型服务请使用 HTTPS；本机服务可使用 HTTP。')
  }
  return url.href
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|responses|messages|models)$/, '')
}
function endpoint(base: string, path: string): string {
  const parsed = new URL(base)
  return `${base}${parsed.pathname === '/' ? '/v1' : ''}/${path}`
}
function headers(c: Connection): Record<string, string> {
  return c.protocol === 'anthropic'
    ? {
        'content-type': 'application/json',
        'x-api-key': c.apiKey,
        'anthropic-version': '2023-06-01',
      }
    : { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` }
}
function needsToolStream(c: Connection, body: unknown): boolean {
  if (c.protocol !== 'chat' || !body || typeof body !== 'object') return false
  const hostname = new URL(c.baseUrl).hostname
  return (
    (['open.bigmodel.cn', 'api.z.ai'].includes(hostname) || /^glm-/i.test(c.model)) &&
    Array.isArray((body as { tools?: unknown }).tools) &&
    (body as { tools: unknown[] }).tools.length > 0
  )
}
function glm53AgentDefaults(c: Connection): Record<string, unknown> {
  const hostname = new URL(c.baseUrl).hostname
  if (
    !/^glm-5(?:\.|-|$)/i.test(c.model) ||
    !['open.bigmodel.cn', 'api.z.ai'].includes(hostname)
  )
    return {}
  // Preserve tool continuation; the agent's own reasoning settings are applied below.
  return {
    thinking: { type: 'enabled', clear_thinking: false },
  }
}
function cleanError(text: string, key: string): string {
  return (key ? text.split(key).join('[已隐藏密钥]') : text)
    .replace(/(?:sk-|Bearer\s+)[a-zA-Z0-9_-]{6,}/g, '[已隐藏密钥]')
    .slice(0, 800)
}
async function request(
  c: Connection,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  onDelta?: DeltaListener,
  prepared?: PreparedModelRequest,
): Promise<any> {
  // Bound the serialized request across all protocols, including skills and tools.
  // This is a character guard, not a provider token estimate.
  const payload = prepared?.payload ?? serializeRequest(c, body, !!onDelta)
  if (prepared) assertPreparedCapacity(prepared)
  if (payload && !prepared && payload.length > 160_000 && c.capabilities?.contextPolicy?.mode !== 'adaptive')
    throw new ModelContextLimitError('本次模型请求超过 160000 字符上限（含资料、技能、工具和对话，并非 token 数）。原始资料已保留。', payload.length, 160000)
  if (payload && Buffer.byteLength(payload) > Math.min(16 * 1024 * 1024, c.capabilities?.transportByteLimit ?? Infinity)) throw new ContextBudgetError('模型请求超过传输字节保护上限。')
  const startedAt = Date.now()
  const transportError = (error: unknown, beforeResponse = false): Error => {
    const codes: string[] = []
    let cause: any = error
    for (let depth = 0; cause && depth < 6; depth++, cause = cause.cause) {
      if (typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(cause.code))
        codes.push(cause.code)
    }
    const code = [...new Set(codes)].join(', ') || 'UNKNOWN'
    const reason = /TIMEOUT|TIMEDOUT/.test(code)
      ? '底层网络超时'
      : /ECONNRESET|UND_ERR_SOCKET/.test(code)
        ? '连接中断'
        : /ENOTFOUND|EAI_AGAIN/.test(code)
          ? '域名解析失败'
          : /CERT|TLS|SSL/.test(code)
            ? 'TLS 或证书校验失败'
            : '网络请求失败'
    // Never serialize cause.message: it may contain credentials or a request URL.
    return new ModelTransportError(`${reason}（${code}；耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒）。请检查模型服务与网络连接。`, [...new Set(codes)], beforeResponse)
  }
  // A design response may contain a complete HTML document and can spend
  // several minutes in reasoning before its first text delta. Keep the
  // timeout bounded, but do not turn a healthy slow stream into a partial
  // result after the old 150-second limit.
  const timeoutMs = Number.isSafeInteger(c.requestTimeoutMs) && c.requestTimeoutMs! > 0
    ? Math.min(c.requestTimeoutMs!, 10 * 60 * 1000) : 10 * 60 * 1000
  const timeout = AbortSignal.timeout(timeoutMs)
  const timeoutError = () => new Error(timeoutMs < 10 * 60 * 1000
    ? `模型响应超时（${Math.ceil(timeoutMs / 1000)} 秒）；本轮未执行尚未完整返回的工具。已完成的执行进度保留，请检查模型响应速度或调整推理强度后继续。`
    : '模型响应超过 10 分钟未完成，已保留已收到的内容，请重试。')
  let response: Response
  const url = endpoint(normalizedBase(c.baseUrl), path)
  signal?.throwIfAborted()
  c.onRequest?.()
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers(c),
      body: payload,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (error) {
    if (timeout.aborted && !signal?.aborted)
      throw timeoutError()
    if (signal?.aborted) throw error
    throw transportError(error, true)
  }
  c.onResponse?.({ httpStatus: response.status })
  try {
    if (response.ok && onDelta && response.headers.get('content-type')?.includes('text/event-stream'))
      return await readModelStream(response, c.protocol, onDelta, usage => c.onResponse?.({ usage: tokenUsage(c.protocol, usage) }))
    const raw = await response.text()
    if (raw.length > 8_000_000) throw new Error('模型返回内容过大，请缩小任务范围。')
    if (!response.ok && [400, 413, 422].includes(response.status) &&
      /context_length_exceeded|maximum context length|context window.{0,80}(?:exceed|limit)|(?:input|prompt).{0,60}(?:too long|exceeds.{0,30}token)|上下文.{0,30}(?:超出|超过|过长)/i.test(raw))
      throw new ModelContextLimitError('模型上下文容量不足：' + cleanError(raw, c.apiKey), payload?.length)
    if (!response.ok) throw new Error(`模型服务返回 ${response.status}：${cleanError(raw, c.apiKey)}`)
    let result: any
    try { result = JSON.parse(raw) } catch {
      throw new Error('服务未返回有效 JSON，请检查接口类型与服务地址。')
    }
    c.onResponse?.({ usage: tokenUsage(c.protocol, result?.usage) })
    return result
  } catch (error) {
    // AbortSignal.timeout aborts the response body reader as well as fetch.
    // Normalize both paths so every caller gets the same actionable message.
    if (timeout.aborted && !signal?.aborted)
      throw timeoutError()
    if (!signal?.aborted && error instanceof TypeError) throw transportError(error)
    throw error
  }
}
export async function getModels(c: Connection): Promise<string[]> {
  const result = await request(c, 'models')
  const items = Array.isArray(result.data) ? result.data : []
  return items
    .map((item: any) => item.id)
    .filter((id: unknown): id is string => typeof id === 'string')
    .slice(0, 500)
}
export async function complete(
  c: Connection,
  system: string,
  messages: ModelMessage[],
  tools: ToolDefinition[] = [],
  signal?: AbortSignal,
  onDelta?: DeltaListener,
  prepared?: PreparedModelRequest,
): Promise<ModelReply> {
  prepared ??= prepareModelRequest(c, system, messages, tools, !!onDelta)
  assertPreparedCapacity(prepared)
  if (prepared.protocol !== c.protocol || prepared.model !== c.model || prepared.profile.identity.baseUrl !== c.baseUrl)
    throw new Error('已准备请求与当前连接不匹配。')
  if (!c.traffic || !c.id) return completeRequest(c, system, messages, tools, signal, onDelta, prepared)
  let recording: ReturnType<TrafficRecorder['start']> | undefined
  const traced: Connection = { ...c,
    onRequest: () => { c.onRequest?.(); try { recording = c.traffic!.start(c, c.trafficPurpose ?? 'inference') } catch { /* Monitoring cannot interrupt inference. */ } },
    onResponse: update => { c.onResponse?.(update); try { recording?.observe(update) } catch { /* Keep inference independent of monitoring. */ } },
  }
  try {
    const reply = await completeRequest(traced, system, messages, tools, signal, onDelta, prepared)
    try { recording?.finish('succeeded') } catch { /* Keep the valid reply. */ }
    return reply
  } catch (error) {
    const timedOut = signal?.reason?.name === 'TimeoutError' || /超时|超过 10 分钟/.test(String(error))
    try { recording?.finish(signal?.aborted && !timedOut ? 'cancelled' : 'failed', timedOut ? 'timeout' : /网络|连接中断|域名|TLS/.test(String(error)) ? 'network' : 'response') } catch { /* Preserve the original model error. */ }
    throw error
  }
}

function serializeRequest(c: Connection, body: unknown, stream: boolean): string | undefined {
  return body === undefined ? undefined : JSON.stringify(stream
    ? { ...(body as object), stream: true, ...(c.protocol === 'chat' ? { stream_options: { include_usage: true } } : {}), ...(needsToolStream(c, body) ? { tool_stream: true } : {}) }
    : body)
}

function buildModelRequest(c: Connection, system: string, messages: ModelMessage[], tools: ToolDefinition[]) {
  // Current-segment replies may roundtrip native state. Persistent history requires
  // a matching declared compatibility key; canonical history remains unchanged.
  messages = messages.map(message => {
    const origin = message.origin
    const same = !!origin && origin.identity.connectionId === c.id && origin.identity.baseUrl === c.baseUrl && origin.identity.model === c.model && origin.identity.protocol === c.protocol
    const compatible = same && !!origin.nativeCompatibilityKey && origin.nativeCompatibilityKey === c.capabilities?.nativeCompatibilityKey
    if (c.nativeScope ? same && (origin?.nativeScope === c.nativeScope || compatible) : !origin || same) return message
    if ((message.reasoning || message.responseItems?.length || message.anthropicBlocks?.length) && !message.content && !message.calls?.length)
      throw new Error('持久历史仅有未确认兼容的原生状态，缺少规范内容；保留原件，请核对后显式续接。')
    const { reasoning: _reasoning, responseItems: _responses, anthropicBlocks: _blocks, ...portable } = message
    return portable
  })
  if (c.protocol === 'anthropic') {
    const input: any[] = []
    for (const m of messages) {
      if (m.role === 'tool') {
        const part = { type: 'tool_result', tool_use_id: m.callId, content: m.content }
        const last = input.at(-1)
        if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(part)
        else input.push({ role: 'user', content: [part] })
      } else if (m.anthropicBlocks?.length) {
        input.push({ role: 'assistant', content: m.anthropicBlocks })
      } else if (m.calls?.length) {
        input.push({
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.calls.map((call) => ({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: JSON.parse(call.arguments),
            })),
          ],
        })
      } else input.push({ role: m.role, content: m.content })
    }
    return {
      path: 'messages',
      body: {
        model: c.model,
        system,
        messages: input,
        max_tokens: 8192,
        ...reasoningRequest(c, c.reasoning),
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      },
    }
  }
  if (c.protocol === 'responses') {
    const input: any[] = []
    for (const m of messages) {
      if (m.role === 'tool')
        input.push({ type: 'function_call_output', call_id: m.callId, output: m.content })
      else if (m.responseItems?.length) input.push(...m.responseItems)
      else {
        if (m.content) input.push({ role: m.role, content: m.content })
        for (const call of m.calls ?? [])
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          })
      }
    }
    return {
      path: 'responses',
      body: {
        model: c.model,
        instructions: system,
        input,
        store: false,
        include: ['reasoning.encrypted_content'],
        ...reasoningRequest(c, c.reasoning),
        ...(tools.length
          ? { tools: tools.map((t) => ({ type: 'function', ...t, strict: false })) }
          : {}),
      },
    }
  }
  return {
    path: 'chat/completions',
    body: {
      model: c.model,
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) => ({
          role: m.role,
          content: m.content || (m.calls?.length ? null : ''),
          ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
          ...(m.callId ? { tool_call_id: m.callId } : {}),
          ...(m.calls?.length
            ? {
                tool_calls: m.calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        })),
      ],
      stream: false,
      ...glm53AgentDefaults(c),
      ...reasoningRequest(c, c.reasoning),
      ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
    },
  }
}

export function modelRequestCharacters(c: Connection, system: string, messages: ModelMessage[], tools: ToolDefinition[], stream = true): number {
  return prepareModelRequest(c, system, messages, tools, stream).budget.requestCharacters
}
export function prepareModelRequest(c: Connection, system: string, messages: ModelMessage[], tools: ToolDefinition[], stream = true): PreparedModelRequest {
  assertProtocolHistory(messages, c.protocol)
  const profile = modelProfile(c), request = buildModelRequest(c, system, messages, tools)
  if (tools.length && profile.declared.toolCalling === false) throw new ContextBudgetError('当前连接声明不支持工具调用，已保存进度。')
  const body = request.body as Record<string, any>
  const parameter = profile.declared.outputParameter ?? (c.protocol === 'anthropic' ? 'max_tokens' : undefined)
  if (parameter && profile.declared.maxOutputTokens !== undefined) body[parameter] = profile.declared.maxOutputTokens
  const payload = serializeRequest(c, body, stream)!
  return Object.freeze({ version: 1, nativeScope: c.nativeScope, protocol: c.protocol, model: c.model, path: request.path, payload,
    hash: createHash('sha256').update(payload).digest('hex'), stream, profile,
    budget: requestBudget(payload, profile, parameter ? body[parameter] : undefined) })
}
export function assertPreparedMeasurement(prepared: PreparedModelRequest): void {
  if (prepared.budget.requiresProviderCount && prepared.budget.estimateMethod !== 'provider-count-v1')
    throw new ContextBudgetError('原生或多模态内容缺少可靠 token 计数，原始视图保留。')
}
export function assertPreparedCapacity(prepared: PreparedModelRequest): void {
  assertPreparedMeasurement(prepared)
  const budget = prepared.budget
  if (budget.requestCharacters > budget.characterLimit)
    throw new ModelContextLimitError(`本次模型请求超过 ${budget.characterLimit} 字符上限（含资料、技能、工具和对话，并非 token 数）。原始资料已保留。`, budget.requestCharacters, budget.characterLimit)
  if (budget.requestBytes > budget.byteLimit)
    throw new ModelContextLimitError(`本次模型请求超过 ${budget.byteLimit} UTF-8 字节保护上限（并非已知模型窗口）。原始资料已保留。`, budget.requestBytes, budget.byteLimit)
  if (budget.contextWindowTokens !== undefined && budget.estimatedTotalTokens > budget.contextWindowTokens)
    throw new ContextBudgetError('当前必需输入与预留超过已声明窗口估算：' + JSON.stringify(budget) + '；已保存现场，未删减目标、授权或标准。')
}

/** Auxiliary operations have their own ledger; never merge their usage into inference. */
export async function auxiliaryModelRequest(c: Connection, kind: 'count' | 'compaction', prepared: PreparedModelRequest, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const operation: import('../../shared/model-profile').ContextOperation = { id: randomUUID(), kind, parentHash: prepared.hash,
    wireHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), at: new Date().toISOString(), status: 'prepared' }
  c.onOperation?.(structuredClone(operation))
  let recording: ReturnType<TrafficRecorder['start']> | undefined
  try {
    const result = await request({ ...c, onRequest: () => { c.onRequest?.(); try { recording = c.traffic?.start(c, kind) } catch {} },
      onResponse: update => { if (update.usage && Object.values(update.usage).some(v => v !== undefined)) operation.usage = update.usage; try { recording?.observe(update) } catch {} } },
      kind === 'count' ? 'responses/input_tokens' : 'responses/compact', body, signal)
    operation.status = 'completed'; c.onOperation?.(structuredClone(operation)); try { recording?.finish('succeeded') } catch {}
    return result
  } catch (error) {
    try { recording?.finish(signal?.aborted ? 'cancelled' : 'failed', 'response') } catch {}
    operation.status = 'failed'; operation.error = cleanError(String(error), c.apiKey)
    c.onOperation?.(structuredClone(operation)); throw error
  }
}
export async function verifyModelRequest(c: Connection, prepared: PreparedModelRequest, signal?: AbortSignal): Promise<PreparedModelRequest> {
  if (!prepared.budget.adaptive || c.capabilities?.tokenCounting !== 'responses' || prepared.budget.estimateMethod === 'provider-count-v1') return prepared
  const source = JSON.parse(prepared.payload), body: Record<string, unknown> = { model: source.model, input: source.input }
  for (const key of ['instructions', 'tools', 'tool_choice', 'text', 'reasoning']) if (source[key] !== undefined) body[key] = source[key]
  const result = await auxiliaryModelRequest(c, 'count', prepared, body, signal)
  rememberInputCount(prepared.profile, prepared.payload, result.input_tokens)
  return Object.freeze({ ...prepared, budget: requestBudget(prepared.payload, prepared.profile, prepared.budget.reserves.outputTokens) })
}
async function completeRequest(
  c: Connection,
  system: string,
  messages: ModelMessage[],
  tools: ToolDefinition[] = [],
  signal?: AbortSignal,
  onDelta?: DeltaListener,
  prepared?: PreparedModelRequest,
): Promise<ModelReply> {
  const protocol: Protocol = c.protocol
  prepared ??= prepareModelRequest(c, system, messages, tools, !!onDelta)
  const result = await request(c, prepared.path, {}, signal, onDelta, prepared)
  const receipt = { usage: tokenUsage(protocol, result?.usage), responseId: typeof result?.id === 'string' ? result.id : undefined }
  if (!prepared.opaqueWindow) observeInputUsage(prepared.budget, receipt.usage.inputTokens)
  if (protocol === 'anthropic') {
    if (!Array.isArray(result?.content)) throw new Error('服务返回中缺少模型回复，请检查模型名称和协议。')
    if (['max_tokens', 'refusal', 'pause_turn'].includes(result.stop_reason)) throw new Error('模型输出被截断或尚未完成，本轮工具未执行。')
    return executableReply({
      ...receipt,
      anthropicBlocks: result.content,
      model: typeof result.model === 'string' ? result.model : undefined,
      reasoning: (result.content ?? [])
        .filter((p: any) => p.type === 'thinking')
        .map((p: any) => p.thinking)
        .join('\n'),
      text: (result.content ?? [])
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('\n'),
      calls: (result.content ?? [])
        .filter((p: any) => p.type === 'tool_use')
        .map((p: any) => ({ id: p.id, name: p.name, arguments: JSON.stringify(p.input) })),
    })
  }
  if (protocol === 'responses') {
    if (!Array.isArray(result?.output) || ['failed', 'incomplete'].includes(result.status)) throw new Error('服务返回中缺少完整模型回复，请检查模型名称和协议。')
    return executableReply({
      ...receipt,
      responseItems: result.output,
      model: typeof result.model === 'string' ? result.model : undefined,
      text: (result.output ?? [])
        .flatMap((item: any) => item.content ?? [])
        .filter((p: any) => p.type === 'output_text')
        .map((p: any) => p.text)
        .join('\n'),
      calls: (result.output ?? [])
        .filter((item: any) => item.type === 'function_call')
        .map((item: any) => ({ id: item.call_id, name: item.name, arguments: item.arguments })),
    })
  }
  const message = result.choices?.[0]?.message
  if (!message) throw new Error('服务返回中缺少模型回复，请检查模型名称和协议。')
  if (['length', 'content_filter'].includes(result.choices?.[0]?.finish_reason)) throw new Error('模型输出被截断，本轮工具未执行。')
  return executableReply({
    ...receipt,
    text: typeof message.content === 'string' ? message.content : '',
    model: typeof result.model === 'string' ? result.model : undefined,
    reasoning: message.reasoning_content,
    calls: (message.tool_calls ?? []).map((call: any) => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
    })),
  })
}
export function parseJson(text: string): any {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(clean)
  } catch {
    const start = clean.indexOf('{'),
      end = clean.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1))
    throw new Error('模型输出格式不完整，请重试；已有内容已保留。')
  }
}
