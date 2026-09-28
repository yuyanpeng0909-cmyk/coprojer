import { Fragment } from 'react'
import type { ResearchTab } from './RequirementsWorkspace'
import {
  Activity,
  ArrowLeft,
  Bot,
  ChevronDown,
  Folder,
  GitBranch,
  LayoutDashboard,
  ListTodo,
  Plus,
  Settings2,
  BookOpen,
  SlidersHorizontal,
} from 'lucide-react'
import type { EngineeringState, Project } from '../../../shared/engineering'
import { deliveryCount, deliveryFeatures, deliveryStages, isStageRunning, type DeliveryStage, type DeliveryView } from './delivery'
export const workspaceNavigation = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard },
  { id: 'map', label: '需求与功能图', icon: GitBranch },
  { id: 'board', label: '任务看板', icon: ListTodo },
  { id: 'context', label: '共享上下文', icon: BookOpen },
  { id: 'activity', label: '执行记录', icon: Activity },
] as const
export type ProjectView = (typeof workspaceNavigation)[number]['id'] | DeliveryView
export type WorkspaceSection = 'projects' | 'models' | 'agents' | 'appearance' | 'onboarding'
export default function WorkspaceSidebar({
  researchTab,
  onResearchTab,
  state,
  project,
  view,
  section,
  collapsed,
  onSelect,
  onCreate,
  onHome,
  onNavigate,
  onSection,
  onStage,
}: {
  researchTab: ResearchTab
  onResearchTab(tab: ResearchTab): void
  state: EngineeringState
  project?: Project
  view: ProjectView
  section: WorkspaceSection
  collapsed: boolean
  onSelect(id: string): void
  onCreate(): void
  onHome(): void
  onNavigate(view: ProjectView): void
  onSection(section: WorkspaceSection): void
  onStage(stage: DeliveryStage): void
}) {
  const features = project ? deliveryFeatures(project) : []
  const completed = features.filter((f) => f.stage === 'done').length
  const selectedStage = section !== 'projects' ? undefined : view === 'map'
    ? researchTab === 'requirements' ? 'discussion' : researchTab === 'prototype' ? 'prototype' : undefined
    : view
  const countLabels: Record<DeliveryStage, string> = { discussion: '条需求讨论', prototype: '个原型版本', specification: '项需求规格', plans: '项待准备或确认方案', development: '项待开发或开发中', verification: '项验证中', acceptance: '项待验收' }
  return (
    <aside className={`studio-sidebar ${collapsed ? 'collapsed' : ''}`}>
      {project ? <div className="project-switcher">
        <span className="project-monogram">
          {project ? project.name.slice(0, 1).toUpperCase() : <Folder size={16} />}
        </span>
        <label>
          <span>当前项目</span>
          <select
            aria-label="切换工程项目"
            value={project?.id ?? ''}
            onChange={(e) => onSelect(e.target.value)}
          >
            <option value="" disabled>
              选择或创建项目
            </option>
            {state.projects.filter((p) => !p.archivedAt || p.id === project?.id).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <ChevronDown size={13} />
      </div> : (
        <div className="project-library-brand">
          <span className="project-monogram"><Folder size={16} /></span>
          <div><strong>我的项目</strong><small>{state.projects.filter(p => !p.archivedAt).length} 个活跃项目</small></div>
        </div>
      )}
      <button
        className="create-project-button"
        aria-label="新建工程项目"
        title="新建项目 · Ctrl N"
        onClick={onCreate}
      >
        <Plus size={14} />
        <span className="nav-label">新建项目</span>
        <kbd>Ctrl N</kbd>
      </button>
      <div className="studio-sidebar-scroll">
        <nav className="project-home-nav" aria-label="项目管理导航">
          <button
            aria-label={project ? '返回项目管理' : '项目管理'}
            title={project ? '返回项目管理' : '项目管理'}
            aria-current={!project && section === 'projects' ? 'page' : undefined}
            className={!project && section === 'projects' ? 'selected' : ''}
            onClick={onHome}
          >
            {project ? <ArrowLeft size={15} /> : <Folder size={15} />}
            <span className="nav-label">{project ? '返回项目管理' : '项目管理'}</span>
          </button>
          <button aria-label="新手入门" title="新手入门" aria-current={section === 'onboarding' ? 'page' : undefined} className={section === 'onboarding' ? 'selected' : ''} onClick={() => onSection('onboarding')}><BookOpen size={15} /><span className="nav-label">新手入门</span></button>
        </nav>
        {project && <>
        <div className="sidebar-section-label">项目工作区</div>
        <nav aria-label="项目导航">
          {workspaceNavigation.map(({ id, label, icon: Icon }) => (
            <Fragment key={id}>
              <button
                aria-label={label}
                title={label}
                aria-current={section === 'projects' && view === id ? 'page' : undefined}
                disabled={!project && id !== 'overview'}
                className={section === 'projects' && view === id ? 'selected' : ''}
                onClick={() => onNavigate(id)}
              >
                <Icon size={15} />
                <span className="nav-label">{label}</span>
                {id === 'board' && !!project?.features.length && (
                  <span className="nav-count">{features.length}</span>
                )}
              </button>
              {id === 'map' && section === 'projects' && view === 'map' && (
                <div className="sidebar-research-tabs">
                  {(
                    [
                      ['requirements', '需求'],
                      ['map', '功能图'],
                      ['prototype', '原型'],
                      ['projects', '子项目'],
                    ] as const
                  ).map(([tab, label]) => (
                    <button
                      key={tab}
                      aria-label={label + '子模块'}
                      className={researchTab === tab ? 'selected' : ''}
                      onClick={() => onResearchTab(tab)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-lifecycle">
          <div className="sidebar-section-label">
            交付阶段 <span>开发串行</span>
          </div>
          <ol>
            {deliveryStages.map(
              ({ id, label }, index) => (
                <li key={id}>
                  <button
                    disabled={!project}
                    aria-label={label}
                    title={`${label} · ${deliveryCount(project, id)} ${countLabels[id]} · 仅导航`}
                    aria-current={selectedStage === id ? 'page' : undefined}
                    className={`${selectedStage === id ? 'viewing' : ''} ${isStageRunning(project, id) ? 'running' : ''}`}
                    onClick={() => onStage(id)}
                  >
                    <span className="lifecycle-step">{index + 1}</span>
                    <span>{label}</span>
                    <span className="lifecycle-count" aria-hidden="true">{deliveryCount(project, id)}</span>
                    {isStageRunning(project, id) && <i aria-label="正在执行" />}
                  </button>
                </li>
              ),
            )}
          </ol>
          {project && (
            <div className="sidebar-completion">
              <div>
                <span>已验收</span>
                <strong>
                  {completed}
                  <em> / {features.length}</em>
                </strong>
              </div>
              <div
                role="progressbar"
                aria-label="项目验收进度"
                aria-valuenow={
                  features.length
                    ? Math.round((completed / features.length) * 100)
                    : 0
                }
                aria-valuemin={0}
                aria-valuemax={100}
                className="eng-mini-progress"
              >
                <i
                  style={{
                    width: `${features.length ? (completed / features.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
        </>}
      </div>
      <nav className="studio-config" aria-label="工作空间设置">
        {[
          { id: 'models', label: '模型连接', icon: Settings2, count: state.models.length },
          { id: 'agents', label: '智能体', icon: Bot, count: state.agents.length },
          { id: 'appearance', label: '外观与偏好', icon: SlidersHorizontal },
        ].map(({ id, label, icon: Icon, count }) => (
          <button
            aria-label={label}
            title={label}
            key={id}
            className={section === id ? 'selected' : ''}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => onSection(id as WorkspaceSection)}
          >
            <Icon size={15} />
            <span className="nav-label">{label}</span>
            {count !== undefined && <span className="nav-count">{count}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-footnote">
        <span className="local-workspace-dot" />
        本地工作空间
      </div>
    </aside>
  )
}
