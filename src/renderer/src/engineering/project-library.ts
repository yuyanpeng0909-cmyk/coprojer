import type { Feature, Project } from '../../../shared/engineering'
import { activePrototypeBriefs } from '../../../shared/prototype-workflow'
import type { ProjectView } from './WorkspaceSidebar'
import { deliveryFeatures } from './delivery'

export interface ProjectDestination {
  view: ProjectView
  featureId?: string
  tab?: 'plan' | 'results' | 'logs'
  researchTab?: 'requirements' | 'prototype'
}
export interface ProjectAttention {
  id: string
  title: string
  detail: string
  kind: 'failure' | 'decision' | 'acceptance' | 'plan' | 'requirements' | 'prototype'
  destination: ProjectDestination
}

export function lastProjectEvent(project: Project) {
  for (let index = project.events.length - 1; index >= 0; index--) {
    const event = project.events[index]
    if (event.kind !== 'project-management') return event
  }
}
export function lastProjectActivity(project: Project) {
  return lastProjectEvent(project)?.at || project.createdAt
}
export function projectIsRunning(project: Project) {
  return !!(project.activity || project.designActivity || project.previewUrl || project.executionPlan?.status === 'running')
}

export function projectAttention(project: Project): ProjectAttention[] {
  if (project.archivedAt) return []
  const items: ProjectAttention[] = []
  const featureItem = (feature: Feature, kind: ProjectAttention['kind'], title: string, tab: 'plan' | 'results' | 'logs') => {
    const view = kind === 'acceptance' ? 'acceptance' : tab === 'plan' ? 'plans' : 'development'
    items.push({ id: feature.id, kind, title, detail: feature.title, destination: { view, featureId: feature.id, tab } })
  }
  const current = deliveryFeatures(project)
  current.filter(feature => feature.stage === 'blocked').forEach(feature => featureItem(feature, 'failure', '执行需要处理', 'logs'))
  current.filter(feature => feature.stage === 'solution' && (feature.planGenerationError || feature.planConfirmationError))
    .forEach(feature => featureItem(feature, 'failure', '方案需要处理', 'plan'))
  const decision = project.decisions?.find(item => item.status === 'pending')
  if (decision) items.push({ id: `decision-${decision.id}`, kind: 'decision', title: '产品决策待回答', detail: decision.question, destination: { view: 'map' } })
  current.filter(feature => feature.stage === 'acceptance').forEach(feature => featureItem(feature, 'acceptance', '功能待验收', 'results'))
  current.filter(feature => feature.stage === 'solution' && !!feature.plan.trim() &&
    feature.tasks.some(task => !!task.title.trim()) && !feature.planGenerationError && !feature.planConfirmationError)
    .forEach(feature => featureItem(feature, 'plan', '方案待确认', 'plan'))
  if (project.prd?.status === 'review' && project.features.some(feature => feature.stage === 'requirements' && feature.scope !== 'later')) {
    items.push({ id: 'requirements', kind: 'requirements', title: '需求待审阅', detail: '确认本期范围与验收标准', destination: { view: 'specification' } })
  }
  if (activePrototypeBriefs(project).some(brief => brief.status === 'review')) {
    items.push({ id: 'prototype', kind: 'prototype', title: '原型待验收', detail: '试用原型并提交反馈', destination: { view: 'map', researchTab: 'prototype' } })
  }
  if (project.prd?.status === 'error') {
    items.unshift({ id: 'prd-error', kind: 'failure', title: '需求文档生成失败', detail: project.prd.error || '查看原因并重试', destination: { view: 'map' } })
  }
  const lastEvent = lastProjectEvent(project)
  if (!project.activity && !project.designActivity && !items.some(item => item.kind === 'failure') &&
    lastEvent && ['error', 'stopped', 'interrupted', 'repair'].includes(lastEvent.kind)) {
    items.unshift({ id: `event-${lastEvent.id}`, kind: 'failure', title: '执行记录需要检查', detail: lastEvent.message.split('\n')[0], destination: { view: 'activity' } })
  }
  return items
}

export function projectContinuation(project: Project): { summary: string; next: string; destination: ProjectDestination } {
  const attention = projectAttention(project)[0]
  if (project.activity || project.designActivity) {
    const view = project.features.some(feature => feature.stage === 'verifying') ? 'verification'
      : project.features.some(feature => feature.stage === 'developing') ? 'development' : 'map'
    return { summary: project.activity || '正在生成原型', next: '查看执行进展', destination: { view, researchTab: project.designActivity ? 'prototype' : 'requirements' } }
  }
  if (attention) return { summary: `${attention.title} · ${attention.detail}`, next: '处理待办后继续推进', destination: { view: attention.destination.view, researchTab: attention.destination.researchTab } }
  const current = deliveryFeatures(project)
  if (current.length && current.every(feature => feature.stage === 'done'))
    return { summary: '本期功能已验收', next: '查看交付记录或规划下一期', destination: { view: 'overview' } }
  const ready = current.filter(feature => feature.stage === 'ready').length
  if (ready) return { summary: `${ready} 个功能已就绪`, next: '安排执行顺序并开始开发', destination: { view: 'development' } }
  if (current.some(feature => feature.stage === 'solution'))
    return { summary: '正在准备实现方案', next: '补全方案和实现任务', destination: { view: 'plans' } }
  if (project.chat.length || current.length || project.features.some(feature => feature.scope === 'discussion'))
    return { summary: '需求与设计资料已保存', next: '继续完善需求和原型', destination: { view: 'map' } }
  return { summary: '项目已创建', next: project.discussionModelId ? '开始描述需求与设计想法' : '连接模型，开始整理想法', destination: { view: 'overview' } }
}
