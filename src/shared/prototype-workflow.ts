import type { Feature, Project } from './engineering'

export function designFingerprint(project: Project, targetId?: string): string {
  const raw = rawDesignFingerprint(project, targetId)
  const source = project.prd?.sources.find(s => (s.targetId || '') === (targetId || ''))
  return source?.derivedFingerprint === raw ? source.fingerprint : raw
}

export function rawDesignFingerprint(project: Project, targetId?: string): string {
  return JSON.stringify({
    brief: project.brief,
    document: project.requirementsDocument || '',
    target: project.targets?.find(t => t.id === targetId),
    features: project.features.filter(f => f.scope !== 'later' && (!targetId || f.targetId === targetId))
      .map(f => ({ id: f.id, title: f.title, description: f.description, criteria: f.criteria })),
  })
}

export function activePrototypeBriefs(project: Project) {
  const keys = project.targets?.length
    ? project.targets.filter(t => ['web', 'admin', 'mobile', 'desktop'].includes(t.kind)).map(t => t.id)
    : ['']
  return keys.flatMap(key => project.prototypeBriefs?.[key] ? [project.prototypeBriefs[key]] : [])
}

// An initial goal is enough: gather design preferences before drafting the PRD.
export function syncPrototypeBriefs(project: Project): void {
  if (project.decisions?.some(d => d.status === 'pending')) return
  const targets = project.targets?.length
    ? project.targets.filter(t => ['web', 'admin', 'mobile', 'desktop'].includes(t.kind)).map(t => t.id)
    : ['']
  for (const key of targets) {
    const features = project.features.filter(f => f.scope !== 'later' && (!key || f.targetId === key))
    if (!project.brief.trim() && !features.length || features.length > 0 && !features.some(f => f.stage === 'requirements')) continue
    const fingerprint = designFingerprint(project, key || undefined)
    const briefs = project.prototypeBriefs ??= {}
    const brief = briefs[key]
    if (!brief) briefs[key] = { targetId: key || undefined, status: 'preferences', preferences: '', fingerprint }
    else if (brief.status !== 'designing' && brief.fingerprint !== fingerprint) {
      brief.status = 'preferences'
      brief.fingerprint = fingerprint
      brief.acceptedAt = undefined
      brief.error = '需求有更新，请补充设计意见，系统会更新原型后再次交给你验收。'
      if (project.prd) project.prd.status = 'stale'
    }
  }
}

export function requirePrototypeReview(project: Project, feature?: Feature): void {
  syncPrototypeBriefs(project)
  for (const brief of activePrototypeBriefs(project)) {
    if (feature && (brief.targetId || '') !== (feature.targetId || '')) continue
    const current = project.features.some(f => f.stage === 'requirements' && f.scope !== 'later' && (!brief.targetId || f.targetId === brief.targetId))
    if (current && (brief.status !== 'accepted' || brief.fingerprint !== designFingerprint(project, brief.targetId)))
      throw new Error('请先提交设计意见并验收原型，再确认完整需求。')
  }
}

export function pinnedPrototype(project: Project, feature: Feature) {
  if (!feature.prototypeId) return undefined
  const prototype = project.prototypes?.find(p => p.id === feature.prototypeId)
  if (!prototype) throw new Error('此功能绑定的验收原型不存在，请恢复原型记录后继续。')
  return prototype
}

export function requirePrd(project: Project): void {
  const accepted = activePrototypeBriefs(project).filter(b => b.status === 'accepted')
  if (!accepted.length) return
  if (!project.prd || !project.requirementsDocument?.trim() || !['review', 'confirmed'].includes(project.prd.status) || accepted.some(b => b.fingerprint !== designFingerprint(project, b.targetId) || !project.prd!.sources.some(s => s.prototypeId === b.prototypeId && s.fingerprint === b.fingerprint && (s.targetId || '') === (b.targetId || ''))))
    throw new Error('请先根据已确认原型生成并审阅 PRD，再确认需求。')
}
