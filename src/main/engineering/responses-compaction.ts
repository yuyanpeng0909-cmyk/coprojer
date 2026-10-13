import { createHash } from 'node:crypto'
import { auxiliaryModelRequest, assertPreparedCapacity, type Connection, type PreparedModelRequest } from './model'
import { requestBudget } from './model-profile'
import { continuityHash } from './context-continuity'
import type { ExecutionArtifacts } from './execution-artifacts'

export interface NativeContextPorts {
  compact(prepared: PreparedModelRequest, signal: AbortSignal): Promise<Record<string, unknown>[]>
  write(output: Record<string, unknown>[], identity: string): string
  read(reference: string, identity: string): Record<string, unknown>[]
}
export const nativeIdentity = (p: PreparedModelRequest, sourceIdentity: string) => continuityHash([sourceIdentity, p.profile.identity, p.profile.declared.nativeCompatibilityKey])
export function prepareNativeWindow(prepared: PreparedModelRequest, output: Record<string, unknown>[]): PreparedModelRequest {
  if (prepared.protocol !== 'responses' || prepared.profile.declared.tokenCounting !== 'responses') throw new Error('原生窗口缺少兼容计数能力。')
  const body = JSON.parse(prepared.payload)
  const payload = JSON.stringify({ ...body, input: [...output, ...body.input] })
  return Object.freeze({ ...prepared, opaqueWindow: true, payload, hash: createHash('sha256').update(payload).digest('hex'),
    budget: requestBudget(payload, prepared.profile, prepared.budget.reserves.outputTokens) })
}
export function responsesCompaction(connection: Connection, artifacts: ExecutionArtifacts): NativeContextPorts {
  return {
    read: (reference, identity) => artifacts.readOpaque(reference, identity),
    write: (output, identity) => artifacts.writeOpaque(output, identity),
    async compact(prepared, signal) {
      assertPreparedCapacity(prepared)
      const source = JSON.parse(prepared.payload)
      const result = await auxiliaryModelRequest(connection, 'compaction', prepared, { model: source.model, input: source.input, instructions: source.instructions }, signal)
      if (!Array.isArray(result.output) || !result.output.length || !result.output.every((item: unknown) => item && typeof item === 'object' && !Array.isArray(item)) ||
        !result.output.some((item: any) => item.type === 'compaction' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0))
        throw new Error('Responses 压缩未返回完整原生窗口。')
      const pending = new Set<string>()
      for (const item of result.output) {
        if (item.type === 'function_call') { if (typeof item.call_id !== 'string' || pending.has(item.call_id)) throw new Error('压缩窗口工具身份无效。'); pending.add(item.call_id) }
        if (item.type === 'function_call_output' && !pending.delete(item.call_id)) throw new Error('压缩窗口包含未配对工具结果。')
      }
      if (pending.size) throw new Error('压缩窗口包含未完成工具组。')
      return result.output
    },
  }
}
