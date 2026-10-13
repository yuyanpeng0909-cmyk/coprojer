import type { ToolDefinition } from './model'

export const toolContractVersion = 'engineering-tools-v3'
export const receiptToolVersions = ['engineering-tools-v2', toolContractVersion]
export class ToolContractError extends Error {
  readonly category = 'invalid_tool_arguments'
  constructor(readonly fields: { path: string; message: string }[]) {
    super(JSON.stringify({ category: 'invalid_tool_arguments', version: toolContractVersion, fields }))
    this.name = 'ToolContractError'
  }
}

// This deliberately implements only the schema vocabulary used by our tools.
// Definitions are both the provider schema and the execution contract; no coercion.
export function validateToolArguments(tool: ToolDefinition, value: unknown): Record<string, any> {
  const errors: { path: string; message: string }[] = []
  function check(schema: any, item: unknown, path: string): void {
    const fail = (message: string) => errors.push({ path, message })
    if (schema.type === 'object') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { fail('必须是对象'); return }
      const data = item as Record<string, unknown>
      for (const key of schema.required ?? []) if (!(key in data)) errors.push({ path: `${path}.${key}`, message: '缺少必填字段' })
      for (const [key, val] of Object.entries(data)) {
        // Optional undefined values exist in host calls, never on the JSON wire.
        if (val === undefined && !(schema.required ?? []).includes(key) && Object.hasOwn(schema.properties ?? {}, key)) continue
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: key === 'timeoutMs' ? '未知字段；请使用 timeoutSeconds（秒）' : '未知字段' })
        } else check(schema.properties[key], val, `${path}.${key}`)
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(item)) { fail('必须是数组'); return }
      if (schema.maxItems !== undefined && item.length > schema.maxItems) fail(`最多 ${schema.maxItems} 项`)
      item.forEach((entry, i) => check(schema.items, entry, `${path}[${i}]`))
    } else if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof item !== 'number' || !Number.isFinite(item) || schema.type === 'integer' && !Number.isInteger(item)) { fail(`必须是有限${schema.type === 'integer' ? '整数' : '数字'}`); return }
      if (schema.minimum !== undefined && item < schema.minimum) fail(`不得小于 ${schema.minimum}`)
      if (schema.maximum !== undefined && item > schema.maximum) fail(`不得大于 ${schema.maximum}`)
    } else if (typeof item !== schema.type) fail(`必须是 ${schema.type}`)
    if (schema.enum && !schema.enum.includes(item)) fail('不在允许值中')
    if (typeof item === 'string' && schema.maxLength !== undefined && item.length > schema.maxLength) fail(`最多 ${schema.maxLength} 字符`)
    if (typeof item === 'string' && schema.minLength !== undefined && item.length < schema.minLength) fail(`至少 ${schema.minLength} 字符`)
  }
  check(tool.parameters, value, '$')
  if (errors.length) throw new ToolContractError(errors)
  return value as Record<string, any>
}

export function parseToolArguments(tool: ToolDefinition, raw: string): Record<string, any> {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new ToolContractError([{ path: '$', message: '参数必须是完整 JSON 对象' }]) }
  return validateToolArguments(tool, value)
}
