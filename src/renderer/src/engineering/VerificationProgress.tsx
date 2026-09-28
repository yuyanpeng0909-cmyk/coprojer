import type { Feature } from '../../../shared/engineering'

const phases = { diagnosing: '分析验证缺口', preparing: '准备验证条件', rechecking: '重新独立验证', blocked: '待补验证', complete: '独立验证完成' }
const dispositions = { automatic: '可自动补齐', external: '外部条件', unknown: '待技术诊断' }
export default function VerificationProgress({ feature }: { feature: Feature }) {
  const state = feature.verificationPreparation
  if (!state) return null
  const failed = feature.results.some(r => r.status === 'failed') || feature.verificationChecks?.some(c => c.code !== 0) || state.attempts.at(-1)?.status === 'defect'
  const failedCommands = failed ? [...new Set(feature.verificationChecks?.filter(c => c.code !== 0).map(c => c.command) ?? [])] : []
  return <section className="eng-verification-progress" aria-label="验证条件准备">
    <div className="eng-verification-heading"><strong role="status">{state.phase === 'blocked' && failed ? '检查未通过' : phases[state.phase]}</strong><span>准备 {state.round} / {state.limit} 轮 · 代码修复 {feature.repairRound} / 3 轮</span></div>
    {state.phase === 'blocked' && failedCommands.length > 0 && <p>实际检查未通过：{failedCommands.join('；')}。失败尚未解决，不能进入成果验收。</p>}
    <p>{state.phase === 'blocked' && state.gaps.length > 0 && state.gaps.every(g => g.disposition !== 'automatic')
      ? '仍有 ' + state.gaps.length + ' 项未验证。具体依据和最少需要补充的条件见下方。' : state.summary}</p>
    {state.gaps.length > 0 && state.phase !== 'complete' && <details open={state.phase === 'blocked'}>
      <summary>验证缺口与下一步（{state.gaps.length}）</summary>
      {state.gaps.map(gap => <div className="eng-verification-gap" key={gap.id}><strong>{gap.criterion} · {dispositions[gap.disposition]}</strong>
        <p>{gap.reason}</p><p>下一步：{gap.nextStep}</p></div>)}
    </details>}
    {state.attempts.length > 0 && <details><summary>已完成的准备与实际结果</summary>
      {state.attempts.map(attempt => <div className="eng-verification-gap" key={attempt.id}><strong>第 {attempt.round} 轮 · {{ running: '执行中', ready: '已准备', failed: '技术阻塞', interrupted: '已中断', defect: '移交代码修复' }[attempt.status]}</strong>
        <p>{attempt.result || '正在执行，完成后独立复验。'}</p>
        {attempt.actions.filter(a => a.startsWith('created:')).map((a, i) => <p key={i}>新增检查资料：{a.slice(8)}</p>)}
        {attempt.nextStep && <p>下一步：{attempt.nextStep}</p>}
      </div>)}
    </details>}
  </section>
}
