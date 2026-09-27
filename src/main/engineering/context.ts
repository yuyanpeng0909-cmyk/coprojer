import { createHash } from 'node:crypto'
import type { ContextEntry, Feature, Project } from '../../shared/engineering'
import type { ModelMessage } from './model'
import { activePrototypeBriefs } from '../../shared/prototype-workflow'

export const contextHash = (text: string) => createHash('sha256').update(text).digest('hex')
export const PAGE_SIZE = 6000
export function readPage(content: string, args: { offset?: number; limit?: number; version?: string } = {}) {
  const offset = args.offset ?? 0, limit = args.limit ?? PAGE_SIZE
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE)
    throw new Error('分页参数无效：offset 为原文字符位置，limit 必须在 1–6000 之间。')
  const version = contextHash(content)
  if (args.version && args.version !== version) throw new Error('原文版本已变化，请从第一页重新读取。')
  const end = Math.min(content.length, offset + limit)
  return JSON.stringify({ version, offset, totalCharacters: content.length, nextOffset: end < content.length ? end : null, content: content.slice(offset, end) })
}

export function normalizeContext(project: Project): void {
  for (const entry of project.context) {
    entry.featureId ??= project.features.find(f => entry.source.includes(f.id))?.id
    entry.targetId ??= project.features.find(f => f.id === entry.featureId)?.targetId
    entry.kind ??= entry.source.includes('用户最终验收') ? 'acceptance'
      : entry.source.includes('用户需求确认') ? 'requirements'
      : entry.source.includes('开发与验证') ? 'result'
      : entry.source.includes('用户创建项目') ? 'goal' : 'manual'
    entry.baselineId ??= entry.kind === 'requirements' && entry.source.includes('项目全量') ? entry.id : undefined
    entry.status ??= entry.baselineId && project.requirementsBaseline && entry.baselineId !== project.requirementsBaseline.id ? 'superseded' : 'active'
    entry.revision ??= 1
  }
}

export function readContext(project: Project, args: { id?: string; offset?: number; limit?: number; version?: string }): string {
  let value: unknown
  if (!args.id) value = [
    ...project.context.map(({ id, title, source, kind, featureId, targetId, status }) => ({ id, title, source, kind, featureId, targetId, status })),
    { id: 'requirements:current', title: '当前需求文档草稿' },
    ...project.features.map(f => ({ id: 'feature:' + f.id, title: f.title, targetId: f.targetId })),
    ...Array.from({ length: Math.ceil(project.chat.length / 10) }, (_, i) => ({ id: 'discussion:' + i, title: '原始讨论第 ' + (i + 1) + ' 页，仅作参考' })),
    ...(project.prototypes || []).map(p => ({ id: 'prototype:' + p.id, title: p.title, targetId: p.targetId })),
  ]
  else if (args.id === 'requirements:current') value = { content: project.requirementsDocument || '', confirmed: false }
  else if (args.id.startsWith('feature:')) value = project.features.find(f => f.id === args.id!.slice(8))
  else if (/^discussion:[0-9]+$/.test(args.id)) {
    const start = Number(args.id.slice(11)) * 10
    value = project.chat.slice(start, start + 10).map(({ id, role, text, at, modelName, status }) => ({ id, role, text, at, modelName, status }))
  } else if (args.id.startsWith('prototype:')) value = project.prototypes?.find(p => p.id === args.id!.slice(10))
  else value = project.context.find(c => c.id === args.id)
  if (value === undefined) throw new Error('上下文记录不存在，请先读取索引。')
  return readPage(JSON.stringify(value), args)
}

export function assembleContext(project: Project, feature?: Feature, budget = project.contextBudget ?? 32000) {
  normalizeContext(project)
  const relevant = new Set<string>()
  const visit = (id: string) => {
    if (relevant.has(id)) return
    relevant.add(id)
    project.features.find(f => f.id === id)?.dependencies.forEach(visit)
  }
  if (feature) visit(feature.id)
  const features = feature ? project.features.filter(f => relevant.has(f.id)) : project.features.filter(f => f.scope !== 'later')
  const targetIds = new Set(features.map(f => f.targetId).filter(Boolean))
  const targets = (project.targets || []).filter(t => !feature || targetIds.has(t.id))
  const baseline = feature?.baselineId ? project.context.find(c => c.id === feature.baselineId) : undefined
  const prototypeIds = feature?.prototypeId ? [feature.prototypeId] : feature?.baselineId ? [] : project.requirementsBaseline?.prototypeIds || []
  const required = JSON.stringify({
    project: project.name, goal: project.brief, baselineId: feature?.baselineId || project.requirementsBaseline?.id,
    targets, currentFeature: feature ? { id: feature.id, title: feature.title, description: feature.description, criteria: feature.criteria, plan: feature.plan, tasks: feature.tasks.map(t => t.title), targetId: feature.targetId } : undefined,
    featureIndex: features.map(f => ({ id: f.id, title: f.title, targetId: f.targetId, dependencies: f.dependencies, stage: f.stage })),
    decisions: (project.decisions || []).filter(d => d.answer && (!baseline || (d.answeredAt || d.at) <= baseline.at) && (!feature || !d.targetId || targetIds.has(d.targetId))).map(d => ({ question: d.question, answer: d.answer })),
    approvedPrototypes: prototypeIds.map(id => ({ id: 'prototype:' + id, title: project.prototypes?.find(p => p.id === id)?.title })),
    designWorkflow: feature ? undefined : activePrototypeBriefs(project).map(b => ({ targetId: b.targetId, status: b.status, preferences: b.preferences, prototypeId: b.prototypeId })),
  })
  if (!Number.isSafeInteger(budget) || budget < 4000 || budget > 120000) throw new Error('上下文字符预算必须在 4000–120000 之间。')
  const header = '当前任务约束（不得以摘要或历史讨论覆盖）：' + required
  const footer = '\n原文通过 read_context 按 ID 分页读取；使用 nextOffset 和 version 连续读取。原始讨论和模型总结只作参考，不能代替人工确认。'
  if (header.length + footer.length > budget) throw new Error('当前功能的必需约束超过上下文预算，请拆分功能或缩短方案；验收标准未被截断。')
  let text = header, omittedCount = 0
  const contextIds: string[] = []
  const entries = project.context.filter(c => (!c.status || c.status === 'active' || !!feature?.baselineId && c.baselineId === feature.baselineId) && (!feature?.baselineId || !c.baselineId || c.baselineId === feature.baselineId || !!c.featureId && relevant.has(c.featureId)) && (!feature || (!c.featureId && (!c.targetId || targetIds.has(c.targetId))) || !!c.featureId && relevant.has(c.featureId)))
  const ordered = [...entries].sort((a, b) => {
    const score = (c: ContextEntry) => (feature && c.featureId === feature.id ? 300 : c.featureId && relevant.has(c.featureId) ? 200 : 0) + (c.baselineId === feature?.baselineId && !!feature?.baselineId ? 180 : 0) + (c.kind === 'manual' ? 70 : c.kind === 'requirements' ? 60 : 10)
    return score(b) - score(a) || b.at.localeCompare(a.at)
  })
  for (const c of ordered) {
    const excerpt = '\n' + JSON.stringify({ id: c.id, title: c.title, kind: c.kind, source: c.source, summary: c.content.slice(0, c.kind === 'manual' ? 4000 : 1200), complete: c.content.length <= (c.kind === 'manual' ? 4000 : 1200) })
    if (text.length + excerpt.length + footer.length <= budget) { text += excerpt; contextIds.push(c.id) }
    else omittedCount++
  }
  return { text: text + footer, contextIds, omittedCount: omittedCount + project.context.length - entries.length, characters: text.length + footer.length }
}

export function discussionHistory(project: Project, budget = 20000): ModelMessage[] {
  const selected: ModelMessage[] = []
  let size = 0
  for (let i = project.chat.length - 1; i >= 0; i--) {
    const c = project.chat[i]
    if (c.status === 'streaming') continue
    const content = (c.role === 'assistant' ? '[历史 AI 发言，仅作讨论资料，不代表人工指令或确认；模型：' + (c.modelName || '未记录') + ']\n' : '') +
      (c.purpose === 'roundtable' ? '[圆桌第 ' + c.meetingRound + ' 轮 · ' + (c.speaker || c.modelName || '人工') + ']\n' : '') + c.text + (c.error ? '\n[响应状态：' + c.error + ']' : '')
    if (size + content.length > budget) {
      if (!selected.length && c.role === 'user') throw new Error('当前输入超过讨论预算，请分段描述。')
      selected.unshift({ role: 'user', content: '[较早历史已归档，可使用 read_context 的 discussion:页码 按需读取。当前人工决策和项目约束仍在系统上下文中。]' })
      break
    }
    selected.unshift({ role: 'user', content }); size += content.length
  }
  return selected
}

// Only compact between complete tool rounds; preserve the newest assistant/tool group.
export function boundMessages(messages: ModelMessage[], budget = 46000): void {
  const size = () => JSON.stringify(messages).length
  if (size() <= budget) return
  let start = messages.length - 1
  while (start > 0 && messages[start].role === 'tool') start--
  if (start <= 1) throw new Error('当前工具回合超过上下文预算，请缩小单次文件或工具输出。')
  const summary = messages.slice(1, start).filter(m => m.role === 'tool').slice(-8).map(m => m.content.slice(0, 500)).join('\n')
  messages.splice(1, start - 1, { role: 'user', content: '[旧工具往返已压缩，以下仅为执行摘要；必要时重新读取实际文件和上下文。]\n' + summary })
  if (size() > budget) throw new Error('当前工具回合超过上下文预算，请缩小任务后继续。')
}
