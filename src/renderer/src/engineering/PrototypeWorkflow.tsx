import { useEffect, useState } from 'react'
import type { Project, PrototypeBrief } from '../../../shared/engineering'
import { activePrototypeBriefs } from '../../../shared/prototype-workflow'

export default function PrototypeWorkflow({ project, targetId, onPreview, onReview }: {
  project: Project; targetId?: string; onPreview(targetId?: string): void; onReview(): void
}) {
  if (project.decisions?.some(d => d.status === 'pending')) return null
  const briefs = activePrototypeBriefs(project)
  const brief = briefs.find(b => targetId && b.targetId === targetId) || briefs.find(b => b.status !== 'accepted') || briefs[0]
  if (!brief) return null
  return <DesignOpinion key={(brief.targetId || '') + ':' + (brief.prototypeId || '')} project={project} brief={brief} onPreview={onPreview} onReview={onReview} />
}

function DesignOpinion({ project, brief, onPreview, onReview }: { project: Project; brief: PrototypeBrief; onPreview(targetId?: string): void; onReview(): void }) {
  const draftKey = 'coprojer.design.opinion.' + project.id + ':' + (brief.targetId || '')
  const [opinion, setOpinion] = useState(() => {
    try { return localStorage.getItem(draftKey) ?? (brief.status === 'review' ? '' : brief.preferences) }
    catch { return brief.status === 'review' ? '' : brief.preferences }
  })
  useEffect(() => { try { localStorage.setItem(draftKey, opinion) } catch { /* Keep the draft in memory. */ } }, [draftKey, opinion])
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const blocked = busy || !!project.activity || !!project.designActivity
  const target = project.targets?.find(t => t.id === brief.targetId)?.name || '项目界面'
  const edit = () => { setOpinion(brief.status === 'error' ? brief.preferences : ''); setEditing(true); onPreview(brief.targetId) }
  const submit = async (preferences: string) => {
    if (blocked) return
    setBusy(true); setError('')
    try {
      await window.desktop.engineering.submitPrototypePreferences(project.id, preferences, brief.targetId)
      setOpinion(''); setEditing(false); onPreview(brief.targetId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  if (brief.status === 'designing') return null // Progress stays in the prototype's existing status bar.
  if (brief.status === 'accepted' && !editing && activePrototypeBriefs(project).every(b => b.status === 'accepted')) return <PrdWorkflow project={project} onReview={onReview} onEdit={edit} />
  if (brief.status === 'accepted' && !editing) return <section className="prototype-opinion accepted"><strong>{target} · 原型已验收</strong><span>PRD、实现方案和开发校验都沿用这个版本。</span><button className="ui-button secondary small" disabled={blocked} onClick={edit}>补充修改意见</button></section>
  if (brief.status === 'review' && !editing) return <section className="prototype-opinion accepted"><div className="prototype-opinion-copy"><strong>{target} · 请试用并验收原型</strong><p>满意后点击「验收此原型」，系统将据此整理 PRD。</p></div><button className="ui-button secondary small" disabled={blocked} onClick={edit}>提出修改意见</button></section>
  if (!editing && (brief.status === 'error' || brief.status === 'preferences' && brief.prototypeId)) return <section className="prototype-opinion accepted"><div className="prototype-opinion-copy"><strong>{target} · {brief.status === 'error' ? '设计未完成，已有版本保留' : '需求已有更新，请调整原型'}</strong><p role="alert">{brief.error}</p></div><button className="ui-button secondary small" disabled={blocked} onClick={edit}>调整设计意见</button></section>
  return <section className="prototype-opinion" aria-label="原型设计意见">
    <div className="prototype-opinion-heading"><strong>{target} · {brief.status === 'review' ? '请试用原型并提出意见' : '从你的想法开始，你期待怎样的界面？'}</strong>
      {brief.prototypeId && <button className="ui-button secondary small" onClick={() => onPreview(brief.targetId)}>查看原型</button>}
    </div>
    <p>{brief.status === 'review' ? '满意后在原型预览中点击「验收此原型」。需要调整时直接提交意见，系统会自动更新并再次交给你验收。' : '可以说说喜欢的风格、主要使用设备、首页最重要的信息，以及不喜欢的设计。提交意见后，原型前端智能体会自动开始。'}</p>
    <textarea aria-label="我的设计意见" rows={2} maxLength={8000} value={opinion} disabled={blocked} onChange={e => setOpinion(e.target.value)} placeholder="例如：手机优先，简洁明亮；首页突出记一笔和本月结余，少用装饰。" />
    <div className="prototype-opinion-actions">
      <button className="ui-button primary small" disabled={blocked || !opinion.trim()} onClick={() => void submit(opinion)}>提交设计意见</button>
      {brief.status !== 'review' && !editing && <button className="ui-button secondary small" disabled={blocked} onClick={() => void submit('采用与当前需求匹配的简洁清晰设计；优先突出主要任务，兼顾桌面与手机、键盘操作、空状态和错误反馈。')}>采用推荐设计</button>}
    </div>
    {(error || brief.error) && <p role="alert" className="eng-inline-error">{error || brief.error}</p>}
  </section>
}

function PrdWorkflow({ project, onReview, onEdit }: { project: Project; onReview(): void; onEdit(): void }) {
  const [error, setError] = useState('')
  const briefs = activePrototypeBriefs(project)
  if (!briefs.length || briefs.some(b => b.status !== 'accepted')) return null
  const prd = project.prd
  const pending = !!project.activity || !!project.designActivity
  return <section className="prototype-opinion accepted" aria-label="原型生成 PRD" aria-live="polite">
    <div className="prototype-opinion-copy"><strong>{prd?.status === 'generating' ? '正在根据已确认原型生成 PRD' : prd?.status === 'review' ? 'PRD 已生成，请审阅需求' : prd?.status === 'confirmed' ? 'PRD 已确认，按原型设计实现方案' : '原型已确定，继续整理 PRD'}</strong>
    <p>已验收 {briefs.length} 个界面原型；PRD、方案和开发沿用这些版本。</p></div>
    {prd && ['review', 'confirmed'].includes(prd.status)
      ? <button className="ui-button secondary small" disabled={pending} onClick={onReview}>审阅 PRD</button>
      : prd?.status !== 'generating' && <button className="ui-button primary small" disabled={pending} onClick={() => { setError(''); void window.desktop.engineering.preparePrd(project.id).catch(e => setError(String(e))) }}>根据已确认原型生成 PRD</button>}
    <button className="ui-button secondary small" disabled={pending} onClick={onEdit}>补充修改意见</button>
    {(error || prd?.error) && <p className="eng-inline-error" role="alert">{error || prd?.error}</p>}
  </section>
}
