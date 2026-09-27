import { useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import { stageLabels, type Feature, type Project } from '../../../shared/engineering'
import { deliveryFeatures, hasVerification, mergedFeatureFor, type DeliveryView, type FeatureTab } from './delivery'
import './delivery.css'

type View = Exclude<DeliveryView, 'specification'>
const copy: Record<View, { description: string; action: string; empty: string }> = {
  plans: { description: '逐项审阅实现方案、任务与依赖，确认后再进入开发队列。', action: '查看方案', empty: '尚无本期功能。先在需求与规格中确认交付范围。' },
  development: { description: '查看实际执行状态与开发队列。选择具体功能后查看日志、修改或开始执行。', action: '查看执行', empty: '尚无可开发功能。完成方案确认后，功能会出现在这里。' },
  verification: { description: '独立校验的过程、结果和证据集中在这里，验证通过不等于人工验收。', action: '查看证据', empty: '尚无开发提交或验证记录。代码开发后再进入独立验证。' },
  acceptance: { description: '对照需求、原型和实际运行结果，逐项验收交付成果。', action: '查看成果', empty: '尚无待验收或已验收成果。独立验证通过后才能最终验收。' },
}
function eligible(project: Project, feature: Feature, view: View) {
  if (view === 'plans') return true
  if (view === 'development') return !['requirements', 'solution'].includes(feature.stage)
  if (view === 'verification') return ['developing', 'verifying', 'acceptance', 'done'].includes(feature.stage) || hasVerification(project, feature)
  return ['acceptance', 'done'].includes(feature.stage)
}
function summary(project: Project, feature: Feature, view: View) {
  if (view === 'plans') {
    if (feature.stage === 'requirements') return '等待需求基线确认'
    return `${feature.plan.trim() ? '已有方案' : '待生成方案'} · ${feature.tasks.length} 项任务 · ${feature.dependencies.length} 项依赖`
  }
  if (view === 'development') return `${feature.tasks.filter(task => task.done).length} / ${feature.tasks.length} 项任务 · ${project.changes.filter(change => change.featureId === feature.id).length} 个文件修改`
  return feature.results.length
    ? `${feature.results.filter(result => result.passed).length} / ${feature.results.length} 项校验通过`
    : feature.stage === 'developing' ? '等待开发提交' : '尚无已保存的校验证据'
}
export default function DeliveryWorkspace({ project, view, onFeature, onBoard, onSpecification }: {
  project: Project
  view: View
  onFeature(id: string, tab: FeatureTab): void
  onBoard(): void
  onSpecification(): void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [showHistory, setShowHistory] = useState(false)
  const current = deliveryFeatures(project)
  const features = current.filter(feature => eligible(project, feature, view))
  const visible = features.filter(feature =>
    (filter === 'all' || feature.stage === filter) &&
    `${feature.title} ${feature.module}`.toLowerCase().includes(query.trim().toLowerCase()))
  const history = project.features.filter(feature => mergedFeatureFor(project, feature))
  const running = current.find(feature => ['developing', 'verifying'].includes(feature.stage))
  const plan = project.executionPlan
  const queue = (plan?.orderedFeatureIds ?? []).slice(plan?.currentIndex ?? 0)
    .map(id => current.find(feature => feature.id === id))
    .filter((feature): feature is Feature => !!feature && feature.stage !== 'done')
  const tabFor = (feature: Feature): FeatureTab => view === 'plans'
    ? feature.stage === 'requirements' ? 'requirements' : 'plan'
    : view === 'development' ? 'logs' : 'results'
  return (
    <section className="delivery-workspace" aria-label={`${view}阶段总览`}>
      <div className="delivery-intro">
        <p>{copy[view].description}</p>
        <button className="ui-button secondary" onClick={onBoard}>打开任务看板</button>
      </div>
      {view === 'development' && (
        <section className="delivery-execution" aria-label="当前执行与队列">
          <div>
            <h2>{running ? '当前执行' : '当前没有功能正在执行'}</h2>
            {running
              ? <button className="delivery-feature-link" onClick={() => onFeature(running.id, 'logs')}>{running.title}<span>{stageLabels[running.stage]}</span><ArrowRight size={13} /></button>
              : <p>查看已确认的执行顺序，或选择具体功能开始、继续开发。</p>}
          </div>
          {queue.length > 0 ? <div className="delivery-queue">
            <span>{plan?.status === 'waiting-acceptance' ? '等待当前成果验收' : '已保存的执行顺序'}</span>
            <ol>{queue.map(feature => <li key={feature.id}><button onClick={() => onFeature(feature.id, 'logs')}>{feature.title}</button><small>{stageLabels[feature.stage]}</small></li>)}</ol>
          </div> : <p className="eng-hint">尚无待执行队列，可在任务看板中选择功能并安排顺序。</p>}
        </section>
      )}
      <div className="delivery-filters">
        <label className="workspace-search"><Search size={14} /><input aria-label="搜索阶段功能" placeholder="搜索功能或模块…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="筛选交付状态" value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">全部状态</option>
          {[...new Set(features.map(feature => feature.stage))].map(stage => <option key={stage} value={stage}>{stageLabels[stage]}</option>)}
        </select>
        <span role="status">{visible.length} / {features.length} 个功能</span>
      </div>
      <div className="delivery-list-scroll">
        {visible.length ? <table className="delivery-table">
          <thead><tr><th scope="col">功能</th><th scope="col">当前状态</th><th scope="col" className="delivery-summary-column">{view === 'plans' ? '方案与任务' : '交付记录'}</th><th scope="col">操作</th></tr></thead>
          <tbody>{visible.map(feature => <tr key={feature.id} data-feature-id={feature.id}>
            <td><button className="delivery-feature-name" onClick={() => onFeature(feature.id, tabFor(feature))}>{feature.title}</button><small>{project.targets?.find(target => target.id === feature.targetId)?.name || feature.module || '未分组'}</small></td>
            <td><span className={`eng-stage stage-${feature.stage}`}>{stageLabels[feature.stage]}</span></td>
            <td className="delivery-summary-column">{summary(project, feature, view)}</td>
            <td><div className="delivery-row-actions">
              <button className="ui-button secondary small" onClick={() => onFeature(feature.id, tabFor(feature))}>{feature.stage === 'requirements' ? '查看需求' : copy[view].action}</button>
              {view === 'verification' && <button className="ui-button secondary small" onClick={() => onFeature(feature.id, 'logs')}>验证日志</button>}
            </div></td>
          </tr>)}</tbody>
        </table> : <div className="delivery-empty">
          <h2>{features.length ? '没有匹配的功能' : '本阶段暂无记录'}</h2>
          <p>{features.length ? '调整搜索或状态筛选，查看其他功能。' : copy[view].empty}</p>
          {features.length ? <button className="ui-button secondary" onClick={() => { setQuery(''); setFilter('all') }}>清除筛选</button> : <button className="ui-button secondary" onClick={onSpecification}>查看需求与规格</button>}
        </div>}
        {history.length > 0 && <section className="delivery-history">
          <button className="ui-button secondary small" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>{showHistory ? '收起' : '查看'}历史合并记录（{history.length}）</button>
          {showHistory && <><p>仅供追溯，不计入当前队列和交付进度。</p><ul>{history.map(feature => <li key={feature.id}><button onClick={() => onFeature(feature.id, tabFor(feature))}>{feature.title}</button><span>已合并至 {mergedFeatureFor(project, feature)?.title}</span></li>)}</ul></>}
        </section>}
      </div>
    </section>
  )
}
