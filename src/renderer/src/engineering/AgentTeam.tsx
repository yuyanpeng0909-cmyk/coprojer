import { useState } from 'react'
import { Bot, Plus } from 'lucide-react'
import { agentRoleLabels, defaultAgentTools, type AgentConfig, type EngineeringState, type Project } from '../../../shared/engineering'
import { agentModelLabel } from '../../../shared/reasoning'
import { agentInstructionsVersion, defaultAgentInstructions } from '../../../shared/agent-instructions'
import { LoadingStatus } from '../components/RequestFeedback'

export default function AgentTeam({ state, project, onEdit, onSkills, onModels, refresh }: {
  state: EngineeringState; project?: Project; onEdit(agent: AgentConfig): void; onSkills(id: string): void; onModels(): void; refresh(): Promise<void>
}) {
  const [sourceId, setSourceId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [showPrevious, setShowPrevious] = useState(false)
  const shared = state.agents.filter(a => !a.ownerProjectId)
  const used = new Set([...(project?.teamAgentIds || []), project?.plannerId, project?.designerId, ...(project?.features.filter(f => f.stage !== 'done').flatMap(f => [f.developerId, f.reviewerId]) || [])])
  const owned = state.agents.filter(a => a.ownerProjectId === project?.id)
  const legacy = project ? shared.filter(a => used.has(a.id)) : []
  const members = project ? owned.filter(a => showPrevious || used.has(a.id)) : shared
  const previousCount = project ? owned.filter(a => !used.has(a.id)).length : 0
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await work(); await refresh() } catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')) } finally { setBusy(false) }
  }
  const cards = (agents: AgentConfig[], inherited = false) => <div className="eng-agents">{Object.keys(agentRoleLabels).flatMap(role => agents.filter(a => a.role === role)).map(a => <article className="eng-agent-card" key={a.id}>
    <div className="eng-section-heading"><Bot size={21} /><span className="eng-tag">{agentRoleLabels[a.role]}</span></div>
    <h3>{a.name}</h3><small>{inherited ? '沿用共享配置 · 复制后可独立修改' : project ? (used.has(a.id) ? '项目成员 · ' : '历史成员 · ') + project.name : '共享模板 · 加入项目后独立配置'}</small>
    <p>{a.instructions.replace(/^【成员分工与专门要求】\s*/, '').split(/\r?\n\s*\r?\n/)[0]}</p><small>专属技能：{(a.skillIds || []).map(id => state.skills?.find(s => s.id === id && s.ownerAgentId === a.id)?.name || id).join('、') || '未启用技能'}</small>
    <footer><span>{agentModelLabel(state.models.find(m => m.id === a.modelId), a.reasoning)}</span>
      {!inherited && <><button className="ui-button secondary" onClick={() => onSkills(a.id)}>技能</button><button className="ui-button secondary" onClick={() => onEdit({ ...a })}>配置</button></>}
    </footer></article>)}</div>
  return <div className="eng-settings">
    <div className="eng-section-heading"><div><h2>{project ? '项目团队 · ' + project.name : '共享智能体模板'}</h2><p>需求与架构、交互与原型、全栈开发、独立测试各一位；复杂项目可增加开发成员。每个实例独立配置模型与技能。</p></div>
      {!project && <button className="ui-button secondary" disabled={!state.models.length} onClick={onModels}><Bot size={14} />模型配置助手</button>}
      <button className="ui-button primary" onClick={() => onEdit({ id: '', name: '', role: 'developer', modelId: state.models[0]?.id || '', instructions: defaultAgentInstructions.developer, instructionsVersion: agentInstructionsVersion, tools: defaultAgentTools('developer'), ownerProjectId: project?.id })}><Plus size={14} />{project ? '新增项目成员' : '新增智能体'}</button>
    </div>
    {project && <div className="eng-team-actions"><label className="eng-field"><span>从共享模板添加</span><select aria-label="共享智能体模板" value={sourceId} onChange={e => setSourceId(e.target.value)} disabled={busy}><option value="">选择模板</option>{shared.map(a => <option key={a.id} value={a.id}>{a.name} · {agentRoleLabels[a.role]}</option>)}</select></label><button className="ui-button secondary" disabled={busy || !sourceId} onClick={() => void run(async () => { await window.desktop.engineering.addProjectAgent(project.id, sourceId); setSourceId('') })}>复制到项目</button></div>}
    {legacy.length > 0 && <section className="eng-team-legacy"><p>此项目仍沿用 {legacy.length} 个共享成员。复制后独立保存模型、工作要求和专属技能，保留历史运行记录。</p><button className="ui-button secondary" disabled={busy} onClick={() => void run(() => window.desktop.engineering.isolateProjectTeam(project!.id))}>复制为项目团队</button>{cards(legacy, true)}</section>}
    {cards(members)}
    {project && !members.length && !legacy.length && <p className="eng-hint">还没有项目成员，请从共享模板添加。</p>}
    {previousCount > 0 && <label className="eng-team-history"><input type="checkbox" checked={showPrevious} onChange={e => setShowPrevious(e.target.checked)} />显示未分配的历史成员（{previousCount}）</label>}
    {busy && <LoadingStatus label="保存团队配置" />}
    {error && <p role="alert" className="eng-inline-error">{error}</p>}
  </div>
}
