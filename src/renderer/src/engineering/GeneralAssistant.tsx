import { useEffect, useRef, useState } from 'react'
import { Bot, LoaderCircle, Send } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EngineeringState } from '../../../shared/engineering'
import { AssistantModelSelect, hasAssistantModel, ModelUsage } from './AssistantModels'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')

export function DefaultAssistantSettings({ state, refresh, onOpen }: { state: EngineeringState; refresh: () => Promise<void>; onOpen: () => void }) {
  const [selected, setSelected] = useState(state.defaultAssistantModelId || '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => { setSelected(state.defaultAssistantModelId || '') }, [state.defaultAssistantModelId])
  const save = async () => {
    setBusy(true); setError(''); setNotice('')
    try { await window.desktop.engineering.setDefaultAssistantModel(selected); await refresh(); setNotice(selected ? '默认通用助手模型已保存。' : '已取消默认模型，可在每次请求时选择。') }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <section className="eng-assistant-settings" aria-label="默认通用助手模型设置">
    <h3>默认通用助手模型</h3>
    <p className="eng-hint">用于闲聊、操作引导、Skill 搜索推荐和智能体模型分配建议。工程任务继续使用各智能体绑定的模型。</p>
    <label className="eng-field"><span>默认通用助手模型</span><select aria-label="默认通用助手模型" value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setNotice('') }}>
      <option value="">不设置默认，每次选择</option>
      {state.models.map(m => <option key={m.id} value={m.id}>{m.model}</option>)}
    </select></label>
    <p className="eng-hint">使用 qwen3.7-flash 时，可点击已有 DashScope 连接的“复用连接”，获取并选择具体模型 ID 后保存；地址、协议和密钥沿用该连接。</p>
    <div className="eng-assistant-actions"><button className="ui-button primary" disabled={busy || selected === (state.defaultAssistantModelId || '')} onClick={() => void save()}>保存默认模型</button><button className="ui-button secondary" onClick={onOpen}><Bot size={14} />打开通用助手</button></div>
    {notice && <p className="eng-inline-result" role="status">{notice}</p>}{error && <p className="eng-inline-error" role="alert">{error}</p>}
  </section>
}

export default function GeneralAssistant({ state, refresh }: { state: EngineeringState; refresh: () => Promise<void> }) {
  const [override, setOverride] = useState(''), [draft, setDraft] = useState(''), [error, setError] = useState(''), [sending, setSending] = useState(false)
  const chat = state.assistantChat || [], pending = sending || chat.some(m => m.status === 'pending')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [chat.length, chat.at(-1)?.status])
  const send = async () => {
    if (pending || !draft.trim()) return
    const message = draft.trim(), modelId = override
    setSending(true); setError(''); setOverride('')
    try { await window.desktop.engineering.sendAssistantMessage(message, modelId); setDraft(''); await refresh() }
    catch (e) { setError(errorText(e)) } finally { setSending(false) }
  }
  return <div className="eng-form eng-general-assistant">
    <p className="eng-hint">闲聊与操作引导，对话独立保存在本机。</p>
    <AssistantModelSelect state={state} value={override} onChange={setOverride} disabled={pending} />
    <div className="eng-assistant-history" aria-label="通用助手对话">
      {!chat.length && <p className="eng-hint">例如：如何为一个智能体导入 Skill？</p>}
      {chat.map(entry => <article className={'eng-assistant-message ' + entry.role} key={entry.id}>
        <strong>{entry.role === 'user' ? '你' : '通用助手'}</strong>
        {entry.text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>}
        {entry.status === 'pending' && <p role="status">正在回复…</p>}
        {entry.error && <p className="eng-inline-error" role="alert">{entry.error}</p>}
        <ModelUsage usage={entry.usage} pending={entry.status === 'pending'} />
      </article>)}<div ref={end} />
    </div>
    <form className="eng-form" onSubmit={e => { e.preventDefault(); void send() }}>
      <label className="eng-field"><span>消息</span><textarea rows={2} maxLength={8000} value={draft} disabled={pending} onChange={e => setDraft(e.target.value)} placeholder="输入问题或需要的操作引导" /></label>
      <div className="eng-assistant-actions"><button type="submit" className="ui-button primary" disabled={pending || !draft.trim() || !hasAssistantModel(state, override)}>{pending ? <LoaderCircle size={14} /> : <Send size={14} />}{pending ? '回复中…' : '发送'}</button>
        <button type="button" className="ui-button secondary" disabled={pending || !chat.length} onClick={() => { setError(''); void window.desktop.engineering.clearAssistantChat().then(refresh).catch(e => setError(errorText(e))) }}>清空对话</button></div>
    </form>
    {!hasAssistantModel(state, override) && <p className="eng-hint">请先设置默认通用助手模型，或选择本次模型。</p>}
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
  </div>
}
