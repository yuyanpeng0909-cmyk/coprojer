import { useEffect, useState } from 'react'
import { ArrowRight, Check, Play } from 'lucide-react'
import { Overlay } from '../components/ui'
import { agentRoleLabels, type EngineeringState, type Feature, type Project } from '../../../shared/engineering'
import { activePrototypeBriefs } from '../../../shared/prototype-workflow'

export function FirstRunCheck({ parent }: { parent?: string }) {
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string }[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.desktop.engineering.preflight(parent).then(result => { if (active) setChecks(result.checks) }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [parent])
  return <div className="eng-readiness" aria-live="polite">
    <strong>开发环境</strong>
    {!checks.length && !error && <span>正在检查本机环境…</span>}
    {checks.map(c => <span className={c.ok ? '' : 'eng-inline-error'} key={c.name}>{c.ok ? '✓' : '!'} {c.name} · {c.detail}</span>)}
    {error && <span role="alert">{error}</span>}
  </div>
}

export default function GuidedWorkflow({ project, state, onMap, onModels, onOpen, onBoard }: {
  project: Project; state: EngineeringState; onMap(): void; onModels(): void; onOpen(feature: Feature): void; onBoard(): void
}) {
  const [review, setReview] = useState<Feature[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.desktop.engineering
  const [team, setTeam] = useState({ plannerId: project.plannerId || state.agents.find(a => a.role === 'planner')?.id || '', designerId: project.designerId || state.agents.find(a => a.role === 'designer')?.id || '', contextBudget: project.contextBudget || 32000 })
  const current = project.features.filter(f => f.scope !== 'later')
  const teamAgents = (['planner', 'designer', 'developer', 'reviewer'] as const).flatMap(role => {
    const id = role === 'planner' ? project.plannerId : role === 'designer' ? project.designerId : undefined
    const agent = state.agents.find(a => a.role === role && a.id === id) || state.agents.find(a => a.role === role)
    return agent ? [agent] : []
  })
  const acceptance = current.find(f => f.stage === 'acceptance')
  const blocked = current.find(f => f.stage === 'blocked')
  const unplanned = current.filter(f => f.stage === 'solution' && (!f.plan || !f.tasks.length || f.planGenerationError))
  const candidates = current.filter(f => ['solution', 'ready'].includes(f.stage) && f.plan && f.tasks.length)
  const pending = busy || !!project.activity || !!project.designActivity
  const act = async (work: () => Promise<unknown>) => {
    if (pending) return
    setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const openReview = () => void act(async () => {
    const latest = (await api.state()).projects.find(p => p.id === project.id)
    if (!latest) throw new Error('项目已关闭，请重新打开。')
    const plans = latest.features.filter(f => f.scope === 'current' && ['solution', 'ready'].includes(f.stage) && f.plan && f.tasks.length)
    setReview(plans); setSelected(plans.slice(0, 8).map(f => f.id))
  })
  const connected = !!state.models.length && !!project.discussionModelId
  const requirements = current.some(f => f.stage === 'requirements')
  const briefs = activePrototypeBriefs(project)
  const design = briefs.find(b => b.status !== 'accepted')
  let title = '开始描述你的项目', detail = '规划、原型、开发和独立校验会按阶段接力。', label = '整理我的想法'
  let action: () => void = () => project.brief.trim() ? void act(async () => { await api.discuss(project.id, project.brief); onMap() }) : onMap()
  if (!connected) { title = '先连接一个模型'; detail = '保存后，默认四个角色会自动使用这个模型。'; label = '连接模型'; action = onModels }
  else if (project.activity) { title = project.activity; detail = '系统正在推进，完成后会显示下一步。'; label = '查看当前工作'; action = onBoard }
  else if (acceptance) { title = '试用并验收：' + acceptance.title; detail = '自动检查已完成；实际页面和业务结果仍需要你试用确认。'; label = '查看验收'; action = () => onOpen(acceptance) }
  else if (blocked) { title = '继续处理：' + blocked.title; detail = blocked.feedback || '现场和执行记录已保存，查看原因后可以继续。'; label = '处理阻塞'; action = () => onOpen(blocked) }
  else if (design) { title = design.status === 'review' ? '试用并验收你的原型' : design.status === 'designing' ? '正在根据设计意见生成原型' : '聊聊你期待的界面'; detail = '提交风格与交互意见后自动设计；验收通过的原型将用于实际开发。'; label = design.status === 'review' ? '查看原型与反馈' : '填写设计意见'; action = onMap }
  else if (briefs.length && (!project.prd || ['error', 'stale'].includes(project.prd.status))) { title = '原型已确定，继续整理 PRD'; detail = project.prd?.error || '根据你确认的原型提取页面、交互、业务规则和验收标准。'; label = '根据原型生成 PRD'; action = () => void act(() => api.preparePrd(project.id)) }
  else if (requirements) { title = project.prd?.status === 'review' ? '审阅从原型生成的 PRD' : '确认要做的内容'; detail = '审阅需求与验收标准后，再按已确认原型设计实现方案。'; label = '审阅需求与原型'; action = onMap }
  else if (unplanned.length) { title = '准备实现方案'; detail = '已有方案保留，只处理缺少方案或上次失败的功能。'; label = '准备全部方案'; action = () => void act(async () => { const results = await api.preparePlans(project.id); const failed = results.filter(r => !r.success); if (failed.length) throw new Error(failed.length + ' 项未完成，其余已保留。请到任务看板查看原因。') }) }
  else if (candidates.length) { title = '方案就绪，可以开工'; detail = '一次审阅本批功能，系统按依赖顺序开发、检查和修复。'; label = '审阅方案并开始'; action = openReview }
  else if (current.length && current.every(f => f.stage === 'done')) { title = '本期功能已验收'; detail = '可以打开项目试用，或继续规划下一期。'; label = '规划下一期'; action = onMap }
  return <section className="eng-guided-flow" aria-label="项目下一步">
    <div className="eng-guided-copy"><span className="eng-kicker">下一步</span><h2>{title}</h2><p>{detail}</p></div>
    <div className="eng-guided-actions">
      <button className="ui-button primary" disabled={busy || !!project.designActivity} onClick={action}>{busy ? '处理中…' : label}<ArrowRight size={13} /></button>
      {(acceptance || current.some(f => f.stage === 'done')) && <button className="ui-button secondary" disabled={pending} onClick={() => void act(async () => { await api.startPreview(project.id, 'dev'); await api.openPreview(project.id) })}><Play size={13} />启动并打开预览</button>}
    </div>
    <div className="eng-team-summary">{teamAgents.map(a => <span key={a.id} title={a.name}>{a.modelId && <Check size={11} />}{agentRoleLabels[a.role]} · {(a.skillIds || []).length} 项技能</span>)}</div>
    {error && <p role="alert" className="eng-inline-error">{error}</p>}
    <details className="eng-guided-settings"><summary>团队与上下文设置</summary><div className="eng-form">
      {(['planner', 'designer'] as const).map(role => <label key={role}>{agentRoleLabels[role]}智能体<select aria-label={agentRoleLabels[role] + '智能体'} value={role === 'planner' ? team.plannerId : team.designerId} onChange={e => setTeam({ ...team, [role === 'planner' ? 'plannerId' : 'designerId']: e.target.value })}>{state.agents.filter(a => a.role === role).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>)}
      <label>资料字符预算<input type="number" min={8000} max={64000} step={1000} value={team.contextBudget} onChange={e => setTeam({ ...team, contextBudget: Number(e.target.value) })} /></label>
      <small>只计算组装资料的字符数，模型输入还包括技能、工具和当前对话。必需约束超限时会明确提示。</small>
      <button className="ui-button secondary" disabled={pending} onClick={() => void act(() => api.configureProject(project.id, team))}>保存团队与预算</button>
    </div></details>
    <Overlay open={!!review} onClose={() => { if (!busy) setReview(null) }} title="审阅方案并开始" description="选择本批功能（最多 8 项），确认范围和方案后启动；每项完成后仍需你验收。" footer={<>
      <button className="ui-button secondary" onClick={() => setReview(null)} disabled={busy}>取消</button>
      <button className="ui-button primary" disabled={pending || !selected.length || selected.length > 8} onClick={() => void act(async () => {
        const chosen = (review || []).filter(f => selected.includes(f.id))
        const results = await api.confirmPlansAndStart(project.id, chosen.map(f => f.id), chosen.map(f => f.revision))
        const failed = results.filter(r => !r.success)
        if (failed.length) throw new Error(failed.map(r => r.error).join('；'))
        setReview(null)
      })}>确认方案并开始</button>
    </>}>
      <div className="eng-plan-review">{review?.map(f => <article key={f.id}>
        <label><input type="checkbox" checked={selected.includes(f.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, f.id] : ids.filter(id => id !== f.id))} />{f.title}</label>
        <p>{f.description}</p><small>前置功能：{f.dependencies.map(id => project.features.find(dep => dep.id === id)?.title || id).join('、') || '无'}</small>
        <details><summary>查看方案、任务和验收标准</summary><p className="eng-plan-text">{f.plan}</p><ul>{f.tasks.map(t => <li key={t.id}>{t.title}</li>)}</ul><strong>验收标准</strong><ul>{f.criteria.map(c => <li key={c}>{c}</li>)}</ul></details>
      </article>)}</div>
      {error && <p role="alert" className="eng-inline-error">{error}</p>}
    </Overlay>
  </section>
}
