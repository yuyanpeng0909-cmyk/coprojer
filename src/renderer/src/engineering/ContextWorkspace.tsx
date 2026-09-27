import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  ExternalLink,
  FileText,
  FolderTree,
  Maximize2,
  Minimize2,
  Plus,
} from 'lucide-react'
import type { ContextEntry, Feature, Project } from '../../../shared/engineering'

export type ContextStageKey =
  | 'discussion'
  | 'requirements'
  | 'solution'
  | 'development'
  | 'verification'
  | 'acceptance'
  | 'manual'

export interface ContextFeatureNode {
  feature: Feature
  entries: ContextEntry[]
}

export interface ContextStageNode {
  key: ContextStageKey
  label: string
  description: string
  action?: { label: string; view: 'map' | 'board' | 'activity' }
  entries: ContextEntry[]
  features: ContextFeatureNode[]
}

const stageKeys: ContextStageKey[] = [
  'discussion',
  'requirements',
  'solution',
  'development',
  'verification',
  'acceptance',
  'manual',
]

const stageDefinitions: Record<
  ContextStageKey,
  Pick<ContextStageNode, 'label' | 'description' | 'action'>
> = {
  discussion: {
    label: '需求讨论',
    description: '目标、场景与问题边界',
    action: { label: '打开需求与功能图', view: 'map' },
  },
  requirements: {
    label: '需求确认',
    description: '已确认的基线、决策与范围',
    action: { label: '打开需求与功能图', view: 'map' },
  },
  solution: {
    label: '方案与任务',
    description: '实现方案、任务拆分与依赖',
    action: { label: '打开任务看板', view: 'board' },
  },
  development: {
    label: '代码开发',
    description: '开发现场、修改记录与执行过程',
    action: { label: '查看执行记录', view: 'activity' },
  },
  verification: {
    label: '独立验证',
    description: '测试结果、证据与修复反馈',
    action: { label: '查看执行记录', view: 'activity' },
  },
  acceptance: {
    label: '最终验收',
    description: '用户验收与已交付内容',
    action: { label: '查看执行记录', view: 'activity' },
  },
  manual: {
    label: '人工补充',
    description: '用户补充的工程知识',
  },
}

function stageForFeature(feature: Feature): ContextStageKey {
  switch (feature.stage) {
    case 'requirements':
      return 'requirements'
    case 'solution':
    case 'ready':
      return 'solution'
    case 'developing':
    case 'blocked':
      return 'development'
    case 'verifying':
      return 'verification'
    case 'acceptance':
    case 'done':
      return 'acceptance'
  }
}

function featureForEntry(entry: ContextEntry, features: Feature[]): Feature | undefined {
  if (entry.featureId) return features.find(f => f.id === entry.featureId)
  // Only accept an ID that exists in the current feature list. This prevents the
  // project-wide requirements baseline UUID from being mistaken for a feature.
  return features.find((feature) => entry.source.includes(feature.id) || entry.title.includes(feature.id))
}

function stageForEntry(entry: ContextEntry, feature?: Feature): ContextStageKey {
  if (entry.kind === 'goal') return 'discussion'
  if (entry.kind === 'requirements' || entry.kind === 'decision') return 'requirements'
  if (entry.kind === 'result') return 'verification'
  if (entry.kind === 'acceptance') return 'acceptance'
  if (entry.kind === 'manual') return 'manual'
  const text = `${entry.title} ${entry.source}`
  if (/用户创建项目|项目目标/.test(text)) return 'discussion'
  if (/用户最终验收|已交付|最终验收/.test(text)) return 'acceptance'
  if (/工程结果|独立验证|验证/.test(text)) return 'verification'
  if (/用户需求确认|完整需求|需求决策|需求边界|已确认需求|需求基线/.test(text)) {
    return 'requirements'
  }
  if (/用户编辑/.test(entry.source)) return 'manual'
  return feature ? stageForFeature(feature) : 'manual'
}

export function buildContextTree(project: Project): ContextStageNode[] {
  const stages = new Map<
    ContextStageKey,
    ContextStageNode & { featureMap: Map<string, ContextFeatureNode> }
  >()
  for (const key of stageKeys) {
    stages.set(key, {
      key,
      ...stageDefinitions[key],
      entries: [],
      features: [],
      featureMap: new Map(),
    })
  }

  const addFeature = (stage: ContextStageKey, feature: Feature): ContextFeatureNode => {
    const node = stages.get(stage)!
    const current = node.featureMap.get(feature.id)
    if (current) return current
    const created = { feature, entries: [] }
    node.featureMap.set(feature.id, created)
    node.features.push(created)
    return created
  }

  for (const feature of project.features ?? []) addFeature(stageForFeature(feature), feature)

  for (const entry of project.context ?? []) {
    const feature = featureForEntry(entry, project.features ?? [])
    const stage = stageForEntry(entry, feature)
    if (feature) addFeature(stage, feature).entries.push(entry)
    else stages.get(stage)!.entries.push(entry)
  }

  return stageKeys.map((key) => {
    const { featureMap: _featureMap, ...stage } = stages.get(key)!
    return stage
  })
}

function taskSummary(feature: Feature): string {
  const tasks = feature.tasks ?? []
  if (tasks.length) return `${tasks.filter((task) => task.done).length}/${tasks.length} 任务`
  if (feature.plan) return '已有方案，待拆分任务'
  return '待生成方案'
}

function formatAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

export default function ContextWorkspace({
  project,
  onAdd,
  onEdit,
  onFeature,
  onNavigate,
}: {
  project: Project
  onAdd(): void
  onEdit(entry: ContextEntry): void
  onFeature(id: string): void
  onNavigate(view: 'map' | 'board' | 'activity'): void
}) {
  const tree = useMemo(() => buildContextTree(project), [project])
  const allEntries = useMemo(
    () => tree.flatMap((stage) => [...stage.entries, ...stage.features.flatMap((feature) => feature.entries)]),
    [tree],
  )
  const [selectedId, setSelectedId] = useState<string | null>(() => allEntries[0]?.id ?? null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [expandedStages, setExpandedStages] = useState<Set<ContextStageKey>>(
    () => new Set(stageKeys),
  )
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!allEntries.some((entry) => entry.id === selectedId)) setSelectedId(allEntries[0]?.id ?? null)
  }, [allEntries, selectedId])
  useEffect(() => {
    const withEntries = new Set(
      tree.flatMap((stage) =>
        stage.features.filter((node) => node.entries.length).map((node) => node.feature.id),
      ),
    )
    setExpandedFeatures((current) => {
      let changed = false
      const next = new Set(current)
      for (const id of withEntries) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [tree])

  const selected = allEntries.find((entry) => entry.id === selectedId)
  const canArchive = selected && !['goal', 'requirements', 'acceptance'].includes(selected.kind || '') && !/用户需求确认|用户最终验收|用户创建项目/.test(selected.source)
  const archiveSelected = async () => {
    if (!selected || archiveBusy) return
    setArchiveBusy(true); setArchiveError('')
    try { await window.desktop.engineering.archiveContext(project.id, selected.id, selected.status !== 'archived') }
    catch (error) { setArchiveError(error instanceof Error ? error.message : String(error)) }
    finally { setArchiveBusy(false) }
  }
  const selectedFeature = selected ? featureForEntry(selected, project.features ?? []) : undefined
  const selectedStage = selected
    ? tree.find((stage) => stage.entries.some((entry) => entry.id === selected.id) || stage.features.some((feature) => feature.entries.some((entry) => entry.id === selected.id)))
    : undefined

  const toggleStage = (key: ContextStageKey) => {
    setExpandedStages((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const toggleFeature = (id: string) => {
    setExpandedFeatures((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const expandableFeatureIds = tree.flatMap((stage) =>
    stage.features.filter((node) => node.entries.length).map((node) => node.feature.id),
  )

  return (
    <div className="eng-context-workspace">
      {!!project.agentRuns?.length && <details className="eng-context-run"><summary>最近任务的上下文 · {project.agentRuns.at(-1)!.contextCharacters.toLocaleString()} 字符 · {project.agentRuns.at(-1)!.contextIds.length} 条资料</summary>
        <p>按当前功能和依赖取材；未注入的历史仍保留，可按 ID 分页读取。字符数不是模型 token 用量。</p>
        {project.agentRuns.slice(-6).reverse().map(run => <p key={run.id}>{run.role} · {run.contextCharacters.toLocaleString()} 字符 · {run.omittedCount} 条未注入 · 技能 {run.skills.map(s => s.id + '@' + s.version).join('、') || '无'}<br />资料：{run.contextIds.map(id => project.context.find(c => c.id === id)?.title || id).join('、') || '当前任务约束'}</p>)}
      </details>}
      <div className="eng-context-heading">
        <div>
          <p>按交付阶段查看项目知识，目录会随着模型开发与用户补充动态更新。</p>
          <small>
            {project.context.length} 条上下文 · {project.features.length} 个功能 · 记录来源保留
          </small>
        </div>
        <button className="ui-button secondary" disabled={!!project.activity} onClick={onAdd} type="button">
          <Plus size={13} />
          补充上下文
        </button>
      </div>
      <div className="eng-context-toolbar">
        <span>
          <FolderTree size={13} />
          目录层级：阶段 / 功能 / 记录
        </span>
        <div>
          <button
            className="ui-button secondary small"
            type="button"
            onClick={() => {
              setExpandedStages(new Set(stageKeys))
              setExpandedFeatures(new Set(expandableFeatureIds))
            }}
          >
            <Maximize2 size={12} />
            展开全部
          </button>
          <button
            className="ui-button secondary small"
            type="button"
            onClick={() => {
              setExpandedStages(new Set())
              setExpandedFeatures(new Set())
            }}
          >
            <Minimize2 size={12} />
            收起全部
          </button>
        </div>
      </div>
      <div className="eng-context-layout">
        <aside className="eng-context-tree" aria-label="共享上下文目录">
          {tree.map((stage) => {
            const expanded = expandedStages.has(stage.key)
            const count = stage.entries.length + stage.features.reduce((sum, node) => sum + node.entries.length, 0)
            const countLabel = count
              ? `${count} 条${stage.features.length ? ` · ${stage.features.length} 个功能` : ''}`
              : stage.features.length
                ? `${stage.features.length} 个功能 · 暂无记录`
                : '暂无记录'
            return (
              <section key={stage.key} className={`eng-context-stage ${expanded ? 'expanded' : ''}`}>
                <button
                  className="eng-context-stage-toggle"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleStage(stage.key)}
                >
                  <ChevronRight size={13} />
                  <strong>{stage.label}</strong>
                  <span>{countLabel}</span>
                </button>
                {expanded && (
                  <div className="eng-context-stage-body">
                    {stage.entries.map((entry) => (
                      <ContextEntryButton
                        key={entry.id}
                        entry={entry}
                        selected={selectedId === entry.id}
                        onClick={() => setSelectedId(entry.id)}
                      />
                    ))}
                    {stage.features.map((node) => {
                      const featureExpanded = expandedFeatures.has(node.feature.id)
                      return (
                        <div className="eng-context-feature" key={`${stage.key}-${node.feature.id}`}>
                          <div className="eng-context-feature-row">
                            <button
                              className="eng-context-feature-toggle"
                              type="button"
                              aria-expanded={featureExpanded}
                              onClick={() => toggleFeature(node.feature.id)}
                            >
                              <ChevronRight size={12} />
                              <span>{node.feature.title}</span>
                              <small>{node.entries.length ? `${node.entries.length} 条` : taskSummary(node.feature)}</small>
                            </button>
                            <button
                              className="eng-context-feature-open"
                              type="button"
                              title={`打开功能：${node.feature.title}`}
                              aria-label={`打开功能：${node.feature.title}`}
                              onClick={() => onFeature(node.feature.id)}
                            >
                              <ExternalLink size={11} />
                            </button>
                          </div>
                          {featureExpanded && (
                            <div className="eng-context-feature-entries">
                              {node.entries.length ? (
                                node.entries.map((entry) => (
                                  <ContextEntryButton
                                    key={entry.id}
                                    entry={entry}
                                    selected={selectedId === entry.id}
                                    onClick={() => setSelectedId(entry.id)}
                                  />
                                ))
                              ) : (
                                <p className="eng-context-node-empty">
                                  此功能暂未沉淀上下文，打开功能可继续生成方案。
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {!stage.entries.length && !stage.features.length && (
                      <div className="eng-context-node-empty">
                        <span>此阶段暂未沉淀上下文。</span>
                        {stage.action && (
                          <button
                            className="eng-context-node-action"
                            type="button"
                            onClick={() => onNavigate(stage.action!.view)}
                          >
                            {stage.action.label}
                            <ExternalLink size={11} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </aside>
        <section className="eng-context-detail" aria-live="polite">
          {selected ? (
            <article>
              <header>
                <div>
                  <span className="eng-context-detail-stage">{selectedStage?.label ?? '工程记录'}</span>
                  <h2>{selected.title}</h2>
                  <small>{selected.status === 'archived' ? '已归档 · 不自动注入新任务' : selected.status === 'superseded' ? '已被后续基线替代 · 旧任务仍可引用' : '有效资料'} · 修订 {selected.revision || 1}</small>
                </div>
                {canArchive && <button className="ui-button secondary small" disabled={archiveBusy || !!project.activity || !!project.designActivity} onClick={() => void archiveSelected()}>{selected.status === 'archived' ? '恢复使用' : '归档'}</button>}
                <button
                  className="ui-button secondary small"
                  type="button"
                  disabled={
                    !!project.activity ||
                    selected.source.includes('用户需求确认') ||
                    selected.source.includes('用户最终验收')
                  }
                  onClick={() => onEdit(selected)}
                >
                  编辑
                </button>
              </header>
              {archiveError && <p role="alert" className="eng-inline-error">{archiveError}</p>}
              <p className="eng-context-detail-content">{selected.content}</p>
              <footer>
                <span>来源：{selected.source}</span>
                <time dateTime={selected.at}>更新于 {formatAt(selected.at)}</time>
                {selectedFeature && (
                  <button
                    className="eng-context-related"
                    type="button"
                    onClick={() => onFeature(selectedFeature.id)}
                  >
                    查看关联功能：{selectedFeature.title}
                    <ExternalLink size={11} />
                  </button>
                )}
              </footer>
            </article>
          ) : (
            <div className="eng-context-detail-empty">
              <FileText size={20} />
              <strong>选择一条上下文记录</strong>
              <p>从左侧目录展开阶段、功能和记录，查看对应的工程依据。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ContextEntryButton({
  entry,
  selected,
  onClick,
}: {
  entry: ContextEntry
  selected: boolean
  onClick(): void
}) {
  return (
    <button
      className={`eng-context-entry ${selected ? 'selected' : ''}`}
      type="button"
      aria-pressed={selected}
      onClick={onClick}
    >
      <FileText size={12} />
      <span>{entry.title}</span>
      <small>{formatAt(entry.at)}</small>
    </button>
  )
}
