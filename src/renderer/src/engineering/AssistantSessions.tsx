import { useState } from 'react'
import { Pin, Plus, Search } from 'lucide-react'
import type { EngineeringState } from '../../../shared/engineering'
import type { AssistantMemoryInput, AssistantSession } from '../../../shared/assistant'

export type AssistantRun = (action: () => Promise<unknown>) => Promise<void>
export const assistantError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')
const api = () => window.desktop.engineering

export function SessionList({ state, currentProjectId, activeId, run, onCreate, onSelect }: { state: EngineeringState; currentProjectId?: string; activeId?: string; run: AssistantRun; onCreate(projectId?: string): void; onSelect(id: string): void }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [renameId, setRenameId] = useState(''), [title, setTitle] = useState(''), [deleting, setDeleting] = useState('')
  const sessions = (state.assistant?.sessions || []).filter(s => (filter === 'archived' ? s.archived : !s.archived) && (filter !== 'project' || s.projectId === currentProjectId) && (!query || (s.title + ' ' + s.messages.map(m => m.text).join(' ')).toLowerCase().includes(query.toLowerCase()))).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
  return <section className="assistant-sessions" aria-label="会话列表"><div className="assistant-session-tools"><label className="assistant-search"><Search size={14} /><input aria-label="搜索会话" placeholder="搜索标题和消息" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className="assistant-filters"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>最近</button>{currentProjectId && <button aria-pressed={filter === 'project'} onClick={() => setFilter('project')}>当前项目</button>}<button aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>归档</button></div>
    <button className="ui-button secondary" onClick={() => onCreate()}><Plus size={12} />新建全局会话</button>{currentProjectId && <button className="ui-button secondary" onClick={() => onCreate(currentProjectId)}><Plus size={12} />新建项目会话</button>}
  </div><div className="assistant-session-list">{!sessions.length && <p className="assistant-empty">{query ? '没有匹配的会话。' : '这里还没有会话。'}</p>}{sessions.map(s => <article key={s.id} className={'assistant-session-row' + (s.id === activeId ? ' selected' : '')}>
    {renameId === s.id ? <form onSubmit={e => { e.preventDefault(); void run(async () => { await api().updateAssistantSession(s.id, { title }); setRenameId('') }) }}><input aria-label="会话名称" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} /><button className="ui-button secondary" disabled={!title.trim()}>保存名称</button><button type="button" className="ui-button secondary" onClick={() => setRenameId('')}>取消</button></form> : <button className="assistant-session-open" onClick={() => onSelect(s.id)} aria-current={s.id === activeId ? 'true' : undefined}><strong>{s.pinned && <Pin size={11} />}{s.title}</strong><span>{s.projectId ? state.projects.find(p => p.id === s.projectId)?.name || '原项目已删除' : '全局'} · {new Date(s.updatedAt).toLocaleDateString()}</span><small>{s.messages.some(m => m.status === 'pending') ? '正在回复…' : s.messages.at(-1)?.text.slice(0, 70) || '尚无消息'}</small></button>}
    <div className="assistant-session-actions"><button onClick={() => { setRenameId(s.id); setTitle(s.title) }}>改名</button><button onClick={() => void run(() => api().updateAssistantSession(s.id, { pinned: !s.pinned }))}>{s.pinned ? '取消置顶' : '置顶'}</button><button onClick={() => void run(() => api().updateAssistantSession(s.id, { archived: !s.archived }))}>{s.archived ? '恢复' : '归档'}</button><button disabled={s.messages.some(m => m.status === 'pending')} onClick={() => setDeleting(s.id)}>删除</button></div>
    {deleting === s.id && <div className="assistant-delete"><p>删除这段会话及其方案记录？项目和已确认偏好会保留。</p><button className="ui-button danger" onClick={() => void run(async () => { await api().deleteAssistantSession(s.id); setDeleting('') })}>确认删除会话</button><button className="ui-button secondary" onClick={() => setDeleting('')}>取消</button></div>}
  </article>)}</div></section>
}

export function MemoryView({ state, session, initialText, run, onBack }: { state: EngineeringState; session?: AssistantSession; initialText: string; run: AssistantRun; onBack(): void }) {
  const [text, setText] = useState(initialText), [id, setId] = useState<string>(), [projectId, setProjectId] = useState(session?.projectId || ''), [deleting, setDeleting] = useState('')
  return <section className="assistant-memory" aria-label="已确认偏好"><button className="ui-button secondary" onClick={onBack}>返回对话</button><h2>已确认偏好</h2><p>只有你确认的内容会用于以后的对话。临时选择不会自动成为记忆。</p>
    <form onSubmit={e => { e.preventDefault(); const input: AssistantMemoryInput = { id, text, projectId: projectId || undefined, sourceSessionId: session?.id }; void run(async () => { await api().saveAssistantMemory(input); setText(''); setId(undefined) }) }}>
      <label className="assistant-field"><span>{id ? '编辑偏好' : '要记住的偏好'}</span><textarea aria-label="偏好内容" rows={3} maxLength={1000} value={text} onChange={e => setText(e.target.value)} placeholder="例如：推荐团队配置时优先控制成本" /></label>
      <label className="assistant-field"><span>使用范围</span><select aria-label="偏好使用范围" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">全局偏好</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <button className="ui-button primary" disabled={!text.trim()}>确认保存偏好</button>{id && <button type="button" className="ui-button secondary" onClick={() => { setId(undefined); setText('') }}>取消编辑</button>}
    </form>
    {(state.assistant?.memories || []).map(m => <article className="assistant-memory-item" key={m.id}><p>{m.text}</p><small>{m.projectId ? state.projects.find(p => p.id === m.projectId)?.name || '原项目已删除' : '全局偏好'}</small><div><button onClick={() => { setId(m.id); setText(m.text); setProjectId(m.projectId || '') }}>编辑</button><button onClick={() => setDeleting(m.id)}>删除</button></div>{deleting === m.id && <div><span>删除后不再用于新回复。</span><button className="ui-button danger" onClick={() => void run(async () => { await api().deleteAssistantMemory(m.id); setDeleting('') })}>确认删除偏好</button><button onClick={() => setDeleting('')}>取消</button></div>}</article>)}
    {!state.assistant?.memories.length && <p className="assistant-empty">尚未保存任何长期偏好。</p>}
  </section>
}
