import type { AgentConfig, ModelConfig } from '../../../shared/engineering'
import { agentModelLabel, defaultReasoning, effortLabels, reasoningCapability, resolveReasoning, type AgentReasoning, type ReasoningEffort } from '../../../shared/reasoning'

export default function AgentReasoningSettings({ model, value, onChange }: {
  model?: ModelConfig; value: AgentConfig['reasoning']; onChange: (value: AgentReasoning | undefined) => void
}) {
  if (!model) return null
  const capability = reasoningCapability(model)
  let current: AgentReasoning | undefined, error = ''
  try { current = resolveReasoning(model, value) } catch (e) { error = e instanceof Error ? e.message : String(e) }
  return <fieldset className="eng-reasoning-options">
    <legend>推理设置 · 此智能体独立使用</legend>
    <p className="eng-hint" aria-live="polite">{agentModelLabel(model, value)}</p>
    {error ? <p className="eng-inline-error" role="alert">{error} <button type="button" className="ui-button secondary" onClick={() => onChange(defaultReasoning(model))}>使用支持的默认值</button></p> : null}
    {current && <>
      <label className="eng-field"><span>是否推理</span><select aria-label="是否推理" value={current.enabled ? 'on' : 'off'} disabled={!capability.canDisable} onChange={e => onChange({ ...current!, enabled: e.target.value === 'on' })}>
        <option value="on">开启{!capability.canDisable ? '（此型号始终推理）' : ''}</option>
        {capability.canDisable && <option value="off">关闭</option>}
      </select></label>
      {capability.kind === 'effort' && <label className="eng-field"><span>推理强度</span><select aria-label="推理强度" value={current.effort} disabled={!current.enabled} onChange={e => onChange({ ...current!, effort: e.target.value as ReasoningEffort })}>
        {capability.efforts.map((effort, index) => <option key={effort} value={effort}>{effortLabels[effort]}{index === capability.efforts.length - 1 ? ' · 最高（默认）' : ''}</option>)}
      </select></label>}
      {capability.kind === 'budget' && <label className="eng-field"><span>思考预算（tokens）</span><input aria-label="思考预算" type="number" min={1} max={capability.maxBudget} step={1} value={current.budget ?? ''} disabled={!current.enabled} placeholder={'最大（' + capability.maxBudget?.toLocaleString('en-US') + '）'} onChange={e => onChange({ ...current!, budget: e.target.value === '' ? undefined : Number(e.target.value) })} /><small>留空使用最大预算。自定义预算会单独标记，AA 无对应设置时不借用其他档位分数。</small></label>}
    </>}
    <p className="eng-hint">{capability.note} 推理越充分，通常需要更多时间与 tokens。</p>
  </fieldset>
}
