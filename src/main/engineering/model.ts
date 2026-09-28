import type { ModelInput, Protocol } from '../../shared/engineering'
import { reasoningRequest, type AgentReasoning } from '../../shared/reasoning'
import { readModelStream, type DeltaListener } from './stream'
import { tokenUsage } from '../../shared/model-traffic'
import type { TrafficRecorder, TrafficObservation } from './model-traffic'
export class ContextBudgetError extends Error { name = 'ContextBudgetError' }

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
  role: 'user' | 'assistant' | 'tool'
  content: string
  calls?: ToolCall[]
  callId?: string
  reasoning?: string
  responseItems?: Record<string, unknown>[]
  anthropicBlocks?: Record<string, unknown>[]
}
export interface ModelReply {
  text: string
  model?: string
  calls: ToolCall[]
  reasoning?: string
  responseItems?: Record<string, unknown>[]
  anthropicBlocks?: Record<string, unknown>[]
}
export type Connection = ModelInput & { name: string; apiKey: string; reasoning?: AgentReasoning; traffic?: TrafficRecorder; trafficPurpose?: 'inference' | 'test'; onRequest?: () => void; onResponse?: (update: TrafficObservation) => void }

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
): Promise<any> {
  // Bound the serialized request across all protocols, including skills and tools.
  // This is a character guard, not a provider token estimate.
  const payload = serializeRequest(c, body, !!onDelta)
  if (payload && payload.length > 160_000)
    throw new ModelContextLimitError('本次模型请求超过 160000 字符上限（含资料、技能、工具和对话，并非 token 数）。原始资料已保留。', payload.length, 160000)
  const startedAt = Date.now()
  const transportError = (error: unknown): Error => {
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
    return new Error(`${reason}（${code}；耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒）。请检查模型服务与网络连接。`)
  }
  // A design response may contain a complete HTML document and can spend
  // several minutes in reasoning before its first text delta. Keep the
  // timeout bounded, but do not turn a healthy slow stream into a partial
  // result after the old 150-second limit.
  const timeout = AbortSignal.timeout(10 * 60 * 1000)
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
      throw new Error('模型响应超过 10 分钟未完成，已保留已收到的内容，请重试。')
    if (signal?.aborted) throw error
    throw transportError(error)
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
    try {
      const result = JSON.parse(raw)
      c.onResponse?.({ usage: tokenUsage(c.protocol, result?.usage) })
      return result
    } catch {
      throw new Error('服务未返回有效 JSON，请检查接口类型与服务地址。')
    }
  } catch (error) {
    // AbortSignal.timeout aborts the response body reader as well as fetch.
    // Normalize both paths so every caller gets the same actionable message.
    if (timeout.aborted && !signal?.aborted)
      throw new Error('模型响应超过 10 分钟未完成，已保留已收到的内容，请重试。')
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
): Promise<ModelReply> {
  if (!c.traffic || !c.id) return completeRequest(c, system, messages, tools, signal, onDelta)
  let recording: ReturnType<TrafficRecorder['start']> | undefined
  const traced: Connection = { ...c,
    onRequest: () => { try { recording = c.traffic!.start(c, c.trafficPurpose ?? 'inference') } catch { /* Monitoring cannot interrupt inference. */ } },
    onResponse: update => { try { recording?.observe(update) } catch { /* Keep inference independent of monitoring. */ } },
  }
  try {
    const reply = await completeRequest(traced, system, messages, tools, signal, onDelta)
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
              input: parseJson(call.arguments),
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
  return serializeRequest(c, buildModelRequest(c, system, messages, tools).body, stream)!.length
}
async function completeRequest(
  c: Connection,
  system: string,
  messages: ModelMessage[],
  tools: ToolDefinition[] = [],
  signal?: AbortSignal,
  onDelta?: DeltaListener,
): Promise<ModelReply> {
  const protocol: Protocol = c.protocol
  const prepared = buildModelRequest(c, system, messages, tools)
  const result = await request(c, prepared.path, prepared.body, signal, onDelta)
  if (protocol === 'anthropic') {
    if (!Array.isArray(result?.content)) throw new Error('服务返回中缺少模型回复，请检查模型名称和协议。')
    return {
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
    }
  }
  if (protocol === 'responses') {
    if (!Array.isArray(result?.output) || ['failed', 'incomplete'].includes(result.status)) throw new Error('服务返回中缺少完整模型回复，请检查模型名称和协议。')
    return {
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
    }
  }
  const message = result.choices?.[0]?.message
  if (!message) throw new Error('服务返回中缺少模型回复，请检查模型名称和协议。')
  return {
    text: typeof message.content === 'string' ? message.content : '',
    model: typeof result.model === 'string' ? result.model : undefined,
    reasoning: message.reasoning_content,
    calls: (message.tool_calls ?? []).map((call: any) => ({
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
    })),
  }
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
