import type { Feature } from '../../../shared/engineering'

const labels = { current: '当前适用', superseded: '已被替代', stale: '已过期', history: '仅历史', insufficient: '证据不足' }
export default function CurrentEvidence({ feature }: { feature: Feature }) {
  const view = feature.evidenceProjection
  if (!view) return null
  return <details className="eng-verification-progress">
    <summary>当前检查与历史依据（{view.records.length}）</summary>
    <p>修订 {view.taskRevision} · 源码 {view.sourceFingerprint.slice(0, 10)}。检查通过仍等待最终人工验收。</p>
    {view.records.map((c, i) => <div className="eng-verification-gap" key={`${c.runId}-${c.id}-${i}`}>
      <strong>{labels[view.taskRevision === feature.revision ? c.disposition : 'stale']} · {c.command}</strong>
      <p>退出码 {c.code} · {c.durationMs === undefined ? '耗时未知' : `${c.durationMs} ms`}{c.supersededBy ? ` · 由 ${c.supersededBy} 替代` : ''}</p>
      <details><summary>检查输出与来源</summary><pre>{[...(feature.verificationChecks ?? []), ...(feature.verificationHistory ?? [])].find(row => row.runId === c.runId && row.id === c.id)?.output ?? c.output}</pre><small>检查 {c.id || '历史未记录'} · 运行 {c.runId || view.executionRunId}{c.artifactId ? ` · 完整日志 ${c.artifactId}` : ''}</small></details>
    </div>)}
  </details>
}
