import { useEffect, useState } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import { agentRoleLabels, type AgentRole, type EngineeringState } from '../../../shared/engineering'
import type { AssistantTeamPlan } from '../../../shared/assistant'

export default function AssistantTeamCard({ plan, state, run }: { plan: AssistantTeamPlan; state: EngineeringState; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [members, setMembers] = useState(plan.members), [adding, setAdding] = useState<AgentRole>('developer'), [busy, setBusy] = useState(false)
  const dirty = JSON.stringify(members) !== JSON.stringify(plan.members)
  useEffect(() => { setMembers(plan.members) }, [JSON.stringify(plan.members)])
  const editable = plan.status === 'preview' && Date.parse(plan.expiresAt) > Date.now()
  const project = state.projects.find(p => p.id === plan.projectId)
  const edit = (key: string, patch: object) => setMembers(ms => ms.map(m => m.key === key ? { ...m, ...patch } : m))
  return <section className="assistant-plan" aria-label="团队配置方案">
    <header><strong>{plan.projectId ? '项目团队方案' : '全局团队方案'}</strong><span>{members.length} 位成员</span></header>
    <p>生效范围：{plan.projectId ? project?.name || '原项目已不存在' : '全局共享成员'}</p>
    <p className="assistant-subtle">{plan.projectId ? '共享成员将建立项目专用实例，不复制其专属 Skill。其他项目配置保持原样。' : '将设为新项目默认团队，并修改明确引用的共享成员；独立设置的项目讨论型号保持原选择。'}</p>
    <p className="assistant-subtle">影响项目：{plan.affectedProjects.join('、') || '目前没有项目引用这些成员'}</p>
    <div className="assistant-plan-members">{members.map(m => {
      const source = state.agents.find(a => a.id === m.sourceAgentId), model = state.models.find(model => model.id === m.previousModelId)
      const clone = !!plan.projectId && source?.ownerProjectId !== plan.projectId
      return <div className="assistant-plan-member" key={m.key}>
        <div className="assistant-member-title"><span>{agentRoleLabels[m.role]}</span><small>{!source ? '新增' : clone ? '新建项目实例' : '调整现有实例'}</small>{editable && members.filter(other => other.role === m.role).length > 1 && <button type="button" className="eng-icon" aria-label={'移除' + m.name} disabled={busy} onClick={() => setMembers(ms => ms.filter(other => other.key !== m.key))}><Trash2 size={12} /></button>}</div>
        <label className="assistant-field"><span>成员名称</span><input value={m.name} disabled={!editable || busy} maxLength={80} onChange={e => edit(m.key, { name: e.target.value })} /></label>
        <label className="assistant-field"><span>模型</span><select value={m.modelId} disabled={!editable || busy} onChange={e => edit(m.key, { modelId: e.target.value })}>{state.models.map(model => <option key={model.id} value={model.id}>{model.model}</option>)}</select></label>
        <small className="assistant-subtle">原型号：{model?.model || '未配置'} → {state.models.find(model => model.id === m.modelId)?.model || '型号已删除'}</small>
        <p>{m.reason}</p>
      </div>
    })}</div>
    {editable && <div className="assistant-plan-add"><select aria-label="新增成员职责" value={adding} disabled={busy || members.length >= 12} onChange={e => setAdding(e.target.value as AgentRole)}>{Object.entries(agentRoleLabels).filter(([role]) => role === 'developer' || role === 'reviewer').map(([role, label]) => <option value={role} key={role}>{label}</option>)}</select><button className="ui-button secondary" disabled={busy || members.length >= 12} onClick={() => setMembers(ms => [...ms, { key: crypto.randomUUID(), name: agentRoleLabels[adding] + '成员', role: adding, modelId: state.models[0]?.id || '', reason: '用户新增；用于明确的职责分工，数量不代表自动并行。' }])}><Plus size={12} />添加成员</button></div>}
    <p className="assistant-subtle">规划与原型前端各一位，开发与验证可按分工增减；执行仍按现有串行流程。型号依据为职责、偏好及已接入配置，能力与费用未经独立验证。方案生成后 15 分钟内有效。</p>
    {plan.status === 'applied' ? <p className="assistant-success" role="status"><Check size={14} />{plan.result}</p> : editable ? <div className="assistant-card-actions">
      {dirty && <button className="ui-button secondary" disabled={busy} onClick={() => { setBusy(true); void run(() => window.desktop.engineering.updateAssistantTeamPlan(plan.id, members)).finally(() => setBusy(false)) }}>保存调整</button>}
      <button className="ui-button primary" disabled={busy || dirty} onClick={() => { setBusy(true); void run(() => window.desktop.engineering.applyAssistantTeamPlan(plan.id)).finally(() => setBusy(false)) }}>{busy ? '处理中…' : '确认应用方案'}</button>
    </div> : <p role="status">此预览已失效，请重新生成方案后再应用。</p>}
  </section>
}
