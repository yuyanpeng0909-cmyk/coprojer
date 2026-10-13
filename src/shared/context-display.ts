import type { ContextCompactionRecord, RequestBudget } from './model-profile'

export function effectiveContextMode(budget: RequestBudget): string {
  if (budget.adaptive) return '自适应（已生效）'
  if (budget.policy?.mode === 'adaptive') return '兼容保护（自适应未生效）'
  return budget.policy?.mode === 'shadow' ? '兼容保护（观察自适应）' : '兼容保护'
}
export function compactionDescription(record: ContextCompactionRecord): string {
  const roles: Record<string, string> = { developer: '开发', reviewer: '独立验证', preparer: '验证准备', diagnoser: '缺口诊断' }
  const reasons: Record<string, string> = { legacy: '兼容策略', 'hard-limit': '达到输入硬预算', 'predicted-capacity': '预留下一轮空间', 'soft-limit': '达到软阈值' }
  const parsed = new Date(record.at)
  const at = Number.isNaN(parsed.getTime()) ? '时间未记录' : parsed.toLocaleString('zh-CN', { hour12: false })
  // Old character-based records have no decision. Never label their values as tokens.
  const unit = record.unit ?? (record.decision || record.method === 'responses-native' ? 'tokens' : record.reason === 'legacy' || record.method === 'utf8-bytes-divided-by-3-v1' ? 'characters' : undefined)
  const amounts = record.before === undefined ? '' : ` · ${record.before.toLocaleString()} → ${record.after?.toLocaleString() ?? '未知'} ${unit === 'characters' ? '字符' : unit === 'tokens' ? '输入 token（计量值）' : '单位未记录'}`
  return `${at} · ${record.role ? roles[record.role] ?? record.role : '角色未记录'}${record.model ? ' · ' + record.model : ''} · ${reasons[record.reason] ?? record.reason}${amounts}${record.method ? ' · ' + record.method : ''}`
}
