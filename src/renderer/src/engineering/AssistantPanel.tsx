import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, History, Maximize2, Minimize2, Plus, Settings2, X } from 'lucide-react'
import type { EngineeringState } from '../../../shared/engineering'
import type { AssistantDestination } from '../../../shared/assistant'
import Conversation from './AssistantConversation'
import { assistantError, MemoryView, SessionList, type AssistantRun } from './AssistantSessions'
import './assistant.css'

const api = () => window.desktop.engineering
function Icon({ label, children, onClick, pressed }: { label: string; children: ReactNode; onClick(): void; pressed?: boolean }) {
  return <button type="button" className="eng-icon" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>{children}</button>
}

export default function AssistantPanel({ state, refresh, currentProjectId, expanded, onExpandedChange, onClose, onNavigate }: {
  state: EngineeringState; refresh(): Promise<void>; currentProjectId?: string; expanded: boolean; onExpandedChange(value: boolean): void; onClose(): void; onNavigate(destination: AssistantDestination, projectId?: string): void
}) {
  const workspace = state.assistant, active = workspace?.sessions.find(s => s.id === workspace.activeSessionId)
  const [tab, setTab] = useState<'chat' | 'history' | 'memory'>('chat'), [error, setError] = useState(''), [memoryText, setMemoryText] = useState('')
  const creating = useRef(false), panel = useRef<HTMLElement>(null), trigger = useRef<HTMLElement | null>(null)
  const flush = useRef<() => Promise<void>>(() => Promise.resolve())
  const run: AssistantRun = async action => { setError(''); try { await action(); await refresh() } catch (e) { setError(assistantError(e)) } }
  useEffect(() => {
    trigger.current = document.activeElement as HTMLElement
    panel.current?.focus()
    return () => { if (trigger.current?.isConnected) trigger.current.focus() }
  }, [])
  useEffect(() => {
    if (!workspace || active || creating.current) return
    creating.current = true
    void run(() => api().createAssistantSession(currentProjectId)).finally(() => { creating.current = false })
  }, [workspace?.activeSessionId, workspace?.sessions.length])
  const create = (projectId?: string) => void run(async () => { await flush.current(); await api().createAssistantSession(projectId); setTab('chat') })
  const remember = (text: string) => void run(async () => { await flush.current(); setMemoryText(text); setTab('memory') })
  const close = () => void run(async () => { await flush.current(); await refresh(); onClose() })
  const switchTab = (next: 'chat' | 'history' | 'memory') => void run(async () => { await flush.current(); await refresh(); setTab(next) })
  return <aside ref={panel} tabIndex={-1} className={'assistant-panel' + (expanded ? ' expanded' : '')} role="dialog" aria-modal="false" aria-label="通用助手" onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.stopPropagation(); close() } }}>
    <header className="assistant-header"><div className="assistant-heading"><Bot size={17} /><strong>通用助手</strong><span>随时接着聊</span></div><div className="assistant-header-actions">
      <Icon label="会话历史" pressed={tab === 'history'} onClick={() => switchTab(tab === 'history' ? 'chat' : 'history')}><History size={15} /></Icon>
      <Icon label="新建会话" onClick={() => create(currentProjectId)}><Plus size={16} /></Icon>
      <Icon label={expanded ? '收起宽视图' : '展开宽视图'} onClick={() => onExpandedChange(!expanded)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</Icon>
      <Icon label="关闭面板" onClick={close}><X size={16} /></Icon>
    </div></header>
    <div className="assistant-scope"><span title={active?.title}>{active?.title || '准备新会话…'}</span><small>{active?.projectId ? state.projects.find(p => p.id === active.projectId)?.name || '原项目已删除' : '全局会话'}</small><Icon label="管理已确认偏好" pressed={tab === 'memory'} onClick={() => { setMemoryText(''); switchTab(tab === 'memory' ? 'chat' : 'memory') }}><Settings2 size={14} /></Icon></div>
    {error && <div className="assistant-error" role="alert">{error}<button className="eng-icon" aria-label="关闭错误提示" onClick={() => setError('')}><X size={12} /></button></div>}
    <div className={'assistant-body' + (expanded && tab !== 'memory' ? ' with-history' : '')}>
      {(expanded && tab !== 'memory' || tab === 'history') && <SessionList state={state} currentProjectId={currentProjectId} activeId={active?.id} run={run} onCreate={create} onSelect={id => void run(async () => { await flush.current(); await api().selectAssistantSession(id); setTab('chat') })} />}
      {tab === 'memory' ? <MemoryView state={state} session={active} initialText={memoryText} run={run} onBack={() => setTab('chat')} /> : (tab === 'chat' || expanded) && active ? <Conversation key={active.id} session={active} state={state} currentProjectId={currentProjectId} run={run} registerFlush={fn => { flush.current = fn }} onNavigate={onNavigate} onRemember={remember} onCreate={create} /> : tab !== 'history' && <p className="assistant-empty">正在恢复会话…</p>}
    </div>
  </aside>
}

export function AssistantHint({ state, projectId, onHelp, refresh }: { state: EngineeringState; projectId?: string; onHelp(text: string, projectId?: string): void; refresh(): Promise<void> }) {
  const project = state.projects.find(p => p.id === projectId), last = project?.events.at(-1), [error, setError] = useState('')
  const hint = !state.models.length ? { key: 'setup:no-models', text: '还没接入模型？我可以带你完成首次配置。', question: '带我完成首次模型连接配置。', projectId: undefined } : !state.defaultAssistantModelId ? { key: 'setup:no-default:' + state.models.map(m => m.id).join(',').slice(0, 180), text: '设置默认助手模型后，就能随时获得操作帮助。', question: '如何设置默认通用助手模型？', projectId: undefined } : project && (!project.plannerId || !project.designerId || project.features.some(f => !f.developerId || !f.reviewerId)) ? { key: 'team:' + project.id, text: '当前项目的必要成员尚未配齐。', question: '请检查当前项目缺少哪些成员，并给出配置建议。', projectId } : project && last && ['error', 'interrupted', 'repair'].includes(last.kind) ? { key: 'error:' + project.id + ':' + last.id, text: '最近的操作遇到了问题，可以一起检查原因。', question: '请根据当前项目最近的错误，解释已知原因和下一步检查。', projectId } : undefined
  if (!hint || state.assistant?.dismissedHints.includes(hint.key)) return error ? <p role="alert">{error}</p> : null
  return <div className="assistant-hint" role="status"><Bot size={14} /><span>{hint.text}</span><button onClick={() => onHelp(hint.question, hint.projectId)}>查看帮助</button><button className="eng-icon" aria-label="忽略助手提示" onClick={() => void api().dismissAssistantHint(hint.key).then(refresh).catch(e => setError(assistantError(e)))}><X size={12} /></button>{error && <span role="alert">{error}</span>}</div>
}
