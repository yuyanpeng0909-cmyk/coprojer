import { Fragment } from 'react'
import type { ResearchTab } from './RequirementsWorkspace'
import {
  Activity,
  Bot,
  Check,
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
export const workspaceNavigation = [
  { id: 'overview', label: '工作台', icon: LayoutDashboard },
  { id: 'map', label: '需求与功能图', icon: GitBranch },
  { id: 'board', label: '任务看板', icon: ListTodo },
  { id: 'context', label: '共享上下文', icon: BookOpen },
  { id: 'activity', label: '执行记录', icon: Activity },
] as const
export type ProjectView = (typeof workspaceNavigation)[number]['id']
export type WorkspaceSection = 'projects' | 'models' | 'agents' | 'appearance'
export default function WorkspaceSidebar({
  researchTab,
  onResearchTab,
  state,
  project,
  view,
  section,
  collapsed,
  phase,
  onSelect,
  onCreate,
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
  phase: number
  onSelect(id: string): void
  onCreate(): void
  onNavigate(view: ProjectView): void
  onSection(section: WorkspaceSection): void
  onStage(index: number): void
}) {
  const completed = project?.features.filter((f) => f.stage === 'done').length ?? 0
  return (
    <aside className={`studio-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="project-switcher">
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
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <ChevronDown size={13} />
      </div>
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
                  <span className="nav-count">{project.features.length}</span>
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
            {['需求讨论', '需求确认', '方案与任务', '代码开发', '独立验证', '最终验收'].map(
              (label, index) => (
                <li key={label}>
                  <button
                    disabled={!project}
                    className={
                      project && index === phase
                        ? 'current'
                        : project && index < phase
                          ? 'complete'
                          : ''
                    }
                    onClick={() => onStage(index)}
                  >
                    <span className="lifecycle-step">
                      {project && index < phase ? <Check size={10} /> : index + 1}
                    </span>
                    <span>{label}</span>
                    {project && index === phase && <i />}
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
                  <em> / {project.features.length}</em>
                </strong>
              </div>
              <div
                role="progressbar"
                aria-label="项目验收进度"
                aria-valuenow={
                  project.features.length
                    ? Math.round((completed / project.features.length) * 100)
                    : 0
                }
                aria-valuemin={0}
                aria-valuemax={100}
                className="eng-mini-progress"
              >
                <i
                  style={{
                    width: `${project.features.length ? (completed / project.features.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
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
