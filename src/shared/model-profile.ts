import type { ModelConfig, Protocol } from './engineering'
import type { AgentReasoning, ReasoningCapability } from './reasoning'
import type { TokenUsage } from './model-traffic'

export interface ContextPolicy {
  version: 2
  mode: 'legacy' | 'shadow' | 'adaptive'
  triggerScope: 'total' | 'body_after_prefix'
  autoCompactTokenLimit?: number
  compactor: 'portable' | 'responses-native'
  horizonRounds: number
}
export interface TokenCalibration { identity: string; samples: { bytes: number; tokens: number }[] }
export interface ContextGrowthState {
  identity: string
  samples: number[]
  throughSequence: number
  prefixThroughSequence: number
  epoch: number
  rearmGrowth?: number
  compactedInput?: number
  lastAttemptHash?: string
}
export interface ContextDecision {
  reason: 'within-budget' | 'soft-limit' | 'predicted-capacity' | 'hard-limit' | 'rearm-wait'
  input: number; prefix: number; body: number; hardLimit: number; trigger: number; bodyLimit: number
  growth: number; headroom: number; target: number; shouldCompact: boolean
  /** Unbounded historical estimate for diagnostics; growth is the scheduling reserve. */
  observedGrowth?: number
}
export interface ContextCompactionRecord {
  at: string; reason: string; epoch?: number; before?: number; after?: number
  decision?: ContextDecision; method?: string; archiveId?: string
  manifestId?: string; role?: string; model?: string; unit?: 'characters' | 'tokens'
}
export interface ContextOperation {
  id: string; kind: 'count' | 'compaction'; parentHash: string; wireHash: string; at: string
  status: 'prepared' | 'completed' | 'failed'; usage?: TokenUsage; error?: string
}

/** User/host declarations, never silently promoted to provider verification. */
export interface ModelCapabilities {
  contextWindowTokens?: number
  maxOutputTokens?: number
  outputParameter?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'
  windowAccounting?: 'input-plus-output' | 'input-only'
  reasoningAccounting?: 'included-in-output' | 'separate'
  extraReasoningTokens?: number
  toolCalling?: boolean
  usageSupported?: boolean
  nativeCompatibilityKey?: string
  contextPolicy?: ContextPolicy
  tokenCounting?: 'responses'
  nativeCompaction?: 'responses'
  transportByteLimit?: number
}
export interface ModelProfile {
  version: 1
  identity: { connectionId: string; baseUrl: string; model: string; protocol: Protocol }
  declared: ModelCapabilities
  documentation: { source: string; at: string; values: ModelCapabilities }[]
  connectionVerification: ModelConfig['checks'] | null
  reasoning: ReasoningCapability
  unknown: string[]
}
export interface RequestBudget {
  requestCharacters: number
  requestBytes: number
  estimatedInputTokens: number
  estimateMethod: 'utf8-bytes-divided-by-3-v1' | 'utf8-upper-bound-v1' | 'usage-calibrated-v1' | 'provider-count-v1'
  measurementIdentity?: string
  policy?: ContextPolicy
  adaptive?: boolean
  requiresProviderCount?: boolean
  fallbackReason?: string
  inputLimit?: number
  decision?: ContextDecision
  shadowDecision?: ContextDecision
  contextWindowTokens?: number
  reserves: { outputTokens: number; extraReasoningTokens?: number; safetyTokens: number; outputSource: 'declared' | 'adapter-default' | 'policy-estimate'; accountingKnown: boolean }
  estimatedTotalTokens: number
  usage?: TokenUsage
  characterLimit: number
  byteLimit: number
}
export interface ExecutionManifest {
  version: 1
  id: string
  at: string
  taskRevision: number
  model: ModelProfile['identity']
  /** A reference only; no keys or credential-bearing URLs. */
  credentialRef: string
  parameters: { reasoning?: AgentReasoning }
  profile: ModelProfile
  versions: { harness: string; context: string; tools: string; permissions: string; result: string; checkpoint: string }
  environment: string
  upstreamVersion: null
}
export interface ContextRuntimeState {
  version: 1 | 2
  manifest: ExecutionManifest
  manifests: ExecutionManifest[]
  status: 'running' | 'paused' | 'recovery_required' | 'completed' | 'cancelled' | 'failed'
  reason?: string
  latestBudget?: RequestBudget
  view?: { version: 2; lastSequence: number; sources: string[]; archives: string[]; summaries: string[] }
  compactions?: ContextCompactionRecord[]
  operations?: ContextOperation[]
  receipts?: import('./runtime-receipt').ToolReceiptView[]
  requests: { id: string; manifestId: string; hash: string; at: string; status: 'prepared' | 'completed' | 'failed'; budget: RequestBudget; usage?: TokenUsage; responseId?: string }[]
}
export interface RuntimeArtifactQuery {
  projectId?: string
  featureId?: string
  sessionId?: string
  id: string
  offset?: number
  version?: string
}
