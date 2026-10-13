import { useEffect, useState } from 'react'
import { Overlay } from '../components/ui'
import type { EngineeringState, ModelConfig } from '../../../shared/engineering'
import type { ModelRemovalPreview } from '../../../shared/model-removal'

export default function ModelRemovalDialog({ model, state, onClose, refresh }: { model: ModelConfig; state: EngineeringState; onClose(): void; refresh(): Promise<void> }) {
  const [preview, setPreview] = useState<ModelRemovalPreview>(), [replacement, setReplacement] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => {
    setError(''); setPreview(undefined)
    try { const result = await window.desktop.engineering.previewModelRemoval(model.id); setPreview(result); setReplacement(result.suggestedReplacementId || '') }
    catch (e) { setError(String(e)) }
  }
  useEffect(() => { void load() }, [model.id])
  const remove = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await window.desktop.engineering.deleteModel(model.id, replacement || undefined); await refresh(); onClose() }
    catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')) }
    finally { setBusy(false) }
  }
  const candidates = state.models.filter(m => m.id !== model.id)
  return <Overlay open title="删除模型连接" onClose={() => { if (!busy) onClose() }} footer={<><button className="ui-button secondary" disabled={busy} onClick={onClose}>取消</button><button className="ui-button primary" disabled={busy || !preview || !!preview.blockers.length || (!!preview.references.length && !replacement)} onClick={() => void remove()}>{busy ? '正在保存…' : preview?.references.length ? '迁移绑定并删除' : '删除连接'}</button></>}>
    <div className="eng-form"><p>将删除 <strong>{model.model}</strong></p><small className="eng-connection-identity">{model.baseUrl} · 连接 {model.id.slice(-8)}</small>
      {!preview && !error && <p role="status">正在读取引用…</p>}
      {preview && <>
        {!!preview.references.length && <label className="eng-field"><span>保留并改用的连接</span><select aria-label="替代模型连接" value={replacement} disabled={busy} onChange={e => setReplacement(e.target.value)}><option value="">请选择替代连接</option>{candidates.map(m => <option key={m.id} value={m.id}>{m.model} · {m.baseUrl} · {m.id.slice(-8)}</option>)}</select><small>同名连接可能属于不同账户，请确认服务地址及连接。{!candidates.length && '请先添加另一条可用连接。'}</small></label>}
        <details className="eng-model-references" open={preview.references.length <= 6}><summary>当前引用（{preview.references.length}）</summary><section aria-label="模型引用明细">{preview.references.length ? <ul>{preview.references.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>没有当前配置引用，可以直接删除。</p>}</section></details>
        <p className="eng-hint">修改当前配置与后续调用的绑定，保留历史聊天、运行记录和流量记录。正在执行的任务结束后才能迁移。</p>
        {!!preview.blockers.length && <div role="alert" className="eng-inline-error">{preview.blockers.map(item => <p key={item}>{item}</p>)}<button className="ui-button secondary" onClick={() => void load()}>重新读取引用</button></div>}
      </>}
      {error && <p role="alert" className="eng-inline-error">{error} <button className="ui-button secondary" disabled={busy} onClick={() => void load()}>重新读取引用</button></p>}
    </div>
  </Overlay>
}
