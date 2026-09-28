import { useId, useState, type ReactNode } from 'react'
import { AlertCircle, Archive, ArrowRight, CircleCheck, FolderOpen, LoaderCircle, Pencil, Pin, Search } from 'lucide-react'
import type { EngineeringApi, EngineeringState, Project } from '../../../shared/engineering'
import { Overlay, Tabs } from '../components/ui'
import BoardBatchActions from './BoardBatchActions'
import { WelcomeWorkspace } from './WorkspaceOverview'
import { lastProjectActivity, projectAttention, projectContinuation, projectIsRunning, type ProjectDestination } from './project-library'
import './project-manager.css'

function projectStatus(project: Project) {
  if (project.archivedAt) return '已归档'
  if (project.activity || project.designActivity) return '执行中'
  if (projectAttention(project).length) return '待处理'
  if (project.features.length && project.features.every(feature => feature.stage === 'done')) return '已完成'
  return project.features.length ? '进行中' : '待规划'
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': Error: /, '')

export default function ProjectManager({
  state, loaded, loadFailed, onRetry, onSelect, onOpen, onUpdate, onOpenFolder, onCreate, onModels, onAgents, onboarding,
}: {
  state: EngineeringState
  onboarding?: ReactNode
  loaded: boolean
  loadFailed: boolean
  onRetry(): void
  onSelect(id: string): void
  onOpen(id: string, destination: ProjectDestination): void
  onUpdate: EngineeringApi['updateProjectMetadata']
  onOpenFolder(id: string): Promise<void>
  onCreate(): void
  onModels(): void
  onAgents(): void
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('activity')
  const [scope, setScope] = useState<'active' | 'archived'>('active')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const formId = useId()
  const act = async (work: () => Promise<void>, message?: string) => {
    if (busy) return false
    setBusy(true); setError(''); setNotice('')
    try {
      await work()
      if (message) setNotice(message)
      return true
    } catch (cause) {
      setError(messageOf(cause))
      return false
    } finally { setBusy(false) }
  }
  const rename = async () => {
    if (!editing) return
    if (await act(() => onUpdate(editing.id, { name: editing.name }), '项目已重命名，目录保持原位。')) setEditing(null)
  }
  if (!loaded) return (
    <div className="project-manager-state" role="status">
      {loadFailed ? <>
        <p>项目列表加载失败，请重试。</p>
        <button className="ui-button secondary" onClick={onRetry}>重新加载</button>
      </> : <><LoaderCircle size={18} /><p>正在加载项目…</p></>}
    </div>
  )
  if (!state.projects.length) return (
    <div className="project-manager">{onboarding}<WelcomeWorkspace state={state} onCreate={onCreate} onModels={onModels} onAgents={onAgents} /></div>
  )
  const active = state.projects.filter(project => !project.archivedAt)
  const archived = state.projects.filter(project => !!project.archivedAt)
  const matches = (project: Project) => `${project.name} ${project.brief} ${project.root}`.toLowerCase().includes(query.trim().toLowerCase())
  const priorities = { failure: 0, decision: 1, acceptance: 2, requirements: 3, prototype: 4, plan: 5 }
  const attention = active.filter(matches).flatMap(project => projectAttention(project).map(item => ({ project, ...item })))
    .sort((a, b) => priorities[a.kind] - priorities[b.kind])
  const source = scope === 'active' ? active : archived
  const projects = source.filter(matches).sort((a, b) => {
    if (scope === 'active' && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN')
    return sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : lastProjectActivity(b).localeCompare(lastProjectActivity(a))
  })
  return (
    <section className="project-manager" aria-label="已保存的项目">
      {onboarding}
      {error && !editing && <p className="eng-inline-error" role="alert">{error}</p>}
      {scope === 'active' && attention.length > 0 && (
        <section className="project-attention" aria-label="跨项目待处理事项">
          <header>
            <h2>待你处理 <span>{attention.length}</span></h2>
            <span>查看资料，确认后再推进</span>
          </header>
          {(expanded ? attention : attention.slice(0, 3)).map(item => (
            <button key={`${item.project.id}-${item.id}`} className="project-attention-row"
              disabled={busy} onClick={() => onOpen(item.project.id, item.destination)}
              aria-label={`${item.project.name}：${item.title}，${item.detail}`}>
              {item.kind === 'failure' ? <AlertCircle size={15} className="project-attention-failure" /> : <CircleCheck size={15} />}
              <span><strong>{item.title}<small>{item.project.name}</small></strong><span title={item.detail}>{item.detail}</span></span>
              <ArrowRight size={13} />
            </button>
          ))}
          {attention.length > 3 && <button className="project-attention-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起待处理事项' : `展开全部 ${attention.length} 项`}
          </button>}
        </section>
      )}
      <div className="project-library-heading">
        <div><h2>我的项目</h2>{notice && <p className="project-library-notice" role="status" title={notice}>{notice}</p>}</div>
        <Tabs value={scope} onChange={setScope} label="项目范围" style="segment" options={[
          { value: 'active', label: `活跃项目 ${active.length}` },
          { value: 'archived', label: `已归档 ${archived.length}` },
        ]} />
      </div>
      <div className="project-manager-controls">
        <label className="workspace-search project-manager-search">
          <Search size={14} />
          <input aria-label="搜索项目" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目名称、目标或路径…" />
        </label>
        <span role="status">{query.trim() ? `${projects.length} / ${source.length}` : source.length} 个项目</span>
        <label className="project-manager-sort">排序
          <select aria-label="项目排序" value={sort} onChange={event => setSort(event.target.value)}>
            <option value="activity">最近活动</option>
            <option value="created">创建时间</option>
            <option value="name">项目名称</option>
          </select>
        </label>
      </div>
      {!projects.length ? (
        <div className="project-manager-state">
          {query.trim() ? <Search size={22} /> : <Archive size={22} />}
          <h2>{query.trim() ? '没有匹配的项目' : scope === 'archived' ? '还没有归档项目' : '暂时没有活跃项目'}</h2>
          <p>{query.trim() ? '试试其他名称、目标或路径。' : scope === 'archived' ? '归档会保留工程文件和全部开发记录，可随时恢复。' : '可以恢复已归档的项目，或开始一个新项目。'}</p>
          {query.trim() ? <button className="ui-button secondary" onClick={() => setQuery('')}>清除搜索</button>
            : scope === 'active' && <button className="ui-button secondary" onClick={() => setScope('archived')}>查看归档项目</button>}
        </div>
      ) : (
        <ul className="project-manager-list">
          {projects.map(project => {
            const date = new Date(lastProjectActivity(project))
            const done = project.features.filter(feature => feature.stage === 'done').length
            const continuation = projectContinuation(project)
            const running = projectIsRunning(project)
            return (
              <li key={project.id}>
                <article className="project-manager-row" aria-label={project.name}>
                  <span className="project-monogram"><FolderOpen size={17} /></span>
                  <div className="project-manager-copy">
                    <div className="project-manager-title">
                      <h2>{project.archivedAt ? <span title={project.name}>{project.name}</span> :
                        <button onClick={() => onSelect(project.id)} title={project.name}>{project.name}</button>}</h2>
                      {project.pinned && <Pin size={12} aria-label="已置顶" />}
                      <span className="eng-tag">{projectStatus(project)}</span>
                    </div>
                    <p title={project.brief}>{project.brief || '尚未填写项目目标'}</p>
                    <div className="project-manager-resume">
                      <div><strong title={continuation.summary}>{project.archivedAt ? '工程文件与记录已保留' : continuation.summary}</strong>
                        <small>{project.archivedAt ? '恢复后可继续开发' : `下一步：${continuation.next}`}</small></div>
                      <div className="project-manager-actions">
                        {project.archivedAt ? <button className="ui-button secondary small" disabled={busy}
                          aria-label={`恢复项目 ${project.name}`} onClick={() => void act(() => onUpdate(project.id, { archived: false }), '项目已恢复到活跃列表。')}>恢复项目</button>
                          : <button className="ui-button secondary small" disabled={busy}
                            aria-label={`继续开发 ${project.name}`} onClick={() => onOpen(project.id, continuation.destination)}>继续开发<ArrowRight size={13} /></button>}
                        {!project.archivedAt && <button className="eng-icon project-pin" disabled={busy}
                          aria-label={`${project.pinned ? '取消置顶' : '置顶项目'} ${project.name}`} aria-pressed={!!project.pinned}
                          title={project.pinned ? '取消置顶' : '置顶项目'} onClick={() => void act(() => onUpdate(project.id, { pinned: !project.pinned }), project.pinned ? '已取消置顶。' : '项目已置顶。')}>
                          <Pin size={14} />
                        </button>}
                        <BoardBatchActions compact label={`项目操作 ${project.name}`} summary={project.name} disabled={busy} actions={[
                          { label: '重命名', icon: <Pencil size={13} />, onSelect: () => { setError(''); setEditing({ id: project.id, name: project.name }) } },
                          { label: '打开目录', icon: <FolderOpen size={13} />, onSelect: () => void act(() => onOpenFolder(project.id)) },
                          ...(project.archivedAt ? [] : [{ label: running ? '执行或预览中，暂不能归档' : '归档项目', icon: <Archive size={13} />, disabled: running,
                            onSelect: () => void act(() => onUpdate(project.id, { archived: true }), '项目已归档，工程文件与记录全部保留，可在“已归档”中恢复。') }]),
                        ]} />
                      </div>
                    </div>
                    <div className="project-manager-meta">
                      <span>{project.features.length} 个功能 · {done} 个已验收</span>
                      {!Number.isNaN(date.getTime()) && <span>最近活动 <time dateTime={date.toISOString()}>{date.toLocaleDateString('zh-CN')}</time></span>}
                      <button className="project-manager-path" title={project.root} aria-label={`打开项目目录 ${project.name}`} disabled={busy}
                        onClick={() => void act(() => onOpenFolder(project.id))}><FolderOpen size={12} />查看目录</button>
                    </div>
                  </div>
                </article>
              </li>
            )
          })}
        </ul>
      )}
      <Overlay open={!!editing} onClose={() => { if (!busy) { setEditing(null); setError('') } }} title="重命名项目"
        description="只修改显示名称，工程目录和历史记录保持原位。" footer={<>
          <button className="ui-button secondary" disabled={busy} onClick={() => { setEditing(null); setError('') }}>取消</button>
          <button className="ui-button" type="submit" form={formId} disabled={busy || !editing?.name.trim()}>{busy ? '保存中…' : '保存名称'}</button>
        </>}>
        {editing && <form id={formId} className="eng-form" onSubmit={event => { event.preventDefault(); void rename() }}>
          <label className="eng-field"><span>项目名称</span><input autoFocus maxLength={80} value={editing.name}
            aria-invalid={!!error} aria-describedby={error ? `${formId}-error` : undefined}
            onChange={event => { setEditing({ ...editing, name: event.target.value }); setError('') }} /></label>
          {error && <p id={`${formId}-error`} className="eng-inline-error" role="alert">{error}</p>}
        </form>}
      </Overlay>
    </section>
  )
}
