import { useEffect, useRef, useState } from 'react'
import { runtimeAllowanceBlockReason, runtimeBudgetBlockReason, type RuntimeBudget, type RuntimeBudgetTarget } from '../../../shared/runtime-budget'

export default function RuntimeBudgetDetails({ budget, target, busy, openRequest = 0 }: { budget?: RuntimeBudget; target: RuntimeBudgetTarget; busy?: boolean; openRequest?: number }) {
  const [editing, setEditing] = useState(false), [requests, setRequests] = useState(''), [tools, setTools] = useState(''), [minutes, setMinutes] = useState('')
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const blockedReason = !busy ? runtimeBudgetBlockReason(budget) : null
  const revealPause = !!blockedReason && !!(budget?.limits || budget?.activeLease)
  const [open, setOpen] = useState(revealPause)
  const details = useRef<HTMLDetailsElement>(null)
  const start = () => {
    if (editing) { setOpen(true); details.current?.querySelector('form')?.scrollIntoView({ block: 'start' }); return }
    setRequests(String(Math.max(budget?.limits?.requests ?? 0, budget?.used.requests ?? 0)))
    setTools(String(Math.max(budget?.limits?.tools ?? 0, budget?.used.tools ?? 0)))
    setMinutes(String(Math.ceil(Math.max(budget?.limits?.activeMs ?? 0, budget?.used.activeMs ?? 0) / 600) / 100))
    setError(''); setOpen(true); setEditing(true)
  }
  useEffect(() => { if (openRequest) start() }, [openRequest])
  useEffect(() => { if (revealPause) setOpen(true) }, [revealPause])
  useEffect(() => {
    if (editing) { details.current?.scrollIntoView({ block: 'start' }); details.current?.querySelector('input')?.focus({ preventScroll: true }) }
  }, [editing, openRequest])
  const save = async () => {
    setSaving(true); setError('')
    try {
      const limits = { requests: Number(requests), tools: Number(tools), activeMs: Math.round(Number(minutes) * 60000) }
      const blocked = runtimeAllowanceBlockReason(budget?.used ?? { requests: 0, tools: 0, activeMs: 0 }, limits)
      if (blocked) throw new Error(blocked)
      await window.desktop.engineering.adjustRuntimeBudget(target, limits, reason); setEditing(false); setReason('')
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setSaving(false) }
  }
  return <details ref={details} className="eng-context-details" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>任务累计额度 · {budget?.limits ? '已启用' : '待明确授予'}</summary>
    {blockedReason && <p className="eng-inline-error" role="status">{blockedReason} 已完成的文件、检查记录和断点保留。</p>}
    {!budget && <p className="eng-hint">此旧任务尚未启用累计额度，历史用量未知。可明确授予启用后的有限额度；不会补造历史用量或迁移已有工具记录。</p>}
    {budget && <>
    <p className="eng-hint">{budget.historical.kind === 'exact' ? '从任务创建开始累计。' : '启用前历史用量' + (budget.historical.kind === 'unknown' ? '未知' : '仅有下界') + '；以下单独累计启用后的消耗。'}继续、重启或换模不会清零。</p>
    {budget.activeLease && !busy && <p role="status">上段活动时间尚未可靠结算；先核对效果，再明确授予后续有限时间。原预占不会清零。</p>}
    {!!budget.unsettledActivity?.length && <p className="eng-hint">有 {budget.unsettledActivity.length} 段历史活动时间未知，已保留原预占与用户授予记录；累计时间不能视为精确实测。</p>}
    <dl><dt>模型请求</dt><dd>{budget.used.requests} / {budget.limits?.requests ?? '未授予'}</dd>
      <dt>工具调用</dt><dd>{budget.used.tools} / {budget.limits?.tools ?? '未授予'}</dd>
      <dt>活动时间</dt><dd>{(budget.used.activeMs / 60000).toFixed(2)} / {budget.limits ? (budget.limits.activeMs / 60000).toFixed(2) : '未授予'} 分钟</dd></dl>
    <p className="eng-hint">累计值包含可靠预占；异常退出时无法确认是否使用的预占会保留，不能据此声称实际已调用。单次继续仍沿用角色步数，工具超时与业务修复轮次另计。token 用量和费用不作为可靠硬额度。</p>
    </>}
    <button className="ui-button secondary" disabled={busy || saving} onClick={start}>{budget ? '调整任务总额度' : '授予后续有限额度'}</button>
    {editing && <form onSubmit={e => { e.preventDefault(); void save() }}>
      <p className="eng-hint">填写包含已用部分的总额度。保存后点击继续，接续原任务。</p>
      <label className="eng-field">模型请求总额度<input type="number" min="0" step="1" value={requests} onChange={e => { setRequests(e.target.value); setError('') }} required /></label>
      <label className="eng-field">工具调用总额度<input type="number" min="0" step="1" value={tools} onChange={e => { setTools(e.target.value); setError('') }} required /></label>
      <label className="eng-field">活动分钟总额度<input type="number" min="0" step="0.01" value={minutes} onChange={e => { setMinutes(e.target.value); setError('') }} required /></label>
      <label className="eng-field">调整原因<input value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} required /></label>
      <button className="ui-button" disabled={saving || busy} type="submit">保存额度</button><button className="ui-button secondary" type="button" onClick={() => setEditing(false)}>取消调整</button>
    </form>}
    {error && <p role="alert" className="eng-inline-error">{error}</p>}
    {budget && <details><summary>额度调整记录（{budget.adjustments.length}）</summary>{budget.adjustments.map((a, i) => <p key={i}>{a.at} · {a.source === 'local-user' ? '本机用户' : '新任务初值'} · {a.reason} · 请求 {a.before?.requests ?? '未授予'}→{a.after.requests}，工具 {a.before?.tools ?? '未授予'}→{a.after.tools}，活动毫秒 {a.before?.activeMs ?? '未授予'}→{a.after.activeMs}</p>)}</details>}
  </details>
}
