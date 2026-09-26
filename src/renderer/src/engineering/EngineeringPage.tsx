import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  ChevronRight,
  Search,
  Moon,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
  Bot,
  Check,
  Circle,
  CircleCheck,
  FileCode2,
  FolderOpen,
  GitBranch,
  ListChecks,
  LoaderCircle,
  Network,
  Play,
  Plus,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { Overlay, Tabs } from '../components/ui'
import {
  scopeLabels,
  stageLabels,
  type AgentConfig,
  type ExecutionPlan,
  type EngineeringState,
  type Feature,
  type FeatureInput,
  type ModelInput,
  type Project,
  type Protocol,
} from '../../../shared/engineering'
import './engineering.css'
import type { Preferences } from '../usePreferences'
import WorkspaceSidebar, {
  workspaceNavigation,
  type ProjectView,
  type WorkspaceSection,
} from './WorkspaceSidebar'
import WorkspaceOverview, { WelcomeWorkspace } from './WorkspaceOverview'
import WorkspaceSettings from './WorkspaceSettings'
import RequirementsWorkspace, { type ResearchTab } from './RequirementsWorkspace'
import ContextWorkspace from './ContextWorkspace'
import {
  defaultAgentTools,
  toolLabels,
  type EngineeringToolName,
} from '../../../shared/engineering'

const api = () => window.desktop.engineering
const emptyState: EngineeringState = { models: [], agents: [], projects: [] }
const freshModel: ModelInput = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  protocol: 'chat',
  apiKey: '',
}
const splitLines = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
const protocolLabels: Record<Protocol, string> = {
  chat: 'OpenAI 兼容',
  responses: 'Responses',
  anthropic: 'Anthropic',
}
const executionPlanStatusLabels: Record<ExecutionPlan['status'], string> = {
  planned: '待开始',
  running: '执行中',
  'waiting-acceptance': '待最终验收',
  completed: '已完成',
  stopped: '已暂停',
}
const deletableFeatureStages: Feature['stage'][] = ['requirements', 'solution', 'ready']
const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  )
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="eng-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}
function Empty({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children?: ReactNode
}) {
  return (
    <div className="eng-empty">
      <Network size={28} strokeWidth={1.2} />
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </div>
  )
}
function Stage({ feature }: { feature: Feature }) {
  return (
    <span className={`eng-stage stage-${feature.stage}`}>
      {feature.stage === 'done' ? <CircleCheck size={12} /> : <Circle size={11} />}
      {stageLabels[feature.stage]}
    </span>
  )
}

export default function EngineeringPage({
  preferences,
  connected,
}: {
  preferences: Preferences
  connected: boolean
}) {
  const [state, setState] = useState<EngineeringState>(emptyState)
  const [section, setSection] = useState<WorkspaceSection>('projects')
  const [projectId, setProjectId] = useState(() => {
    try {
      return localStorage.getItem('coprojer.studio.project') || ''
    } catch {
      return ''
    }
  })
  const [collapsed, setCollapsed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false),
    [search, setSearch] = useState('')
  const [researchTab, setResearchTab] = useState<ResearchTab>('requirements')
  const [view, setView] = useState<ProjectView>('overview')
  const [featureId, setFeatureId] = useState<string | null>(null)
  const [newFeature, setNewFeature] = useState(false)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [executionSelection, setExecutionSelection] = useState<string[]>([])
  const [model, setModel] = useState<ModelInput | null>(null),
    [modelList, setModelList] = useState<string[]>([]),
    [modelStatus, setModelStatus] = useState('')
  const [agent, setAgent] = useState<AgentConfig | null>(null)
  const [projectDraft, setProjectDraft] = useState<{
    name: string
    parent: string
    brief: string
    modelId: string
  } | null>(null)
  const [contextDraft, setContextDraft] = useState<{
    id: string | null
    title: string
    content: string
  } | null>(null)
  const [script, setScript] = useState('dev')
  const refresh = useCallback(async () => {
    setState(await api().state())
  }, [])
  useEffect(() => {
    let mounted = true,
      fetching = false
    const poll = async () => {
      if (fetching) return
      fetching = true
      try {
        const value = await api().state()
        if (mounted) setState(value)
      } catch (e) {
        if (mounted) setError(messageOf(e))
      } finally {
        fetching = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 250)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [])
  const project = state.projects.find((p) => p.id === projectId) ?? state.projects[0]
  const lastEvent = project?.events.at(-1)
  const backgroundProblem =
    !project?.activity &&
    lastEvent &&
    ['error', 'stopped', 'interrupted', 'repair'].includes(lastEvent.kind)
      ? lastEvent.message.split('\n')[0]
      : null
  const feature = project?.features.find((f) => f.id === featureId)
  const perform = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
      await refresh()
      if (success) setNotice(success)
      return true
    } catch (e) {
      setError(messageOf(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const openModel = (input?: ModelInput) => {
    setModel(input ? { ...input, apiKey: '' } : { ...freshModel })
    setModelList([])
    setModelStatus('')
    setError('')
  }
  const selectProject = (id: string) => {
    setProjectId(id)
    setFeatureId(null)
    setExecutionSelection([])
    setResearchTab('requirements')
    setView('overview')
    setSection('projects')
    try {
      localStorage.setItem('coprojer.studio.project', id)
    } catch {
      /* Session selection remains available. */
    }
  }
  const startNewProject = () =>
    setProjectDraft({ name: '', parent: '', brief: '', modelId: state.models[0]?.id ?? '' })
  const activeFeature =
    feature ??
    ['developing', 'verifying', 'acceptance', 'blocked', 'ready', 'solution', 'requirements']
      .map((stage) => project?.features.find((f) => f.stage === stage))
      .find(Boolean)
  const stages = ['需求讨论', '需求确认', '方案与任务', '代码开发', '独立验证', '最终验收']
  const stageIndex = activeFeature
    ? {
        requirements: 0,
        solution: 2,
        ready: 3,
        developing: 3,
        verifying: 4,
        acceptance: 5,
        done: 5,
        blocked: 3,
      }[activeFeature.stage]
    : project?.features.length && project.features.every((f) => f.stage === 'done')
      ? 6
      : 0
  const totalTasks = project?.features.reduce((sum, item) => sum + (item.tasks ?? []).length, 0) ?? 0
  const unplannedFeatures =
    project?.features.filter((item) => item.stage === 'solution' && (item.tasks ?? []).length === 0) ?? []
  const readyFeatures = project?.features.filter((item) => item.stage === 'ready') ?? []
  const selectedExecutionIds = readyFeatures
    .filter((item) => executionSelection.includes(item.id))
    .map((item) => item.id)
  const executionPlan = project?.executionPlan
  const executionPlanCurrent = executionPlan
    ? project?.features.find((item) => item.id === executionPlan.orderedFeatureIds[executionPlan.currentIndex])
    : undefined
  useEffect(() => {
    const available = new Set(readyFeatures.map((item) => item.id))
    setExecutionSelection((current) => {
      const next = current.filter((id) => available.has(id))
      return next.length === current.length ? current : next
    })
  }, [project?.id, readyFeatures.map((item) => item.id).join('|')])
  const navigate = (next: ProjectView) => {
    setSection('projects')
    setView(next)
  }
  const pageTitle =
    section === 'projects'
      ? workspaceNavigation.find((n) => n.id === view)!.label
      : { models: '模型连接', agents: '智能体', appearance: '外观与偏好' }[section]
  const pageDescription =
    section === 'projects'
      ? {
          overview: '掌握项目进展，处理关键决策。',
          map: '探索完整需求，让功能与界面随着讨论逐步成形。',
          board: '追踪每项功能的开发阶段与任务进度。',
          context: '让每次接续开发，都建立在已有工程知识上。',
          activity: '查看真实操作、测试输出与交付依据。',
        }[view]
      : {
          models: '管理你的模型服务与连接。',
          agents: '配置可复用的开发与验证角色。',
          appearance: '按你的习惯调整工作空间。',
        }[section]
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]') || !(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        startNewProject()
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearch('')
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [state.models])
  return (
    <section className="studio eng-page" data-collapsed={collapsed}>
      <WorkspaceSidebar
        researchTab={researchTab}
        onResearchTab={(tab) => {
          setResearchTab(tab)
          navigate('map')
        }}
        state={state}
        project={project}
        view={view}
        section={section}
        collapsed={collapsed}
        phase={stageIndex}
        onSelect={selectProject}
        onCreate={startNewProject}
        onNavigate={navigate}
        onSection={setSection}
        onStage={(index) => {
          if (index < 2) {
            navigate('map')
            setResearchTab('requirements')
            return
          }
          const targets = [
            ['requirements'],
            ['requirements'],
            ['solution'],
            ['ready', 'developing', 'blocked'],
            ['verifying'],
            ['acceptance'],
          ]
          const target = project?.features.find((f) => targets[index].includes(f.stage))
          if (target) setFeatureId(target.id)
          else navigate(index < 2 ? 'map' : index === 4 ? 'activity' : 'board')
        }}
      />
      <main className="studio-main">
        <div className="studio-toolbar">
          <div className="studio-breadcrumb">
            <button
              className="eng-icon"
              aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
            <span>{project?.name ?? '工作空间'}</span>
            <ChevronRight size={12} />
            <strong>{pageTitle}</strong>
          </div>
          <div className="studio-toolbar-actions">
            <button
              className="quick-search-button"
              aria-label="搜索工作空间"
              onClick={() => {
                setSearch('')
                setSearchOpen(true)
              }}
            >
              <Search size={13} />
              <span>快速查找</span>
              <kbd>Ctrl K</kbd>
            </button>
            {project && (
              <button
                className="eng-icon"
                aria-label="打开工程目录"
                title={project.root}
                onClick={() => void perform(() => api().openProject(project.id))}
              >
                <FolderOpen size={15} />
              </button>
            )}
            <button className="eng-icon" aria-label="切换主题" onClick={preferences.toggleTheme}>
              {preferences.theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
            </button>
          </div>
        </div>
        <div className="studio-content">
          <header className="studio-page-heading">
            <div>
              <h1>{pageTitle}</h1>
              <p>{pageDescription}</p>
            </div>
            {section === 'projects' && project && (
              <div className="page-actions">
                {project.activity && view !== 'map' && (
                  <button
                    className="ui-button secondary"
                    onClick={() => void perform(() => api().stop(project.id))}
                  >
                    <Square size={11} />
                    停止执行
                  </button>
                )}
                <button
                  className={`ui-button ${view === 'map' ? 'secondary' : ''}`}
                  onClick={() => {
                    setNewFeature(true)
                    setFeatureId(null)
                  }}
                >
                  <Plus size={13} />
                  添加功能
                </button>
              </div>
            )}
          </header>
          {error && (
            <div role="alert" className="eng-alert">
              <span>{error}</span>
              <button className="eng-icon" aria-label="关闭工程错误" onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="eng-notice">
              {notice}
            </div>
          )}
          {section === 'models' && (
            <div className="eng-settings">
              <div className="eng-section-heading">
                <div>
                  <h2>模型连接</h2>
                  <p>配置你使用的模型，供需求讨论和工程智能体选择。</p>
                </div>
                <button className="ui-button primary" onClick={() => openModel()}>
                  <Plus size={14} />
                  新增模型
                </button>
              </div>
              {!state.models.length ? (
                <Empty title="连接你的第一个模型" detail="支持官方服务与自定义中转地址。">
                  <button className="ui-button secondary" onClick={() => openModel()}>
                    添加模型连接
                  </button>
                </Empty>
              ) : (
                <div className="eng-models">
                  {state.models.map((m) => (
                    <article className="eng-model-card" key={m.id}>
                      <div className="eng-model-icon">
                        <Bot size={20} />
                      </div>
                      <div className="eng-card-copy">
                        <h3>{m.name}</h3>
                        <p>{m.model}</p>
                        <small>{m.baseUrl}</small>
                      </div>
                      <span className="eng-tag">{protocolLabels[m.protocol]}</span>
                      <button className="ui-button secondary" onClick={() => openModel(m)}>
                        编辑
                      </button>
                      <button
                        className="eng-icon"
                        aria-label={`删除模型 ${m.name}`}
                        disabled={busy}
                        onClick={() => void perform(() => api().deleteModel(m.id))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
          {section === 'agents' && (
            <div className="eng-settings">
              <div className="eng-section-heading">
                <div>
                  <h2>你的工程成员</h2>
                  <p>按职责选择模型与工作要求，开发和验证分别执行。</p>
                </div>
                <button
                  className="ui-button primary"
                  onClick={() =>
                    setAgent({
                      id: '',
                      name: '',
                      role: 'developer',
                      modelId: state.models[0]?.id ?? '',
                      instructions: '',
                      tools: defaultAgentTools('developer'),
                    })
                  }
                >
                  <Plus size={14} />
                  新增智能体
                </button>
              </div>
              <div className="eng-agents">
                {state.agents.map((a) => (
                  <article className="eng-agent-card" key={a.id}>
                    <div className="eng-section-heading">
                      <Bot size={21} />
                      <span className="eng-tag">{a.role === 'developer' ? '开发' : '验证'}</span>
                    </div>
                    <h3>{a.name}</h3>
                    <p>{a.instructions}</p>
                    <footer>
                      <span>
                        {state.models.find((m) => m.id === a.modelId)?.name ?? '尚未选择模型'}
                      </span>
                      <button className="ui-button secondary" onClick={() => setAgent({ ...a })}>
                        配置
                      </button>
                    </footer>
                  </article>
                ))}
              </div>
            </div>
          )}
          {section === 'projects' && (
            <div className="eng-workspace">
              <div className="eng-project-content">
                {!project ? (
                  <WelcomeWorkspace
                    state={state}
                    onCreate={startNewProject}
                    onModels={() => setSection('models')}
                    onAgents={() => setSection('agents')}
                  />
                ) : (
                  <>
                    {project.activity && (
                      <div className="eng-working" role="status">
                        <LoaderCircle size={13} />
                        {project.activity}
                      </div>
                    )}
                    {backgroundProblem && view !== 'map' && (
                      <div className="eng-background-problem" role="status">
                        <span>{backgroundProblem}</span>
                        <button
                          className="ui-button secondary small"
                          onClick={() => setView('activity')}
                        >
                          查看记录
                        </button>
                      </div>
                    )}
                    {view === 'overview' && (
                      <WorkspaceOverview
                        key={project.id}
                        project={project}
                        state={state}
                        onOpen={(f) => setFeatureId(f.id)}
                        onAdd={() => {
                          setNewFeature(true)
                          setFeatureId(null)
                        }}
                        onMap={() => navigate('map')}
                        onActivity={() => navigate('activity')}
                        onContext={() => navigate('context')}
                      />
                    )}
                    {view === 'map' && (
                      <RequirementsWorkspace
                        key={project.id}
                        project={project}
                        state={state}
                        onFeature={setFeatureId}
                        perform={perform}
                        tab={researchTab}
                        onTab={setResearchTab}
                      />
                    )}
                    {view === 'board' && (
                      <div className="eng-board-shell">
                        <div className="eng-board-summary" role="status">
                          <div className="eng-board-summary-copy">
                            <strong>
                              {totalTasks ? `${totalTasks} 项实现任务` : '当前没有已确认实现任务'}
                            </strong>
                            <span>
                              {readyFeatures.length
                                ? `${readyFeatures.length} 个已确认方案可勾选加入执行计划。`
                                : unplannedFeatures.length
                                  ? `${unplannedFeatures.length} 个功能正在方案确认，打开卡片生成并确认任务。`
                                  : '先在功能卡片中确认方案，确认后才可加入 LLM 执行计划。'}
                            </span>
                          </div>
                          <div className="eng-board-summary-actions">
                            <span>{selectedExecutionIds.length ? `已勾选 ${selectedExecutionIds.length} 项` : '可多选方案'}</span>
                            <button
                              className="ui-button primary small"
                              disabled={!selectedExecutionIds.length || busy || !!project.activity}
                              onClick={() =>
                                void perform(async () => {
                                  await api().planExecution(project.id, selectedExecutionIds)
                                  setExecutionSelection([])
                                }, 'LLM 已生成执行顺序，请检查规划理由后开始执行。')
                              }
                            >
                              <ListChecks size={12} />
                              LLM 规划执行
                            </button>
                          </div>
                          {executionPlan && (
                            <div className="eng-execution-plan" data-testid="execution-plan">
                              <div className="eng-execution-plan-heading">
                                <strong>执行计划 · {executionPlanStatusLabels[executionPlan.status]}</strong>
                                {['planned', 'stopped'].includes(executionPlan.status) && (
                                  <button
                                    className="ui-button secondary small"
                                    disabled={busy || !!project.activity}
                                    onClick={() =>
                                      void perform(
                                        () => api().runExecutionPlan(project.id),
                                        '已开始按 LLM 规划执行，当前功能完成验证后请最终验收。',
                                      )
                                    }
                                  >
                                    <Play size={11} />
                                    {executionPlan.status === 'stopped' ? '继续执行计划' : '开始执行计划'}
                                  </button>
                                )}
                                {executionPlan.status === 'waiting-acceptance' && executionPlanCurrent && (
                                  <button
                                    className="ui-button secondary small"
                                    disabled={busy}
                                    onClick={() => setFeatureId(executionPlanCurrent.id)}
                                  >
                                    打开当前验收
                                  </button>
                                )}
                              </div>
                              <div className="eng-execution-plan-order">
                                {executionPlan.orderedFeatureIds.map((id, index) => {
                                  const item = project.features.find((candidate) => candidate.id === id)
                                  if (!item) return null
                                  const current = index === executionPlan.currentIndex
                                  return (
                                    <span key={id} className={current ? 'current' : ''}>
                                      {index + 1}. {item.title}
                                      {item.stage === 'done' ? ' · 已验收' : current ? ' · 当前' : ''}
                                    </span>
                                  )
                                })}
                              </div>
                              <small>LLM 规划理由：{executionPlan.rationale}</small>
                              {executionPlan.status === 'waiting-acceptance' && executionPlanCurrent && (
                                <small className="eng-execution-plan-hint">
                                  「{executionPlanCurrent.title}」已通过独立验证，最终验收后才能继续下一项。
                                </small>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="eng-board">
                          {(
                            [
                              'requirements',
                              'solution',
                              'ready',
                              'developing',
                              'verifying',
                              'acceptance',
                              'done',
                              'blocked',
                            ] as const
                          ).map((stage) => {
                            const cards = project.features.filter((f) => f.stage === stage)
                            return (
                              <section key={stage} className="eng-board-column">
                                <h3>
                                  {stageLabels[stage]}
                                  <span>{cards.length}</span>
                                </h3>
                                {cards.map((f) => {
                                  const tasks = f.tasks ?? []
                                  const deleteDisabled =
                                    !!project.activity ||
                                    !deletableFeatureStages.includes(f.stage) ||
                                    !!executionPlan?.featureIds.includes(f.id)
                                  return (
                                    <div
                                      className={`eng-board-card-wrap ${f.stage === 'ready' ? 'selectable' : ''}`}
                                      key={f.id}
                                    >
                                      {f.stage === 'ready' && (
                                        <label className="eng-board-select">
                                          <input
                                            type="checkbox"
                                            checked={executionSelection.includes(f.id)}
                                            disabled={
                                              !!project.activity ||
                                              executionPlan?.status === 'running' ||
                                              executionPlan?.status === 'waiting-acceptance'
                                            }
                                            aria-label={`选择执行方案：${f.title}`}
                                            onChange={(event) =>
                                              setExecutionSelection((current) =>
                                                event.target.checked
                                                  ? [...current, f.id]
                                                  : current.filter((id) => id !== f.id),
                                              )
                                            }
                                          />
                                          <span>加入执行计划</span>
                                        </label>
                                      )}
                                      <button
                                        className="eng-board-card-delete"
                                        type="button"
                                        aria-label={`删除功能：${f.title}`}
                                        title={
                                          deleteDisabled
                                            ? '当前阶段或执行计划不允许删除'
                                            : `删除功能：${f.title}`
                                        }
                                        disabled={deleteDisabled}
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          if (!window.confirm(`确认删除「${f.title}」？删除后不会保留功能卡片。`)) return
                                          void perform(async () => {
                                            await api().deleteFeature(project.id, f.id)
                                            if (featureId === f.id) setFeatureId(null)
                                          }, '功能已删除。')
                                        }}
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                      <button
                                        className="eng-board-card"
                                        aria-label={`打开功能：${f.title}`}
                                        onClick={() => setFeatureId(f.id)}
                                      >
                                        <small>
                                          {f.module} · {scopeLabels[f.scope]}
                                        </small>
                                        <strong>{f.title}</strong>
                                        <span>
                                          <ListChecks size={12} />
                                          {tasks.filter((t) => t.done).length}/{tasks.length} 任务
                                        </span>
                                        {tasks.length ? (
                                          tasks.slice(0, 3).map((t) => (
                                            <em key={t.id}>
                                              {t.done ? '✓' : '○'} {t.title}
                                            </em>
                                          ))
                                        ) : (
                                          <em className="eng-board-card-empty">
                                            {stage === 'solution'
                                              ? '待生成实现方案与任务'
                                              : stage === 'blocked'
                                                ? '现场已保留，等待继续处理'
                                                : '当前阶段暂无实现任务'}
                                          </em>
                                        )}
                                      </button>
                                    </div>
                                  )
                                })}
                                {!cards.length && <p className="eng-board-empty">暂无功能</p>}
                              </section>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    {view === 'context' && (
                      <ContextWorkspace
                        project={project}
                        onAdd={() => setContextDraft({ id: null, title: '', content: '' })}
                        onEdit={(entry) =>
                          setContextDraft({ id: entry.id, title: entry.title, content: entry.content })
                        }
                        onFeature={setFeatureId}
                        onNavigate={navigate}
                      />
                    )}
                    {view === 'activity' && (
                      <div className="eng-activity">
                        <div className="eng-preview-bar">
                          <Field label="启动脚本">
                            <input
                              value={script}
                              onChange={(e) => setScript(e.target.value)}
                              placeholder="dev"
                            />
                          </Field>
                          {project.previewUrl ? (
                            <>
                              <button
                                className="ui-button primary"
                                onClick={() => void perform(() => api().openPreview(project.id))}
                              >
                                打开预览
                              </button>
                              <button
                                className="ui-button secondary"
                                onClick={() => void perform(() => api().stopPreview(project.id))}
                              >
                                停止预览
                              </button>
                              <small>{project.previewUrl}</small>
                            </>
                          ) : (
                            <button
                              className="ui-button secondary"
                              disabled={busy || !!project.activity}
                              onClick={() =>
                                void perform(
                                  () => api().startPreview(project.id, script),
                                  '本地页面已启动，可打开预览。',
                                )
                              }
                            >
                              <Play size={12} />
                              启动项目
                            </button>
                          )}
                        </div>
                        <EventList project={project} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          {section === 'appearance' && <WorkspaceSettings preferences={preferences} />}
        </div>
      </main>
      <footer className="statusbar">
        <span>
          <i className={connected ? 'connected' : ''} />
          {connected ? '桌面服务已连接' : '正在连接桌面服务'}
        </span>
        <span>
          {project
            ? `${project.features.length} 个功能 · ${project.context.length} 条上下文`
            : 'Coprojer · 本地工程智能体'}
          <em>支持批量规划 · 逐项验收</em>
        </span>
      </footer>
      <Overlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        title="快速查找"
        description="打开工作区或当前项目中的功能。"
      >
        <div className="workspace-command">
          <label className="workspace-search">
            <Search size={14} />
            <input
              autoFocus
              aria-label="查找工作区或功能"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="输入名称…"
            />
          </label>
          <div>
            {workspaceNavigation
              .filter((n) => n.label.includes(search))
              .map((n) => (
                <button
                  key={n.id}
                  disabled={!project && n.id !== 'overview'}
                  onClick={() => {
                    navigate(n.id)
                    setSearchOpen(false)
                  }}
                >
                  <n.icon size={14} />
                  {n.label}
                  <ArrowRight size={12} />
                </button>
              ))}
            {project?.features
              .filter((f) => `${f.title} ${f.module}`.toLowerCase().includes(search.toLowerCase()))
              .map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setFeatureId(f.id)
                    setSearchOpen(false)
                  }}
                >
                  <GitBranch size={14} />
                  <span>
                    {f.title}
                    <small>
                      {f.module} · {stageLabels[f.stage]}
                    </small>
                  </span>
                  <ArrowRight size={12} />
                </button>
              ))}
          </div>
        </div>
      </Overlay>
      <Overlay
        open={!!model}
        onClose={() => {
          if (!busy) setModel(null)
        }}
        title={model?.id ? '编辑模型' : '新增模型'}
        description="保存连接后，可在智能体中选择使用。"
        footer={
          <>
            <button className="ui-button secondary" disabled={busy} onClick={() => setModel(null)}>
              取消
            </button>
            <button
              className="ui-button primary"
              disabled={busy}
              onClick={() =>
                model &&
                void perform(async () => {
                  await api().saveModel(model)
                  setModel(null)
                }, '模型配置已保存。')
              }
            >
              保存模型
            </button>
          </>
        }
      >
        {model && (
          <div className="eng-form">
            <Field label="服务预设">
              <select
                defaultValue="custom"
                onChange={(e) => {
                  const presets: Record<string, string> = {
                    deepseek: 'https://api.deepseek.com',
                    glm: 'https://open.bigmodel.cn/api/paas/v4',
                    custom: '',
                  }
                  setModel({ ...model, baseUrl: presets[e.target.value], protocol: 'chat' })
                  setModelStatus('')
                }}
              >
                <option value="custom">自定义服务</option>
                <option value="deepseek">DeepSeek</option>
                <option value="glm">GLM / 智谱</option>
              </select>
            </Field>
            <Field label="显示名称">
              <input
                value={model.name}
                onChange={(e) => setModel({ ...model, name: e.target.value })}
                placeholder="例如：我的开发模型"
              />
            </Field>
            <Field label="服务地址 Base URL">
              <input
                value={model.baseUrl}
                onChange={(e) => {
                  setModel({ ...model, baseUrl: e.target.value })
                  setModelStatus('')
                }}
                placeholder="https://your-service.example/v1"
              />
            </Field>
            <Field label="接口类型">
              <select
                value={model.protocol}
                onChange={(e) => {
                  setModel({ ...model, protocol: e.target.value as Protocol })
                  setModelStatus('')
                }}
              >
                {Object.entries(protocolLabels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="API Key"
              hint={model.id ? '留空保留已保存的密钥。' : '密钥由系统加密，保存在本机。'}
            >
              <input
                type="password"
                autoComplete="off"
                value={model.apiKey ?? ''}
                onChange={(e) => setModel({ ...model, apiKey: e.target.value })}
                placeholder={model.id ? '已保存，留空不修改' : '填写服务提供的密钥'}
              />
            </Field>
            <Field label="模型标识">
              <div className="eng-input-action">
                <input
                  list="eng-model-options"
                  value={model.model}
                  onChange={(e) => setModel({ ...model, model: e.target.value })}
                  placeholder="填写或选择模型 ID"
                />
                <button
                  className="ui-button secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const values = await api().listModels(model)
                      setModelList(values)
                      setModelStatus(
                        values.length
                          ? `获取到 ${values.length} 个模型，可在模型标识中选择。`
                          : '服务未返回模型列表，可以手动填写。',
                      )
                    })
                  }
                >
                  获取列表
                </button>
                <datalist id="eng-model-options">
                  {modelList.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </div>
            </Field>
            <button
              className="ui-button secondary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setModelStatus(await api().testModel(model))
                })
              }
            >
              {busy ? <LoaderCircle size={13} /> : <Play size={12} />}测试连接
            </button>
            {modelStatus && (
              <p className="eng-inline-result" role="status">
                {modelStatus}
              </p>
            )}
            {error && (
              <p role="alert" className="eng-inline-error">
                {error}
              </p>
            )}
          </div>
        )}
      </Overlay>
      <Overlay
        open={!!agent}
        onClose={() => {
          if (!busy) setAgent(null)
        }}
        title={agent?.id ? '配置智能体' : '新增智能体'}
        footer={
          <>
            <button className="ui-button secondary" onClick={() => setAgent(null)}>
              取消
            </button>
            <button
              className="ui-button primary"
              disabled={busy}
              onClick={() =>
                agent &&
                void perform(async () => {
                  await api().saveAgent(agent)
                  setAgent(null)
                })
              }
            >
              保存智能体
            </button>
          </>
        }
      >
        {agent && (
          <div className="eng-form">
            <Field label="智能体名称">
              <input
                value={agent.name}
                onChange={(e) => setAgent({ ...agent, name: e.target.value })}
              />
            </Field>
            <Field label="职责类型">
              <select
                value={agent.role}
                disabled={!!agent.id}
                onChange={(e) =>
                  setAgent({
                    ...agent,
                    role: e.target.value as AgentConfig['role'],
                    tools: defaultAgentTools(e.target.value as AgentConfig['role']),
                  })
                }
              >
                <option value="developer">开发</option>
                <option value="reviewer">验证</option>
              </select>
            </Field>
            <Field label="使用模型">
              <select
                value={agent.modelId}
                onChange={(e) => setAgent({ ...agent, modelId: e.target.value })}
              >
                <option value="">选择模型</option>
                {state.models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="工作要求">
              <textarea
                rows={6}
                value={agent.instructions}
                onChange={(e) => setAgent({ ...agent, instructions: e.target.value })}
              />
            </Field>
            <fieldset className="eng-tool-options">
              <legend>可用工具</legend>
              {(Object.keys(toolLabels) as EngineeringToolName[]).map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={agent.tools.includes(name)}
                    disabled={
                      !['write_file', 'run_command'].includes(name) ||
                      (agent.role === 'reviewer' && name === 'write_file')
                    }
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        tools: e.target.checked
                          ? [...agent.tools, name]
                          : agent.tools.filter((t) => t !== name),
                      })
                    }
                  />
                  {toolLabels[name]}
                </label>
              ))}
              <small>基础读取工具始终可用，验证角色不提供文件修改工具。</small>
            </fieldset>
            <p className="eng-hint">
              开发角色可读写文件和运行工程命令；验证角色独立读取代码并执行检查。
            </p>
            {error && (
              <p role="alert" className="eng-inline-error">
                {error}
              </p>
            )}
          </div>
        )}
      </Overlay>
      <Overlay
        open={!!projectDraft}
        onClose={() => {
          if (!busy) setProjectDraft(null)
        }}
        title="新建工程项目"
        description="在选定父目录下创建一个全新的项目文件夹。"
        footer={
          <>
            <button className="ui-button secondary" onClick={() => setProjectDraft(null)}>
              取消
            </button>
            <button
              className="ui-button primary"
              disabled={busy}
              onClick={() =>
                projectDraft &&
                void perform(async () => {
                  const id = await api().createProject(projectDraft)
                  selectProject(id)
                  setProjectDraft(null)
                })
              }
            >
              创建工程
            </button>
          </>
        }
      >
        {projectDraft && (
          <div className="eng-form">
            <Field label="项目名称">
              <input
                value={projectDraft.name}
                onChange={(e) => setProjectDraft({ ...projectDraft, name: e.target.value })}
                placeholder="例如：个人记账"
              />
            </Field>
            <Field label="存放位置">
              <div className="eng-input-action">
                <input value={projectDraft.parent} readOnly placeholder="选择父目录" />
                <button
                  className="ui-button secondary"
                  onClick={() =>
                    void perform(async () => {
                      const parent = await window.desktop.selectFolder()
                      if (parent)
                        setProjectDraft((current) => (current ? { ...current, parent } : null))
                    })
                  }
                >
                  选择位置
                </button>
              </div>
            </Field>
            <Field label="项目目标">
              <textarea
                rows={4}
                value={projectDraft.brief}
                onChange={(e) => setProjectDraft({ ...projectDraft, brief: e.target.value })}
                placeholder="描述要解决的问题，以及希望交付的软件。"
              />
            </Field>
            <Field label="需求讨论模型">
              <select
                value={projectDraft.modelId}
                onChange={(e) => setProjectDraft({ ...projectDraft, modelId: e.target.value })}
              >
                <option value="">稍后配置</option>
                {state.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            {error && (
              <p role="alert" className="eng-inline-error">
                {error}
              </p>
            )}
          </div>
        )}
      </Overlay>
      <Overlay
        open={!!contextDraft}
        onClose={() => setContextDraft(null)}
        title="编辑共享上下文"
        footer={
          <>
            <button className="ui-button secondary" onClick={() => setContextDraft(null)}>
              取消
            </button>
            <button
              className="ui-button primary"
              disabled={busy}
              onClick={() =>
                project &&
                contextDraft &&
                void perform(async () => {
                  await api().saveContext(
                    project.id,
                    contextDraft.id,
                    contextDraft.title,
                    contextDraft.content,
                  )
                  setContextDraft(null)
                })
              }
            >
              保存上下文
            </button>
          </>
        }
      >
        {contextDraft && (
          <div className="eng-form">
            <Field label="标题">
              <input
                value={contextDraft.title}
                onChange={(e) => setContextDraft({ ...contextDraft, title: e.target.value })}
              />
            </Field>
            <Field label="内容">
              <textarea
                rows={12}
                value={contextDraft.content}
                onChange={(e) => setContextDraft({ ...contextDraft, content: e.target.value })}
              />
            </Field>
            {error && (
              <p role="alert" className="eng-inline-error">
                {error}
              </p>
            )}
          </div>
        )}
      </Overlay>
      {project && (feature || newFeature) && (
        <FeatureDrawer
          key={feature?.id ?? 'new'}
          project={project}
          feature={feature}
          state={state}
          busy={busy}
          error={error}
          onClose={() => {
            setFeatureId(null)
            setNewFeature(false)
          }}
          perform={perform}
          onSaved={(id) => {
            setNewFeature(false)
            setFeatureId(id)
          }}
        />
      )}
    </section>
  )
}

const eventLabels: Record<string, string> = {
  project: '项目',
  confirmed: '已确认',
  start: '开始',
  discussion: '需求讨论',
  model: '模型调用',
  tool: '工程操作',
  'tool-result': '操作结果',
  output: '命令输出',
  review: '验证回复',
  developer: '开发回复',
  verification: '独立验证',
  repair: '修复',
  acceptance: '待验收',
  accepted: '已验收',
  rejected: '退回修改',
  deleted: '已删除',
  error: '错误',
  stopped: '已停止',
  interrupted: '执行中断',
  preview: '本地预览',
  agents: '智能体',
  notice: '提示',
  plan: '方案',
}
function EventList({ project, featureId }: { project: Project; featureId?: string }) {
  return (
    <div className="eng-events">
      {project.events
        .filter((e) => !featureId || e.featureId === featureId)
        .slice(-150)
        .reverse()
        .map((e) => (
          <details key={e.id} className={`event-${e.kind}`}>
            <summary>
              <time>{new Date(e.at).toLocaleTimeString('zh-CN')}</time>
              <span className="eng-tag">{eventLabels[e.kind] ?? e.kind}</span>
              <span>{e.message.split('\n')[0].slice(0, 130)}</span>
            </summary>
            <pre>{e.message}</pre>
          </details>
        ))}
    </div>
  )
}

function mergedFeatureFor(project: Project, feature?: Feature): Feature | undefined {
  if (!feature) return undefined
  const mergedId = /历史记录[，,]\s*已合并至\s+([a-zA-Z0-9-]+)/.exec(feature.title)?.[1]
  if (!mergedId) return undefined
  const candidates = project.features.filter(
    (candidate) => candidate.id !== feature.id && candidate.id.startsWith(mergedId),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

function FeatureDrawer({
  project,
  feature,
  state,
  busy,
  error,
  onClose,
  perform,
  onSaved,
}: {
  project: Project
  feature?: Feature
  state: EngineeringState
  busy: boolean
  error: string
  onClose(): void
  perform(work: () => Promise<unknown>, success?: string): Promise<boolean>
  onSaved(id: string): void
}) {
  const [tab, setTab] = useState<'requirements' | 'plan' | 'results' | 'changes' | 'logs'>(
    feature?.stage === 'solution' || feature?.stage === 'ready'
      ? 'plan'
      : feature?.stage === 'acceptance' || feature?.stage === 'done'
        ? 'results'
        : feature && ['developing', 'verifying', 'blocked'].includes(feature.stage)
          ? 'logs'
          : 'requirements',
  )
  const [draft, setDraft] = useState<FeatureInput>(
    feature
      ? { ...feature }
      : {
          title: '',
          module: '',
          description: '',
          criteria: [],
          scope: 'discussion',
          dependencies: [],
          developerId: state.agents.find((a) => a.role === 'developer')?.id ?? '',
          reviewerId: state.agents.find((a) => a.role === 'reviewer')?.id ?? '',
        },
  )
  const [criteria, setCriteria] = useState(feature?.criteria.join('\n') ?? '')
  const [plan, setPlan] = useState(feature?.plan ?? ''),
    [tasks, setTasks] = useState(feature?.tasks.map((t) => t.title).join('\n') ?? '')
  const [reason, setReason] = useState('')
  useEffect(() => {
    setPlan(feature?.plan ?? '')
    setTasks(feature?.tasks.map((t) => t.title).join('\n') ?? '')
  }, [feature?.plan])
  const locked = !!feature && feature.stage !== 'requirements',
    running = !!project.activity,
    mergedTarget = mergedFeatureFor(project, feature)
  const save = async () => {
    const id = await api().saveFeature(project.id, feature?.id ?? null, {
      ...draft,
      criteria: splitLines(criteria),
    })
    onSaved(id)
    return id
  }
  const act = (operation: () => Promise<unknown>) => void perform(operation)
  return (
    <Overlay
      open
      onClose={onClose}
      drawer
      title={feature?.title || '添加功能'}
      description={
        feature
          ? `${feature.module} · ${stageLabels[feature.stage]} · ${scopeLabels[feature.scope]}`
          : '将一个可独立验收的功能加入项目。'
      }
      footer={
        <>
          <button className="ui-button secondary" onClick={onClose}>
            关闭
          </button>
          {!locked && (
            <>
              <button
                className="ui-button secondary"
                disabled={busy || (running && project.activity !== '整理需求与功能图')}
                onClick={() => act(save)}
              >
                保存需求
              </button>
            </>
          )}
          {feature?.stage === 'solution' && (
            <button
              className="ui-button primary"
              disabled={busy || running}
              onClick={() =>
                act(async () => {
                  await api().savePlan(project.id, feature.id, plan, splitLines(tasks))
                  await api().confirmPlan(project.id, feature.id)
                })
              }
            >
              确认方案
            </button>
          )}
          {feature && mergedTarget && feature.stage === 'blocked' ? (
            <button
              className="ui-button primary"
              disabled={busy || running}
              title={`此历史记录已合并至「${mergedTarget.title}」`}
              onClick={() => onSaved(mergedTarget.id)}
            >
              <ArrowRight size={12} />
              打开正式功能
            </button>
          ) : feature && ['ready', 'blocked'].includes(feature.stage) ? (
            <button
              className="ui-button primary"
              disabled={busy || running}
              onClick={() =>
                act(async () => {
                  await api().runFeature(project.id, feature.id)
                  setTab('logs')
                })
              }
            >
              <Play size={12} />
              {feature.stage === 'blocked' ? '继续执行' : '开始开发'}
            </button>
          ) : null}
          {feature?.stage === 'acceptance' && (
            <button
              className="ui-button primary"
              disabled={busy || running}
              onClick={() => act(() => api().accept(project.id, feature.id))}
            >
              <Check size={13} />
              验收通过
            </button>
          )}
        </>
      }
    >
      <div className="eng-feature-detail">
        <Tabs
          value={tab}
          onChange={setTab}
          label="功能详情"
          options={[
            { value: 'requirements', label: '需求' },
            { value: 'plan', label: '方案' },
            { value: 'results', label: '验收' },
            { value: 'changes', label: '修改' },
            { value: 'logs', label: '日志' },
          ]}
        />
        {error && (
          <p className="eng-inline-error" role="alert">
            {error}
          </p>
        )}
        {tab === 'requirements' && (
          <div className="eng-form">
            <Field label="功能名称">
              <input
                disabled={locked}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </Field>
            {!!project.targets?.length && (
              <Field label="所属子项目">
                <select
                  aria-label="功能所属子项目"
                  disabled={locked}
                  value={draft.targetId || ''}
                  onChange={(e) => setDraft({ ...draft, targetId: e.target.value })}
                >
                  <option value="">尚未分配</option>
                  {project.targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="eng-form-row">
              <Field label="所属模块">
                <input
                  disabled={locked}
                  value={draft.module}
                  onChange={(e) => setDraft({ ...draft, module: e.target.value })}
                  placeholder="例如：账目管理"
                />
              </Field>
              <Field label="功能范围">
                <select
                  disabled={locked}
                  value={draft.scope}
                  onChange={(e) =>
                    setDraft({ ...draft, scope: e.target.value as FeatureInput['scope'] })
                  }
                >
                  {Object.entries(scopeLabels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="需求说明">
              <textarea
                rows={4}
                disabled={locked}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>
            <Field label="验收标准" hint="每行一项，写明可验证的完成条件。">
              <textarea
                rows={5}
                disabled={locked}
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
              />
            </Field>
            <div className="eng-form-row">
              {(['developer', 'reviewer'] as const).map((role) => (
                <Field key={role} label={role === 'developer' ? '开发智能体' : '验证智能体'}>
                  <select
                    disabled={
                      running ||
                      busy ||
                      feature?.stage === 'done' ||
                      feature?.stage === 'acceptance'
                    }
                    value={role === 'developer' ? draft.developerId : draft.reviewerId}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [role === 'developer' ? 'developerId' : 'reviewerId']: e.target.value,
                      })
                    }
                  >
                    <option value="">选择智能体</option>
                    {state.agents
                      .filter((a) => a.role === role)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </Field>
              ))}
            </div>
            {project.features.some((f) => f.id !== feature?.id) && (
              <Field label="前置依赖">
                <select
                  multiple
                  disabled={locked}
                  value={draft.dependencies}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      dependencies: Array.from(e.target.selectedOptions).map((o) => o.value),
                    })
                  }
                >
                  {project.features
                    .filter((f) => f.id !== feature?.id)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.title}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            {locked && (
              <p className="eng-hint">
                已确认需求作为固定验收依据。需要补充目标时，可以新增功能记录。
              </p>
            )}
          </div>
        )}
        {tab === 'requirements' &&
          locked &&
          feature &&
          !['done', 'acceptance'].includes(feature.stage) && (
            <button
              className="ui-button secondary eng-assignment-save"
              disabled={busy || running}
              onClick={() =>
                act(() =>
                  api().assignAgents(project.id, feature.id, draft.developerId, draft.reviewerId),
                )
              }
            >
              保存执行智能体
            </button>
          )}
        {tab === 'plan' && (
          <div className="eng-form">
            {feature?.stage === 'solution' && (
              <button
                className="ui-button secondary"
                disabled={busy || running}
                onClick={() => act(() => api().generatePlan(project.id, feature.id))}
              >
                <Bot size={13} />
                {feature.plan ? '重新生成方案' : '生成实现方案'}
              </button>
            )}
            <Field label="实现方案">
              <textarea
                rows={12}
                value={plan}
                disabled={feature?.stage !== 'solution' || running}
                onChange={(e) => setPlan(e.target.value)}
                placeholder="需求确认后，生成或手动填写实现方案。"
              />
            </Field>
            <Field label="实现任务" hint="每行一个任务。">
              <textarea
                rows={5}
                value={tasks}
                disabled={feature?.stage !== 'solution' || running}
                onChange={(e) => setTasks(e.target.value)}
              />
            </Field>
            {feature?.stage === 'solution' && (
              <button
                className="ui-button secondary"
                disabled={busy || running}
                onClick={() =>
                  act(() => api().savePlan(project.id, feature.id, plan, splitLines(tasks)))
                }
              >
                保存方案
              </button>
            )}
          </div>
        )}
        {tab === 'results' && (
          <div className="eng-results">
            {feature?.results.length ? (
              feature.results.map((r, i) => (
                <article key={i}>
                  <h3 className={r.passed ? 'passed' : 'failed'}>
                    {r.passed ? <CircleCheck size={14} /> : <Circle size={13} />}
                    {r.criterion}
                  </h3>
                  <p>{r.evidence}</p>
                </article>
              ))
            ) : (
              <Empty title="等待独立验证" detail="实际测试与验收依据将在这里汇总。" />
            )}
            {feature && (
              <p className="eng-hint">
                自动修复：{feature.repairRound} / 3 轮 · {stageLabels[feature.stage]}
              </p>
            )}
            {feature?.feedback && (
              <details>
                <summary>上次未解决的问题</summary>
                <pre>{feature.feedback}</pre>
              </details>
            )}
            {feature?.stage === 'acceptance' && (
              <>
                <Field label="退回修改的原因">
                  <textarea
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="描述试用中发现的问题。"
                  />
                </Field>
                <button
                  className="ui-button secondary"
                  disabled={!reason.trim() || busy}
                  onClick={() => act(() => api().reject(project.id, feature.id, reason))}
                >
                  退回修改
                </button>
              </>
            )}
          </div>
        )}
        {tab === 'changes' && (
          <div className="eng-changes">
            {project.changes
              .filter((c) => c.featureId === feature?.id)
              .map((c) => (
                <details key={c.path}>
                  <summary>
                    <FileCode2 size={13} />
                    {c.path}
                    <span>{c.after === null ? '删除' : c.before === null ? '新增' : '修改'}</span>
                  </summary>
                  <h4>修改前</h4>
                  <pre>{c.before ?? '新文件'}</pre>
                  <h4>修改后</h4>
                  <pre>{c.after ?? '文件已删除'}</pre>
                </details>
              ))}
            {!project.changes.some((c) => c.featureId === feature?.id) && (
              <Empty title="还没有代码变化" detail="智能体修改文件后，这里会保留前后内容。" />
            )}
          </div>
        )}
        {tab === 'logs' && <EventList project={project} featureId={feature?.id} />}
      </div>
    </Overlay>
  )
}
