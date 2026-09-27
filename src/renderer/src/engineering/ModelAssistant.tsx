import { useState } from 'react'
import { Bot, LoaderCircle } from 'lucide-react'
import { agentRoleLabels, type AgentModelPlan, type EngineeringState } from '../../../shared/engineering'
import { AssistantModelSelect, hasAssistantModel, ModelUsage } from './AssistantModels'

export default function ModelAssistant({ state, refresh }: { state: EngineeringState; refresh: () => Promise<void> }) {
  const [advisorId, setAdvisorId] = useState('')
  const [preference, setPreference] = useState('优先保证规划与代码质量；设计关注界面与交互；验证保持独立判断。')
  const [plan, setPlan] = useState<AgentModelPlan | null>(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError(''); setNotice('')
    try { await action() } catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')) }
    finally { setBusy('') }
  }
  const modelName = (id: string) => state.models.find(m => m.id === id)?.model ?? '尚未配置'
  return <div className="eng-form eng-model-assistant">
    <p className="eng-hint"><Bot size={14} /> 配置助手根据你接入的具体模型，为每个智能体选择模型。四类交付角色和各自的专属技能保持独立。</p>
    <AssistantModelSelect state={state} value={advisorId} disabled={!!busy} onChange={setAdvisorId} />
    <label className="eng-field"><span>选择偏好</span><textarea rows={3} maxLength={2000} value={preference} disabled={!!busy} onChange={e => { setPreference(e.target.value); setPlan(null) }} /></label>
    <p className="eng-hint">候选范围：模型连接中已保存的 {state.models.length} 个具体型号。可先在“模型连接”获取供应商列表并添加更多型号。</p>
    <button className="ui-button primary" disabled={!!busy || !hasAssistantModel(state, advisorId) || !state.agents.length} onClick={() => void run('分析模型与职责', async () => { const selected = advisorId; setAdvisorId(''); setPlan(null); setPlan(await window.desktop.engineering.recommendAgentModels(selected, preference)) })}>{busy === '分析模型与职责' ? <LoaderCircle size={14} /> : <Bot size={14} />}一键推荐模型</button>
    <ModelUsage usage={plan?.usage} />
    {plan && <section aria-label="模型分配预览" className="eng-model-plan"><h3>模型分配预览</h3>{plan.choices.map(choice => {
      const agent = state.agents.find(a => a.id === choice.agentId)
      return <article key={choice.agentId}><h4>{agent?.name} <span className="eng-tag">{agent ? agentRoleLabels[agent.role] : ''}</span></h4><p>当前：{modelName(choice.previousModelId)}</p><p><strong>推荐：{modelName(choice.modelId)}</strong></p><p>{choice.reason}</p></article>
    })}<p className="eng-hint">{plan.caveat}</p><button className="ui-button primary" disabled={!!busy} onClick={() => void run('应用模型配置', async () => { await window.desktop.engineering.applyAgentModels(plan.id); await refresh(); setPlan(null); setNotice('已应用到全部智能体，后续任务使用新配置。') })}>一键应用模型配置</button></section>}
    {busy && <p role="status" className="eng-inline-result">{busy}…</p>}
    {notice && <p role="status" className="eng-inline-result">{notice}</p>}
    {error && <p role="alert" className="eng-inline-error">{error}</p>}
  </div>
}
