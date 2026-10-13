import { useEffect, useRef, useState } from 'react'
import type { ContextPolicy, ContextRuntimeState, RuntimeArtifactQuery } from '../../../shared/model-profile'
import type { RuntimeBudget } from '../../../shared/runtime-budget'
import RuntimeBudgetDetails from './RuntimeBudgetDetails'
import { compactionDescription, effectiveContextMode } from '../../../shared/context-display'

const status = { running: '运行中', paused: '已暂停', recovery_required: '需要核对效果', completed: '本轮已返回', cancelled: '已停止', failed: '执行失败' }
export default function ContextDetails({ state, scope, contextPolicy, currentRevision, budget, busy: running, budgetOpenRequest }: { state?: ContextRuntimeState; scope: Omit<RuntimeArtifactQuery, 'id' | 'offset' | 'version'>; contextPolicy?: ContextPolicy; currentRevision?: number; budget?: RuntimeBudget; busy?: boolean; budgetOpenRequest?: number }) {
  const [page, setPage] = useState<{ id: string; content: string; version: string; nextOffset: number | null; complete: boolean }>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const identity = JSON.stringify(scope) + ':' + (state?.manifest.id ?? ''), current = useRef(identity)
  current.current = identity
  useEffect(() => { setPage(undefined); setError(''); setBusy(false) }, [identity])
  const allowance = <RuntimeBudgetDetails key={JSON.stringify(scope)} budget={budget} target={scope} busy={running} openRequest={budgetOpenRequest} />
  if (!state) return allowance
  const requestBudget = state.latestBudget, last = state.requests.at(-1)
  const read = async (id: string, next = false) => {
    setBusy(true); setError('')
    try {
      const value = JSON.parse(await window.desktop.engineering.readRuntimeArtifact({ ...scope, id, ...(next && page ? { offset: page.nextOffset ?? 0, version: page.version } : {}) }))
      if (current.current !== identity) return
      setPage({ id, ...value })
    } catch (e) { if (current.current === identity) setError(e instanceof Error ? e.message : String(e)) } finally { if (current.current === identity) setBusy(false) }
  }
  return <>{allowance}<details className="eng-context-details">
    <summary>上下文与运行详情 · {status[state.status]}</summary>
    <p className="eng-hint">{currentRevision !== undefined && `当前修订 ${currentRevision} / `}本次运行修订 {state.manifest.taskRevision} · {state.manifest.model.model} · {state.manifest.model.protocol}。运行结果仍需业务流程确认。</p>
    {state.reason && <p role="status">{state.reason}</p>}
    <label>后续上下文模式<select aria-label="后续上下文模式" disabled={busy || running} value={contextPolicy?.mode ?? ''} onChange={async e => {
      const mode = e.target.value; setBusy(true); setError('')
      try { await window.desktop.engineering.setContextPolicy(scope, mode ? { version: 2, triggerScope: 'total', compactor: 'portable', horizonRounds: 6, ...(contextPolicy ?? state.latestBudget?.policy), mode: mode as 'legacy' | 'shadow' | 'adaptive' } : null) }
      catch (failure) { setError(String(failure)) } finally { setBusy(false) }
    }}><option value="">继承项目或模型连接设置</option><option value="legacy">此范围使用兼容模式</option><option value="shadow">此范围观察自适应判断</option><option value="adaptive">此范围使用自适应模式</option></select></label>
    {requestBudget && <dl>
      <dt>请求体</dt><dd>{requestBudget.requestCharacters.toLocaleString()} 字符 / {requestBudget.requestBytes.toLocaleString()} UTF-8 字节</dd>
      <dt>容量估算</dt><dd>输入约 {requestBudget.estimatedInputTokens.toLocaleString()} token；声明窗口 {requestBudget.contextWindowTokens?.toLocaleString() ?? '未知'}</dd>
      <dt>实际生效策略</dt><dd>{effectiveContextMode(requestBudget)} · {({ 'utf8-bytes-divided-by-3-v1': '兼容估算', 'utf8-upper-bound-v1': 'UTF-8 保守上界', 'usage-calibrated-v1': '实际用量校准', 'provider-count-v1': '供应商计数' })[requestBudget.estimateMethod]}</dd>
      {requestBudget.fallbackReason && <><dt>回退原因</dt><dd role="status">{requestBudget.fallbackReason}</dd></>}
      {(requestBudget.decision || requestBudget.shadowDecision) && (() => { const d = requestBudget.decision ?? requestBudget.shadowDecision!; return <><dt>{requestBudget.shadowDecision ? '观察判断' : '动态预算'}</dt><dd>输入硬预算 {d.hardLimit.toLocaleString()}；软触发 {d.trigger.toLocaleString()}；本次目标 {d.target.toLocaleString()} token</dd><dt>后续空间</dt><dd>前缀 {d.prefix.toLocaleString()} / 新增 {d.body.toLocaleString()}；期望 {d.headroom.toLocaleString()} / 当前 {Math.max(0, d.hardLimit - d.input).toLocaleString()}；{d.reason}</dd></> })()}
      <dt>预留</dt><dd>输出 {requestBudget.reserves.outputTokens}（{requestBudget.reserves.outputSource === 'declared' ? '配置声明' : requestBudget.reserves.outputSource === 'adapter-default' ? '协议默认' : '保守估算'}）；额外推理 {requestBudget.reserves.extraReasoningTokens ?? '未知'}；余量 {requestBudget.reserves.safetyTokens}</dd>
      <dt>最近实际用量</dt><dd>输入 {last?.usage?.inputTokens ?? '未知'} / 输出 {last?.usage?.outputTokens ?? '未知'} token</dd>
    </dl>}
    {!!state.compactions?.length && <details><summary>整理历史（{state.compactions.length} 条，含之前运行）</summary><p className="eng-hint">按时间倒序显示，包含不同阶段和连接；字符数与 token 不可直接比较。旧记录缺少角色时不推定归属。</p>{[...state.compactions].reverse().map((c, i) => <p key={c.at + ':' + i}>{compactionDescription(c)}</p>)}</details>}
    {!!state.operations?.length && <details><summary>计数与压缩请求（{state.operations.length}）</summary>{state.operations.map(o => <p key={o.id}>{o.kind === 'count' ? '计数' : '原生压缩'} · {o.status} · 输入 {o.usage?.inputTokens ?? '未知'} / 输出 {o.usage?.outputTokens ?? '未知'}{o.error && ' · ' + o.error}</p>)}</details>}
    {!!state.view?.sources.length && <details><summary>资料与来源（{state.view.sources.length}）</summary><pre>{state.view.sources.join('\n')}</pre></details>}
    {!!state.view?.archives.length && <div aria-label="原始归档">{state.view.archives.map((id, i) => <button key={id} className="ui-button secondary" disabled={busy} onClick={() => void read(id)}>查看归档 {i + 1}</button>)}</div>}
    {!!state.receipts?.length && <details><summary>调用记录（{state.receipts.length}）</summary>{state.receipts.map(r => <div key={r.logicalId}><p>{r.tool} · {{ prepared: '已保存意图', running: '执行中或待核对', completed: '已完成', failed: '失败', cancelled: '已停止', uncertain: '效果待核对' }[r.status]} · 修订 {r.taskRevision}</p>{r.reason && <p>{r.reason}</p>}{r.effects.map((effect, i) => <p key={i}>{effect}</p>)}{r.partialCommand?.artifact && <button className="ui-button secondary" disabled={busy} onClick={() => void read(r.partialCommand!.artifact!.id)}>查看部分命令输出</button>}{r.nextStep && <p>下一步：{r.nextStep}</p>}<small>实际尝试 {r.attempts} 次 · {r.applied ? '已登记' : '待补登记'} · {r.logicalId}</small></div>)}</details>}
    {!!state.receipts?.length && scope.projectId && scope.featureId && <button className="ui-button secondary" disabled={busy || running} onClick={async () => {
      setBusy(true); setError('')
      try { await window.desktop.engineering.reconcileRuntime(scope.projectId!, scope.featureId!) }
      catch (e) { if (current.current === identity) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (current.current === identity) setBusy(false) }
    }}>核对已记录效果</button>}
    {page && <div aria-label="归档分页"><p className="eng-hint">{page.complete ? '完整归档，可分页查看' : '仅部分内容，归档不完整'}</p><pre>{page.content}</pre>{page.nextOffset !== null && <button className="ui-button secondary" disabled={busy} onClick={() => void read(page.id, true)}>下一页原文</button>}</div>}
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
  </details></>
}
