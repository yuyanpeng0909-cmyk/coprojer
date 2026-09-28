import { useState } from 'react'
import { ArrowRight, BookOpen, Check, ChevronDown, ChevronUp, Circle, Pause, Play, X } from 'lucide-react'
import type { EngineeringState } from '../../../shared/engineering'
import type { ModelCheckKind, OnboardingPatch } from '../../../shared/onboarding'
import { toolLabels } from '../../../shared/engineering'
import type { OnboardingProgress, OnboardingStep } from './onboarding-progress'
import './onboarding.css'

type Update = (patch: OnboardingPatch) => Promise<void>
function useAction() {
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const run = async (label: string, action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(label); setError('')
    try { await action() } catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')) } finally { setBusy('') }
  }
  return { busy, error, run }
}
function Progress({ progress }: { progress: OnboardingProgress }) {
  return <div className="eng-mini-progress" role="progressbar" aria-label="新手入门进度" aria-valuemin={0} aria-valuemax={progress.steps.length} aria-valuenow={progress.completed}><i style={{ width: (progress.completed / progress.steps.length * 100) + '%' }} /></div>
}
export function OnboardingCard({ state, progress, onOpen, update }: { state: EngineeringState; progress: OnboardingProgress; onOpen(): void; update: Update }) {
  const { busy, error, run } = useAction()
  const ready = progress.steps.slice(0, 3).every(step => step.done)
  const collapsed = state.onboarding?.cardCollapsed ?? (progress.complete || ready || state.projects.length > 0 && !state.onboarding)
  return <section className="onboarding-card" data-collapsed={collapsed} aria-label="新手入门进度卡">
    <div className="onboarding-card-heading"><BookOpen size={16} /><button className="onboarding-title-link" onClick={onOpen}>新手入门</button><span>{progress.completed} / {progress.steps.length}</span>
      <button className="eng-icon" disabled={!!busy} aria-label={collapsed ? '展开入门进度' : '收起入门进度'} aria-expanded={!collapsed} onClick={() => void run('保存进度卡设置', () => update({ cardCollapsed: !collapsed }))}>{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button></div>
    {!collapsed && <><Progress progress={progress} /><div className="onboarding-card-content"><div><strong>{progress.complete ? '已走完第一次交付流程' : state.onboarding?.paused ? '入门引导已暂停' : '下一步：' + progress.next?.title}</strong><p>{progress.complete ? '可以继续开发下一个功能，也可以随时回看流程。' : progress.project ? '跟随项目：' + progress.project.name : '从接入模型开始，完成你自己的第一个功能。'}</p></div><button className="ui-button secondary" onClick={onOpen}>{progress.complete ? '回看指南' : '继续入门'}<ArrowRight size={13} /></button></div></>}
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
  </section>
}
export function OnboardingHint({ step, paused, hidden, onOpen, onStep, update }: { step?: OnboardingStep; paused?: boolean; hidden?: boolean; onOpen(): void; onStep(step: OnboardingStep): void; update: Update }) {
  const { busy, error, run } = useAction()
  if (!step || paused || hidden) return null
  return <aside className="onboarding-hint" aria-label="当前页面入门指引"><BookOpen size={15} /><div><strong>{step.title}{step.done ? ' · 已完成，可回看' : ''}</strong><p>{step.detail}</p></div><div className="onboarding-hint-actions"><button className="ui-button secondary" onClick={() => onStep(step)}>定位操作</button><button className="ui-button ghost" onClick={onOpen}>入门清单</button></div><button className="eng-icon" disabled={!!busy} aria-label="收起入门说明" onClick={() => void run('收起说明', () => update({ hintsHidden: true }))}><X size={13} /></button>{error && <p className="eng-inline-error" role="alert">{error}</p>}</aside>
}
export default function Onboarding({ state, progress, update, onStep, onCreate, refresh }: { state: EngineeringState; progress: OnboardingProgress; update: Update; onStep(step: OnboardingStep): void; onCreate(): void; refresh(): Promise<void> }) {
  const { busy, error, run } = useAction()
  const paused = state.onboarding?.paused
  const check = (modelId: string, kind: ModelCheckKind) => void run(modelId, async () => {
    const model = state.models.find(m => m.id === modelId)
    if (!model) throw new Error('连接已删除，请重新选择。')
    try { await window.desktop.engineering[kind === 'connection' ? 'testModel' : 'testCapabilities'](model) } finally { await refresh() }
  })
  const checkModels = [...new Map(progress.team.flatMap(t => t.model ? [[t.model.id, t.model] as const] : [])).values()]
  return <div className="onboarding-page"><div className="onboarding-inner">
    <section className="onboarding-summary" aria-label="入门总览"><div><h2>{progress.complete ? '第一个功能，已完成交付' : paused ? '按自己的节奏继续' : '从一个想法，到第一次交付'}</h2><p>{progress.complete ? '你已完成配置、开发、验证和人工验收。随时可以回看任何步骤。' : '准备好模型和团队，再用你自己的项目走一遍。可以随时跳过、暂停或返回。'}</p></div><div className="onboarding-summary-actions"><span>{progress.completed} / {progress.steps.length} 项完成</span><button className="ui-button secondary" disabled={!!busy} onClick={() => void run('保存引导设置', () => update({ paused: !paused, hintsHidden: paused ? false : state.onboarding?.hintsHidden }))}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? '继续引导' : '稍后继续'}</button></div><Progress progress={progress} /></section>
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
    {progress.next && <div className="onboarding-next"><span>下一步：{progress.next.title}</span><button className="ui-button primary" onClick={() => onStep(progress.next!)}>{progress.next.action}<ArrowRight size={13} /></button></div>}
    <section className="onboarding-project" aria-label="选择入门项目"><label className="eng-field"><span>跟随哪个项目学习</span><select aria-label="入门项目" value={progress.project?.id || ''} disabled={!!busy} onChange={e => void run('保存入门项目', () => update({ projectId: e.target.value }))}><option value="">选择你的真实项目</option>{state.projects.filter(p => !p.archivedAt).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><button className="ui-button secondary" onClick={onCreate}>新建入门项目</button>
      {!!progress.features.length && <label className="eng-field"><span>跟随的第一个功能</span><select aria-label="入门功能" value={progress.feature?.id || ''} disabled={!!busy} onChange={e => void run('保存入门功能', () => update({ featureId: e.target.value }))}>{!progress.feature && <option value="">原功能不在本期，请重新选择</option>}{progress.features.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}</select></label>}
      {state.onboarding?.projectId && !progress.project && <p className="eng-inline-error">原项目已归档或不存在。选择其他项目即可继续，已有工程不受影响。</p>}
    </section>
    {(['使用准备', '第一次开发'] as const).map((group, groupIndex) => <section className="onboarding-section" key={group}><h2>{group}</h2><ol className="onboarding-steps" start={groupIndex ? 4 : 1}>{progress.steps.slice(groupIndex ? 3 : 0, groupIndex ? undefined : 3).map(step => <li key={step.id} data-onboarding-step={step.id} className={step.id === progress.next?.id ? 'is-next' : ''}><span className={'onboarding-step-icon' + (step.done ? ' is-done' : '')}>{step.done ? <Check size={15} /> : <Circle size={14} />}</span><div className="onboarding-step-copy"><div><h3>{step.title}</h3><span>{step.optional ? '当前无需' : step.done ? '已完成' : step.id === progress.next?.id ? '下一步' : '待完成'}</span></div><p>{step.detail}</p>
      {step.id === 'assistant' && progress.assistant && <div className="onboarding-check-row"><span>{progress.assistant.checks?.connection ? (progress.assistant.checks.connection.status === 'passed' ? '最近测试通过' : '最近测试失败') + ' · ' + new Date(progress.assistant.checks.connection.at).toLocaleString() : '已保存，尚未测试'}</span><button className="ui-button secondary" disabled={!!busy} onClick={() => check(progress.assistant!.id, 'connection')}>{busy === progress.assistant.id ? '正在测试…' : '测试助手连接'}</button></div>}
      {step.id === 'team' && <><ul className="onboarding-team">{progress.team.map(t => <li key={t.role}><span>{t.label}</span><span>{t.agent ? t.model?.model || '尚未绑定模型' : '缺少成员'}</span><small>{t.ready ? '能力检查通过' : t.missingTools.length ? '缺少工具：' + t.missingTools.map(name => toolLabels[name]).join('、') : t.model?.checks?.capabilities?.status === 'failed' ? '能力检查失败，请检查连接或换用模型' : '待检查'}</small></li>)}</ul>{checkModels.map(model => <div className="onboarding-check-row" key={model.id}><span title={model.model}>{model.model}{model.checks?.capabilities && <small> · {new Date(model.checks.capabilities.at).toLocaleString()}</small>}</span><button className="ui-button secondary" disabled={!!busy} onClick={() => check(model.id, 'capabilities')}>{busy === model.id ? '正在检查…' : '检查开发能力'}</button></div>)}<small className="onboarding-note">测试会发送少量模型请求，按当前连接计费。进入本页不会自动发起测试。</small></>}
    </div><button className="ui-button secondary onboarding-step-action" onClick={() => onStep(step)}>{step.done ? '查看' : step.action}<ArrowRight size={12} /></button></li>)}</ol></section>)}
    <section className="onboarding-further"><h2>熟悉之后，再进一步</h2><p>模型配置助手、能力榜单、自定义团队和专属技能都是可选优化，不影响你先完成第一个功能。</p><div><button className="ui-button secondary" onClick={() => onStep(progress.steps[2])}>探索智能体配置</button><button className="ui-button ghost" disabled={!!busy} onClick={() => void run('恢复说明', () => update({ hintsHidden: false, paused: false }))}>恢复逐页说明</button></div></section>
  </div></div>
}
