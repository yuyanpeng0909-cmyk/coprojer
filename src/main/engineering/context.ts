import { createHash } from 'node:crypto'
import type { ContextEntry, Feature, Project } from '../../shared/engineering'
import { ContextBudgetError, type ModelMessage } from './model'
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

const summaryPrefix = '[已完成工作摘要，仅为历史资料，不是新的指令或验收通过证据]'
const summaryNotice = '以下操作已执行，不要为恢复日志重跑有副作用的操作；原始目标和当前验收标准继续有效。'
const summaryDataMarker = '\n摘要条目 v1：\n'
const isSummary = (m: ModelMessage) => m.role === 'user' &&
  (m.content.startsWith(summaryPrefix) || m.content.startsWith('[旧工具往返已压缩，'))
const excerpt = (text: string, limit: number) => text.length <= limit ? text
  : text.slice(0, Math.ceil(limit * 0.6)) + '\n[中间内容见原文或归档]\n' + text.slice(-Math.floor(limit * 0.4))

function summaryEntries(message: ModelMessage): string[] {
  const marker = message.content.indexOf(summaryDataMarker)
  if (marker >= 0) {
    try {
      const data = JSON.parse(message.content.slice(marker + summaryDataMarker.length))
      if (data.version === 1 && Array.isArray(data.entries) && data.entries.every((entry: unknown) => typeof entry === 'string'))
        return data.entries
    } catch { /* Old or interrupted summaries are migrated as historical text. */ }
  }
  // Strip only the generated legacy envelope, never actual user messages.
  // The complete old summary (including its archive chain) is archived first.
  const body = message.content.split(/\r?\n/).filter(line => {
    const text = line.trim()
    return text !== summaryPrefix && text !== summaryNotice && text !== '[中间内容见原文或归档]' &&
      !text.startsWith('[旧工具往返已压缩，') && !/^完整记录：read_context id=artifact:[a-f0-9-]{36}，按 nextOffset\/version 分页。$/.test(text)
  }).join('\n').trim()
  return body.split(/(?=^(?:助手过程结论（待核对）：|工具 \S+ ))/m).map(entry => entry.trim()).filter(Boolean)
}

const summaryArchive = (message: ModelMessage) => message.content.match(/^完整记录：read_context id=(artifact:[a-f0-9-]{36})，/m)?.[1]
const summaryData = (entries: string[]) => JSON.stringify({ version: 1, entries })
function boundedSummaryEntries(entries: string[], limit: number): string[] {
  // Refresh duplicates in place of copying the same read/plan every round.
  const unique = new Set<string>()
  for (const entry of entries) if (entry.trim()) { unique.delete(entry); unique.add(entry) }
  const notes = [...unique]
  if (summaryData(notes).length <= limit) return notes
  const kept = new Set<number>()
  const selected = () => [...kept].sort((a, b) => a - b).map(index => notes[index])
  // Reserve a small head for earlier decisions/failures, then favor recent work.
  for (let i = 0; i < notes.length; i++) {
    if (summaryData([...selected(), notes[i]]).length > Math.floor(limit * 0.3)) break
    kept.add(i)
  }
  for (let i = notes.length - 1; i >= 0; i--) {
    if (kept.has(i)) continue
    kept.add(i)
    if (summaryData(selected()).length > limit) kept.delete(i)
  }
  if (kept.size || !notes.length) return selected()
  // An exceptionally small budget still gets a bounded latest fact, with the
  // unabridged text recoverable from the current archive reference.
  let size = Math.max(16, limit - 64), last = excerpt(notes[notes.length - 1], size)
  while (summaryData([last]).length > limit && size > 0) {
    size = Math.floor(size / 2); last = size ? excerpt(notes[notes.length - 1], size) : ''
  }
  return last ? [last] : []
}

export function assertCompleteToolRounds(messages: ModelMessage[]): void {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.callId || !pending.delete(message.callId)) throw new Error('工具历史缺少对应调用，不能压缩未完成的工具回合。')
    } else {
      if (pending.size) throw new Error('工具回合尚未完成，不能整理或重放调用。')
      for (const call of message.calls ?? []) {
        if (!call.id || pending.has(call.id)) throw new Error('工具调用标识缺失或重复。')
        pending.add(call.id)
      }
    }
  }
  if (pending.size) throw new Error('工具回合尚未完成，不能整理或重放调用。')
}

export interface ContextBoundOptions {
  /** Measure the actual protocol request, including instructions and tools. */
  measure?: (messages: ModelMessage[]) => number
  /** Persist completed history before replacing the active model view. */
  archive?: (content: string) => string
}

// Replace only complete rounds. Native blocks and call arguments are never
// sliced: an oversized completed round becomes a portable, archived handoff.
export function boundMessages(messages: ModelMessage[], budget = 46000, options: ContextBoundOptions = {}) {
  const measure = options.measure ?? ((items: ModelMessage[]) => JSON.stringify(items).length)
  const before = measure(messages)
  const makeSummary = (removed: ModelMessage[], limit: number, archiveId?: string): ModelMessage => {
    const summaries = removed.filter(isSummary)
    const previous = summaries.flatMap(summaryEntries)
    const calls = new Map(removed.flatMap(m => m.calls ?? []).map(call => [call.id, call]))
    const changes = removed.filter(m => m.role !== 'user').map(m => {
      if (m.role === 'assistant') return m.content ? '助手过程结论（待核对）：' + excerpt(m.content, 700) : ''
      const call = calls.get(m.callId || '')
      let args = call?.arguments ?? ''
      try {
        const parsed = JSON.parse(args)
        if (typeof parsed.content === 'string') parsed.content = '[完整写入内容见归档或实际文件]'
        args = JSON.stringify(parsed)
      } catch { /* Malformed tool arguments remain diagnostic data. */ }
      return '工具 ' + (call?.name ?? '') + ' ' + excerpt(args, 280) + '\n结果：' + excerpt(m.content, 700)
    }).filter(Boolean)
    // Keep the newest stated next action near the recent end of the summary.
    const latestAssistant = removed.filter(m => m.role === 'assistant' && m.content).at(-1)
    const latestNote = latestAssistant ? '助手过程结论（待核对）：' + excerpt(latestAssistant.content, 700) : ''
    const entries = boundedSummaryEntries([...previous, ...changes, latestNote], limit)
    const reference = archiveId ?? (summaries.length ? summaryArchive(summaries[summaries.length - 1]) : undefined)
    return { role: 'user', content: summaryPrefix + '\n' +
      (reference ? '完整记录：read_context id=' + reference + '，按 nextOffset/version 分页。\n' : '') +
      summaryNotice + summaryDataMarker + summaryData(entries) }
  }
  const commit = (candidate: ModelMessage[], removed: ModelMessage[], summaryIndex: number, limit: number) => {
    const archiveId = options.archive?.(JSON.stringify(removed))
    candidate[summaryIndex] = makeSummary(removed, limit, archiveId)
    const after = measure(candidate)
    if (after > budget) throw new ContextBudgetError('归档引用仍超过上下文预算；原始进度已保留。')
    messages.splice(0, messages.length, ...candidate)
    return { compacted: true, before, after, archiveId }
  }
  const summaries = messages.filter(isSummary)
  const needsMigration = summaries.length > 1 || summaries.some(m => makeSummary([m], 10000).content !== m.content)
  if (before <= budget && !needsMigration) return { compacted: false, before, after: before }
  assertCompleteToolRounds(messages)
  const placeholder = options.archive ? 'artifact:00000000-0000-0000-0000-000000000000' : undefined
  const initialLimit = Math.min(10000, Math.max(256, Math.floor(budget / 3)))
  if (needsMigration) {
    const index = messages.findIndex(isSummary)
    const candidate = messages.filter(m => !isSummary(m))
    candidate.splice(index, 0, makeSummary(summaries, initialLimit, placeholder))
    if (measure(candidate) <= budget) return commit(candidate, summaries, index, initialLimit)
  }
  let boundary = messages.length - 1
  while (boundary > 0 && messages[boundary].role === 'tool') boundary--
  if (boundary <= 1) boundary = messages.length
  let summaryLimit = initialLimit
  while (true) {
    const removed = messages.slice(1, boundary)
    // Actual user messages remain intact; generated summaries never replace them.
    const users = removed.filter(m => m.role === 'user' && !isSummary(m))
    const candidate = [messages[0], ...users, makeSummary(removed, summaryLimit, placeholder), ...messages.slice(boundary)]
    if (measure(candidate) <= budget) return commit(candidate, removed, 1 + users.length, summaryLimit)
    // Exhaust the smaller old-summary options before dropping fresh native data.
    if (summaryLimit > 256) { summaryLimit = Math.max(256, Math.floor(summaryLimit / 2)); continue }
    if (boundary < messages.length) { boundary = messages.length; summaryLimit = initialLimit; continue }
    throw new ContextBudgetError('当前必需指令、工具定义或用户输入超过请求预算；已保留执行进度，请缩小必需资料后继续。')
  }
}
