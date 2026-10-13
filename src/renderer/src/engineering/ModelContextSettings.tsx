import type { ModelInput } from '../../../shared/engineering'
import type { ContextPolicy, ModelCapabilities } from '../../../shared/model-profile'

const defaults: ContextPolicy = { version: 2, mode: 'legacy', triggerScope: 'total', compactor: 'portable', horizonRounds: 6 }
export default function ModelContextSettings({ model, onChange }: { model: ModelInput; onChange(model: ModelInput): void }) {
  const c = model.capabilities ?? {}, policy = c.contextPolicy ?? defaults
  const set = (patch: Partial<ModelCapabilities>) => onChange({ ...model, capabilities: { ...c, ...patch } })
  const setPolicy = (patch: Partial<ContextPolicy>) => set({ contextPolicy: { ...policy, ...patch } })
  const numeric = (key: 'contextWindowTokens' | 'maxOutputTokens' | 'extraReasoningTokens', label: string, placeholder: string) => <label className="eng-field">{label}<input type="number" min="1" step="1" value={c[key] ?? ''} placeholder={placeholder} onChange={e => set({ [key]: e.target.value ? Number(e.target.value) : undefined, ...(key === 'maxOutputTokens' ? { outputParameter: model.protocol === 'responses' ? 'max_output_tokens' : 'max_tokens' } : {}) })} /></label>
  return <details className="eng-context-details"><summary>上下文容量与整理策略</summary><div className="eng-form">
    <p className="eng-hint">按服务实际能力填写 token 数。留空表示未知；已有连接保持兼容策略。资料字符预算与这里的模型窗口独立。</p>
    {numeric('contextWindowTokens', '模型窗口（token）', '例如 256000；未知留空')}
    {numeric('maxOutputTokens', '单次最大输出（token）', '例如 16000')}
    {model.protocol === 'chat' && <label className="eng-field">输出参数<select aria-label="输出参数" value={c.outputParameter ?? 'max_tokens'} onChange={e => set({ outputParameter: e.target.value as ModelCapabilities['outputParameter'] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>}
    <label className="eng-field">窗口计量<select aria-label="窗口计量" value={c.windowAccounting ?? ''} onChange={e => set({ windowAccounting: e.target.value as ModelCapabilities['windowAccounting'] || undefined })}><option value="">未知</option><option value="input-plus-output">输入与输出共享窗口</option><option value="input-only">窗口仅限制输入</option></select></label>
    <label className="eng-field">推理计量<select aria-label="推理计量" value={c.reasoningAccounting ?? ''} onChange={e => set({ reasoningAccounting: e.target.value as ModelCapabilities['reasoningAccounting'] || undefined })}><option value="">未知</option><option value="included-in-output">已包含在输出限制中</option><option value="separate">额外预留</option></select></label>
    {c.reasoningAccounting === 'separate' && numeric('extraReasoningTokens', '额外推理预留（token）', '需要明确填写')}
    <label className="eng-field">整理模式<select aria-label="整理模式" value={policy.mode} onChange={e => setPolicy({ mode: e.target.value as ContextPolicy['mode'] })}><option value="legacy">兼容</option><option value="shadow">观察（记录自适应判断）</option><option value="adaptive">自适应</option></select></label>
    <label className="eng-field">触发范围<select aria-label="触发范围" value={policy.triggerScope} onChange={e => setPolicy({ triggerScope: e.target.value as ContextPolicy['triggerScope'] })}><option value="total">完整输入</option><option value="body_after_prefix">继承前缀后的新增内容</option></select></label>
    <label className="eng-field">软触发上限（token，可留空）<input type="number" min="1" value={policy.autoCompactTokenLimit ?? ''} placeholder="自动按窗口与下一回合空间计算" onChange={e => setPolicy({ autoCompactTokenLimit: e.target.value ? Number(e.target.value) : undefined })} /></label>
    <label className="eng-field">期望后续工作回合<input type="number" min="2" max="12" value={policy.horizonRounds} onChange={e => setPolicy({ horizonRounds: Number(e.target.value) })} /></label>
    {model.protocol === 'responses' && <>
      <label className="eng-field">供应商计数<select aria-label="供应商计数" value={c.tokenCounting ?? ''} onChange={e => set({ tokenCounting: e.target.value === 'responses' ? 'responses' : undefined })}><option value="">未验证，使用本地估算</option><option value="responses">已确认支持 input_tokens</option></select></label>
      <label className="eng-field">整理方式<select aria-label="整理方式" value={policy.compactor} onChange={e => set({ contextPolicy: { ...policy, compactor: e.target.value as ContextPolicy['compactor'] }, nativeCompaction: e.target.value === 'responses-native' ? 'responses' : undefined })}><option value="portable">可迁移的归档与摘要</option><option value="responses-native">已确认支持 Responses compact</option></select></label>
      {policy.compactor === 'responses-native' && <label className="eng-field">原生兼容标识<input value={c.nativeCompatibilityKey ?? ''} placeholder="服务文档确认的兼容标识" onChange={e => set({ nativeCompatibilityKey: e.target.value })} /></label>}
    </>}
  </div></details>
}
