/** Incremental SSE framing and protocol assembly. No simulated token streaming. */
export interface ModelDelta {
  kind: 'text' | 'reasoning' | 'tool'
  text: string
  id?: string
  name?: string
}
export type DeltaListener = (delta: ModelDelta) => void

export async function readModelStream(
  response: Response,
  protocol: string,
  emit: DeltaListener,
  onUsage?: (usage: unknown) => void,
): Promise<any> {
  if (!response.body) throw new Error('模型服务没有返回数据流。')
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = '',
    size = 0,
    finished = false,
    finalResponse: any,
    reportedModel: string | undefined
  const chat: any = { content: '', reasoning_content: '', tool_calls: [] }
  const blocks: any[] = [],
    items: any[] = []
  let usage: Record<string, unknown> = {}
  const send = (kind: ModelDelta['kind'], value: unknown, extra = {}) => {
    if (typeof value === 'string' && (value || kind === 'tool'))
      emit({ kind, text: value, ...extra })
  }
  function event(raw: string) {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data) return
    if (data === '[DONE]') {
      finished = true
      return
    }
    const e = JSON.parse(data)
    const reportedUsage = e.usage ?? e.message?.usage ?? e.response?.usage
    if (reportedUsage && typeof reportedUsage === 'object') {
      // message_delta and usage-only Chat chunks are cumulative snapshots.
      usage = { ...usage, ...reportedUsage }
      onUsage?.(usage)
    }
    if (typeof e.model === 'string') reportedModel = e.model
    if (e.type === 'message_start' && typeof e.message?.model === 'string') reportedModel = e.message.model
    if (e.error || ['error', 'response.failed', 'response.incomplete'].includes(e.type))
      throw new Error(e.error?.message || e.response?.error?.message || '模型数据流未完成。')
    if (protocol === 'chat') {
      const choice = e.choices?.[0],
        d = choice?.delta
      if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter')
        throw new Error('模型输出被截断，已保留收到的内容。')
      if (choice?.finish_reason) finished = true
      if (!d) return
      chat.content += d.content || ''
      chat.reasoning_content += d.reasoning_content || ''
      send('text', d.content)
      send('reasoning', d.reasoning_content)
      for (const call of d.tool_calls || []) {
        const t = (chat.tool_calls[call.index] ??= {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        })
        t.id += call.id || ''
        t.function.name += call.function?.name || ''
        t.function.arguments += call.function?.arguments || ''
        send('tool', t.function.arguments, {
          id: t.id || `call-${call.index}`,
          name: t.function.name,
        })
      }
    } else if (protocol === 'anthropic') {
      if (e.type === 'message_stop') finished = true
      if (e.type === 'message_delta' && e.delta?.stop_reason === 'max_tokens')
        throw new Error('模型输出被截断，已保留收到的内容。')
      if (e.type === 'content_block_start') {
        blocks[e.index] = { ...e.content_block }
        if (e.content_block.type === 'tool_use') {
          blocks[e.index]._json = ''
          send('tool', '', { id: e.content_block.id, name: e.content_block.name })
        }
        send('text', e.content_block.text)
        send('reasoning', e.content_block.thinking)
      }
      if (e.type === 'content_block_delta') {
        const b = blocks[e.index],
          d = e.delta
        if (!b) throw new Error('模型流中的内容块缺失。')
        if (d.type === 'text_delta') {
          b.text = (b.text || '') + d.text
          send('text', d.text)
        }
        if (d.type === 'thinking_delta') {
          b.thinking = (b.thinking || '') + d.thinking
          send('reasoning', d.thinking)
        }
        if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature
        if (d.type === 'input_json_delta') {
          b._json += d.partial_json
          send('tool', b._json, { id: b.id, name: b.name })
        }
      }
    } else {
      if (e.type === 'response.output_item.added') {
        items[e.output_index] = { ...e.item }
        if (e.item.type === 'function_call')
          send('tool', e.item.arguments || '', { id: e.item.call_id, name: e.item.name })
      }
      if (e.type === 'response.output_text.delta') send('text', e.delta)
      if (
        ['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(e.type)
      )
        send('reasoning', e.delta)
      if (e.type === 'response.function_call_arguments.delta') {
        const t = items[e.output_index]
        if (t) {
          t.arguments = (t.arguments || '') + e.delta
          send('tool', t.arguments, { id: t.call_id, name: t.name })
        }
      }
      if (e.type === 'response.completed') {
        finalResponse = e.response
        finished = true
      }
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8_000_000) throw new Error('模型返回内容过大。')
      buffer += decoder.decode(value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) event(buffer)
    if (!finished) throw new Error('模型连接提前断开，已保留收到的内容，请继续讨论。')
    if (protocol === 'chat')
      return { model: reportedModel, choices: [{ message: { ...chat, tool_calls: chat.tool_calls.filter(Boolean) } }] }
    if (protocol === 'anthropic')
      return {
        model: reportedModel,
        content: blocks
          .filter(Boolean)
          .map(({ _json, ...b }) => ({ ...b, ...(_json ? { input: JSON.parse(_json) } : {}) })),
      }
    if (!finalResponse) throw new Error('模型流中缺少完成结果。')
    return finalResponse
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
