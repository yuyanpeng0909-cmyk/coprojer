import { createHash } from 'node:crypto'
import { agentRoleLabels, defaultAgentTools, type AgentConfig, type AgentRole, type AssistantChatEntry } from '../../shared/engineering'
import type { AssistantSession, AssistantTeamMember, AssistantTeamPlan } from '../../shared/assistant'
import { EngineeringStore, now, uid } from './store'
import { assistantConnection, assistantUsage } from './general-assistant'
import { complete, parseJson, type Connection } from './model'

const roles = Object.keys(agentRoleLabels) as AgentRole[]
export class AssistantTeam {
  private requests = new Map<string, AbortController>()
  constructor(private store: EngineeringStore, private connection: (id: string) => Connection) {}
  private get workspace() { return this.store.data.assistant! }
  private session(id: string) {
    const session = this.workspace.sessions.find(s => s.id === id)
    if (!session) throw new Error('会话已不存在。')
    if (session.projectId) this.store.project(session.projectId)
    return session
  }
  private fingerprint(session: AssistantSession) {
    const p = session.projectId ? this.store.project(session.projectId) : undefined
    return createHash('sha256').update(JSON.stringify({
      models: this.store.data.models.map(m => ({ id: m.id, model: m.model, protocol: m.protocol, baseUrl: m.baseUrl })),
      agents: this.store.data.agents.filter(a => !a.ownerProjectId || a.ownerProjectId === p?.id),
      defaultTeamAgentIds: this.store.data.defaultTeamAgentIds,
      project: p ? { id: p.id, brief: p.brief, plannerId: p.plannerId, designerId: p.designerId, discussionModelId: p.discussionModelId, designModelId: p.designModelId, teamAgentIds: p.teamAgentIds, features: p.features.map(f => ({ id: f.id, developerId: f.developerId, reviewerId: f.reviewerId, stage: f.stage })) } : this.store.data.projects.map(p => ({ id: p.id, plannerId: p.plannerId, designerId: p.designerId, discussionModelId: p.discussionModelId, designModelId: p.designModelId, teamAgentIds: p.teamAgentIds, features: p.features.map(f => ({ developerId: f.developerId, reviewerId: f.reviewerId })) })),
    })).digest('hex')
  }
  private validate(members: AssistantTeamMember[], session: AssistantSession): AssistantTeamMember[] {
    if (!Array.isArray(members) || members.length < 4 || members.length > 12) throw new Error('请保留四类必要职责，团队总数为 4–12 位。更多成员不代表会并行执行。')
    const result = members.map((m, index) => {
      if (!m || !roles.includes(m.role) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80 || typeof m.reason !== 'string' || !m.reason.trim() || m.reason.length > 1500) throw new Error('团队成员名称、职责或推荐理由无效。')
      if (!this.store.data.models.some(model => model.id === m.modelId)) throw new Error('方案只能使用已接入的有效模型。')
      const source = m.sourceAgentId ? this.store.data.agents.find(a => a.id === m.sourceAgentId && a.role === m.role && (!a.ownerProjectId || a.ownerProjectId === session.projectId)) : undefined
      if (m.sourceAgentId && !source) throw new Error('方案引用的智能体已不存在或不属于此项目。')
      return { key: typeof m.key === 'string' && m.key ? m.key.slice(0, 100) : 'member-' + index, role: m.role, name: m.name.trim(), modelId: m.modelId, sourceAgentId: source?.id, previousModelId: source?.modelId, reason: m.reason.trim() }
    })
    if (new Set(result.map(m => m.key)).size !== result.length) throw new Error('团队成员标识重复。')
    const sources = result.flatMap(m => m.sourceAgentId ? [m.sourceAgentId] : [])
    if (new Set(sources).size !== sources.length) throw new Error('同一实例只能在方案中出现一次；新增成员请选新建实例。')
    for (const role of roles) if (!result.some(m => m.role === role)) throw new Error('缺少必要职责：' + agentRoleLabels[role])
    for (const role of ['planner', 'designer']) if (result.filter(m => m.role === role).length !== 1) throw new Error('规划和原型前端各保留一位；额外成员用于开发或独立验证。')
    return result
  }
  private affected(members: AssistantTeamMember[], session: AssistantSession) {
    if (session.projectId) return [this.store.project(session.projectId).name]
    const ids = new Set(members.flatMap(m => m.sourceAgentId ? [m.sourceAgentId] : []))
    return this.store.data.projects.filter(p => ids.has(p.plannerId || '') || ids.has(p.designerId || '') || p.features.some(f => ids.has(f.developerId) || ids.has(f.reviewerId))).map(p => p.name)
  }
  stop = (id: string) => { this.requests.get(id)?.abort('user') }
  recommendAssistantTeam = async (sessionId: string, preference: string, modelId?: string): Promise<AssistantTeamPlan> => {
    const session = this.session(sessionId)
    if (session.messages.some(m => m.status === 'pending')) throw new Error('通用助手正在回复，请稍后生成方案。')
    if (typeof preference !== 'string' || preference.length > 8000) throw new Error('请将配置要求控制在 8000 字以内。')
    const connection = assistantConnection(this.store, this.connection, modelId), fingerprint = this.fingerprint(session)
    const p = session.projectId ? this.store.project(session.projectId) : undefined
    const agents = this.store.data.agents.filter(a => !a.ownerProjectId || a.ownerProjectId === p?.id).map(a => ({ id: a.id, name: a.name, role: a.role, modelId: a.modelId, projectOwned: !!a.ownerProjectId }))
    const entry: AssistantChatEntry = { id: uid(), role: 'assistant', text: '', at: now(), status: 'pending', requestKind: 'team', usage: assistantUsage(connection) }, length = session.messages.length
    const previous = { title: session.title, updatedAt: session.updatedAt, draft: session.draft, modelId: session.modelId }
    session.messages.push({ id: uid(), role: 'user', text: preference.trim() || '请根据当前配置推荐智能体组合与模型。', status: 'complete', at: now() }, entry)
    session.updatedAt = now(); session.draft = ''; session.modelId = ''
    if (!length && session.title === '新会话') session.title = p ? p.name + ' · 团队配置' : '全局团队配置'
    const controller = new AbortController(); this.requests.set(sessionId, controller)
    try { this.store.save() } catch (error) { session.messages.splice(length); Object.assign(session, previous); this.requests.delete(sessionId); throw error }
    try {
      const reply = await complete(connection, 'ASSISTANT_TEAM_PLAN：为 Coprojer 推荐可落地的团队。只使用给出的已接入 modelId；职责只有 planner/designer/developer/reviewer。planner 和 designer 各一位；developer 和 reviewer 各至少一位，总共 4–12 位。按项目目标和实际分工推荐最少必要数量，人数不等于并行能力。信息不足沿用现有型号并说明；不要猜测价格、工具能力或质量排名。项目方案会隔离创建或复用项目专用实例，不复制共享实例的专属技能；全局方案会修改明确引用的共享成员。已有成员可设置 sourceAgentId，新成员省略。只返回 JSON {"members":[{"key":"unique","role":"planner","name":"任务规划","modelId":"已接入ID","sourceAgentId":"可选现有ID","reason":"职责分工、型号依据与不确定性"}]}。不要执行任何修改。', [{ role: 'user', content: this.store.redact(JSON.stringify({ preference, project: p ? { name: p.name, brief: p.brief, features: p.features.map(f => ({ title: f.title, description: f.description.slice(0, 1000), stage: f.stage })), teamAgentIds: p.teamAgentIds } : null, agents, models: this.store.data.models.map(m => ({ id: m.id, model: m.model, protocol: m.protocol })), memories: this.workspace.memories.filter(m => !m.projectId || m.projectId === p?.id).map(m => m.text) })) }], [], AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]))
      if (controller.signal.aborted) throw new Error('方案生成已停止。')
      if (this.fingerprint(session) !== fingerprint) throw new Error('配置已变化，请重新生成团队方案。')
      const members = this.validate(parseJson(reply.text).members, session)
      const plan: AssistantTeamPlan = { id: uid(), sessionId, projectId: session.projectId, createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), fingerprint, status: 'preview', members, usage: assistantUsage(connection, reply), affectedProjects: this.affected(members, session) }
      this.workspace.plans.push(plan); entry.planId = plan.id; entry.usage = plan.usage; entry.text = '团队方案已准备好。请检查成员、型号与生效范围，确认后应用。'; entry.status = 'complete'
      return structuredClone(plan)
    } catch (error) {
      entry.status = controller.signal.aborted ? 'stopped' : 'error'; entry.error = controller.signal.aborted ? '方案生成已停止，可重新生成。' : this.store.redact(error instanceof Error ? error.message : String(error)); throw new Error(entry.error)
    } finally { this.requests.delete(sessionId); session.updatedAt = now(); this.store.save() }
  }
  private preview(id: string) {
    const plan = this.workspace.plans.find(p => p.id === id)
    if (!plan) throw new Error('方案已不存在。')
    const session = this.session(plan.sessionId)
    if (plan.status !== 'preview' || Date.parse(plan.expiresAt) < Date.now() || plan.fingerprint !== this.fingerprint(session)) throw new Error('方案已过期、已应用或配置发生变化，请重新生成。')
    return { plan, session }
  }
  updateAssistantTeamPlan = (id: string, members: AssistantTeamMember[]) => {
    const { plan, session } = this.preview(id), previous = { members: plan.members, affectedProjects: plan.affectedProjects }
    plan.members = this.validate(members, session); plan.affectedProjects = this.affected(plan.members, session)
    try { this.store.save() } catch (error) { Object.assign(plan, previous); throw error }
  }
  applyAssistantTeamPlan = (id: string) => {
    const applied = this.workspace.plans.find(p => p.id === id)
    if (applied?.status === 'applied') return
    const { plan, session } = this.preview(id), members = this.validate(plan.members, session)
    const project = session.projectId ? this.store.project(session.projectId) : undefined
    const affected = project ? [project] : this.store.data.projects
    if (affected.some(p => p.activity || p.designActivity || p.roundtable?.status === 'running' || p.prd?.status === 'generating')) throw new Error('相关项目正在执行，请等待任务结束后应用配置。')
    const previousAgents = this.store.data.agents, previousDefaults = this.store.data.defaultTeamAgentIds, previousProjects = new Map(affected.map(p => [p, structuredClone(p)])), previousPlan = { ...plan }
    const next = [...previousAgents], assigned: AgentConfig[] = []
    for (const member of members) {
      const source = next.find(a => a.id === member.sourceAgentId)
      const reusable = source && (project ? source.ownerProjectId === project.id : !source.ownerProjectId)
      const agent: AgentConfig = reusable ? { ...source, name: member.name, modelId: member.modelId } : { id: uid(), ownerProjectId: project?.id, name: member.name, role: member.role, modelId: member.modelId, instructions: source?.instructions || '负责' + agentRoleLabels[member.role] + '，遵循项目要求并提供真实结果。', tools: source ? [...source.tools] : defaultAgentTools(member.role), skillIds: [] }
      if (reusable) next[next.findIndex(a => a.id === agent.id)] = agent; else next.push(agent)
      assigned.push(agent)
    }
    this.store.data.agents = next
    if (project) {
      project.teamAgentIds = assigned.map(a => a.id)
      const planner = assigned.find(a => a.role === 'planner')!, designer = assigned.find(a => a.role === 'designer')!
      project.plannerId = planner.id; project.designerId = designer.id; project.discussionModelId = planner.modelId; project.designModelId = designer.modelId
      const developers = assigned.filter(a => a.role === 'developer'), reviewers = assigned.filter(a => a.role === 'reviewer')
      project.features.forEach((f, i) => { if (f.stage !== 'done') { f.developerId = developers[i % developers.length].id; f.reviewerId = reviewers[i % reviewers.length].id } })
    } else {
      this.store.data.defaultTeamAgentIds = assigned.map(a => a.id)
      const oldModels = new Map(previousAgents.map(a => [a.id, a.modelId]))
      for (const p of affected) {
        const planner = assigned.find(a => a.id === p.plannerId), designer = assigned.find(a => a.id === p.designerId)
        if (planner && p.discussionModelId === oldModels.get(planner.id)) p.discussionModelId = planner.modelId
        if (designer && p.designModelId === oldModels.get(designer.id)) p.designModelId = designer.modelId
      }
    }
    plan.status = 'applied'; plan.appliedAt = now(); plan.result = project ? '已为「' + project.name + '」应用 ' + assigned.length + ' 位项目专用成员；其他项目配置未改变。' : '已应用全局成员配置，并设为新项目默认团队。独立设置的项目讨论型号保持原选择；影响范围见此方案。'
    try { this.store.save() } catch (error) {
      this.store.data.agents = previousAgents; this.store.data.defaultTeamAgentIds = previousDefaults
      for (const [p, original] of previousProjects) {
        for (const key of ['teamAgentIds', 'plannerId', 'designerId', 'discussionModelId', 'designModelId'] as const) if (!(key in original)) delete p[key]
        Object.assign(p, original)
      }
      delete plan.appliedAt; delete plan.result; Object.assign(plan, previousPlan)
      throw error
    }
  }
}
