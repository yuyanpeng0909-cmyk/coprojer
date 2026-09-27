import type { Feature, Project } from '../../../shared/engineering'

export const deliveryStages = [
  { id: 'discussion', label: '需求讨论' },
  { id: 'prototype', label: '原型设计' },
  { id: 'specification', label: '需求与规格' },
  { id: 'plans', label: '方案与任务' },
  { id: 'development', label: '开发执行' },
  { id: 'verification', label: '独立验证' },
  { id: 'acceptance', label: '成果验收' },
] as const
export type DeliveryStage = typeof deliveryStages[number]['id']
export type DeliveryView = Exclude<DeliveryStage, 'discussion' | 'prototype'>
export type FeatureTab = 'requirements' | 'plan' | 'results' | 'changes' | 'logs'

export function mergedFeatureFor(project: Project, feature?: Feature): Feature | undefined {
  if (!feature) return undefined
  const mergedId = /历史记录[，,]\s*已合并至\s+([a-zA-Z0-9-]+)/.exec(feature.title)?.[1]
  if (!mergedId) return undefined
  const matches = project.features.filter(item => item.id !== feature.id && item.id.startsWith(mergedId))
  return matches.length === 1 ? matches[0] : undefined
}
export function deliveryFeatures(project: Project): Feature[] {
  return project.features.filter(feature => feature.scope === 'current' && !mergedFeatureFor(project, feature))
}
export function hasVerification(project: Project, feature: Feature): boolean {
  return feature.results.length > 0 || project.events.some(event =>
    event.featureId === feature.id && ['verification', 'reviewer', 'review'].includes(event.kind))
}
export function deliveryCount(project: Project, stage: DeliveryStage): number {
  const features = deliveryFeatures(project)
  switch (stage) {
    case 'discussion': return project.chat.filter(entry => entry.purpose !== 'design').length
    case 'prototype': return project.prototypes?.length ?? 0
    case 'specification': return project.features.filter(feature => !mergedFeatureFor(project, feature)).length
    case 'plans': return features.filter(feature => ['requirements', 'solution'].includes(feature.stage)).length
    case 'development': return features.filter(feature => ['ready', 'developing', 'blocked'].includes(feature.stage)).length
    case 'verification': return features.filter(feature => feature.stage === 'verifying').length
    case 'acceptance': return features.filter(feature => feature.stage === 'acceptance').length
  }
}
export function isStageRunning(project: Project, stage: DeliveryStage): boolean {
  const features = deliveryFeatures(project)
  if (stage === 'prototype') return !!project.designActivity
  if (stage === 'development') return features.some(feature => feature.stage === 'developing')
  if (stage === 'verification') return features.some(feature => feature.stage === 'verifying')
  if (stage === 'discussion') return !!project.activity && !features.some(feature => ['developing', 'verifying'].includes(feature.stage)) && project.chat.some(entry => entry.status === 'streaming' && entry.purpose !== 'design')
  return false
}
