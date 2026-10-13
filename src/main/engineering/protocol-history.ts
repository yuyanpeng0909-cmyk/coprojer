import { isDeepStrictEqual } from 'node:util'
import type { ModelMessage } from './model'
import type { Protocol } from '../../shared/engineering'

export function assertCompleteToolRounds(messages: ModelMessage[]): void {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.callId || !pending.delete(message.callId)) throw new Error('工具历史缺少对应调用，不能压缩未完成的工具回合。')
    } else {
      if (pending.size) throw new Error('工具回合尚未完成，不能整理或重放调用。')
      if (message.calls?.length && message.role !== 'assistant') throw new Error('工具调用必须来自完整助手回复。')
      for (const call of message.calls ?? []) {
        if (!call.id || pending.has(call.id)) throw new Error('工具调用标识缺失或重复。')
        pending.add(call.id)
      }
    }
  }
  if (pending.size) throw new Error('工具回合尚未完成，不能整理或重放调用。')
}

export function assertProtocolHistory(messages: ModelMessage[], protocol: Protocol): void {
  assertCompleteToolRounds(messages)
  for (const message of messages) {
    const native = protocol === 'responses' && message.responseItems?.length ? message.responseItems.filter(item => item.type === 'function_call')
      .map(item => ({ id: item.call_id, name: item.name, args: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : undefined }))
      : protocol === 'anthropic' && message.anthropicBlocks?.length ? message.anthropicBlocks.filter(item => item.type === 'tool_use')
        .map(item => ({ id: item.id, name: item.name, args: item.input })) : undefined
    if (native) {
      const normalized = (message.calls ?? []).map(call => ({ id: call.id, name: call.name, args: JSON.parse(call.arguments) }))
      if (message.role !== 'assistant' || !isDeepStrictEqual(native, normalized)) throw new Error('原生工具块与调用/结果记录不匹配，原文保留，禁止发送不完整续接。')
    }
  }
}
