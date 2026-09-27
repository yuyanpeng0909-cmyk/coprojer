import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, Bot, Check, Copy, MessageSquare, MoreHorizontal, Send, Settings2, Square } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EngineeringState } from '../../../shared/engineering'
import type { AssistantDestination, AssistantSession, AssistantSessionPatch } from '../../../shared/assistant'
import { hasAssistantModel, ModelUsage } from './AssistantModels'
import { assistantError, type AssistantRun } from './AssistantSessions'
import AssistantTeamCard from './AssistantTeamCard'

const api = () => window.desktop.engineering
const hideActions = (text: string) => text.split(String.fromCharCode(96).repeat(3) + 'coprojer-actions')[0]
export default function Conversation({ session, state, currentProjectId, run, registerFlush, onNavigate, onRemember, onCreate }: { session: AssistantSession; state: EngineeringState; currentProjectId?: string; run: AssistantRun; registerFlush(fn: () => Promise<void>): void; onNavigate(destination: AssistantDestination, projectId?: string): void; onRemember(text: string): void; onCreate(projectId?: string): void }) {
  const [draft, setDraft] = useState(session.draft), [modelId, setModelId] = useState(session.modelId), [sending, setSending] = useState(false), [newReply, setNewReply] = useState(false), [clearing, setClearing] = useState(false), [saveError, setSaveError] = useState(''), [copied, setCopied] = useState('')
  const scroll = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), follow = useRef(!session.messages.length), buffered = useRef<AssistantSessionPatch>({}), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), queue = useRef(Promise.resolve())
  const editedSinceSend = useRef(false)
  const project = state.projects.find(p => p.id === session.projectId), missingProject = !!session.projectId && !project, pending = sending || session.messages.some(m => m.status === 'pending')
  const persist = () => {
    clearTimeout(timer.current); const patch = buffered.current; buffered.current = {}
    if (!Object.keys(patch).length) return queue.current
    queue.current = queue.current.catch(() => {}).then(() => api().updateAssistantSession(session.id, patch)).then(() => { setSaveError('') }).catch(e => { setSaveError(assistantError(e)); throw e })
    return queue.current
  }
  const save = (patch: AssistantSessionPatch) => { Object.assign(buffered.current, patch); clearTimeout(timer.current); timer.current = setTimeout(() => { void persist().catch(() => {}) }, 200) }
  useEffect(() => { registerFlush(persist); return () => { registerFlush(() => Promise.resolve()); void persist().catch(() => {}) } }, [])
  useEffect(() => window.desktop.onBeforeClose(persist), [])
  useLayoutEffect(() => { if (scroll.current) { scroll.current.scrollTop = session.scrollTop; follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 50 } }, [])
  useLayoutEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = Math.min(160, Math.max(54, input.current.scrollHeight)) + 'px' } }, [draft])
  const last = session.messages.at(-1)
  useEffect(() => { if (!scroll.current) return; if (follow.current) scroll.current.scrollTop = scroll.current.scrollHeight; else if (last?.status === 'complete') setNewReply(true) }, [session.messages.length, last?.text, last?.status])
  const send = async (text = draft, team = false) => {
    if (pending || (!text.trim() && !team)) return
    setSending(true); setSaveError(''); follow.current = true
    try {
      await persist()
      await run(async () => { const request = team ? api().recommendAssistantTeam(session.id, text, modelId) : api().sendAssistantMessage(text, modelId, session.id); editedSinceSend.current = false; setDraft(''); setModelId(''); try { await request } catch (e) { if (!editedSinceSend.current) { setDraft(text); setModelId(modelId); save({ draft: text, modelId }) } throw e } })
    } catch (e) { setSaveError(assistantError(e)) } finally { setSending(false) }
  }
  const navigate = (destination: AssistantDestination) => onNavigate(destination, session.projectId)
  const seed = (value: string) => { editedSinceSend.current = true; setDraft(value); save({ draft: value }); input.current?.focus() }
  const ready = hasAssistantModel(state, modelId)
  return <section className="assistant-conversation" aria-label="当前会话">
    {currentProjectId && session.projectId !== currentProjectId && <div className="assistant-context-note">此会话仍属于{session.projectId ? project?.name || '原项目' : '全局'}。<button onClick={() => onCreate(currentProjectId)}>为当前项目新建</button></div>}
    {missingProject && <div className="assistant-context-note">原项目已删除；历史保留，项目操作已停用。</div>}
    <div className="assistant-conversation-tools"><span>{session.summary ? '使用近期对话和历史摘录' : '使用当前会话'}{project ? '、项目状态及已确认偏好' : '及已确认偏好'}</span><details><summary aria-label="会话更多操作"><MoreHorizontal size={15} /></summary><button onClick={() => setClearing(true)} disabled={pending}>清空当前对话</button></details></div>
    {clearing && <div className="assistant-delete"><p>清空当前会话的消息？其他会话和偏好不会删除。</p><button className="ui-button danger" onClick={() => void run(async () => { await api().clearAssistantChat(session.id); setClearing(false) })}>确认清空</button><button className="ui-button secondary" onClick={() => setClearing(false)}>取消</button></div>}
    <div ref={scroll} className="assistant-messages" aria-label="通用助手对话" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50; if (follow.current) setNewReply(false); save({ scrollTop: el.scrollTop }) }}>
      {!session.messages.length && <div className="assistant-welcome"><MessageSquare size={25} strokeWidth={1.4} /><h2>从你想完成的事开始</h2><p>我可以带你操作 Coprojer，配好智能体，或一起看看项目卡在哪里。</p><div className="assistant-starts">
        <button onClick={() => ready ? seed('请根据我已有的连接和智能体配置，带我完成开始使用 Coprojer 所需的设置。') : navigate('models')}><Settings2 size={15} /><span><strong>带我完成配置</strong><small>连接模型，准备工作环境</small></span><ArrowRight size={13} /></button>
        <button disabled={!ready || missingProject || pending} onClick={() => void send(draft, true)}><Bot size={15} /><span><strong>推荐智能体组合</strong><small>按目标分工，只选已接入型号</small></span><ArrowRight size={13} /></button>
        <button disabled={missingProject} onClick={() => project ? seed('请检查当前项目的真实状态，解释阻塞和下一步，并给出对应操作入口。') : navigate('projects')}><Check size={15} /><span><strong>检查当前项目</strong><small>{project ? '看进展、配置与下一步' : '先选择一个项目'}</small></span><ArrowRight size={13} /></button>
      </div></div>}
      {!ready && <div className="assistant-setup"><strong>{state.models.length ? '先选择本次使用的模型' : '先接入一个模型'}</strong><p>配置引导无需调用模型。连接成功后就能开始对话。</p><ol><li>添加或复用模型连接</li><li>获取型号并测试连接</li><li>设置默认通用助手模型</li></ol><button className="ui-button secondary" onClick={() => navigate('models')}>打开模型连接<ArrowRight size={12} /></button></div>}
      {session.messages.map((entry, index) => <article key={entry.id} className={'assistant-message ' + entry.role}><div className="assistant-message-meta"><strong>{entry.role === 'user' ? '你' : '通用助手'}</strong><time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><div className="assistant-bubble">
        {entry.text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{hideActions(entry.text)}</ReactMarkdown>}
        {entry.status === 'pending' && <span role="status">{entry.requestKind === 'team' ? '正在准备团队方案…' : '正在回复…'}</span>}
        {entry.error && <p className="assistant-inline-error" role="alert">{entry.error}</p>}
        {entry.planId && state.assistant?.plans.find(p => p.id === entry.planId) && <AssistantTeamCard plan={state.assistant.plans.find(p => p.id === entry.planId)!} state={state} run={run} />}
        {!!entry.actions?.length && <div className="assistant-card-actions">{entry.actions.map((action, i) => <button key={i} className="ui-button secondary" disabled={missingProject && action.destination !== 'models' && action.destination !== 'projects'} onClick={() => action.kind === 'remember' ? onRemember(action.text || '') : action.destination && navigate(action.destination)}>{action.label}<ArrowRight size={12} /></button>)}</div>}
      </div>{entry.usage && <ModelUsage usage={entry.usage} pending={entry.status === 'pending'} />}<div className="assistant-message-actions">{entry.text && <button aria-label="复制消息" onClick={() => void run(async () => { await navigator.clipboard.writeText(entry.text); setCopied(entry.id) })}>{copied === entry.id ? <Check size={12} /> : <Copy size={12} />}{copied === entry.id ? '已复制' : '复制'}</button>}{['error', 'stopped'].includes(entry.status) && session.messages[index - 1]?.role === 'user' && <button disabled={pending || !ready || missingProject} onClick={() => void send(session.messages[index - 1].text, entry.requestKind === 'team')}>{entry.requestKind === 'team' ? '重新生成方案' : '重新发送'}</button>}</div></article>)}
    </div>
    {newReply && <button className="assistant-new-reply" onClick={() => { follow.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setNewReply(false) }}><ArrowDown size={12} />查看新回复</button>}
    <form className="assistant-composer" onSubmit={e => { e.preventDefault(); void send() }}>
      {!!session.messages.length && <div className="assistant-composer-shortcuts"><button type="button" disabled={pending || !ready || missingProject} onClick={() => void send(draft, true)}>推荐团队方案</button><button type="button" onClick={() => navigate('models')}>模型连接</button><button type="button" onClick={() => navigate('agents')}>智能体设置</button></div>}
      <textarea ref={input} aria-label="消息" maxLength={8000} placeholder="描述目标，或问我该怎么操作…" value={draft} disabled={missingProject} onChange={e => { editedSinceSend.current = true; setDraft(e.target.value); save({ draft: e.target.value }) }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !pending) { e.preventDefault(); void send() } }} />
      <div className="assistant-composer-bottom"><select aria-label="本次使用的通用助手模型" title="仅用于下一次请求，不修改默认设置" value={modelId} disabled={pending} onChange={e => { setModelId(e.target.value); save({ modelId: e.target.value }) }}><option value="">{state.models.find(m => m.id === state.defaultAssistantModelId)?.model || '选择本次模型'}</option>{state.models.map(m => <option key={m.id} value={m.id}>{m.model}{state.models.filter(other => other.model === m.model).length > 1 ? ' · ' + new URL(m.baseUrl).host : ''}</option>)}</select>
        {pending ? <button type="button" className="ui-button secondary" onClick={() => void run(() => api().stopAssistantMessage(session.id))}><Square size={12} />停止</button> : <button type="submit" className="ui-button primary" disabled={!draft.trim() || !ready || missingProject}><Send size={13} />发送</button>}
      </div><small className="assistant-composer-hint">Enter 发送 · Shift+Enter 换行 · 对话保存在本机</small>
      {saveError && <p role="alert" className="assistant-inline-error">草稿保存失败：{saveError} <button type="button" onClick={() => { save({ draft, modelId, scrollTop: scroll.current?.scrollTop || 0 }); void persist().catch(() => {}) }}>重试保存</button></p>}
    </form>
  </section>
}
