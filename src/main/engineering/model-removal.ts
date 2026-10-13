import type { ModelRemovalPreview } from '../../shared/model-removal'
import type { EngineeringStore } from './store'
import { resolveReasoning } from '../../shared/reasoning'
import { executionKey } from './execution'

export class ModelRemoval {
  constructor(private store: EngineeringStore) {}
  preview = (id: string): ModelRemovalPreview => {
    const data = this.store.data, model = data.models.find(m => m.id === id)
    if (!model) throw new Error('模型连接已不存在，请刷新列表。')
    const references: string[] = [], blockers: string[] = []
    const agents = data.agents.filter(a => a.modelId === id)
    references.push(...agents.map(a => '智能体：' + a.name + (a.ownerProjectId ? ' · ' + (data.projects.find(p => p.id === a.ownerProjectId)?.name || '原项目') : ' · 共享模板')))
    if (data.defaultAssistantModelId === id) references.push('默认通用助手')
    for (const session of data.assistant?.sessions || []) {
      if (session.modelId === id) references.push('助手会话：' + session.title)
      if (session.messages.some(m => m.status === 'pending' && m.usage?.connectionId === id)) blockers.push('助手正在回复：' + session.title)
    }
    const agentIds = new Set(agents.map(a => a.id))
    for (const p of data.projects) {
      const local: string[] = []
      if (p.discussionModelId === id) local.push('需求讨论')
      if (p.designModelId === id) local.push('原型设计')
      if (p.roundtable?.participants.some(m => m.modelId === id)) local.push('圆桌下次使用的配置')
      for (const f of p.features) if (f.stage !== 'done' && Object.values(f.executionModels || {}).includes(id)) local.push('功能指定模型：' + f.title)
      references.push(...local.map(label => '项目「' + p.name + '」：' + label))
      const usesAgent = agentIds.has(p.plannerId || '') || agentIds.has(p.designerId || '') || p.teamAgentIds?.some(a => agentIds.has(a)) || p.features.some(f => agentIds.has(f.developerId) || agentIds.has(f.reviewerId))
      if ((local.length || usesAgent) && (p.activity || p.designActivity || p.roundtable?.status === 'running' || p.prd?.status === 'generating' || p.executionPlan?.status === 'running')) blockers.push('项目正在执行：' + p.name)
      // A resumable runtime can contain pending side effects. Model changes must use its handoff flow.
      for (const f of p.features) {
        if (f.stage === 'done') continue
        const pinned = Object.values(f.executionModels || {}).includes(id) || agentIds.has(f.developerId) || agentIds.has(f.reviewerId)
        if (pinned && data.executionCheckpoints?.[executionKey(p.id, f.id)]) blockers.push('功能「' + f.title + '」有待接续检查点，请先在功能中完成接续或切换模型')
      }
    }
    const suggested = data.models.find(m => m.id !== id && m.model === model.model && m.protocol === model.protocol && m.baseUrl.replace(/\/+$/, '') === model.baseUrl.replace(/\/+$/, ''))
    return { modelId: id, references, blockers: [...new Set(blockers)], suggestedReplacementId: suggested?.id }
  }
  remove = (id: string, replacementId?: string) => {
    const preview = this.preview(id), data = this.store.data
    if (preview.blockers.length) throw new Error(preview.blockers.join('；'))
    const replacement = replacementId ? data.models.find(m => m.id === replacementId && m.id !== id) : undefined
    if (replacementId && !replacement) throw new Error('请选择仍存在的其他模型连接。')
    if (preview.references.length && !replacement) throw new Error('该连接仍有引用，请选择替代连接后迁移并删除。')
    const undo: (() => void)[] = []
    const change = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
      const existed = Object.hasOwn(target, key), previous = target[key]
      undo.push(() => { if (existed) target[key] = previous; else delete target[key] })
      target[key] = value
    }
    try {
      if (replacement) {
        for (const agent of data.agents) if (agent.modelId === id) {
          change(agent, 'modelId', replacement.id)
          change(agent, 'reasoning', resolveReasoning(replacement, agent.reasoning))
        }
        if (data.defaultAssistantModelId === id) change(data, 'defaultAssistantModelId', replacement.id)
        for (const session of data.assistant?.sessions || []) if (session.modelId === id) change(session, 'modelId', replacement.id)
        for (const p of data.projects) {
          if (p.discussionModelId === id) change(p, 'discussionModelId', replacement.id)
          if (p.designModelId === id) change(p, 'designModelId', replacement.id)
          for (const member of p.roundtable?.participants || []) if (member.modelId === id) change(member, 'modelId', replacement.id)
          for (const f of p.features) if (f.stage !== 'done' && f.executionModels) {
            for (const role of ['developer', 'reviewer', 'diagnoser', 'preparer'] as const) if (f.executionModels[role] === id) change(f.executionModels, role, replacement.id)
          }
        }
      }
      for (const plan of data.assistant?.plans || []) if (plan.status === 'preview') change(plan, 'status', 'stale')
      change(data, 'models', data.models.filter(m => m.id !== id))
      this.store.save()
    } catch (error) { for (const restore of undo.reverse()) restore(); throw error }
  }
}
