import type { AssistantModelUsage, EngineeringState } from '../../../shared/engineering'

export function AssistantModelSelect({ state, value, onChange, disabled }: { state: EngineeringState; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const current = state.models.find(m => m.id === state.defaultAssistantModelId)
  return <label className="eng-field"><span>本次使用的通用助手模型</span>
    <select aria-label="本次使用的通用助手模型" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">{current ? '使用默认 · ' + current.model : '未设置默认，请选择本次模型'}</option>
      {state.models.map(m => <option key={m.id} value={m.id}>{m.model}</option>)}
    </select><small>单次选择仅用于下一次请求，不修改默认设置。</small>
  </label>
}

export function ModelUsage({ usage, pending = false }: { usage?: AssistantModelUsage; pending?: boolean }) {
  if (!usage) return null
  return <p className="eng-hint eng-model-usage" aria-label="模型使用记录">
    {pending ? '本次正在请求：' : usage.reportedModels.length ? '本次实际使用：' : '本次请求模型：'}
    {usage.reportedModels.join(' / ') || usage.requestedModel}
    {!pending && !usage.reportedModels.length && <small>服务未返回实际型号；此处显示已发送的模型 ID。</small>}
    {usage.reportedModels.some(m => m !== usage.requestedModel) && <small>请求模型 ID：{usage.requestedModel}</small>}
  </p>
}

export function hasAssistantModel(state: EngineeringState, override: string) {
  return state.models.some(m => m.id === (override || state.defaultAssistantModelId))
}
