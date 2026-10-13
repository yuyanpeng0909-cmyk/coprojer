import { useEffect, useRef, useState } from 'react'
import type { Feature, ModelConfig } from '../../../shared/engineering'

export default function RuntimeHandoffDetails({ projectId, feature, models, busy }: { projectId: string; feature: Feature; models: ModelConfig[]; busy: boolean }) {
  const [modelId, setModelId] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [page, setPage] = useState<{ id: string; content: string; nextOffset: number | null; version: string }>()
  const identity = projectId + ':' + feature.id, current = useRef(identity); current.current = identity
  useEffect(() => { setModelId(''); setPage(undefined); setError(''); setSaving(false) }, [identity])
  const reliable = feature.runtimePolicy === 'receipts-effects-v1' || feature.runtimePolicy === 'receipts-readonly-v1'
  const disabled = busy || saving || feature.scope !== 'current' || !['ready', 'blocked'].includes(feature.stage)
  const act = async (action: 'migrate' | 'switch' | 'legacy') => {
    setSaving(true); setError('')
    try { await window.desktop.engineering.prepareRuntimeHandoff(projectId, feature.id, { action, ...(action === 'switch' ? { modelId } : {}) }) }
    catch (e) { if (current.current === identity) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (current.current === identity) setSaving(false) }
  }
  const read = async (id: string, next = false) => {
    setSaving(true); setError('')
    try {
      const value = JSON.parse(await window.desktop.engineering.readRuntimeArtifact({ projectId, featureId: feature.id, id,
        ...(next && page ? { offset: page.nextOffset ?? 0, version: page.version } : {}) }))
      if (current.current === identity) setPage({ id, ...value })
    } catch (e) { if (current.current === identity) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (current.current === identity) setSaving(false) }
  }
  const records = feature.runtimeHandoffs ?? (feature.runtimeHandoff ? [feature.runtimeHandoff] : [])
  return <details className="eng-context-details">
    <summary>任务迁移与换模 · {reliable ? '可靠执行已启用' : '旧运行策略'}</summary>
    <p className="eng-hint">仅为本功能当前开发或验证阶段准备续接。保留原记录、已完成效果和累计消耗；保存后仍需点击继续。待验收功能不能迁移。</p>
    {!reliable && <><p className="eng-hint">旧记录需先核对并迁移；缺失的历史用量保持未知，未完成或效果不明的记录需先处理。</p>
      <button className="ui-button secondary" disabled={disabled} onClick={() => void act('migrate')}>核对并迁移旧任务</button></>}
    <form onSubmit={e => { e.preventDefault(); void act('switch') }}>
      <label>本功能续接连接<select className="ui-input" value={modelId} disabled={disabled || !reliable} onChange={e => setModelId(e.target.value)} required>
        <option value="">选择已接入连接</option>{models.map(m => <option key={m.id} value={m.id}>{m.model} · {m.protocol}</option>)}
      </select></label>
      <button className="ui-button secondary" type="submit" disabled={disabled || !reliable || !modelId}>保存续接模型</button>
    </form>
    <details><summary>策略回退</summary><p className="eng-hint">仅无新回执的任务可使用旧策略。已有新效果的任务保留兼容读取与核对路径，不能丢弃记录后重跑。</p>
      <button className="ui-button secondary" disabled={disabled} onClick={() => void act('legacy')}>为后续运行使用旧策略</button></details>
    {feature.runtimeHandoff && <p role="status">{feature.runtimeHandoff.reason}</p>}
    {!!records.length && <details><summary>续接记录与原件（{records.length}）</summary>{records.map(record => <div key={record.id}>
      <p>{record.at} · {{ migrate: '迁移', switch: '换模', legacy: '旧策略' }[record.action]} · 修订 {record.taskRevision} · {models.find(m => m.id === record.modelId)?.model ?? record.modelId}</p>
      <button className="ui-button secondary" disabled={saving} onClick={() => void read('handoff-original:' + record.originalId)}>查看续接原件</button>
    </div>)}</details>}
    {page && <div aria-label="续接原件分页"><pre>{page.content}</pre>{page.nextOffset !== null && <button className="ui-button secondary" disabled={saving} onClick={() => void read(page.id, true)}>下一页续接原件</button>}</div>}
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
  </details>
}
