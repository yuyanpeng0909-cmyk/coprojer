import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ChevronRight, List, RefreshCw, Search } from 'lucide-react'
import { requirementsFingerprint, scopeLabels, type Project } from '../../../shared/engineering'
import { DecisionHistory } from './DecisionCard'
import { mergedFeatureFor } from './delivery'
import './specification.css'

// Stable component identities preserve heading focus during project polling.
function markdownHeading(level: 'h1' | 'h2' | 'h3' | 'h4'): Components['h1'] {
  return function HeadingAnchor({ node, children }) {
    const Heading = level
    return <Heading id={`spec-heading-${node?.position?.start.line}`} tabIndex={-1} data-spec-anchor>{children}</Heading>
  }
}
const markdownComponents: Components = {
  h1: markdownHeading('h1'), h2: markdownHeading('h2'), h3: markdownHeading('h3'), h4: markdownHeading('h4'),
  a: ({ children }) => <span>{children}</span>, img: () => null,
}

function documentHeadings(markdown: string) {
  let fence = ''
  return markdown.split(/\r?\n/).flatMap((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) { fence = fence ? marker[0] === fence[0] ? '' : fence : marker; return [] }
    const match = !fence && /^(#{1,4})\s+(.+?)(?:\s+#+)?\s*$/.exec(line)
    return match ? [{ id: `spec-heading-${index + 1}`, title: match[2].replace(/[*_`]/g, ''), depth: match[1].length }] : []
  })
}
export default function SpecificationWorkspace({ project, busy, perform, onDiscuss, onFeature, onPrototype, onPlans }: {
  project: Project
  busy: boolean
  perform(work: () => Promise<unknown>, success?: string): Promise<boolean>
  onDiscuss(): void
  onFeature(id: string): void
  onPrototype(): void
  onPlans(): void
}) {
  const [snapshot, setSnapshot] = useState(project)
  const [query, setQuery] = useState('')
  const [tocOpen, setTocOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([])
  const [active, setActive] = useState('spec-goal')
  const [error, setError] = useState('')
  const reader = useRef<HTMLDivElement>(null)
  const jumping = useRef(false)
  const fingerprint = useMemo(() => requirementsFingerprint(snapshot), [snapshot])
  const currentFingerprint = requirementsFingerprint(project)
  const stale = fingerprint !== currentFingerprint || snapshot.chat.length !== project.chat.length
  const confirmed = snapshot.requirementsBaseline?.fingerprint === fingerprint && snapshot.requirementsBaseline.messageCount === snapshot.chat.length
  const storageKey = `coprojer.spec.review.${project.id}`
  const [reviewed, setReviewed] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); return saved?.fingerprint === fingerprint && Array.isArray(saved.checked) ? saved.checked : [] } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ fingerprint, checked: reviewed })) } catch { /* Reading remains available. */ }
  }, [storageKey, fingerprint, reviewed])
  const historical = snapshot.features.filter(feature => mergedFeatureFor(snapshot, feature))
  const features = snapshot.features.filter(feature => !mergedFeatureFor(snapshot, feature))
  const headings = documentHeadings(snapshot.requirementsDocument || '')
  const unassigned = features.filter(feature => !snapshot.targets?.some(target => target.id === feature.targetId))
  const groups = [
    ...(snapshot.targets || []).map(target => ({
      id: `spec-scope-target-${encodeURIComponent(target.id)}`, label: target.name, target,
      features: features.filter(feature => feature.targetId === target.id),
    })),
    ...(unassigned.length ? [{ id: 'spec-scope-unassigned', label: snapshot.targets?.length ? '未分配子项目' : '项目', target: undefined, features: unassigned }] : []),
  ].map(group => ({ ...group, modules: [...new Set(group.features.map(feature => feature.module || '未分组'))].map(label => ({
    id: `${group.id}-module-${encodeURIComponent(label)}`, label,
    features: group.features.filter(feature => (feature.module || '未分组') === label),
  })) }))
  const outline = [
    { id: 'spec-goal', title: '项目目标与范围', depth: 0 },
    { id: 'spec-document', title: '产品需求文档（PRD）', depth: 0 },
    ...headings,
    ...(snapshot.decisions?.length ? [{ id: 'spec-decisions', title: '决策与未决事项', depth: 0 }] : []),
  ]
  const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase())
  const visibleOutline = outline.filter(item => matches(item.title))
  const visibleGroups = groups.map(group => ({ ...group, modules: group.modules.map(module => ({
    ...module, features: module.features.filter(feature => matches(`${group.label} ${module.label} ${feature.title}`)),
  })).filter(module => module.features.length || matches(`${group.label} ${module.label}`)) })).filter(group => matches(group.label) || group.modules.length)
  const jump = (id: string) => {
    const element = document.getElementById(id)
    if (!element) return
    jumping.current = true
    setActive(id)
    if (window.matchMedia('(max-width: 1000px)').matches) setTocOpen(false)
    requestAnimationFrame(() => {
      element.scrollIntoView({ block: 'start' }); element.focus({ preventScroll: true })
      requestAnimationFrame(() => { jumping.current = false })
    })
  }
  const refresh = () => { setSnapshot(project); setError(''); if (stale) setReviewed([]) }
  const confirm = async (prepare: boolean) => {
    const ok = await perform(async () => {
      if (prepare) {
        const results = await window.desktop.engineering.confirmRequirementsAndPrepare(project.id, fingerprint, snapshot.chat.length)
        const fresh = (await window.desktop.engineering.state()).projects.find(item => item.id === project.id)
        if (fresh) setSnapshot(fresh)
        const failed = results.filter(result => !result.success)
        if (failed.length) throw new Error(`需求已确认，${failed.length} 项方案未生成；成功项已保留，可到方案与任务中查看。`)
      } else {
        await window.desktop.engineering.confirmProjectRequirements(project.id, fingerprint, snapshot.chat.length)
        const fresh = (await window.desktop.engineering.state()).projects.find(item => item.id === project.id)
        if (fresh) setSnapshot(fresh)
      }
    }, prepare ? '需求已确认，方案已准备好。' : '完整需求基线已写入共享上下文。')
    setError(ok ? '' : '未能完成全部操作。请查看提示；内容变化后需刷新并重新审阅。')
  }
  const disabled = busy || !!project.activity || project.designActivity || stale || !features.length
  return (
    <section className="specification-workspace" aria-label="需求与规格审阅">
      <div className="specification-toolbar">
        <button className="ui-button secondary specification-toc-toggle" aria-expanded={tocOpen} aria-controls="specification-toc" onClick={() => setTocOpen(!tocOpen)}><List size={14} />目录</button>
        <span className={`baseline-status ${confirmed ? 'confirmed' : ''}`}>{confirmed ? '已确认基线' : snapshot.requirementsBaseline ? '基线后有修订' : '待确认草稿'}</span>
        <span>{features.length} 个功能 · {snapshot.chat.length} 条讨论 · {snapshot.prototypes?.length || 0} 个原型</span>
        <button className="ui-button secondary small" onClick={refresh}><RefreshCw size={12} />刷新审阅内容</button>
      </div>
      {stale && <div className="specification-warning" role="status">需求或讨论已变化。当前保留你正在审阅的版本，刷新后才能确认。</div>}
      <div className="specification-reader" data-toc-open={tocOpen}>
        <nav className="specification-toc" id="specification-toc" aria-label="需求目录">
          <label className="workspace-search"><Search size={13} /><input aria-label="搜索需求目录" value={query} onChange={event => { setQuery(event.target.value); setCollapsedGroups([]) }} placeholder="搜索章节、模块或功能…" /></label>
          {visibleOutline.map(item => <button key={item.id} className={active === item.id ? 'active' : ''} aria-current={active === item.id ? 'location' : undefined} style={{ paddingLeft: 8 + Math.min(item.depth, 3) * 8 }} onClick={() => jump(item.id)}>{item.title}</button>)}
          {visibleGroups.map(group => <div key={group.id} className="specification-toc-group">
            <div className="specification-toc-group-heading">
              <button className="specification-group-toggle" aria-label={`${collapsedGroups.includes(group.id) ? '展开' : '收起'}子项目目录：${group.label}`} aria-expanded={!collapsedGroups.includes(group.id)} aria-controls={`${group.id}-toc`} onClick={() => setCollapsedGroups(items => items.includes(group.id) ? items.filter(id => id !== group.id) : [...items, group.id])}>{collapsedGroups.includes(group.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
              <button aria-label={`定位子项目：${group.label}`} className={active === group.id ? 'active' : ''} aria-current={active === group.id ? 'location' : undefined} onClick={() => jump(group.id)}>{group.label}</button>
            </div>
            <div id={`${group.id}-toc`} hidden={collapsedGroups.includes(group.id)}>{group.modules.map(module => <div key={module.id} className="specification-toc-module">
              <button aria-label={`定位模块：${group.label} / ${module.label}`} className={active === module.id ? 'active' : ''} aria-current={active === module.id ? 'location' : undefined} onClick={() => jump(module.id)}>{module.label}</button>
              {module.features.map(feature => <button key={feature.id} aria-label={feature.title} className={`specification-toc-feature ${active === `spec-feature-${feature.id}` ? 'active' : ''}`} aria-current={active === `spec-feature-${feature.id}` ? 'location' : undefined} onClick={() => jump(`spec-feature-${feature.id}`)}><span>{feature.title}</span>{reviewed.includes(feature.id) && <small>已核对</small>}</button>)}
            </div>)}{!group.modules.length && <small>尚无功能规格</small>}</div>
          </div>)}
          {historical.length > 0 && matches('历史合并记录') && <button onClick={() => jump('spec-history')}>历史合并记录（{historical.length}）</button>}
          {!visibleOutline.length && !visibleGroups.length && <p>没有匹配的章节或功能。</p>}
        </nav>
        <div className="specification-body" ref={reader} onScroll={() => {
          const container = reader.current
          if (!container || jumping.current) return
          const top = container.getBoundingClientRect().top
          const anchors = [...container.querySelectorAll<HTMLElement>('[data-spec-anchor]')]
          const current = anchors.filter(anchor => anchor.getBoundingClientRect().top <= top + 45).at(-1)
          if (current) setActive(current.id)
        }}>
          <section id="spec-goal" tabIndex={-1} data-spec-anchor data-current={active === 'spec-goal'}>
            <h2>项目目标与范围</h2><p>{snapshot.brief || '尚未填写项目目标。'}</p>
            <p className="eng-hint">PRD 与功能规格共用同一需求基线。技术实现方案在“方案与任务”中审阅。</p>
            {snapshot.requirementsBaseline && <small>已有基线确认于 {new Date(snapshot.requirementsBaseline.at).toLocaleString('zh-CN')}</small>}
          </section>
          <section id="spec-document" tabIndex={-1} data-spec-anchor data-current={active === 'spec-document'}>
            <h2>产品需求文档（PRD）</h2>
            {snapshot.requirementsDocument ? <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{snapshot.requirementsDocument}</ReactMarkdown></div> : <p>尚无完整需求文档。可返回讨论，整理目标、场景、范围和非功能要求。</p>}
          </section>
          {!!snapshot.decisions?.length && <section id="spec-decisions" tabIndex={-1} data-spec-anchor><h2>决策与未决事项</h2><DecisionHistory decisions={snapshot.decisions} /></section>}
          {groups.map(group => <div key={group.id} id={group.id} tabIndex={-1} data-spec-anchor data-current={active === group.id} className="specification-group"><h2>功能规格 · {group.label}</h2>
            {group.target && <div className="specification-target"><p>{group.target.responsibility}</p><p>规划目录：{group.target.directory}</p><p>接口约定：{group.target.contracts || '待补充'}</p></div>}
            {!group.modules.length && <p>该子项目尚无功能规格，可返回需求讨论补充。</p>}
            {group.modules.map(module => <div key={module.id} id={module.id} tabIndex={-1} data-spec-anchor data-current={active === module.id} className="specification-module"><h3>模块 · {module.label}</h3>{module.features.map(feature => <section key={feature.id} id={`spec-feature-${feature.id}`} tabIndex={-1} data-spec-anchor data-current={active === `spec-feature-${feature.id}`}>
            <div className="specification-feature-heading"><h4>{feature.title}</h4><span>{scopeLabels[feature.scope]}</span></div>
            <p className="specification-description">{feature.description || '尚缺行为说明，请补充具体规则和边界。'}</p>
            <h5>验收标准</h5>{feature.criteria.length ? <ul>{feature.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p className="specification-missing">尚缺验收标准</p>}
            {!!feature.dependencies.length && <p>前置依赖：{feature.dependencies.map(id => snapshot.features.find(item => item.id === id)?.title || `未找到功能 ${id}`).join('、')}</p>}
            {feature.prototypeId && <p>关联原型：{snapshot.prototypes?.find(item => item.id === feature.prototypeId)?.title || feature.prototypeId}<button className="ui-button secondary small" onClick={onPrototype}>查看原型</button></p>}
            <div className="specification-feature-actions"><label><input type="checkbox" checked={reviewed.includes(feature.id)} aria-label={`已核对：${feature.title}`} onChange={event => setReviewed(items => event.target.checked ? [...items, feature.id] : items.filter(id => id !== feature.id))} />已核对</label><button className="ui-button secondary small" onClick={() => onFeature(feature.id)}>查看功能详情</button></div>
          </section>)}</div>)}</div>)}
          {historical.length > 0 && <section id="spec-history" tabIndex={-1} data-spec-anchor><h2>历史合并记录</h2><p>保留原始记录供追溯，不计入当前交付队列。</p>{historical.map(feature => <details key={feature.id}><summary>{feature.title}</summary><p>{feature.description}</p><ul>{feature.criteria.map((item, index) => <li key={index}>{item}</li>)}</ul><button className="ui-button secondary small" onClick={() => onFeature(mergedFeatureFor(snapshot, feature)!.id)}>查看正式功能</button></details>)}</section>}
        </div>
      </div>
      <footer className="specification-footer">
        <div><span>已核对 {reviewed.filter(id => features.some(feature => feature.id === id)).length} / {features.length}</span><small>阅读标记不代表需求批准</small>{error && <span role="alert" className="specification-missing">{error}</span>}</div>
        <div className="specification-footer-actions"><button className="ui-button secondary" onClick={onDiscuss}>继续讨论</button>{confirmed ? <button className="ui-button primary" onClick={onPlans}>查看方案与任务</button> : <><button className="ui-button secondary" disabled={disabled} onClick={() => void confirm(false)}>确认并保存基线</button><button className="ui-button primary" disabled={disabled} onClick={() => void confirm(true)}>确认需求并准备方案</button></>}</div>
      </footer>
    </section>
  )
}
