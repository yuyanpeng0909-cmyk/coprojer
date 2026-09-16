import { useState } from 'react'
import {
  ArrowRight,
  Bot,
  Check,
  CircleCheck,
  FileText,
  GitBranch,
  ListChecks,
  Plus,
  Search,
  Terminal,
  Workflow,
} from 'lucide-react'
import {
  stageLabels,
  type EngineeringState,
  type Feature,
  type Project,
} from '../../../shared/engineering'

export function WelcomeWorkspace({
  state,
  onCreate,
  onModels,
  onAgents,
}: {
  state: EngineeringState
  onCreate(): void
  onModels(): void
  onAgents(): void
}) {
  return (
    <div className="workspace-welcome">
      <div className="welcome-intro">
        <span className="workspace-kicker">你的工程，从这里开始</span>
        <h2>让需求有来处，让交付有依据。</h2>
        <p>
          把讨论、实现与验证放在同一个工作空间。
          <br />
          你确认方向，智能体推进执行，每一步都有记录。
        </p>
        <button className="ui-button" onClick={onCreate}>
          <Plus size={14} />
          创建项目
        </button>
      </div>
      <div className="welcome-route">
        {[
          { icon: GitBranch, title: '定义需求', detail: '讨论想法，梳理模块与功能' },
          { icon: ListChecks, title: '确认方案', detail: '确定范围、任务与验收标准' },
          { icon: Terminal, title: '实现与验证', detail: '串行开发，独立运行测试' },
          { icon: CircleCheck, title: '验收交付', detail: '检查结果，沉淀工程知识' },
        ].map(({ icon: Icon, title, detail }, i) => (
          <div key={title}>
            <span className="route-number">0{i + 1}</span>
            <Icon size={18} />
            <h3>{title}</h3>
            <p>{detail}</p>
          </div>
        ))}
      </div>
      <div className="welcome-setup">
        <header>
          <h3>准备工作</h3>
          <span>
            {state.models.length ? '已连接模型，可以开始创建项目' : '连接模型后即可开启需求讨论'}
          </span>
        </header>
        <button onClick={onModels}>
          <span className="setup-icon">
            <Bot size={17} />
          </span>
          <span>
            <strong>模型连接</strong>
            <small>
              {state.models.length
                ? `已配置 ${state.models.length} 个模型`
                : '添加官方服务或自定义中转地址'}
            </small>
          </span>
          {state.models.length ? <Check size={15} /> : <ArrowRight size={15} />}
        </button>
        <button onClick={onAgents}>
          <span className="setup-icon">
            <Workflow size={17} />
          </span>
          <span>
            <strong>工程智能体</strong>
            <small>为开发与独立验证配置模型和工作要求</small>
          </span>
          <span className="workspace-count">{state.agents.length}</span>
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  )
}

export default function WorkspaceOverview({
  project,
  state,
  onOpen,
  onAdd,
  onMap,
  onActivity,
  onContext,
}: {
  project: Project
  state: EngineeringState
  onOpen(feature: Feature): void
  onAdd(): void
  onMap(): void
  onActivity(): void
  onContext(): void
}) {
  const [query, setQuery] = useState(''),
    [scope, setScope] = useState('all')
  const completed = project.features.filter((f) => f.stage === 'done')
  const attention = project.features.filter(
    (f) =>
      ['requirements', 'solution', 'acceptance', 'blocked'].includes(f.stage) &&
      f.scope !== 'later',
  )
  const active = project.features.find((f) => ['developing', 'verifying'].includes(f.stage))
  const next =
    active ??
    project.features.find((f) => f.stage === 'acceptance') ??
    project.features.find((f) => f.stage === 'ready')
  const filtered = project.features.filter(
    (f) =>
      (scope === 'all' || f.scope === scope) &&
      `${f.title} ${f.module} ${f.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="workspace-overview">
      <div className="workspace-metrics">
        {[
          { label: '已规划功能', value: project.features.length, detail: '项目范围' },
          { label: '待你确认', value: attention.length, detail: '需求 · 方案 · 验收' },
          { label: '正在执行', value: active ? 1 : 0, detail: '按功能串行交付' },
          {
            label: '已验收交付',
            value: completed.length,
            detail: project.features.length
              ? `${Math.round((completed.length / project.features.length) * 100)}% 已完成`
              : '尚未开始',
          },
        ].map((m) => (
          <div key={m.label}>
            <span>{m.label}</span>
            <strong>{m.value.toString().padStart(2, '0')}</strong>
            <small>{m.detail}</small>
          </div>
        ))}
      </div>
      <div className="overview-panels">
        <section className="attention-panel">
          <header>
            <h2>
              待办决策 <span>{attention.length}</span>
            </h2>
            <small>由你确认，继续推进</small>
          </header>
          {attention.length ? (
            attention.slice(0, 4).map((f) => (
              <button className="decision-row" key={f.id} onClick={() => onOpen(f)}>
                <span className={`decision-indicator ${f.stage}`} />
                <span>
                  <strong>{f.title}</strong>
                  <small>
                    {f.module} ·{' '}
                    {f.stage === 'requirements'
                      ? '确认范围与验收标准'
                      : f.stage === 'solution'
                        ? '审阅实现方案与任务'
                        : f.stage === 'blocked'
                          ? '检查问题并继续执行'
                          : '查看测试结果，完成最终验收'}
                  </small>
                </span>
                <em>{stageLabels[f.stage]}</em>
                <ArrowRight size={13} />
              </button>
            ))
          ) : (
            <div className="panel-empty">
              <CircleCheck size={21} />
              <strong>{project.features.length ? '目前没有待确认事项' : '先定义第一个功能'}</strong>
              <p>
                {project.features.length
                  ? '新的需求、方案和验收会出现在这里。'
                  : '从需求讨论开始，建立可独立验收的功能。'}
              </p>
              {!project.features.length && (
                <button className="ui-button secondary small" onClick={onMap}>
                  开始讨论 <ArrowRight size={12} />
                </button>
              )}
            </div>
          )}
        </section>
        <section className="execution-panel">
          <header>
            <h2>执行窗口</h2>
            <span className={project.activity ? 'execution-dot active' : 'execution-dot'} />
            {project.activity ? '执行中' : '空闲'}
          </header>
          <div className="execution-summary">
            <Terminal size={19} />
            <h3>{next?.title ?? '等待下一项任务'}</h3>
            <p>
              {project.activity ||
                (next?.stage === 'acceptance'
                  ? '独立验证已完成，等待最终验收。'
                  : next
                    ? '方案已确认，可以开始开发。'
                    : '确认功能方案后，智能体将从这里开始执行。')}
            </p>
          </div>
          {next && (
            <div className="execution-owner">
              <Bot size={13} />
              {state.agents.find((a) => a.id === next.developerId)?.name ?? '开发智能体'}
              <span>{stageLabels[next.stage]}</span>
            </div>
          )}
          <footer>
            <button className="ui-button secondary small" onClick={onActivity}>
              查看执行记录
            </button>
            {next && (
              <button className="ui-button small" onClick={() => onOpen(next)}>
                {active ? '查看执行' : next.stage === 'acceptance' ? '查看验收' : '进入功能'}
                <ArrowRight size={12} />
              </button>
            )}
          </footer>
        </section>
      </div>
      <section className="feature-register">
        <header>
          <div>
            <h2>
              功能清单 <span>{project.features.length}</span>
            </h2>
            <p>从需求到交付，每项功能都有完整记录。</p>
          </div>
          <button className="ui-button secondary small" onClick={onAdd}>
            <Plus size={12} />
            新增功能
          </button>
        </header>
        <div className="register-toolbar">
          <label className="workspace-search">
            <Search size={13} />
            <input
              aria-label="搜索功能"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索功能、模块…"
            />
          </label>
          <select
            aria-label="筛选功能范围"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">全部范围</option>
            <option value="current">本期</option>
            <option value="discussion">待讨论</option>
            <option value="later">暂缓</option>
          </select>
        </div>
        <div className="feature-table">
          <div className="feature-table-heading">
            <span>功能 / 模块</span>
            <span>阶段</span>
            <span>任务</span>
            <span>开发智能体</span>
          </div>
          {filtered.map((f) => (
            <button className="feature-table-row" key={f.id} onClick={() => onOpen(f)}>
              <span>
                <strong>{f.title}</strong>
                <small>{f.module}</small>
              </span>
              <span className={f.stage === 'done' ? 'feature-delivered' : ''}>
                {f.stage === 'done' && <Check size={11} />}
                {stageLabels[f.stage]}
              </span>
              <span>
                {f.tasks.filter((t) => t.done).length}
                <small> / {f.tasks.length}</small>
              </span>
              <span>
                {state.agents.find((a) => a.id === f.developerId)?.name ?? '未指定'}
                <ArrowRight size={12} />
              </span>
            </button>
          ))}
          {!filtered.length && (
            <div className="register-empty">
              {query || scope !== 'all'
                ? '没有符合条件的功能'
                : '还没有功能。开始需求讨论，或手动添加。'}
            </div>
          )}
        </div>
      </section>
      <button className="context-summary" onClick={onContext}>
        <FileText size={15} />
        <span>
          <strong>工程共享上下文</strong>
          <small>已沉淀 {project.context.length} 条记录 · 为后续开发保留依据</small>
        </span>
        <ArrowRight size={14} />
      </button>
    </div>
  )
}
