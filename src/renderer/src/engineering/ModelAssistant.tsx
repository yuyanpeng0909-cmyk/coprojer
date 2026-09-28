import { useState } from 'react'
import { Bot, LoaderCircle } from 'lucide-react'
import { agentRoleLabels, type AgentModelPlan, type EngineeringState } from '../../../shared/engineering'
import { AssistantModelSelect, hasAssistantModel, ModelUsage } from './AssistantModels'
import { defaultModelCapability, modelCapabilityLabels, type AAScore, type ArenaScore, type ModelEvidenceCandidate, type ModelCapability, type ModelSelectionPolicy } from '../../../shared/model-evidence'
import { isAgentModelPlan } from './model-plan'
import { agentModelLabel } from '../../../shared/reasoning'

function EvidenceSourceLink({ url, children }: { url: string; children: string }) {
  const [error, setError] = useState('')
  return <><a href={url} target="_blank" rel="noreferrer" title="在系统浏览器打开" onClick={event => {
    event.preventDefault(); setError('')
    void (async () => {
      try { await window.desktop.engineering.openModelEvidenceSource(url) }
      catch { setError('未能打开系统浏览器，请复制以下链接打开。') }
    })()
  }}>{children}</a>{error && <span className="eng-source-error" role="alert">{error}<span>{url}</span></span>}</>
}
function EvidenceScore({ score }: { score: ArenaScore | AAScore }) {
  return <>{'metric' in score ? score.score.toFixed(2) + (score.metric === 'aa-coding' ? '%' : '') : score.score}
    {score.lower !== undefined && <small>区间 {score.lower}–{score.upper}</small>}
    {score.preliminary && <small>初步结果 · 不参与推荐</small>}</>
}
function SimilarEvidence({ references }: { references: NonNullable<ModelEvidenceCandidate['similar']> }) {
  if (!references.length) return null
  const item = (reference: typeof references[number], index: number) => <li key={reference.url + reference.score.model + index}>
    <EvidenceSourceLink url={reference.url}>{reference.score.model}</EvidenceSourceLink>
    <small>榜单原条目成绩：<EvidenceScore score={reference.score} />{reference.score.votes !== undefined && ' · ' + reference.score.votes.toLocaleString() + ' 票'}</small>
    <small>{reference.note}</small>
  </li>
  return <div className="eng-evidence-references"><span className="eng-evidence-warning">近似参考 · 非精确匹配</span>
    <small>仅供查看，不参与自动推荐或 Pareto。</small>
    <ul>{item(references[0], 0)}</ul>
    {references.length > 1 && <details className="eng-evidence-alternatives"><summary>其他近似条目（{references.length - 1}）</summary><ul>{references.slice(1).map(item)}</ul></details>}
  </div>
}

export default function ModelAssistant({ state, refresh }: { state: EngineeringState; refresh: () => Promise<void> }) {
  const [advisorId, setAdvisorId] = useState('')
  const [preference, setPreference] = useState('按对应任务的能力选择；原型重视页面与交互，开发重视实现质量，验证重视代码分析。')
  const [categories, setCategories] = useState<Record<string, ModelCapability>>({})
  const [policy, setPolicy] = useState<ModelSelectionPolicy>('quality')
  const [plan, setPlan] = useState<AgentModelPlan | null>(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError(''); setNotice('')
    try { await action() } catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')) }
    finally { setBusy('') }
  }
  const agents = state.agents.filter(a => !a.ownerProjectId)
  const changes = plan?.choices.filter(c => c.modelId !== c.previousModelId).length || 0
  const recommend = () => run('读取能力榜单并生成建议', async () => {
    const selected = advisorId
    setAdvisorId(''); setPlan(null)
    const result = await window.desktop.engineering.recommendAgentModels(selected, preference, {
      categories: Object.fromEntries(agents.map(a => [a.id, categories[a.id] || defaultModelCapability(a)])), policy,
    })
    if (!isAgentModelPlan(result)) throw new Error('模型推荐结果不完整，可能仍在使用旧版后台。请保存当前工作，退出并重新打开应用后重试。')
    setPlan(result)
  })
  return <div className="eng-form eng-model-assistant">
    <p className="eng-hint"><Bot size={14} /> 每次推荐重新查询 Artificial Analysis（AA），按每个智能体的型号、推理开关和档位匹配。Web / 前端专项同时查询 Arena，不混用不同指标分数。</p>
    <section aria-label="智能体能力类别" className="eng-model-capabilities"><h3>每个智能体关注什么能力</h3>
      {agents.map(agent => <label className="eng-field" key={agent.id}><span>{agent.name}<small>{agentRoleLabels[agent.role]}</small></span>
        <select aria-label={agent.name + '能力类别'} value={categories[agent.id] || defaultModelCapability(agent)} disabled={!!busy} onChange={e => { setCategories({ ...categories, [agent.id]: e.target.value as ModelCapability }); setPlan(null) }}>
          {Object.entries(modelCapabilityLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>)}
      <p className="eng-hint">规划默认参考 AA 综合指数，开发与校验参考 AA 终端编程；前端使用 Arena 专项。可按任务调整，AA 编程分数不代表页面美观或工程成功率。</p>
    </section>
    <label className="eng-field"><span>选择策略</span><select value={policy} disabled={!!busy} onChange={e => { setPolicy(e.target.value as ModelSelectionPolicy); setPlan(null) }}>
      <option value="quality">能力优先 · 所选类别最高分</option><option value="pareto">分数区间重叠时参考费用 · Pareto</option>
    </select><small>Pareto：在有参考价格的已接入候选中，没有其他型号同时得分更高或相同、输入和输出价格都更低或相同，且至少一项更优。缺失价格不按免费处理。</small></label>
    <AssistantModelSelect state={state} value={advisorId} disabled={!!busy} onChange={setAdvisorId} />
    <label className="eng-field"><span>任务偏好（用于符合策略的候选之间）</span><textarea rows={2} maxLength={2000} value={preference} disabled={!!busy} onChange={e => { setPreference(e.target.value); setPlan(null) }} /></label>
    <p className="eng-hint">候选范围：{state.models.length} 个已保存连接。推理设置取自智能体配置；默认最高支持档位，关闭推理和自定义预算独立匹配。没有同档位证据时保留当前绑定。</p>
    <button className="ui-button primary" disabled={!!busy || !hasAssistantModel(state, advisorId) || !agents.length} onClick={() => void recommend()}>{busy === '读取能力榜单并生成建议' ? <LoaderCircle size={14} /> : <Bot size={14} />}一键推荐模型</button>
    <ModelUsage usage={plan?.usage} />
    {plan && !plan.usage && <p className="eng-hint">没有可比较的能力证据，本次未调用建议模型。</p>}
    {plan && <section aria-label="榜单证据" className="eng-model-evidence"><h3>本次榜单证据</h3>{plan.evidence.map(source => <details key={(source.agentId || '') + source.category}>
      <summary>{state.agents.find(a => a.id === source.agentId)?.name} · {modelCapabilityLabels[source.category]} · {source.status === 'unavailable' ? '获取失败' : source.status === 'stale' ? '日期过期 / 异常' : `精确匹配 ${source.candidates.filter(c => c.match === 'exact').length} / ${source.candidates.length} 个连接`}{source.candidates.some(c => c.similar?.length) && ` · ${source.candidates.filter(c => c.similar?.length).length} 个连接有近似参考`}</summary>
      <p><EvidenceSourceLink url={source.url}>{'查看 ' + (source.source === 'aa' ? 'Artificial Analysis' : 'Arena') + ' 来源'}</EvidenceSourceLink> · 榜单日期：{source.updatedAt || '来源未公布'} · 抓取：{new Date(source.fetchedAt).toLocaleString()}</p>
      <p>{source.note}</p>
      <div className="eng-evidence-table" tabIndex={0} role="region" aria-label={modelCapabilityLabels[source.category] + '候选对比'}><table><thead><tr><th>已接入型号</th><th>能力得分 / 区间</th><th>票数</th><th>参考价 入 / 出</th><th>Pareto</th></tr></thead><tbody>
        {source.candidates.map(c => <tr key={c.connectionId}><th scope="row">{c.displayName || c.model}{c.query && <small>查询：{c.query}</small>}</th><td>{c.score ? <EvidenceScore score={c.score} /> : c.similar?.length ? null : c.match === 'ambiguous' ? '多个冲突条目' : '未匹配'}{c.matchNote && <small>{c.matchNote}</small>}{c.score && 'url' in c.score && <small><EvidenceSourceLink url={c.score.url!}>对应档位条目</EvidenceSourceLink></small>}{c.similar && <SimilarEvidence references={c.similar} />}</td><td>{c.score?.votes?.toLocaleString() ?? '—'}</td><td>{c.score?.inputPrice !== undefined && c.score?.outputPrice !== undefined ? `$${c.score.inputPrice} / $${c.score.outputPrice}` : '未知'}</td><td>{c.pareto === 'frontier' ? '前沿候选' : c.pareto === 'dominated' ? '有更优组合' : '不判定'}</td></tr>)}
      </tbody></table></div><p className="eng-hint">参考价格单位：美元 / 百万 tokens，不代表你当前连接的实际收费。Pareto 按本类别分数及输入、输出价格计算，不使用速度。</p>
    </details>)}</section>}
    {plan && <section aria-label="模型分配预览" className="eng-model-plan"><h3>模型分配预览 · {changes} 项变更</h3>{plan.choices.map(choice => {
      const agent = state.agents.find(a => a.id === choice.agentId)
      return <article key={choice.agentId}><h4>{agent?.name} <span className="eng-tag">{modelCapabilityLabels[choice.category]}</span></h4><p>当前：{agentModelLabel(state.models.find(m => m.id === choice.previousModelId), agent?.reasoning)}</p><p><strong>{choice.supported ? '推荐' : '保留'}：{agentModelLabel(state.models.find(m => m.id === choice.modelId), choice.reasoning ?? agent?.reasoning)}</strong></p><p>{choice.reason}</p></article>
    })}<p className="eng-hint">{plan.caveat}</p>{!changes && <p role="status">没有需要自动应用的变更，可调整能力类别后重新推荐。</p>}<button className="ui-button primary" disabled={!!busy || !changes} onClick={() => void run('应用模型配置', async () => { await window.desktop.engineering.applyAgentModels(plan.id); await refresh(); setPlan(null); setNotice('已应用 ' + changes + ' 项模型变更。智能体职责、专属技能和项目专属配置保持原样。') })}>一键应用模型配置</button></section>}
    {busy && <p role="status" className="eng-inline-result">{busy}…</p>}
    {notice && <p role="status" className="eng-inline-result">{notice}</p>}
    {error && <p role="alert" className="eng-inline-error">{error}</p>}
  </div>
}
