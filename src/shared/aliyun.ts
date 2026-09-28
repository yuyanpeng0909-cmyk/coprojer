import type { AgentRole } from './engineering'

export const aliyunPages = {
  quota: 'https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota',
  key: 'https://bailian.console.aliyun.com/cn-beijing/?tab=app#/api-key',
  guide: 'https://help.aliyun.com/zh/model-studio/new-free-quota',
} as const
export const aliyunBaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export interface AliyunModelCandidate {
  model: string
  remaining?: number
  expiresAt?: number
  quotaStatus?: string
  autoStop?: boolean
}
export interface AliyunImportPreview {
  id: string
  models: AliyunModelCandidate[]
  scannedAt: string
  quotaCheckedAt?: string
  excludedCount: number
}
export interface AliyunImportInput {
  previewId: string
  models: string[]
  freeOnly: boolean
  sameAccountConfirmed: boolean
  configureUnbound: boolean
}
export interface AliyunImportResult {
  imported: number
  reused: number
  configuredAgents: number
  defaultModel?: string
}
export function hasUsableFreeQuota(model: AliyunModelCandidate): boolean {
  return model.quotaStatus === 'VALID' && (model.remaining ?? 0) > 0 && (model.expiresAt ?? 0) > Date.now() && model.autoStop === true
}
// A conservative discovery filter, not a claim that tool calling has been tested.
export function isAliyunChatModel(model: string): boolean {
  return /^(qwen|qwq|qvq|deepseek|glm|kimi|moonshot|MiniMax|baichuan|llama|mistral)/i.test(model)
    && !/(embedding|rerank|tts|asr|audio|image|video|omni|realtime|livetranslate|translate|(?:^|-)mt(?:-|$))/i.test(model)
}
export function chooseAliyunModel(models: string[], role: AgentRole | 'assistant'): string {
  const patterns = role === 'assistant' ? [/^qwen.*flash/i, /^qwen.*turbo/i, /^qwen.*plus/i]
    : role === 'developer' ? [/coder/i, /^qwen.*plus/i, /deepseek/i]
    : role === 'designer' ? [/coder/i, /^qwen.*plus/i, /^qwen.*vl/i]
    : role === 'reviewer' ? [/^qwen.*plus/i, /deepseek/i, /coder/i]
    : [/^qwen.*plus/i, /^qwen.*max/i, /deepseek/i]
  return patterns.map(pattern => models.find(model => pattern.test(model))).find(Boolean) || models[0] || ''
}
