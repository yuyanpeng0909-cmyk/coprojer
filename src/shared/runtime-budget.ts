export interface RuntimeAllowance { requests: number; tools: number; activeMs: number }
export interface RuntimeBudget {
  version: 1
  policy: 'runtime-budget-v1'
  historical: { kind: 'exact' | 'unknown' | 'lower-bound'; requests?: number; tools?: number; activeMs?: number }
  used: RuntimeAllowance
  limits: RuntimeAllowance | null
  enabledAt: string
  timeAccounting: 'active-reservation-ms-v1'
  activeLease?: { id: string; owner: string; startedAt: string; reservedMs: number }
  unsettledActivity?: { id: string; startedAt: string; reservedMs: number; reason: string }[]
  adjustments: { at: string; target: string; before: RuntimeAllowance | null; after: RuntimeAllowance; source: 'new-task-policy' | 'local-user'; reason: string }[]
}
export interface RuntimeBudgetTarget { projectId?: string; featureId?: string; sessionId?: string }

export function runtimeAllowanceBlockReason(used: RuntimeAllowance, limits: RuntimeAllowance | null): string | null {
  if (!limits) return '尚未授予后续额度，请先设置任务总额度。'
  const exhausted = (['requests', 'tools', 'activeMs'] as const).filter(key => used[key] >= limits[key])
  if (!exhausted.length) return null
  const labels = { requests: '模型请求', tools: '工具调用', activeMs: '活动时间' }
  return `${exhausted.map(key => labels[key]).join('、')}额度已用完，请将总额度设为大于累计用量后继续。`
}

/** Only persisted budgets block the UI; legacy tasks keep their existing execution path. */
export function runtimeBudgetBlockReason(budget?: RuntimeBudget): string | null {
  if (!budget) return null
  if (budget.activeLease) return '上段活动时间尚未结算，请核对已记录效果并授予后续额度。'
  return runtimeAllowanceBlockReason(budget.used, budget.limits)
}
