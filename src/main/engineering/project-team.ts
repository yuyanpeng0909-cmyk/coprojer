import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentConfig, Project } from '../../shared/engineering'
import { builtinSkills, ownSkill } from '../../shared/agents'
import { EngineeringStore, uid } from './store'
import { copySkillPackage } from './skills'

export function assertTeamIdle(p: Project) {
  if (p.activity || p.designActivity || p.roundtable?.status === 'running' || p.prd?.status === 'generating' || p.executionPlan?.status === 'running') throw new Error('项目正在执行，请结束当前任务后调整团队。')
}

// Copies are instance-owned, including files. The caller commits or rolls back the entire operation.
export function cloneTeamAgent(store: EngineeringStore, source: AgentConfig, projectId: string, createdRoots: string[]): AgentConfig {
  const agent: AgentConfig = { ...structuredClone(source), id: uid(), ownerProjectId: projectId, templateId: source.templateId || source.id, skillIds: [] }
  const owned = store.skills().filter(s => s.ownerAgentId === source.id)
  const skills = owned.length ? owned : builtinSkills.filter(s => s.roles.includes(source.role)).map(s => ownSkill(s, source.id))
  for (const skill of skills) {
    const copy = ownSkill(skill, agent.id)
    if (skill.packageRoot) {
      const root = join(dirname(store.path), 'agent-skills', agent.id, uid())
      mkdirSync(root, { recursive: true }); createdRoots.push(root)
      copySkillPackage(skill.packageRoot, root); copy.packageRoot = root
    }
    store.data.skills = [...store.skills(), copy]
    if (source.skillIds?.includes(skill.id)) agent.skillIds!.push(copy.id)
  }
  return agent
}

export class ProjectTeam {
  constructor(private store: EngineeringStore) {}
  private transaction<T>(work: (roots: string[]) => T): T {
    const previousAgents = [...this.store.data.agents], previousSkills = this.store.data.skills, roots: string[] = []
    const previousProjects = this.store.data.projects.map(p => ({ project: p, teamAgentIds: p.teamAgentIds, plannerId: p.plannerId, designerId: p.designerId, features: p.features.map(f => ({ feature: f, developerId: f.developerId, reviewerId: f.reviewerId })) }))
    try { const result = work(roots); this.store.save(); return result }
    catch (error) {
      this.store.data.agents = previousAgents; this.store.data.skills = previousSkills
      for (const p of previousProjects) {
        p.project.teamAgentIds = p.teamAgentIds; p.project.plannerId = p.plannerId; p.project.designerId = p.designerId
        for (const f of p.features) { f.feature.developerId = f.developerId; f.feature.reviewerId = f.reviewerId }
      }
      for (const root of roots) rmSync(root, { recursive: true, force: true }); throw error
    }
  }
  initialize(project: Project, roots: string[]) {
    const shared = this.store.data.agents.filter(a => !a.ownerProjectId)
    const selected = shared.filter(a => this.store.data.defaultTeamAgentIds?.includes(a.id))
    for (const role of ['planner', 'designer', 'developer', 'reviewer'] as const) if (!selected.some(a => a.role === role)) {
      const source = shared.find(a => a.role === role); if (source) selected.push(source)
    }
    const members = selected.map(a => cloneTeamAgent(this.store, a, project.id, roots))
    this.store.data.agents.push(...members)
    project.teamAgentIds = members.map(a => a.id)
    project.plannerId = members.find(a => a.role === 'planner')?.id
    project.designerId = members.find(a => a.role === 'designer')?.id
    project.designModelId = members.find(a => a.role === 'designer')?.modelId
  }
  addProjectAgent = (projectId: string, sourceId: string) => this.transaction(roots => {
    const p = this.store.project(projectId); assertTeamIdle(p)
    const source = this.store.data.agents.find(a => a.id === sourceId && !a.ownerProjectId)
    if (!source) throw new Error('请选择共享模板。')
    const agent = cloneTeamAgent(this.store, source, p.id, roots)
    this.store.data.agents.push(agent)
    p.teamAgentIds = [...new Set([...(p.teamAgentIds || []), agent.id])]
    return agent.id
  })
  isolateProjectTeam = (projectId: string) => this.transaction(roots => {
    const p = this.store.project(projectId); assertTeamIdle(p)
    const ids = new Set([...(p.teamAgentIds || []), p.plannerId, p.designerId, ...p.features.filter(f => f.stage !== 'done').flatMap(f => [f.developerId, f.reviewerId])].filter((id): id is string => !!id))
    for (const role of ['planner', 'designer', 'developer', 'reviewer'] as const) if (![...ids].some(id => this.store.data.agents.some(a => a.id === id && a.role === role))) {
      const source = this.store.data.agents.find(a => a.role === role && !a.ownerProjectId); if (source) ids.add(source.id)
    }
    const mapping = new Map<string, string>()
    for (const id of ids) {
      const source = this.store.data.agents.find(a => a.id === id && !a.ownerProjectId)
      if (source) {
        const agent = cloneTeamAgent(this.store, source, p.id, roots)
        this.store.data.agents.push(agent); mapping.set(id, agent.id)
      }
    }
    const assigned = [...ids].map(id => mapping.get(id) || id)
    p.teamAgentIds = [...new Set(assigned)]
    p.plannerId = mapping.get(p.plannerId || '') || p.plannerId || assigned.find(id => this.store.data.agents.find(a => a.id === id)?.role === 'planner')
    p.designerId = mapping.get(p.designerId || '') || p.designerId || assigned.find(id => this.store.data.agents.find(a => a.id === id)?.role === 'designer')
    for (const f of p.features) if (f.stage !== 'done') {
      f.developerId = mapping.get(f.developerId) || f.developerId
      f.reviewerId = mapping.get(f.reviewerId) || f.reviewerId
    }
  })
}
