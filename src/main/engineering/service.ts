import { shell } from 'electron'
import { AliyunImport } from './aliyun-import'
import { ModelCheckRegistry } from './model-checks'
import { ModelTrafficMonitor } from './model-traffic'
import type { TrafficQuery } from '../../shared/model-traffic'
import type { OnboardingPatch } from '../../shared/onboarding'
import { RequirementsWorkspace } from './requirements'
import { mergeTargets } from './targets'
import type { DecisionAnswer, ProjectTarget, RoundtableConfig } from '../../shared/engineering'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { ExecutionBudgetPause, executionKey, executionStepLimit, diagnosisStepLimit, preparationStepLimit, preparationRoundLimit, verificationStatus, commandEvidenceKinds, type ExecutionRole, type CommandEvidence, type ExecutionCheckpoint } from './execution'
import { ExecutionProgress, ExecutionProgressPause } from './execution-progress'
import { digest, verificationContract, verificationEnvironment, commandFailure, pendingGaps, diagnosedGaps, preparationPrompt, interactionEvidenceBoundary, nativeEvidenceSupported, runtimeMeasurements, measurementSummary, measuredDuration, currentCommandEvidence } from './verification'
import { assembleContext, boundMessages, normalizeContext, readContext, assertCompleteToolRounds } from './context'
import { agentSkills, skillReader } from './skills'
import { builtinSkills, ownSkill } from '../../shared/agents'
import { AgentConfiguration } from './agent-configuration'
import { GeneralAssistant } from './general-assistant'
import { ExecutionArtifacts } from './execution-artifacts'
import { AssistantTeam } from './assistant-team'
import { agentModelLabel, resolveReasoning } from '../../shared/reasoning'
import { isModelEvidenceUrl } from '../../shared/model-evidence'
import { completeWithContext } from './planning'
import { activePrototypeBriefs, designFingerprint, rawDesignFingerprint, pinnedPrototype, requirePrototypeReview, requirePrd, syncPrototypeBriefs } from '../../shared/prototype-workflow'
import { agentRoleLabels, type AgentRole } from '../../shared/engineering'
import type {
  AgentConfig,
  BatchConfirmResult,
  BatchPlanResult,
  ExecutionPlan,
  Feature,
  FeatureInput,
  ModelInput,
  Project,
} from '../../shared/engineering'
import { EngineeringStore, now, uid } from './store'
import { defaultAgentTools, toolLabels } from '../../shared/engineering'
import {
  complete,
  getModels,
  normalizedBase,
  parseJson,
  modelRequestCharacters,
  ModelContextLimitError,
  ContextBudgetError,
  type Connection,
  type ModelMessage,
} from './model'
import {
  commandEnvironment,
  engineeringTools,
  executeTool,
  killTree,
  listFiles,
  nodeCommand,
  safePath,
  sourceFingerprint,
  PreparationBoundaryError,
} from './files'

function text(value: unknown, label: string, limit = 20000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label}格式无效或过长。`)
  return value.trim()
}
function lines(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 80) throw new Error(`${label}格式无效。`)
  return value.map((v) => text(v, label, 3000)).filter(Boolean)
}
// Reads are losslessly paged. Other tool output is bounded and may be truncated.
function agentToolMessage(name: string, output: string): string {
  if (name === 'read_context' || name === 'read_file') return output
  const limit = 12_000
  if (output.length <= limit) return output
  const head = Math.max(1, limit - 1_200)
  return `${output.slice(0, head)}\n\n[工具输出已截断，仅保留前 ${head} 个字符与末尾 1000 字符；活动记录也可能截断。不要仅为找回输出而重复执行有副作用的命令；需完整证据时让检查程序写入项目文件，再用 read_file 分页读取。]\n\n${output.slice(-1_000)}`
}
export class EngineeringService {
  acceptPrototypeAndPreparePrd = async (projectId: string, prototypeId: string) => {
    this.selectPrototype(projectId, prototypeId)
    const p = this.store.project(projectId)
    if (activePrototypeBriefs(p).every(b => b.status === 'accepted')) await this.preparePrd(projectId)
  }
  preparePrd = async (projectId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (p.designActivity) throw new Error('请等待原型设计完成。')
    syncPrototypeBriefs(p)
    const briefs = activePrototypeBriefs(p)
    if (!briefs.length || briefs.some(b => b.status !== 'accepted' || !b.prototypeId || b.fingerprint !== designFingerprint(p, b.targetId))) throw new Error('请先确定并验收各界面原型，再生成 PRD。')
    const sources = briefs.map(b => ({ prototypeId: b.prototypeId!, targetId: b.targetId, fingerprint: b.fingerprint,
      derivedFingerprint: p.prd?.sources.find(s => (s.targetId || '') === (b.targetId || '') && s.fingerprint === b.fingerprint)?.derivedFingerprint,
    }))
    const snapshot = () => JSON.stringify({ document: p.requirementsDocument, features: p.features, brief: p.brief, targets: p.targets, selected: p.selectedPrototypeIds })
    const original = snapshot()
    const agent = this.roleAgent(p, 'planner'), connection = this.agentModel(agent)
    p.prd = { status: 'generating', sources }
    return this.beginResult(p, '根据已确认原型生成 PRD', async signal => {
      try {
        const reply = await completeWithContext(connection,
          this.agentInstructions(p, 'planner', agent.modelId) + '\nPRD_FROM_APPROVED_PROTOTYPE：你是产品需求规划者。必须先使用 read_context 完整分页读取输入 sources 中每个 prototype:ID，然后基于已确认原型生成中文 PRD，不得自行另起界面。覆盖产品目标、页面结构、组件、交互与状态、数据与业务规则、范围、验收标准、待确认问题；区分原型已呈现行为和推导的后端实现。保留用户已有业务约束，不变更已开工功能。仅输出 JSON：{"document":"Markdown PRD 正文","features":[{"id":"已有功能可填原ID","title":"功能名","module":"模块","description":"说明","criteria":["可验证标准"],"targetId":"所属子项目，可省略"}]}。已有候选功能保留 ID；新功能按可独立验收的单位拆分。PRD 仍待用户审阅，不自行确认需求。',
          [{ role: 'user', content: JSON.stringify({ goal: p.brief, sharedContext: this.agentContext(p), sources: sources.map(({ prototypeId, targetId }) => ({ prototypeId, targetId })), currentDocument: p.requirementsDocument || '', currentFeatures: p.features.map(({ id, title, module, description, criteria, targetId, scope, stage, dependencies }) => ({ id, title, module, description, criteria, targetId, scope, stage, dependencies })), targets: p.targets || [] }) }], p, signal, undefined, sources.map(s => 'prototype:' + s.prototypeId), this.agentSkillReader(p, 'planner'))
        signal.throwIfAborted()
        if (snapshot() !== original) throw new Error('原型或需求在生成期间已有修改，请重新生成 PRD。')
        const result = parseJson(reply.text)
        const document = text(result.document, 'PRD 文档', 80000)
        if (!document || !Array.isArray(result.features) || !result.features.length || result.features.length > 100) throw new Error('PRD 缺少有效正文或功能清单。')
        const draft = structuredClone(p)
        for (const item of result.features) {
          const existing = draft.features.find(f => f.id === item.id || f.title === item.title && (f.targetId || '') === (item.targetId || ''))
          if (existing && existing.stage !== 'requirements') continue
          this.upsertFeature(draft, existing?.id || null, {
            title: item.title, module: item.module || existing?.module || '未分组', description: item.description, criteria: item.criteria,
            targetId: item.targetId || existing?.targetId, scope: existing?.scope || 'discussion', dependencies: existing?.dependencies || [],
            developerId: existing?.developerId || this.roleAgent(p, 'developer').id, reviewerId: existing?.reviewerId || this.roleAgent(p, 'reviewer').id,
          })
        }
        draft.requirementsDocument = document
        p.prd = { status: 'review', sources: sources.map(s => ({ ...s, derivedFingerprint: rawDesignFingerprint(draft, s.targetId) })) }
        p.requirementsDocument = document
        p.features = draft.features
        this.store.event(p, 'prd', '已根据验收原型生成 PRD 和候选功能，等待你审阅。原型版本已绑定。')
        this.save(p)
      } catch (error) {
        p.prd = { status: 'error', sources, error: this.store.redact(String(error)) }
        throw error
      }
    })
  }
  submitPrototypePreferences = (projectId: string, input: string, targetId?: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (p.designActivity) throw new Error('正在设计，请等待本次结果。')
    syncPrototypeBriefs(p)
    const brief = p.prototypeBriefs?.[targetId || '']
    if (!brief) throw new Error('请先描述项目目标或该界面的初步想法。')
    const preferences = text(input, '设计意见', 8000)
    if (!preferences) throw new Error('请填写设计意见，或选择推荐设计。')
    const previous = brief.preferences
    const modelId = this.roleAgent(p, 'designer').modelId || p.designModelId || p.discussionModelId
    this.generatePrototype(projectId, '用户设计意见：' + preferences + (previous ? '\n此前设计意见：' + previous : '') + '\n请主动完成原型，覆盖已讨论的主要页面与状态，完成后等待用户试用验收。', modelId, targetId)
    brief.preferences = preferences
    this.save(p)
  }
  readonly store = new EngineeringStore()
  private traffic = new ModelTrafficMonitor(join(dirname(this.store.path), 'model-traffic-v1.json'))
  modelTraffic = (query?: TrafficQuery) => this.traffic.snapshot(this.store.data.models, query)
  private modelChecks = new ModelCheckRegistry(this.store, input => this.connection(input))
  updateOnboarding = (input: OnboardingPatch) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('入门设置格式无效。')
    const previous = this.store.data.onboarding
    const next = { version: 1 as const, ...previous }
    for (const key of ['paused', 'cardCollapsed', 'hintsHidden'] as const) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') throw new Error('入门设置格式无效。')
        next[key] = input[key]
      }
    }
    if (input.projectId !== undefined) {
      if (typeof input.projectId !== 'string' || input.projectId && !this.store.data.projects.some(p => p.id === input.projectId && !p.archivedAt)) throw new Error('请选择仍在使用的项目。')
      if (next.projectId !== input.projectId) next.featureId = ''
      next.projectId = input.projectId
    }
    if (input.featureId !== undefined) {
      if (typeof input.featureId !== 'string' || input.featureId && !this.store.data.projects.find(p => p.id === next.projectId)?.features.some(f => f.id === input.featureId && f.scope === 'current')) throw new Error('请选择当前项目的本期功能。')
      next.featureId = input.featureId
    }
    this.store.data.onboarding = next
    try { this.store.save() } catch (error) { this.store.data.onboarding = previous; throw error }
  }
  private aliyun = new AliyunImport(this.store)
  scanAliyunModels = this.aliyun.scanAliyunModels
  syncAliyunQuota = this.aliyun.syncAliyunQuota
  importAliyunModels = this.aliyun.importAliyunModels
  discardAliyunImport = this.aliyun.discardAliyunImport
  openAliyunPage = this.aliyun.openAliyunPage
  private configuration = new AgentConfiguration(this.store, id => this.model(id))
  private assistant = new GeneralAssistant(this.store, id => this.model(id))
  private assistantTeam = new AssistantTeam(this.store, id => this.model(id))
  recommendAssistantTeam = this.assistantTeam.recommendAssistantTeam
  updateAssistantTeamPlan = this.assistantTeam.updateAssistantTeamPlan
  applyAssistantTeamPlan = this.assistantTeam.applyAssistantTeamPlan
  setDefaultAssistantModel = this.assistant.setDefaultAssistantModel
  sendAssistantMessage = this.assistant.sendAssistantMessage
  clearAssistantChat = this.assistant.clearAssistantChat
  createAssistantSession = this.assistant.createAssistantSession
  selectAssistantSession = this.assistant.selectAssistantSession
  updateAssistantSession = this.assistant.updateAssistantSession
  deleteAssistantSession = this.assistant.deleteAssistantSession
  stopAssistantMessage = (id: string) => { this.assistant.stopAssistantMessage(id); this.assistantTeam.stop(id) }
  saveAssistantMemory = this.assistant.saveAssistantMemory
  deleteAssistantMemory = this.assistant.deleteAssistantMemory
  dismissAssistantHint = this.assistant.dismissAssistantHint
  clearSkillSearch = this.configuration.clearSkillSearch
  previewSkill = this.configuration.previewSkill
  installSkill = this.configuration.installSkill
  discardSkillPreview = this.configuration.discardSkillPreview
  removeSkill = this.configuration.removeSkill
  recommendSkills = this.configuration.recommendSkills
  recommendAgentModels = this.configuration.recommendAgentModels
  applyAgentModels = this.configuration.applyAgentModels
  openModelEvidenceSource = async (url: string) => {
    if (!isModelEvidenceUrl(url)) throw new Error('只支持打开已核实的 AA / Arena 榜单页面。')
    try { await shell.openExternal(url) }
    catch { throw new Error('未能打开系统浏览器，请复制链接后在浏览器中打开。') }
  }
  private workflowActions = new Set<string>()
  configureProject = (projectId: string, input: { plannerId: string; designerId: string; contextBudget: number }) => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (p.designActivity) throw new Error('请等待当前设计完成。')
    for (const [role, id] of [['planner', input.plannerId], ['designer', input.designerId]]) {
      const agent = this.store.data.agents.find(a => a.id === id && a.role === role && (!a.ownerProjectId || a.ownerProjectId === p.id))
      if (!agent) throw new Error('请选择有效的规划与原型智能体。')
      this.model(agent.modelId)
    }
    if (!Number.isSafeInteger(input.contextBudget) || input.contextBudget < 8000 || input.contextBudget > 64000) throw new Error('上下文预算必须为 8000–64000 字符。')
    p.plannerId = input.plannerId; p.designerId = input.designerId; p.contextBudget = input.contextBudget
    p.discussionModelId = this.roleAgent(p, 'planner').modelId
    p.designModelId = this.roleAgent(p, 'designer').modelId
    this.save(p)
  }
  archiveContext = (projectId: string, id: string, archived: boolean) => {
    const p = this.store.project(projectId); this.idle(p)
    const entry = p.context.find(c => c.id === id)
    if (!entry || ['requirements', 'acceptance', 'goal'].includes(entry.kind || '') || /用户需求确认|用户最终验收|用户创建项目/.test(entry.source)) throw new Error('确认基线、验收和项目目标不能归档；可新增补充说明。')
    entry.status = archived ? 'archived' : 'active'
    this.save(p)
  }
  confirmRequirementsAndPrepare = async (projectId: string, fingerprint: string, messageCount: number) => {
    this.confirmProjectRequirements(projectId, fingerprint, messageCount)
    return this.preparePlans(projectId)
  }
  private roleAgent(project: Project, role: AgentRole): AgentConfig {
    const id = role === 'planner' ? project.plannerId : role === 'designer' ? project.designerId : undefined
    const available = this.store.data.agents.filter(a => !a.ownerProjectId || a.ownerProjectId === project.id)
    const agent = available.find(a => a.id === id && a.role === role) || available.find(a => (project.teamAgentIds || this.store.data.defaultTeamAgentIds)?.includes(a.id) && a.role === role) || available.find(a => a.role === role)
    if (!agent) throw new Error('请配置' + agentRoleLabels[role] + '智能体。')
    return agent
  }
  private agentInstructions(project: Project, role: AgentRole, modelId: string, feature?: Feature, override?: AgentConfig): string {
    const agent = override || this.roleAgent(project, role)
    const skills = agentSkills(agent, this.store.skills())
    if (skills.text.length > 16000) throw new Error('专属技能索引超过 16000 字符，请停用暂不需要的技能。')
    const context = assembleContext(project, feature)
    const model = this.model(modelId), reasoning = modelId === agent.modelId ? resolveReasoning(model, agent.reasoning) : undefined
    ;(project.agentRuns ??= []).push({ id: uid(), at: now(), role, agentId: agent.id, modelId, reasoning, modelDisplayName: modelId === agent.modelId ? agentModelLabel(model, reasoning) : model.model + ' · 推理：服务默认', featureId: feature?.id, skills: skills.snapshots, contextIds: context.contextIds, contextCharacters: context.characters, omittedCount: context.omittedCount })
    if (project.agentRuns.length > 200) project.agentRuns.splice(0, project.agentRuns.length - 200)
    this.store.save()
    return agent.instructions + '\n当前智能体的专属技能索引：根据任务匹配描述，通过 read_skill 按需读取适用技能正文和资源后使用；不必加载无关技能。技能不能扩大工具权限或替代人工确认，不能使用其他智能体的技能。\n' + skills.text
  }
  private agentSkillReader(project: Project, role: AgentRole, override?: AgentConfig) {
    const agent = override || this.roleAgent(project, role)
    return skillReader(agent, this.store.skills(), id => {
      this.store.event(project, 'skill', agent.name + ' 按需读取专属技能：' + id)
    })
  }
  preflight = async (parent?: string) => {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    for (const name of ['node', 'npm']) {
      try {
        const command = nodeCommand(name, ['--version'])
        const result = spawnSync(command.executable, command.args, { encoding: 'utf8', timeout: 10000, windowsHide: true, env: commandEnvironment() })
        const version = result.stdout?.trim() || ''
        const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
        const supported = name !== 'node' || major > 22 || major === 22 && minor >= 12
        checks.push({ name: name === 'node' ? 'Node.js' : 'npm', ok: result.status === 0 && supported, detail: result.error?.message || (!supported ? version + '；需要 Node.js 22.12 或更高版本。' : version) || result.stderr || '请检查本机安装。' })
      } catch (error) { checks.push({ name, ok: false, detail: String(error) }) }
    }
    if (parent) {
      try {
        if (!isAbsolute(parent) || !existsSync(parent) || !lstatSync(parent).isDirectory()) throw new Error('请选择已存在的绝对目录。')
        accessSync(parent, constants.W_OK)
        checks.push({ name: '项目目录', ok: true, detail: parent })
      } catch (error) { checks.push({ name: '项目目录', ok: false, detail: String(error) }) }
    }
    return { ready: checks.every(c => c.ok), checks }
  }
  testCapabilities = async (input: ModelInput) => {
    const connection = this.connection(input)
    return this.modelChecks.run(connection, 'capabilities', async () => {
    const signal = AbortSignal.timeout(60000)
    const marker = uid()
    const tools = [{ name: 'connection_probe', description: '无副作用的连接检测；调用一次获取标记。', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }]
    const messages: ModelMessage[] = [{ role: 'user', content: '请调用 connection_probe，然后输出 JSON 对象，字段 marker 必须等于工具返回的 marker。' }]
    const first = await complete(connection, '这是开发能力检查。必须调用提供的工具，然后准确返回 JSON。', messages, tools, signal)
    if (first.calls.length !== 1 || first.calls[0].name !== 'connection_probe') throw new Error('文本连接可用，但未完成工具调用；请选用支持工具的模型。')
    messages.push({ role: 'assistant', content: first.text, calls: first.calls, reasoning: first.reasoning, responseItems: first.responseItems, anthropicBlocks: first.anthropicBlocks }, { role: 'tool', callId: first.calls[0].id, content: JSON.stringify({ marker }) })
    const second = await complete(connection, '请只输出包含工具标记的 JSON 对象。', messages, [], signal)
    if (second.calls.length || parseJson(second.text).marker !== marker) throw new Error('工具往返已完成，但结构化结果校验失败。')
    return '开发能力检查通过：工具调用、结果回传和 JSON 均可用。'
    })
  }
  selectPrototype = (projectId: string, prototypeId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (p.designActivity) throw new Error('请等待原型生成完成。')
    const prototype = p.prototypes?.find(r => r.id === prototypeId)
    if (!prototype) throw new Error('原型版本不存在。')
    if (p.targets?.length && !p.targets.some(t => t.id === prototype.targetId && ['web', 'admin', 'mobile', 'desktop'].includes(t.kind))) throw new Error('该原型不属于当前界面，请选择当前子项目的原型。')
    const fingerprint = designFingerprint(p, prototype.targetId)
    if (prototype.designFingerprint && prototype.designFingerprint !== fingerprint) throw new Error('该原型对应的需求已更新，请先提交意见更新原型。')
    ;(p.prototypeBriefs ??= {})[prototype.targetId || ''] = {
      ...(p.prototypeBriefs?.[prototype.targetId || ''] || { preferences: '' }),
      targetId: prototype.targetId, fingerprint, status: 'accepted', prototypeId, acceptedAt: now(), error: undefined,
    }
    ;(p.selectedPrototypeIds ??= {})[prototype.targetId || ''] = prototype.id
    if (p.prd && !p.prd.sources.some(s => s.prototypeId === prototype.id)) p.prd.status = 'stale'
    this.store.event(p, 'prototype', '用户已验收原型：' + prototype.title + '；后续开发与校验将读取此版本，已开工功能保持原有基线。')
    this.save(p)
  }
  preparePlans = async (projectId: string): Promise<BatchPlanResult[]> => {
    const p = this.store.project(projectId)
    const ids = p.features.filter(f => f.scope === 'current' && f.stage === 'solution' && (!f.plan || !f.tasks.length || f.planGenerationError)).map(f => f.id)
    const results: BatchPlanResult[] = []
    for (let i = 0; i < ids.length; i += 20) results.push(...await this.generatePlans(projectId, ids.slice(i, i + 20)))
    return results
  }
  confirmPlansAndStart = async (projectId: string, featureIds: string[], revisions: number[]): Promise<BatchConfirmResult[]> => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (this.workflowActions.has(projectId)) throw new Error('正在处理此操作，请等待。')
    if (!Array.isArray(featureIds) || featureIds.length < 1 || featureIds.length > 8 || new Set(featureIds).size !== featureIds.length || !Array.isArray(revisions) || revisions.length !== featureIds.length) throw new Error('请选择 1–8 个方案。')
    if (p.features.some(f => f.stage === 'acceptance')) throw new Error('请先验收当前功能。')
    const features = featureIds.map((id, i) => {
      const f = this.feature(p, id)
      if (f.revision !== revisions[i] || !['solution', 'ready'].includes(f.stage)) throw new Error('方案已有更新，请重新审阅。')
      return f
    })
    const selected = new Set(featureIds), ordered: string[] = [], visiting = new Set<string>()
    const visit = (f: Feature) => {
      if (ordered.includes(f.id)) return
      if (visiting.has(f.id)) throw new Error('功能依赖不能形成循环。')
      visiting.add(f.id)
      for (const id of f.dependencies) {
        const dep = this.feature(p, id)
        if (dep.stage !== 'done') {
          if (!selected.has(id)) throw new Error('请一并选择前置功能：' + dep.title)
          visit(dep)
        }
      }
      visiting.delete(f.id); ordered.push(f.id)
    }
    features.forEach(visit)
    this.workflowActions.add(projectId)
    try {
      const pending = features.filter(f => f.stage === 'solution').map(f => f.id)
      const results = pending.length ? await this.confirmPlans(projectId, pending) : []
      if (results.some(r => !r.success)) return results
      p.executionPlan = { id: uid(), featureIds, orderedFeatureIds: ordered, rationale: '根据已确认功能依赖排序，逐项开发与验收。', currentIndex: 0, status: 'planned', at: now() }
      this.save(p)
      await this.runExecutionPlan(projectId)
      return results
    } finally { this.workflowActions.delete(projectId) }
  }
  acceptAndContinue = async (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.accept(projectId, featureId)
    if (p.executionPlan?.status === 'planned') await this.runExecutionPlan(projectId)
  }
  private research = new RequirementsWorkspace({
    store: this.store,
    model: (id, agent) => agent && agent.modelId === id ? this.agentModel(agent) : this.model(id),
    save: (p) => this.save(p),
    context: (p) => this.context(p),
    roleAgent: (p, role) => this.roleAgent(p, role),
    agentInstructions: (p, role, modelId) => this.agentInstructions(p, role, modelId),
    skillReader: (p, role) => this.agentSkillReader(p, role),
    upsert: (p, id, input) => this.upsertFeature(p, id, input),
  })
  generatePrototype = (
    projectId: string,
    instruction: string,
    modelId: string,
    targetId?: string,
  ) => this.research.generatePrototype(projectId, instruction, modelId, targetId)
  saveTargets = (projectId: string, targets: ProjectTarget[]) => {
    const p = this.store.project(projectId)
    this.idle(p)
    mergeTargets(p, targets)
    this.save(p)
  }
  roundtableTurn = (projectId: string, input: string, config: RoundtableConfig) => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (p.decisions?.some((d) => d.status === 'pending'))
      throw new Error('请先处理待决卡，回答后会继续当前圆桌。')
    const message = text(input, '圆桌议题或人工反馈')
    if (!message) throw new Error('请输入圆桌议题或人工反馈。')
    if (
      !config ||
      !Array.isArray(config.participants) ||
      config.participants.length < 2 ||
      config.participants.length > 6 ||
      !Number.isInteger(config.passes) ||
      config.passes < 1 ||
      config.passes > 3
    )
      throw new Error('请选择 2–6 个参会模型，每轮自动讨论 1–3 次。')
    const participants = config.participants.map((p) => ({
      modelId: this.model(p.modelId).id,
      role: text(p.role, '参会职责', 500),
    }))
    if (
      participants.some((p) => !p.role) ||
      new Set(participants.map((p) => p.modelId)).size !== participants.length
    )
      throw new Error('每个模型只能入会一次，并需填写职责。')
    const next = { participants, passes: config.passes }
    const previous = p.roundtable
    const resume =
      previous &&
      ['error', 'stopped'].includes(previous.status) &&
      previous.passes === next.passes &&
      previous.participants.length === participants.length &&
      previous.participants.every(
        (p, i) => p.modelId === participants[i].modelId && p.role === participants[i].role,
      )
    if (resume) {
      previous.status = 'running'
      previous.error = undefined
      previous.phase = '恢复当前发言'
    } else {
      p.roundtable = {
        ...next,
        round: (previous?.round || 0) + 1,
        status: 'running',
        phase: '准备圆桌上下文',
      }
    }
    p.chat.push({
      id: uid(),
      role: 'user',
      purpose: 'roundtable',
      meetingRound: p.roundtable!.round,
      speaker: '人工',
      text: message,
      at: now(),
    })
    this.save(p)
    this.begin(p, `圆桌第 ${p.roundtable!.round} 轮`, (signal) =>
      this.research.roundtable(p, next, signal),
    )
  }
  answerDecision = (projectId: string, decisionId: string, answer: DecisionAnswer) => {
    const p = this.store.project(projectId)
    const waiting = this.research.decisions.isWaiting(decisionId)
    if (!waiting) {
      this.idle(p)
      if (!p.roundtable) throw new Error('圆桌记录不存在。')
      for (const participant of p.roundtable.participants) this.model(participant.modelId)
    }
    this.research.decisions.answer(p, decisionId, answer)
    if (!waiting) {
      const config = { participants: p.roundtable!.participants, passes: p.roundtable!.passes }
      this.begin(p, '恢复圆桌讨论', (signal) => this.research.roundtable(p, config, signal))
    }
  }
  stopDesign = (projectId: string) => this.research.stopDesign(projectId)
  saveRequirementsDocument = (projectId: string, content: string, previous: string) => {
    const p = this.store.project(projectId)
    if ((p.requirementsDocument || '') !== previous)
      throw new Error('需求文档已更新，请重新打开后编辑。')
    p.requirementsDocument = text(content, '需求文档', 80000)
    this.save(p)
  }
  confirmProjectRequirements = (projectId: string, fingerprint: string, messageCount: number) => {
    const p = this.store.project(projectId)
    this.idle(p)
    this.research.confirm(p, fingerprint, messageCount)
  }
  reopenProjectRequirements = (projectId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (p.designActivity) throw new Error('请先等待原型设计完成。')
    for (const f of p.features)
      if (['solution', 'ready'].includes(f.stage)) {
        f.stage = 'requirements'
        f.scope = 'discussion'
        f.plan = ''
        f.tasks = []
        f.revision++
      }
    p.chat.push({
      id: uid(),
      role: 'assistant',
      text: '已重新打开未开发功能的需求草稿。旧基线保留在共享上下文；调整后统一确认新版本，已开发功能保持原有交付记录。',
      at: now(),
      status: 'complete',
    })
    this.store.event(p, 'requirements', '需求已重新进入修订，未开发功能的方案需重新确认。')
    this.save(p)
  }
  private jobs = new Map<string, AbortController>()
  private previews = new Map<string, ChildProcess>()
  private previewStarting = new Set<string>()
  state = () => ({ ...this.store.snapshot(), skillSearchActivity: structuredClone(this.configuration.searchActivity) })
  private idle(project: Project): void {
    if (this.jobs.has(project.id)) throw new Error('此项目正在执行，请等待完成或先停止。')
  }
  private feature(project: Project, id: string): Feature {
    const feature = project.features.find((f) => f.id === id)
    if (!feature) throw new Error('功能不存在。')
    return feature
  }
  private dependencyError(project: Project, feature: Feature): string | null {
    const visit = (id: string, path: Set<string>): string | null => {
      if (path.has(id)) return '功能依赖存在循环。'
      const node = project.features.find((item) => item.id === id)
      if (!node) return `依赖功能不存在：${id}。`
      const next = new Set(path)
      next.add(id)
      for (const dependencyId of node.dependencies ?? []) {
        const error = visit(dependencyId, next)
        if (error) return error
      }
      return null
    }
    return visit(feature.id, new Set())
  }
  private async generatePlanContent(
    project: Project,
    feature: Feature,
    signal: AbortSignal,
  ): Promise<{ plan: string; tasks: string[] }> {
    const agent = this.roleAgent(project, 'planner')
    const prototype = pinnedPrototype(project, feature)
    const connection = this.agentModel(agent)
    const format = JSON.stringify({
      plan: '可实现的方案、公共模块复用、检查方式和本地启动方式',
      tasks: ['具体任务'],
    })
    const reply = await completeWithContext(
      connection,
      `你是软件方案设计者。输出中文 JSON ${format}。不改动已确认需求、验收标准和依赖关系。首次创建项目时使用本机 npm/Node 网页技术栈，提供 npm run dev/build/test。已有文件：${JSON.stringify(listFiles(project.root))}\n共享上下文：${this.agentContext(project, feature)}\n职责：${this.agentInstructions(project, "planner", agent.modelId, feature)}` + (prototype ? '\n验收原型ID：' + prototype.id + '\n必须先 read_context 完整分页读取 prototype:' + prototype.id + '。以这个原型为基础设计实现方案，说明页面、组件、状态如何复用并接入业务，不能另起界面。' : ''),
      [
        {
          role: 'user',
          content: JSON.stringify({
            title: feature.title,
            description: feature.description,
            criteria: feature.criteria,
            dependencies: feature.dependencies,
            project: project.brief,
          }),
        },
      ],
      project,
      signal,
      undefined,
      prototype ? ['prototype:' + prototype.id] : [],
      this.agentSkillReader(project, 'planner'),
    )
    signal.throwIfAborted()
    const parsed = parseJson(reply.text)
    const plan = text(parsed.plan, '方案', 40000)
    const tasks = lines(parsed.tasks, '实现任务')
    if (!plan || !tasks.length) throw new Error('方案缺少内容或实现任务，请重试或手动补充。')
    return { plan, tasks }
  }
  private save(project: Project): void {
    normalizeContext(project)
    syncPrototypeBriefs(project)
    this.store.save()
    this.store.export(project)
  }
  private connection(input: ModelInput): Connection {
    const model = text(input.model, '模型标识', 200)
    if (input.reuseConnectionId) {
      if (input.id) throw new Error('复用连接仅用于新增型号。')
      const source = this.store.data.models.find(m => m.id === input.reuseConnectionId)
      if (!source) throw new Error('原连接已不存在，请重新选择。')
      return { ...this.connection(source), id: '', name: model, model }
    }
    const key =
      typeof input.apiKey === 'string' && input.apiKey.trim()
        ? input.apiKey.trim()
        : this.store.key(input.id)
    if (!['chat', 'responses', 'anthropic'].includes(input.protocol))
      throw new Error('不支持的接口类型。')
    return {
      id: text(input.id, '模型 ID', 100),
      name: model,
      baseUrl: normalizedBase(text(input.baseUrl, '服务地址', 1000)),
      model,
      protocol: input.protocol,
      apiKey: key,
      traffic: this.store.data.models.some(m => m.id === input.id && m.model === model && m.protocol === input.protocol && m.baseUrl === normalizedBase(input.baseUrl)) ? this.traffic : undefined,
    }
  }
  private model(id: string): Connection {
    const model = this.store.data.models.find((m) => m.id === id)
    if (!model) throw new Error('请先新增模型，并为当前智能体选择模型。')
    return this.connection(model)
  }
  private agentModel(agent: AgentConfig): Connection {
    const connection = this.model(agent.modelId)
    return { ...connection, reasoning: resolveReasoning(connection, agent.reasoning) }
  }
  saveModel = (input: ModelInput) => {
    const c = this.connection(input)
    if (!c.model) throw new Error('请填写模型标识。')
    if (!c.apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.baseUrl).hostname))
      throw new Error('请填写 API Key。')
    if (input.reuseConnectionId) {
      const existing = this.store.data.models.find(m => m.id === input.reuseConnectionId && m.model === c.model)
      if (existing) { const { cipher, ...publicModel } = existing; return { ...publicModel, hasKey: !!cipher } }
    }
    const saved = {
      id: c.id || uid(),
      name: c.name,
      model: c.model,
      baseUrl: c.baseUrl,
      protocol: c.protocol,
      hasKey: !!c.apiKey,
      cipher: c.apiKey ? this.store.encrypt(c.apiKey) : '',
      checks: this.modelChecks.forSave(c),
    }
    const index = this.store.data.models.findIndex((m) => m.id === saved.id)
    if (index >= 0) this.store.data.models[index] = saved
    else this.store.data.models.push(saved)
    for (const agent of this.store.data.agents) if (!agent.modelId) agent.modelId = saved.id
    for (const project of this.store.data.projects) if (!project.discussionModelId) project.discussionModelId = saved.id
    this.store.save()
    const { cipher, ...publicModel } = saved
    return publicModel
  }
  deleteModel = (id: string) => {
    if (this.store.data.defaultAssistantModelId === id) throw new Error('该模型是默认通用助手模型，请先更换默认值或取消默认设置。')
    if (
      this.store.data.agents.some((a) => a.modelId === id) ||
      this.store.data.projects.some(
        (p) =>
          p.discussionModelId === id ||
          p.designModelId === id ||
          p.roundtable?.participants.some((m) => m.modelId === id),
      )
    )
      throw new Error('该模型正在被智能体或项目使用，请先更换所用模型。')
    this.store.data.models = this.store.data.models.filter((m) => m.id !== id)
    this.store.save()
  }
  testModel = async (input: ModelInput) => {
    const connection = { ...this.connection(input), trafficPurpose: 'test' as const }
    if (!connection.model) throw new Error('请填写模型标识。')
    return this.modelChecks.run(connection, 'connection', async () => {
    const result = await complete(connection, '这是连接测试。请简短回复。', [
      { role: 'user', content: '请回复：连接成功' },
    ], [], AbortSignal.timeout(60000), () => {})
    if (!result.text.trim()) throw new Error('已收到响应，但没有文本内容。请检查模型类型。')
    const safe = connection.apiKey
      ? result.text.split(connection.apiKey).join('[已隐藏密钥]')
      : result.text
    return `连接成功 · ${this.store.redact(safe).slice(0, 200)}`
    })
  }
  listModels = (input: ModelInput) => getModels(this.connection(input))
  saveAgent = (input: AgentConfig) => {
    if (!Object.hasOwn(agentRoleLabels, input.role)) throw new Error('智能体角色无效。')
    const reasoning = resolveReasoning(this.model(input.modelId), input.reasoning)
    const tools = input.tools ?? defaultAgentTools(input.role)
    if (
      !Array.isArray(tools) ||
      tools.some(
        (name) =>
          !Object.hasOwn(toolLabels, name) || !defaultAgentTools(input.role).includes(name),
      )
    )
      throw new Error('智能体工具配置无效。验证角色不提供文件修改工具。')
    const agent: AgentConfig = {
      ownerProjectId: this.store.data.agents.find(a => a.id === input.id)?.ownerProjectId,
      id: input.id || uid(),
      name: text(input.name, '智能体名称', 80),
      role: input.role,
      modelId: input.modelId,
      reasoning,
      instructions: text(input.instructions, '工作要求', 10000),
      skillIds: [...new Set(input.skillIds || [])],
      tools: [
        ...new Set([
          ...defaultAgentTools(input.role).filter(
            (name) => !['write_file', 'run_command'].includes(name),
          ),
          ...tools,
        ]),
      ],
    }
    if (!agent.name) throw new Error('请填写智能体名称。')
    const isNew = !this.store.data.agents.some(a => a.id === agent.id)
    const defaults = isNew ? builtinSkills.filter(s => s.roles.includes(agent.role) && s.requiredTools.every(t => agent.tools.includes(t))).map(s => ownSkill(s, agent.id)) : []
    if (isNew && !input.skillIds?.length) agent.skillIds = defaults.map(s => s.id)
    agentSkills(agent, [...this.store.skills(), ...defaults])
    const index = this.store.data.agents.findIndex((a) => a.id === agent.id)
    if (index >= 0 && this.store.data.agents[index].role !== agent.role)
      throw new Error('已有智能体不能更改职责类型，请新增智能体。')
    if (index >= 0) this.store.data.agents[index] = agent
    else this.store.data.agents.push(agent)
    if (defaults.length) this.store.data.skills = [...this.store.skills(), ...defaults]
    this.store.save()
  }
  createProject = (input: { name: string; parent: string; brief: string; modelId: string }) => {
    const name = text(input.name, '项目名称', 80),
      parent = text(input.parent, '父目录', 1000)
    if (
      !name ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ||
      name === '.' ||
      name === '..'
    )
      throw new Error('项目名称不能包含系统保留名称或路径符号。')
    if (!isAbsolute(parent) || !existsSync(parent) || !lstatSync(parent).isDirectory())
      throw new Error('请选择已存在的父目录。')
    const root = join(realpathSync(parent), name)
    if (existsSync(root)) throw new Error('同名目录已存在，请换一个名称。不会覆盖已有目录。')
    if (input.modelId) this.model(input.modelId)
    mkdirSync(root)
    const project: Project = {
      id: uid(),
      name,
      root,
      brief: text(input.brief, '项目目标'),
      createdAt: now(),
      features: [],
      chat: [],
      context: [],
      events: [],
      changes: [],
      discussionModelId: input.modelId || '',
      teamAgentIds: this.store.data.defaultTeamAgentIds?.filter(id => this.store.data.agents.some(a => a.id === id && !a.ownerProjectId)),
      plannerId: this.store.data.agents.find(a => a.role === 'planner' && this.store.data.defaultTeamAgentIds?.includes(a.id))?.id || this.store.data.agents.find(a => a.role === 'planner' && !a.ownerProjectId)?.id,
      designerId: this.store.data.agents.find(a => a.role === 'designer' && this.store.data.defaultTeamAgentIds?.includes(a.id))?.id || this.store.data.agents.find(a => a.role === 'designer' && !a.ownerProjectId)?.id,
      agentRuns: [],
      activity: null,
      previewUrl: null,
    }
    project.context.push({
      id: uid(),
      title: '项目目标',
      content: project.brief || '从需求讨论开始定义这个项目。',
      source: '用户创建项目',
      at: now(),
    })
    this.store.data.projects.push(project)
    this.store.event(project, 'project', `创建项目目录：${root}`)
    this.save(project)
    return project.id
  }
  updateProjectMetadata = (projectId: string, input: { name?: string; pinned?: boolean; archived?: boolean }) => {
    const project = this.store.project(projectId)
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['name', 'pinned', 'archived'].includes(key)))
      throw new Error('项目管理参数无效。')
    const name = input.name === undefined ? project.name : text(input.name, '项目名称', 80)
    if (!name || /[\x00-\x1f]/.test(name)) throw new Error('请填写有效的项目名称。')
    if (input.pinned !== undefined && typeof input.pinned !== 'boolean' ||
      input.archived !== undefined && typeof input.archived !== 'boolean')
      throw new Error('项目管理参数无效。')
    if (input.archived && !project.archivedAt &&
      (project.activity || project.designActivity || project.previewUrl || project.executionPlan?.status === 'running'))
      throw new Error('项目仍在执行或预览中，请先停止后再归档。')
    const changes: string[] = []
    if (name !== project.name) {
      changes.push(`项目名称：${project.name} → ${name}`)
      project.name = name
    }
    if (input.pinned !== undefined && !!project.pinned !== input.pinned) {
      project.pinned = input.pinned
      changes.push(input.pinned ? '置顶项目' : '取消项目置顶')
    }
    if (input.archived !== undefined && !!project.archivedAt !== input.archived) {
      project.archivedAt = input.archived ? now() : null
      changes.push(input.archived ? '归档项目，保留全部工程文件和记录' : '恢复项目到活跃列表')
    }
    // Library changes never move project directories or rewrite project artifacts.
    if (changes.length) this.store.event(project, 'project-management', changes.join('；'))
  }
  discuss = (projectId: string, input: string) => {
    const project = this.store.project(projectId),
      message = text(input, '讨论内容')
    this.idle(project)
    if (!message) throw new Error('请输入讨论内容。')
    const planner = this.roleAgent(project, 'planner')
    const connection = project.discussionModelId === planner.modelId ? this.agentModel(planner) : this.model(project.discussionModelId)
    project.chat.push({ id: uid(), role: 'user', text: message, at: now() })
    this.save(project)
    this.begin(project, '整理需求与功能图', (signal) =>
      this.research.discuss(project, connection, signal),
    )
  }
  private upsertFeature(project: Project, id: string | null, input: FeatureInput): string {
    for (const agentId of [input.developerId, input.reviewerId]) {
      const member = this.store.data.agents.find(a => a.id === agentId)
      if (member?.ownerProjectId && member.ownerProjectId !== project.id) throw new Error('不能使用其他项目的专用智能体。')
    }
    let f = id ? this.feature(project, id) : undefined
    if (f && f.stage !== 'requirements') throw new Error('需求已确认，不能直接改写目标与验收标准。')
    const title = text(input.title, '功能名称', 100)
    const targetId =
      input.targetId === undefined
        ? f?.targetId
        : text(input.targetId, '所属子项目', 64) || undefined
    if (targetId && !project.targets?.some((t) => t.id === targetId))
      throw new Error('功能所属子项目不存在，请先规划子项目。')
    if (!title) throw new Error('请填写功能名称。')
    if (!['discussion', 'current', 'later'].includes(input.scope)) throw new Error('功能范围无效。')
    const dependencies = lines(input.dependencies ?? [], '功能依赖')
    if (dependencies.some((dep) => dep === id || !project.features.some((item) => item.id === dep)))
      throw new Error('依赖功能无效。')
    const reaches = (node: string, seen = new Set<string>()): boolean => {
      if (node === id) return true
      if (seen.has(node)) return false
      seen.add(node)
      return (
        project.features
          .find((item) => item.id === node)
          ?.dependencies.some((dep) => reaches(dep, seen)) ?? false
      )
    }
    if (dependencies.some((dep) => reaches(dep))) throw new Error('功能依赖不能形成循环。')
    const values = {
      targetId,
      title,
      module: text(input.module, '模块', 80) || '未分组',
      description: text(input.description, '需求说明'),
      criteria: lines(input.criteria, '验收标准'),
      scope: input.scope,
      dependencies,
      developerId: text(input.developerId, '开发角色', 100),
      reviewerId: text(input.reviewerId, '验证角色', 100),
    }
    if (!f) {
      f = {
        id: uid(),
        title: '',
        module: '',
        description: '',
        criteria: [],
        scope: 'discussion',
        stage: 'requirements',
        revision: 0,
        dependencies: [],
        plan: '',
        tasks: [],
        developerId: '',
        reviewerId: '',
        results: [],
        repairRound: 0,
        feedback: '',
      }
      project.features.push(f)
    }
    Object.assign(f, values, { revision: f.revision + 1 })
    return f.id
  }
  saveFeature = (projectId: string, id: string | null, input: FeatureInput) => {
    const project = this.store.project(projectId)
    if (project.activity && project.activity !== '整理需求与功能图') this.idle(project)
    const result = this.upsertFeature(project, id, input)
    this.save(project)
    return result
  }
  confirmRequirements = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (f.stage !== 'requirements' || !f.description || !f.criteria.length)
      throw new Error('请先补充需求说明和至少一项验收标准。')
    requirePrototypeReview(p, f)
    requirePrd(p)
    f.scope = 'current'
    const acceptedPrototype = p.prototypeBriefs?.[f.targetId || '']
    if (acceptedPrototype?.status === 'accepted') f.prototypeId = acceptedPrototype.prototypeId
    f.stage = 'solution'
    f.revision++
    p.context.push({
      id: uid(),
      title: `已确认需求：${f.title}`,
      content: `${f.description}\n\n验收标准：\n${f.criteria.map((c) => `- ${c}`).join('\n')}`,
      source: `用户需求确认 · ${f.id}`,
      at: now(),
    })
    this.store.event(p, 'confirmed', `已确认需求：${f.title}`, f.id)
    this.save(p)
  }
  assignAgents = (
    projectId: string,
    featureId: string,
    developerId: string,
    reviewerId: string,
  ) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (['done', 'acceptance'].includes(f.stage))
      throw new Error('已提交验收的功能无需变更执行角色。')
    this.agent(developerId, 'developer', p.id)
    this.agent(reviewerId, 'reviewer', p.id)
    f.developerId = developerId
    f.reviewerId = reviewerId
    f.revision++
    this.store.event(p, 'agents', '已更新功能的开发与验证智能体。', f.id)
    this.save(p)
  }
  private agent(id: string, role: 'developer' | 'reviewer', projectId?: string): AgentConfig {
    const agent = this.store.data.agents.find((a) => a.id === id && a.role === role)
    if (agent?.ownerProjectId && projectId && agent.ownerProjectId !== projectId) throw new Error('不能使用其他项目的专用智能体。')
    if (!agent) throw new Error(`请选择${role === 'developer' ? '开发' : '验证'}智能体。`)
    this.model(agent.modelId)
    return { ...agent }
  }
  generatePlan = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId),
      f = this.feature(p, featureId)
    if (f.stage !== 'solution') throw new Error('请先确认需求。')
    this.agent(f.developerId, 'developer', p.id)
    this.begin(
      p,
      `为「${f.title}」生成方案`,
      async (signal) => {
        try {
          const generated = await this.generatePlanContent(p, f, signal)
          f.plan = generated.plan
          f.revision++
          f.tasks = generated.tasks.map((title) => ({
            id: uid(),
            title,
            done: false,
          }))
          f.planSource = 'llm'
          f.planGenerationError = undefined
          f.planConfirmationError = undefined
          this.store.event(p, 'plan', '方案已生成，等待你确认。', f.id)
        } catch (error) {
          if (!signal.aborted)
            f.planGenerationError = error instanceof Error ? error.message : String(error)
          throw error
        }
      },
      f,
    )
  }
  savePlan = (projectId: string, featureId: string, plan: string, tasks: string[]) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (f.stage !== 'solution') throw new Error('当前阶段不能编辑初始方案。')
    f.plan = text(plan, '方案', 40000)
    f.revision++
    f.tasks = lines(tasks, '实现任务').map((title) => ({ id: uid(), title, done: false }))
    f.planSource = 'manual'
    f.planGenerationError = undefined
    f.planConfirmationError = undefined
    this.save(p)
  }
  confirmPlan = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (f.stage !== 'solution' || !f.plan.trim() || !f.tasks.some((task) => task.title.trim()))
      throw new Error('请先准备方案和实现任务。')
    const dependencyError = this.dependencyError(p, f)
    if (dependencyError) throw new Error(dependencyError)
    this.executionAgents(f, p.id)
    f.stage = 'ready'
    f.planConfirmationError = undefined
    f.planGenerationError = undefined
    this.store.event(p, 'confirmed', '方案与任务已确认，可以开始开发。', f.id)
    this.save(p)
  }
  private async generatePlanBatchItem(
    project: Project,
    featureId: string,
    overwriteExisting: boolean,
    signal: AbortSignal,
  ): Promise<BatchPlanResult> {
    signal.throwIfAborted()
    const feature = project.features.find((item) => item.id === featureId)
    if (!feature)
      return { featureId, success: false, error: '功能不存在。' }
    if (feature.stage !== 'solution')
      return { featureId, success: false, error: '只能批量生成处于方案确认阶段的功能。' }
    const plan = feature.plan.trim()
    const tasks = feature.tasks.map((task) => task.title.trim()).filter(Boolean)
    if ((plan || tasks.length) && !overwriteExisting)
      return { featureId, success: true, skipped: true, plan: plan || undefined, tasks }
    try {
      const generated = await this.generatePlanContent(project, feature, signal)
      feature.plan = generated.plan
      feature.revision++
      feature.tasks = generated.tasks.map((title) => ({ id: uid(), title, done: false }))
      feature.planSource = 'llm'
      feature.planGenerationError = undefined
      feature.planConfirmationError = undefined
      this.store.event(project, 'plan', '方案已生成，等待你确认。', feature.id)
      return {
        featureId,
        success: true,
        plan: feature.plan,
        tasks: feature.tasks.map((task) => task.title),
      }
    } catch (error) {
      if (signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      feature.planGenerationError = message
      this.store.event(project, 'error', `批量生成方案失败：${message}`, feature.id)
      return {
        featureId,
        success: false,
        plan: feature.plan.trim() || undefined,
        tasks,
        error: message,
      }
    }
  }
  generatePlans = async (
    projectId: string,
    featureIds: string[],
    overwriteExisting = false,
  ): Promise<BatchPlanResult[]> => {
    const project = this.store.project(projectId)
    this.idle(project)
    if (!Array.isArray(featureIds) || featureIds.length < 1 || featureIds.length > 20)
      throw new Error('请选择 1–20 个方案确认阶段的功能。')
    const ids = [...new Set(featureIds)]
    if (ids.length !== featureIds.length) throw new Error('批量生成不能重复选择同一功能。')
    return this.beginResult(project, `批量生成 ${ids.length} 个方案`, async (signal) => {
      const settled = await Promise.allSettled(
        ids.map((featureId) =>
          this.generatePlanBatchItem(project, featureId, Boolean(overwriteExisting), signal),
        ),
      )
      signal.throwIfAborted()
      const results: BatchPlanResult[] = settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        const feature = project.features.find((item) => item.id === ids[index])
        if (feature) feature.planGenerationError = message
        return { featureId: ids[index], success: false, error: message }
      })
      const succeeded = results.filter((result) => result.success && !result.skipped).length
      const skipped = results.filter((result) => result.skipped).length
      const failed = results.length - succeeded - skipped
      this.store.event(
        project,
        'plan',
        `批量方案生成完成：${succeeded} 个已生成，${skipped} 个跳过已有方案，${failed} 个失败。`,
      )
      return results
    })
  }
  private async confirmPlanBatchItem(
    project: Project,
    featureId: string,
    signal: AbortSignal,
  ): Promise<BatchConfirmResult> {
    signal.throwIfAborted()
    const feature = project.features.find((item) => item.id === featureId)
    if (!feature) return { featureId, success: false, error: '功能不存在。' }
    if (feature.stage !== 'solution') {
      const error = '只能确认处于方案确认阶段的功能。'
      feature.planConfirmationError = error
      return { featureId, success: false, error }
    }
    const plan = feature.plan.trim()
    const tasks = feature.tasks.map((task) => task.title.trim()).filter(Boolean)
    if (!plan || !tasks.length) {
      const error = '请先生成或补充完整方案与实现任务。'
      feature.planConfirmationError = error
      this.store.event(project, 'error', `批量确认方案失败：${error}`, feature.id)
      return { featureId, success: false, error }
    }
    const dependencyError = this.dependencyError(project, feature)
    if (dependencyError) {
      feature.planConfirmationError = dependencyError
      this.store.event(project, 'error', `批量确认方案失败：${dependencyError}`, feature.id)
      return { featureId, success: false, error: dependencyError }
    }
    try {
      this.executionAgents(feature, project.id)
      signal.throwIfAborted()
      feature.stage = 'ready'
      feature.planConfirmationError = undefined
      feature.planGenerationError = undefined
      this.store.event(project, 'confirmed', '方案与任务已确认，可以开始开发。', feature.id)
      return { featureId, success: true, plan, tasks }
    } catch (error) {
      if (signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      feature.planConfirmationError = message
      this.store.event(project, 'error', `批量确认方案失败：${message}`, feature.id)
      return { featureId, success: false, plan, tasks, error: message }
    }
  }
  confirmPlans = async (projectId: string, featureIds: string[]): Promise<BatchConfirmResult[]> => {
    const project = this.store.project(projectId)
    this.idle(project)
    if (!Array.isArray(featureIds) || featureIds.length < 1 || featureIds.length > 20)
      throw new Error('请选择 1–20 个方案确认阶段的功能。')
    const ids = [...new Set(featureIds)]
    if (ids.length !== featureIds.length) throw new Error('批量确认不能重复选择同一功能。')
    return this.beginResult(project, `批量确认 ${ids.length} 个方案`, async (signal) => {
      const settled = await Promise.allSettled(
        ids.map((featureId) => this.confirmPlanBatchItem(project, featureId, signal)),
      )
      signal.throwIfAborted()
      const results: BatchConfirmResult[] = settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        const feature = project.features.find((item) => item.id === ids[index])
        if (feature) feature.planConfirmationError = message
        return { featureId: ids[index], success: false, error: message }
      })
      const succeeded = results.filter((result) => result.success).length
      this.store.event(
        project,
        'confirmed',
        `批量方案确认完成：${succeeded} 个进入待开发，${results.length - succeeded} 个保留在方案确认。`,
      )
      return results
    })
  }
  planExecution = async (projectId: string, featureIds: string[]): Promise<ExecutionPlan> => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (!Array.isArray(featureIds) || featureIds.length < 1 || featureIds.length > 8)
      throw new Error('请选择 1–8 个已确认方案。')
    const ids = [...new Set(featureIds)]
    if (ids.length !== featureIds.length) throw new Error('执行计划中不能重复选择同一功能。')
    const features = ids.map((id) => this.feature(p, id))
    if (features.some((feature) => feature.stage !== 'ready'))
      throw new Error('只能选择已确认方案，先完成方案确认再加入执行计划。')
    if (features.some((feature) => feature.scope !== 'current'))
      throw new Error('只有本期功能可以加入执行计划。')
    if (p.features.some((feature) => feature.stage === 'acceptance'))
      throw new Error('请先完成当前待验收功能，再创建新的执行计划。')
    const selected = new Set(ids)
    for (const feature of features) {
      for (const dependencyId of feature.dependencies) {
        const dependency = this.feature(p, dependencyId)
        if (dependency.stage !== 'done' && !selected.has(dependency.id))
          throw new Error(`「${feature.title}」依赖「${dependency.title}」，请一并选择或先完成前置功能。`)
      }
    }
    // Keep a complete, dependency-safe order independent of model output.
    const dependencyOrder: string[] = []
    const remaining = new Set(ids)
    while (remaining.size) {
      const next = features.find((feature) =>
        remaining.has(feature.id) && feature.dependencies.every((id) => !remaining.has(id)),
      )
      if (!next) throw new Error('所选功能的依赖存在循环，请先修正依赖关系。')
      dependencyOrder.push(next.id)
      remaining.delete(next.id)
    }
    const planner = this.roleAgent(p, 'planner'), modelId = planner.modelId
    if (!modelId) throw new Error('请先为项目配置规划模型。')
    const connection = this.agentModel(planner)
    return this.beginResult(p, 'LLM 正在规划批量执行', async (signal) => {
      const payload = features.map((feature) => ({
        id: feature.id,
        title: feature.title,
        description: feature.description,
        dependencies: feature.dependencies,
        plan: feature.plan,
        tasks: feature.tasks.map((task) => task.title),
      }))
      const system = this.agentInstructions(p, 'planner', modelId) + ' 你是软件项目执行规划器。只规划顺序，不修改代码。根据功能依赖、方案和任务，给出可执行的顺序。必须返回 JSON：{"orderedFeatureIds":["功能ID"],"rationale":"中文说明"}。orderedFeatureIds 必须逐字复制 allowedFeatureIds 中的全部 ID，每个恰好一次，不能使用名称、缩写或上下文中的其他 ID。context 仅供背景参考，不得增加已完成或未勾选功能。已选前置功能必须排在依赖它的功能之前；未选中的依赖已完成，无需加入顺序。优先安排能为其他功能提供基础的功能。'
      const messages: ModelMessage[] = [{ role: 'user', content: JSON.stringify({
        project: p.name, features: payload, context: this.agentContext(p), allowedFeatureIds: ids,
      }) }]
      let orderedFeatureIds = dependencyOrder
      let rationale = '模型未返回有效的执行顺序，已使用本地依赖排序；仅包含本次勾选的功能，依赖满足时保留勾选顺序。请确认后开始执行。'
      let plannedByModel = false
      for (let attempt = 0; attempt < 2; attempt++) {
        // Transport failures and cancellation must remain errors, not trigger a local plan.
        const reply = await completeWithContext(connection, system, messages, p, signal, undefined, [], this.agentSkillReader(p, 'planner'))
        signal.throwIfAborted()
        try {
          const parsed = parseJson(reply.text)
          if (!Array.isArray(parsed?.orderedFeatureIds)) throw new Error('LLM 没有返回有效的执行顺序。')
          const candidate: string[] = parsed.orderedFeatureIds.map((id: unknown) => text(id, '功能 ID', 120))
          if (candidate.length !== ids.length || new Set(candidate).size !== ids.length || candidate.some((id) => !selected.has(id)))
            throw new Error('LLM 返回的执行顺序与已选功能不一致。')
          const order = new Map(candidate.map((id, index) => [id, index]))
          for (const feature of features) {
            if (feature.dependencies.some((id) => selected.has(id) && order.get(id)! >= order.get(feature.id)!))
              throw new Error('LLM 返回的顺序违反功能依赖。')
          }
          const explanation = text(parsed.rationale, '规划说明', 6000)
          if (!explanation) throw new Error('LLM 没有返回规划说明。')
          orderedFeatureIds = candidate
          rationale = explanation
          plannedByModel = true
          break
        } catch {
          if (attempt === 0) {
            this.store.event(p, 'plan', '模型执行顺序未通过校验，正在自动纠正一次。')
            messages.push({ role: 'assistant', content: reply.text.slice(0, 8000) }, {
              role: 'user',
              content: JSON.stringify({
                instruction: '上次结果未通过校验。请重新返回 JSON，orderedFeatureIds 只能使用以下完整 ID，每个恰好一次，并满足依赖顺序；rationale 必须是非空中文说明。',
                allowedFeatureIds: ids,
                dependencies: features.map(({ id, dependencies }) => ({ id, dependencies: dependencies.filter((id) => selected.has(id)) })),
              }),
            })
          }
        }
      }
      signal.throwIfAborted()
      const plan: ExecutionPlan = {
        id: uid(),
        featureIds: ids,
        orderedFeatureIds,
        rationale,
        currentIndex: 0,
        status: 'planned',
        at: now(),
      }
      p.executionPlan = plan
      this.store.event(
        p,
        'plan',
        `${plannedByModel ? 'LLM 已规划' : '模型纠正后仍未通过校验，已使用本地依赖排序生成'} ${orderedFeatureIds.length} 个功能的执行顺序：${orderedFeatureIds
          .map((id) => this.feature(p, id).title)
          .join(' → ')}`,
      )
      return plan
    })
  }
  runExecutionPlan = (projectId: string): Promise<void> => {
    const p = this.store.project(projectId)
    this.idle(p)
    const plan = p.executionPlan
    if (!plan) throw new Error('请先创建 LLM 执行计划。')
    if (plan.status === 'running') throw new Error('执行计划正在运行，请等待当前功能完成。')
    if (plan.status === 'completed') throw new Error('执行计划已完成。')
    if (plan.status === 'waiting-acceptance') throw new Error('请先验收当前功能，再继续执行计划。')
    if (plan.currentIndex >= plan.orderedFeatureIds.length) {
      plan.status = 'completed'
      this.save(p)
      return Promise.resolve()
    }
    const next = this.feature(p, plan.orderedFeatureIds[plan.currentIndex])
    if (!['ready', 'blocked'].includes(next.stage)) throw new Error(`「${next.title}」当前不在待开发阶段。`)
    plan.status = 'running'
    this.save(p)
    try {
      this.runFeature(projectId, next.id)
    } catch (error) {
      plan.status = 'stopped'
      this.save(p)
      throw error
    }
    return Promise.resolve()
  }
  private sourceSnapshot(project: Project): string {
    return sourceFingerprint(project.root)
  }
  private sourceFingerprint(project: Project): string {
    return this.sourceSnapshot(project)
  }
  private executionFingerprint(p: Project, f: Feature): string {
    const agents = [this.agent(f.developerId, 'developer', p.id), this.agent(f.reviewerId, 'reviewer', p.id)]
    return createHash('sha256').update(JSON.stringify({
      verificationWorkflow: 'preparation-v4', root: p.root, revision: f.revision, title: f.title, description: f.description,
      criteria: f.criteria, plan: f.plan, tasks: f.tasks.map(t => [t.id, t.title]),
      dependencies: f.dependencies, feedback: f.feedback, prototype: pinnedPrototype(p, f),
      context: p.context, targets: p.targets ?? [], baseline: p.requirementsBaseline,
      agents: agents.map(agent => ({ agent, reasoning: this.agentModel(agent).reasoning, skills: agentSkills(agent, this.store.skills()).snapshots,
        model: this.store.data.models.filter(m => m.id === agent.modelId).map(({ cipher: _key, ...m }) => m) })),
    })).digest('hex')
  }
  private legacyReviewPause(p: Project, f: Feature): boolean {
    if (f.stage !== 'blocked') return false
    const events = p.events.filter(e => e.featureId === f.id)
    const start = events.map(e => e.kind).lastIndexOf('start')
    const run = events.slice(start + 1)
    const last = run.filter(e => ['error', 'stopped', 'repair', 'rejected', 'acceptance'].includes(e.kind)).at(-1)
    return !!last && last.kind === 'error' && last.message.startsWith('达到本次执行的 36 步上限')
      && run.some(e => e.kind === 'verification')
  }
  private async agentLoop(
    p: Project,
    f: Feature,
    agent: AgentConfig,
    feedback: string,
    signal: AbortSignal,
    progress?: { resume?: ExecutionCheckpoint; development?: string; sourceFingerprint?: string; role?: ExecutionRole; environmentFingerprint?: string },
  ): Promise<{ text: string; commands: CommandEvidence[] }> {
    const role = progress?.role ?? agent.role as ExecutionRole,
      connection = this.agentModel(agent),
      commands: CommandEvidence[] = progress?.resume?.commands ?? []
    const skillInstructions = this.agentInstructions(p, agent.role, agent.modelId, f, agent)
    if (p.agentRuns?.length) p.agentRuns[p.agentRuns.length - 1].executionPhase = role
    const readSkill = this.agentSkillReader(p, agent.role, agent)
    const artifacts = new ExecutionArtifacts(this.store, p.id, f.id)
    const prototype = pinnedPrototype(p, f)
    const prototypeLength = prototype ? JSON.stringify(prototype).length : 0
    let prototypeReadUntil = progress?.resume?.prototypeReadUntil ?? 0
    const schema = JSON.stringify({
      summary: '结论',
      results: [{ criterion: '原验收条件逐字保留', passed: false, status: 'unverified', evidence: '实际证据；若缺条件，说明具体缺口', evidenceKind: 'unit / mock / application / desktop / duration / history / inspection 中的一种', commandIds: ['本轮命令返回的 evidenceId'], measuredDurationSeconds: 5 }],
      ...(prototype ? { prototypeReview: { prototypeId: prototype.id, passed: false, status: 'unverified', evidence: '逐项说明页面结构、关键交互与原型的对应文件和检查结果；未实测视觉需明确说明。' } } : {}),
    })
    const rolePrompt =
      role === 'diagnoser' || role === 'preparer' ? preparationPrompt(role) : role === 'developer'
        ? '实现完整可运行功能；首次从零建立网页工程时提供 npm run dev、build、test，测试须真实验证行为，执行 npm install 和必要检查。最终返回 JSON {"status":"complete 或 incomplete","summary":"实际修改和检查结论","nextStep":"后续动作或具体阻塞"}。只有本轮实现和必要检查已完成且无需继续开发工具时才用 complete；仍需修改、排查或运行检查必须用 incomplete，不得把进度总结当作开发交付。'
        : `只检查实际工程，不得修改源代码、测试代码或通过降低测试标准使检查通过。必须运行实际测试（npm test、npm run test:* 或项目中的 test 脚本）并按需构建。最后只输出 JSON ${schema}，覆盖每一项标准，passed 为布尔值；无法确认的标 false。measuredDurationSeconds 仅 duration 项填写，必须是 JSON 数字（示例 5 不代表实际值），按单个实例的连续实测秒数填写；并行模式不能相加，分别保留原始 measurements，不混淆持久化和外部观察延迟。`
    const system = `你是 Coprojer 的${role === 'developer' ? '开发' : '验证'}智能体。\n${skillInstructions}\n当前项目根目录：${p.root}。操作仅限当前项目。只能通过已提供工具执行，不可声称未发生的操作。不能修改已确认目标、验收标准、.coprojer 管理资料或项目外文件。\n先使用 list_files/read_file 检查实际项目，再开展工作。使用 npm 和 Node；run_command 的参数是数组，不使用 shell 连接符。不要运行永久驻留的服务，应用通过预览按钮启动 npm run dev。\n共享上下文索引：${this.agentContext(p, f)}\n已确认功能：${JSON.stringify({ title: f.title, description: f.description, criteria: f.criteria, plan: f.plan, tasks: f.tasks.map((t) => t.title) })}\n${rolePrompt}\n上一轮反馈：${feedback || '无'}`
    const prototypeInstruction = prototype ? '\n验收原型ID：' + prototype.id + '\n必须先完整分页读取 read_context id=prototype:' + prototype.id + '（连续使用 nextOffset/version），才能修改文件或运行命令。开发必须复用该原型的页面结构、视觉样式与核心交互，替换演示数据并接入实际业务；不能自行换一套界面。校验必须对照原型检查实际文件，填写 prototypeReview，明确指出未实测的视觉与交互。用户的最终试用验收仍不可省略。' : ''
    const messages: ModelMessage[] = progress?.resume?.messages ?? [
      {
        role: 'user',
        content:
          role === 'diagnoser' ? '本轮只分析并分类给定验证缺口，不判定验收通过，不运行测试。请返回 gaps JSON；项目检查可运行的事实不因本诊断阶段只读而变成外部阻塞。'
            : role === 'preparer' ? '请只补齐给定 automatic 缺口，返回 status/summary/nextStep JSON。准备结果交回独立验证执行和判断。'
            : role === 'developer'
            ? '请开始实现并检查这个功能。'
            : '请独立核对代码，运行检查并逐项验证。',
      },
    ]
    const reviewerCommandHelp = '验证角色只允许 npm test、npm run test:* / build / typecheck / lint / check，或 node 执行项目内已有检查脚本路径；不允许 node -e、node -p、npm install 或创建脚本。查找路径用 list_files，读取内容用 read_file。已成功完成且源码未变化的同一检查不要重复运行；工具权限错误应换用允许的工具。'
    const offered = engineeringTools.filter(
      (t) =>
        agent.tools.includes(t.name as keyof typeof toolLabels) &&
        (role !== 'reviewer' || t.name !== 'write_file') &&
        (role !== 'diagnoser' || ['list_files', 'read_file', 'read_context', 'read_skill'].includes(t.name)),
    ).map(tool => role === 'reviewer' && tool.name === 'run_command' ? { ...tool, description: reviewerCommandHelp } : tool)
    const reviewerEvidenceHelp = '逐项区分 status：passed（完整证据支持，passed:true）、failed（已发现代码缺陷或检查失败，passed:false）、unverified（没有已知缺陷，仅因缺少目标平台、真实界面、测量时长或权限而未能验证，passed:false）。不能把单测/mock 当作真实桌面、跨平台或长时间测量的证据；同一标准部分未验证也不能标通过。unverified 必须在 evidence 写清缺失环境、具体检查步骤和需要补充的证据。若既发现代码缺陷又缺环境，标 failed 并先修复缺陷。仅缺验证环境时不要要求重复改写代码，也不要放宽标准。'
    const roleSystem = role === 'diagnoser' || role === 'preparer' ? system.replace('你是 Coprojer 的验证智能体。', '你是 Coprojer 的' + (role === 'diagnoser' ? '验证缺口诊断' : '验证准备') + '智能体。') : system
    const instructions = roleSystem + prototypeInstruction + (role !== 'developer' ? '\n' + interactionEvidenceBoundary : '') + (role === 'reviewer' ? '\n' + reviewerCommandHelp + '\n' + reviewerEvidenceHelp +
      '\n缺少项目内脚本、开发依赖、运行条件或实际命令证据也应为 unverified；只在确认业务缺陷/断言失败时 failed。通过项关联本轮命令 evidenceId 并填写 evidenceKind，区分 unit、mock、application、desktop、duration、history、inspection。读取历史证据只能 history，不能冒充重跑；按实际耗时说明测试，不能将短时测试写成长时通过。源码已变化的证据不能复用。条件型命令失败可在补齐后重新检查。' : '')
    const stepLimit = role === 'diagnoser' ? diagnosisStepLimit : role === 'preparer' ? preparationStepLimit : executionStepLimit
    const replyKind = role === 'diagnoser' ? 'verification-diagnosis-report' : role === 'preparer' ? 'verification-preparation-report' : role === 'reviewer' ? 'review' : 'developer'
    const executionProgress = new ExecutionProgress(progress?.resume?.progress)
    let checkpointSteps = progress?.resume?.steps ?? 0
    const saveCheckpoint = () => {
      ;(this.store.data.executionCheckpoints ??= {})[executionKey(p.id, f.id)] = { role,
        fingerprint: this.executionFingerprint(p, f), sourceFingerprint: role === 'reviewer' ? progress?.sourceFingerprint ?? this.sourceFingerprint(p) : this.sourceFingerprint(p), round: f.repairRound,
        development: progress?.development ?? '', messages: JSON.parse(this.store.redact(JSON.stringify(messages))),
        commands: commands.map(c => ({ ...c, output: this.store.redact(c.output) })), prototypeReadUntil, steps: checkpointSteps, environmentFingerprint: progress?.environmentFingerprint, progress: executionProgress.snapshot() }
      this.store.save()
    }
    const requestReply = async (prompt: string, history = messages, tools = offered) => {
      assertCompleteToolRounds(history)
      saveCheckpoint()
      const measure = (items: ModelMessage[]) => modelRequestCharacters(connection, prompt, items, tools)
      // Retain the conservative history allowance, but measure the actual wire
      // protocol and cap the complete request below the 160k character guard.
      // This is explicitly a character budget, not an invented token/window size.
      let requestBudget = Math.min(144000, measure([]) + 46000)
      for (let attempt = 0; attempt < 2; attempt++) {
        const compacted = boundMessages(history, requestBudget, { measure,
          archive: content => artifacts.write(content, '已完成工具回合与历史摘要') })
        if (compacted.compacted) this.store.event(p, 'context-compaction', '已归档历史并整理上下文（请求字符 ' + compacted.before + ' → ' + compacted.after + '），保留当前进度后继续。', f.id)
        saveCheckpoint()
        try { return await complete(connection, prompt, history, tools, signal, () => {}) }
        catch (error) {
          if (!(error instanceof ModelContextLimitError) || attempt || signal.aborted) throw error
          requestBudget = Math.floor(measure(history) * 0.6)
          this.store.event(p, 'context-compaction', '模型报告容量不足；归档已完成回合后缩减上下文重试一次，不重新执行工具。', f.id)
        }
      }
      throw new ContextBudgetError('上下文整理后仍无法继续，执行进度已保存。')
    }
    const finish = (value: string) => {
      if (prototypeReadUntil < prototypeLength) throw new Error('智能体未完整读取已验收原型，不能提交开发或校验结果。')
      delete this.store.data.executionCheckpoints?.[executionKey(p.id, f.id)]
      return { text: value, commands }
    }
    const developmentStatus = (value: string): 'complete' | 'incomplete' | undefined => {
      try {
        const report = parseJson(value)
        // An explicit incomplete signal must never fall through to legacy text completion.
        if (report.status === 'incomplete') return 'incomplete'
        if (report.status === 'complete' && typeof report.summary === 'string' && report.summary.trim()
          && typeof report.nextStep === 'string') return report.status
      } catch { /* earlier providers can still return ordinary completion text before the budget boundary */ }
      return undefined
    }
    const reportShape = (value: string): boolean => {
      if (role === 'developer') return true
      try {
        const report = parseJson(value)
        if (role === 'diagnoser') return Array.isArray(report.gaps) && (f.verificationPreparation?.gaps ?? []).every(gap =>
          report.gaps.some((g: any) => (g?.id === gap.id || g?.criterion === gap.criterion) && ['automatic', 'external', 'unknown'].includes(g.disposition) && typeof g.reason === 'string' && typeof g.nextStep === 'string'))
        if (role === 'preparer') return ['ready', 'blocked', 'defect'].includes(report.status) && typeof report.summary === 'string' && typeof report.nextStep === 'string'
        return Array.isArray(report.results) && f.criteria.every(criterion => report.results.some((r: any) => r?.criterion === criterion && typeof r.passed === 'boolean' && typeof r.evidence === 'string'))
      } catch { return false }
    }
    const reportInstruction = role === 'diagnoser' ? '这是只读缺口诊断，不是验收。按提供的每个缺口返回 gaps JSON（id/disposition/reason/nextStep），本阶段没有命令工具是职责分离，不是项目缺少运行能力。'
      : role === 'preparer' ? '这是验证准备，返回 status/summary/nextStep JSON，不判定验收通过。'
        : '这是独立验证，逐字保留验收条件，返回约定 results JSON；通过项必须关联本轮实际命令，不能用历史资料冒充重跑。'
    for (let step = (role === 'preparer' || role === 'diagnoser') ? progress?.resume?.steps ?? 0 : 0; step < stepLimit; step++) {
      signal.throwIfAborted()
      this.store.event(
        p,
        'model',
        `${agent.name} · ${connection.model} · 第 ${step + 1} 步`,
        f.id,
      )
      // Agent work can include long reasoning and many tool calls. Passing a
      // listener makes `complete` request SSE immediately, so a provider can
      // send headers and progress before the final tool-call payload is ready.
      // Individual deltas are intentionally not persisted as activity events:
      // tool boundaries and final replies remain the durable engineering log.
      checkpointSteps = step
      const budget = `\n本次最多 ${stepLimit} 个工作回合，当前第 ${step + 1} 步。` + (step >= stepLimit - 3
        ? `即将到达预算，请收束检查并提交结论；不能确认的验收项应明确标为 false，不得编造通过。已完成检查：${commands.map(c => `${c.command} (exit ${c.code})`).join('；') || '无'}。` : '')
      const ledger = role === 'reviewer' && commands.length
        ? '\n本轮持久检查台账（即使早期工具消息被压缩，以下实际执行仍有效；不能把 history 当新实测）：\n' +
          commands.map(c => JSON.stringify({ id: c.id, command: c.command, code: c.code, kinds: commandEvidenceKinds(c), durationMs: c.durationMs,
            measurements: c.measurements, output: c.output.slice(-1000) })).join('\n') + '\n已成功完成且源码未变化的命令无需重跑。已有足够证据时立即给出逐项 JSON；缺少桌面证据则标明具体缺口并交给诊断，不继续重复阅读同一文件。'
        : ''
      const reply = await requestReply(instructions + budget + ledger + (executionProgress.warning ? '\n' + executionProgress.warning : ''))
      signal.throwIfAborted()
      if (reply.text)
        this.store.event(p, replyKind, reply.text, f.id)
      messages.push({
        role: 'assistant',
        content: reply.text,
        calls: reply.calls,
        reasoning: reply.reasoning,
        responseItems: reply.responseItems,
        anthropicBlocks: reply.anthropicBlocks,
      })
      if (!reply.calls.length) {
        if (role === 'developer' && (developmentStatus(reply.text) === 'incomplete' || !reply.text.trim())) {
          checkpointSteps = step + 1
          saveCheckpoint()
          throw new ExecutionProgressPause('开发明确未完成，仍有待处理工作')
        }
        if (!reportShape(reply.text)) {
          this.store.event(p, 'verification-report-format', '结论格式不完整，基于已有记录整理一次结构化报告，不再执行工具。', f.id)
          const corrected = await requestReply(instructions, [...messages, { role: 'user',
            content: reportInstruction + '刚才的回复格式不完整；只整理已有事实，不编造通过，也不要增加测试要求。此回合不提供工具。' }], [])
          signal.throwIfAborted()
          if (!corrected.calls.length && reportShape(corrected.text)) {
            this.store.event(p, replyKind, corrected.text, f.id)
            return finish(corrected.text)
          }
        }
        return finish(reply.text)
      }
      if ((role === 'diagnoser' || role === 'preparer') && reply.calls.length > 8)
        throw new Error('验证准备单轮工具调用超过 8 次，已停止，避免无界批量执行。')
      // The last balanced checkpoint must not be replayed after partial effects.
      // A new checkpoint is saved only once all results in this batch exist.
      delete this.store.data.executionCheckpoints?.[executionKey(p.id, f.id)]
      this.store.save()
      for (const call of reply.calls) {
        signal.throwIfAborted()
        let output: string
        const beforeWrite = call.name === 'write_file' ? this.sourceFingerprint(p) : ''
        let progressSource = ''
        try {
          if (!offered.some((t) => t.name === call.name))
            throw new Error('当前角色不可使用此工具。')
          const args = parseJson(call.arguments)
          if (['write_file', 'run_command'].includes(call.name) && prototypeReadUntil < prototypeLength)
            throw new Error('请先完整分页读取已验收原型 prototype:' + prototype!.id + '；当前已连续读取到 ' + prototypeReadUntil + ' 字符。')
          this.store.event(
            p,
            'tool',
            `${call.name} ${call.name === 'write_file' || call.name === 'read_file' ? args.path : call.name === 'run_command' ? `${args.program} ${(args.args ?? []).join(' ')}` : ''}`,
            f.id,
          )
          const started = Date.now()
          const commandFingerprint = call.name === 'run_command' ? this.sourceFingerprint(p) : ''
          progressSource = commandFingerprint
          output = call.name === 'read_skill' ? readSkill(args) : await executeTool(this.store, p, f.id, role, call.name, args, signal)
          if (prototype && call.name === 'read_context' && args.id === 'prototype:' + prototype.id) {
            const page = JSON.parse(output)
            if (page.offset <= prototypeReadUntil) prototypeReadUntil = Math.max(prototypeReadUntil, page.offset + page.content.length)
          }
          if (call.name === 'run_command') {
            const result = JSON.parse(output)
            const evidenceId = 'check-' + (commands.length + 1)
            const evidenceKinds = commandEvidenceKinds(args)
            commands.push({
              ...result, id: evidenceId, at: now(), sourceFingerprint: commandFingerprint, durationMs: Date.now() - started,
              evidenceKind: evidenceKinds[0], evidenceKinds,
              failureKind: commandFailure(result.output, result.code),
              measurements: runtimeMeasurements(result.output),
              command: `${args.program} ${args.args.join(' ')}`,
              isTest:
                args.program === 'npm'
                  ? args.args[0] === 'test' ||
                    (args.args[0] === 'run' && /^test(?::|$)/.test(args.args[1] ?? ''))
                  : /(^|[/.\\_-])tests?([/.\\_-]|$)/i.test(args.args[0] ?? ''),
            })
            if (args.program === 'node' && /(^|[./_-])(smoke|check|verify|verification)([./_-]|$)/i.test(args.args[0] ?? '')) commands[commands.length - 1].isTest = true
            output = JSON.stringify({ ...result, evidenceId, evidenceKinds, measurements: commands.at(-1)?.measurements, sourceFingerprint: commandFingerprint, durationMs: Date.now() - started })
          }
        } catch (error) {
          if (error instanceof PreparationBoundaryError) throw error
          output = `工具错误：${error instanceof Error ? error.message : String(error)}`
        }
        output = this.store.redact(output)
        executionProgress.observe(call.name, call.arguments, output, progressSource,
          call.name === 'write_file' && beforeWrite !== this.sourceFingerprint(p))
        let visible = agentToolMessage(call.name, output)
        if (visible !== output) {
          try {
            const artifactId = artifacts.write(output, '工具结果 ' + call.name)
            visible = visible.replace(/\[工具输出已截断[^\]]*\]/, '[工具结果已归档：read_context id=' + artifactId + '，按 nextOffset/version 分页读取；不要重新执行命令获取日志。]')
          } catch (error) {
            // Optional evidence storage must not discard a completed side effect.
            visible = '[归档不可用，以下仅为部分输出：' + this.store.redact(String(error)) + ']\n' + visible
            this.store.event(p, 'archive-warning', String(error), f.id)
          }
        }
        messages.push({ role: 'tool', content: visible, callId: call.id })
        this.store.event(p, 'tool-result', output, f.id)
        if (role === 'preparer') {
          const attempt = f.verificationPreparation?.attempts.at(-1)
          if (attempt) attempt.actions.push(`${call.name}: ${output.slice(0, 1500)}`)
          this.store.save()
        }
      }
      checkpointSteps = step + 1
      saveCheckpoint()
      if (executionProgress.pauseReason) throw new ExecutionProgressPause(executionProgress.pauseReason)
      if (executionProgress.warning) this.store.event(p, 'execution-warning', executionProgress.warning, f.id)
    }
    // Preserve only balanced, completed tool rounds. The summary-only request
    // cannot run tools and is not appended if a provider ignores that constraint.
    checkpointSteps = stepLimit
    saveCheckpoint()
    signal.throwIfAborted()
    this.store.event(p, 'model', `${agent.name} · 工作步数已用完，整理最终结论（不再执行工具）。`, f.id)
    const conclusion = await requestReply(instructions, [...messages, { role: 'user',
      content: '本次工作步数已用完。本回合仅整理已有实际证据，不提供任何工具。若足以提交，请按约定格式给出最终结论，无法确认的验收项标为 false；不要声称未执行的检查。若仍需要工具则说明尚缺工作，下次从已保存的进度继续。' + (role === 'developer' ? '开发必须返回 status/summary/nextStep JSON，尚缺实现或自测用 incomplete；只有确实已完成才用 complete。普通文字总结不能触发交付。' : ''),
    }], [])
    signal.throwIfAborted()
    let valid = !!conclusion.text.trim() && !conclusion.calls.length && prototypeReadUntil >= prototypeLength
    if (valid && role === 'developer') valid = developmentStatus(conclusion.text) === 'complete'
    if (valid && (role === 'diagnoser' || role === 'preparer')) valid = reportShape(conclusion.text)
    if (valid && role === 'reviewer') {
      try {
        const result = parseJson(conclusion.text)
        valid = Array.isArray(result.results) && f.criteria.every(criterion =>
          result.results.some((r: any) => r?.criterion === criterion && typeof r.passed === 'boolean' && typeof r.evidence === 'string' && r.evidence.trim()))
      } catch { valid = false }
    }
    if (valid) {
      this.store.event(p, replyKind, conclusion.text, f.id)
      return finish(conclusion.text)
    }
    if (conclusion.text.trim() && !conclusion.calls.length) {
      messages.push({ role: 'assistant', content: conclusion.text, reasoning: conclusion.reasoning,
        responseItems: conclusion.responseItems, anthropicBlocks: conclusion.anthropicBlocks })
      this.store.event(p, replyKind, conclusion.text, f.id)
      saveCheckpoint()
    }
    throw new ExecutionBudgetPause(role)
  }
  private async prepareVerification(p: Project, f: Feature, developer: AgentConfig, reviewer: AgentConfig,
    signal: AbortSignal, development: string, resume?: ExecutionCheckpoint): Promise<'recheck' | 'blocked' | 'defect'> {
    const fingerprint = this.sourceFingerprint(p), contract = verificationContract(p, f)
    const state = f.verificationPreparation ??= { phase: 'diagnosing', round: 0, limit: preparationRoundLimit, gaps: [],
      summary: '', sourceFingerprint: fingerprint, contractFingerprint: contract, attempts: [] }
    state.limit = preparationRoundLimit
    state.sourceFingerprint = fingerprint
    state.contractFingerprint = contract
    f.verificationPending = true
    const environment = verificationEnvironment(p), environmentFingerprint = digest({
      platform: environment.platform, arch: environment.arch, runtime: environment.runtime, desktop: environment.desktop,
    })
    state.environment = environment; state.environmentCheckedAt = now()
    if (resume && resume.environmentFingerprint !== environmentFingerprint) {
      this.store.event(p, 'verification-diagnosis', '当前工具/桌面环境与保存断点不同，丢弃旧准备会话并重新诊断；保留已完成动作及预算。', f.id)
      if (state.attempts.at(-1)?.status === 'running') state.attempts.at(-1)!.status = 'interrupted'
      resume = undefined
    }
    const block = (summary: string) => {
      state.phase = 'blocked'; state.summary = this.store.redact(summary)
      this.store.event(p, 'verification-blocked', state.summary, f.id)
      return 'blocked' as const
    }
    let attempt = resume?.role === 'preparer' ? state.attempts.at(-1) : undefined
    if (!attempt) {
      state.phase = 'diagnosing'
      if (resume?.role !== 'diagnoser' || !state.gaps.length) state.gaps = pendingGaps(f)
      state.summary = '正在核对实际工程、可用工具和运行条件，分析验证缺口。'
      p.activity = `分析验证缺口「${f.title}」`
      this.store.event(p, 'verification-diagnosis', state.summary, f.id)
      const diagnosis = await this.agentLoop(p, f, reviewer, JSON.stringify({ gaps: state.gaps, environment,
        checks: (f.verificationChecks ?? []).map(c => ({ id: c.id, command: c.command, code: c.code, evidenceKinds: commandEvidenceKinds(c), output: c.output.slice(-1200) })),
        previous: state.attempts.map(a => ({ result: a.result, nextStep: a.nextStep, status: a.status })) }), signal,
        { role: 'diagnoser', development, resume: resume?.role === 'diagnoser' ? resume : undefined, environmentFingerprint })
      signal.throwIfAborted()
      let report: any = {}
      try { report = parseJson(diagnosis.text) } catch { /* Remain unknown, never invent a manual requirement. */ }
      state.gaps = diagnosedGaps(state.gaps, report.gaps, environment,
        state.attempts.some(a => a.environmentFingerprint === environmentFingerprint && (a.afterFingerprint === fingerprint || a.beforeFingerprint === fingerprint)))
      if (!state.gaps.some(g => g.disposition === 'automatic')) {
        return block(state.gaps.map(g => `${g.criterion}：${g.disposition === 'external' ? '外部条件' : '技术诊断未完成'}；${g.reason} 下一步：${g.nextStep}`).join('\n'))
      }
      const key = digest({ gaps: state.gaps.filter(g => g.disposition === 'automatic').map(g => g.id).sort(), fingerprint, contract, environment })
      if (state.attempts.some(a => a.key === key)) return block('相同缺口、源码和环境已尝试准备，未发现新的进展；停止重复执行。请查看上次实际结果，条件变化后继续验证。')
      if (state.round >= preparationRoundLimit) return block(`验证准备已用完 ${preparationRoundLimit} 轮独立预算，保留实际动作和技术阻塞；不增加代码修复轮次。补齐剩余条件后可继续验证。`)
      attempt = { id: uid(), at: now(), key, round: ++state.round, status: 'running', beforeFingerprint: fingerprint,
        environmentFingerprint,
        actions: [], result: '', nextStep: '' }
      state.attempts.push(attempt)
    }
    state.phase = 'preparing'; attempt.status = 'running'
    state.summary = '正在自动补齐：' + state.gaps.filter(g => g.disposition === 'automatic').map(g => g.nextStep).join('；')
    p.activity = `准备验证条件「${f.title}」`
    this.store.event(p, 'verification-preparation', `${state.summary}（准备 ${state.round}/${state.limit} 轮；代码修复 ${f.repairRound}/3）`, f.id)
    const prepared = await this.agentLoop(p, f, developer, JSON.stringify({ gaps: state.gaps, environment,
      previous: state.attempts.map(a => ({ result: a.result, nextStep: a.nextStep, actions: a.actions })) }), signal,
      { role: 'preparer', development, resume: resume?.role === 'preparer' ? resume : undefined, environmentFingerprint })
    signal.throwIfAborted()
    let report: any = {}
    try { report = parseJson(prepared.text) } catch { /* Invalid preparation report is a technical block. */ }
    attempt.afterFingerprint = this.sourceFingerprint(p)
    attempt.result = this.store.redact(typeof report.summary === 'string' ? report.summary.slice(0, 6000) : '准备回复缺少结构化实际结果。')
    attempt.nextStep = this.store.redact(typeof report.nextStep === 'string' ? report.nextStep.slice(0, 3000) : '检查准备记录和技术阻塞后继续验证。')
    if (report.status === 'defect' && attempt.result.trim()) {
      attempt.status = 'defect'; state.phase = 'blocked'
      state.summary = '准备诊断发现业务缺陷，移交原代码修复流程：' + attempt.result
      f.feedback = state.summary + '\n' + attempt.nextStep
      f.verificationPending = false
      this.store.event(p, 'verification-preparation', state.summary, f.id)
      return 'defect'
    }
    const progress = attempt.beforeFingerprint !== attempt.afterFingerprint || prepared.commands.some(c => c.code === 0)
    attempt.status = report.status === 'ready' && progress ? 'ready' : 'failed'
    if (!progress) return block('验证准备未产生可检查的进展。' + attempt.result + '\n下一步：' + attempt.nextStep)
    // Even partial preparation is independently checked before reporting the
    // remaining external/technical gaps. A preparer's prose is never evidence.
    state.phase = 'rechecking'; state.summary = '准备动作已保存，正在独立重新执行检查；准备报告不代表验证通过。'
    this.store.event(p, 'verification-recheck', state.summary, f.id)
    return 'recheck'
  }
  private executionAgents(feature: Feature, projectId: string): { developer: AgentConfig; reviewer: AgentConfig } {
    const developer = this.agent(feature.developerId, 'developer', projectId),
      reviewer = this.agent(feature.reviewerId, 'reviewer', projectId)
    if (!developer.tools.includes('write_file') && !developer.tools.includes('run_command'))
      throw new Error('开发智能体需要文件修改或命令工具。')
    if (!reviewer.tools.includes('run_command'))
      throw new Error('验证智能体需要命令工具以运行真实测试。')
    return { developer, reviewer }
  }
  runFeature = (projectId: string, featureId: string, reviewOnly = false) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (!['ready', 'blocked'].includes(f.stage)) throw new Error('请先确认需求与方案。')
    if (reviewOnly && (f.stage !== 'blocked' || (!f.results.length && !f.verificationPending)))
      throw new Error('仅可重新验证已有校验记录的暂停功能。')
    if (f.scope !== 'current') throw new Error('只有本期功能可以启动开发；暂缓或合并的历史记录不应重复执行。')
    // Older discussion records encoded merges in the title instead of a structured field.
    // Only honor an explicit legacy marker when it resolves to exactly one other feature.
    const mergedId = /历史记录[，,]\s*已合并至\s+([a-zA-Z0-9-]+)/.exec(f.title)?.[1]
    const mergedTargets = mergedId
      ? p.features.filter(other => other.id !== f.id && other.id.startsWith(mergedId))
      : []
    if (mergedTargets.length === 1)
      throw new Error(`此功能是已合并的历史记录，请执行「${mergedTargets[0].title}」（${mergedTargets[0].id}）。`)
    if (!existsSync(p.root) || !lstatSync(p.root).isDirectory())
      throw new Error(`项目目录不存在或不是文件夹：${p.root}。请恢复或重新关联正确目录后再启动。`)
    if (p.features.some((other) => other.id !== f.id && other.stage === 'acceptance'))
      throw new Error('请先验收上一项功能，再开始下一项。')
    if (f.dependencies.some((id) => this.feature(p, id).stage !== 'done'))
      throw new Error('前置功能尚未验收完成。')
    const { developer, reviewer } = this.executionAgents(f, p.id)
    const key = executionKey(p.id, f.id)
    const saved = f.stage === 'blocked' ? this.store.data.executionCheckpoints?.[key] : undefined
    const resume = saved && saved.fingerprint === this.executionFingerprint(p, f)
      && saved.sourceFingerprint === this.sourceFingerprint(p) ? saved : undefined
    const legacyReview = !saved && this.legacyReviewPause(p, f)
    const pendingReview = f.stage === 'blocked' && (f.verificationPending === true || reviewOnly)
    const continueReview = !!saved && saved.role !== 'developer' || legacyReview || pendingReview
    const firstRound = saved?.round ?? (legacyReview || pendingReview ? f.repairRound : 0)
    this.begin(
      p,
      `${continueReview ? '继续验证' : resume ? '继续开发' : '实现'}「${f.title}」`,
      async (signal) => {
        // A checkpoint is consumed once. Interrupted partial tool work must not
        // replay an older conversation as though those side effects never ran.
        delete this.store.data.executionCheckpoints?.[key]
        if (saved || legacyReview || pendingReview) this.store.event(p, 'resume', resume
          ? `恢复${continueReview ? '验证' : '开发'}进度，保留已完成的工具记录与检查证据。`
          : continueReview ? '继续独立验证：工程、任务或配置已变化，或旧版未保存完整会话；重新读取并运行检查，不重复开发。'
            : '工程、任务或配置已变化，重新读取工程后继续开发。', f.id)
        f.repairRound = firstRound
        if (continueReview && p.executionPlan?.status === 'stopped' && p.executionPlan.orderedFeatureIds[p.executionPlan.currentIndex] === f.id)
          p.executionPlan.status = 'running'
        let preparationResume = resume && ['preparer', 'diagnoser'].includes(resume.role) ? resume : undefined
        let reviewerResume = resume?.role === 'reviewer' ? resume : undefined
        const initialResults = f.results
        f.results = []
        f.prototypeResult = undefined
        let feedback = f.feedback
        for (let round = firstRound; round <= 3; round++) {
          signal.throwIfAborted()
          f.repairRound = round
          let development = { text: saved?.development || '旧版执行已进入独立验证；当前检查以实际工程为准。' }
          if (round !== firstRound || !continueReview) {
            f.verificationPending = false
            f.stage = 'developing'
            this.store.save()
            development = await this.agentLoop(p, f, developer, feedback, signal, {
              resume: round === firstRound && resume?.role === 'developer' ? resume : undefined,
            })
          }
          f.stage = 'verifying'
          let preparationDefect = false
          if (preparationResume) {
            const outcome = await this.prepareVerification(p, f, developer, reviewer, signal, development.text, preparationResume)
            preparationResume = undefined
            if (outcome === 'blocked') { this.pauseVerification(p, f); return }
            preparationDefect = outcome === 'defect'
          }
          while (!preparationDefect) {
            p.activity = f.verificationPreparation ? `重新独立验证「${f.title}」` : `独立验证「${f.title}」`
            if (f.verificationPreparation) f.verificationPreparation.phase = 'rechecking'
            this.store.event(p, 'verification', round === firstRound && continueReview ? '继续独立验证。' : '开发已提交，开始独立验证。', f.id)
            const beforeReview = this.sourceSnapshot(p)
            // New verification helpers are not a repair of a known application
            // failure. Carry that evidence across preparation-only changes.
            const failureSources = new Set([beforeReview])
            for (const attempt of [...(f.verificationPreparation?.attempts ?? [])].reverse()) {
              if (attempt.afterFingerprint && failureSources.has(attempt.afterFingerprint)) failureSources.add(attempt.beforeFingerprint)
            }
            const unresolvedChecks = (f.verificationChecks ?? []).filter(c => failureSources.has(c.sourceFingerprint) &&
              c.code !== 0 && commandFailure(c.output, c.code) === 'check')
            const previousResults = f.results.length ? f.results : initialResults
            const retainedFailures = new Map<string, CommandEvidence>()
            const recheckFeedback = f.verificationPreparation?.attempts.length ? JSON.stringify({
              instruction: '以下仅是准备阶段的交接，不是通过证据。先读取新增/修复的检查脚本，再独立实际执行 nextStep 指定检查；不能只运行 history 证据核对来代替实机重跑。按本轮命令的真实证据类型关联验收项。',
              gaps: f.verificationPreparation.gaps,
              preparation: f.verificationPreparation.attempts.map(a => ({ result: a.result, nextStep: a.nextStep, files: a.actions.filter(action => action.startsWith('created:')) })),
            }) : ''
            const reviewerFeedback = [recheckFeedback, unresolvedChecks.length ? '当前源码仍有未解决的实际检查失败，准备/开发的文字报告不能消除它；必须重新执行同一检查确认。' +
              JSON.stringify(unresolvedChecks.map(c => ({ command: c.command, output: c.output.slice(-1800), at: c.at }))) : ''].filter(Boolean).join('\n')
            const verification = await this.agentLoop(p, f, reviewer, reviewerFeedback, signal, {
              resume: round === firstRound ? reviewerResume : undefined,
              development: development.text,
              sourceFingerprint: beforeReview,
            })
            reviewerResume = undefined
            signal.throwIfAborted()
            // A round with no check, or only unrelated checks, must not erase
            // a known failure against unchanged source. Preserve its original
            // timestamp; this is retained evidence, never a newly executed check.
            for (const previous of unresolvedChecks) {
              const replaced = verification.commands.some(c => c.command === previous.command && c.sourceFingerprint === beforeReview &&
                (c.code === 0 || commandFailure(c.output, c.code) === 'check'))
              if (!replaced) {
                const retained: CommandEvidence = { ...previous, id: 'unresolved-' + digest(previous.command).slice(0, 12), isTest: false, failureKind: 'check' }
                verification.commands.push(retained); retainedFailures.set(previous.id, retained)
              }
            }
            const changed = beforeReview !== this.sourceSnapshot(p)
            let result: any
            try {
              result = parseJson(verification.text)
            } catch {
              result = { summary: '验证回复格式无效，不能判定通过。', results: [] }
            }
            const currentChecks = currentCommandEvidence(verification.commands)
            const hasTest = currentChecks.some((command) => command.isTest)
            const failedCheck = currentChecks.some(c => c.code !== 0 && (c.failureKind ?? commandFailure(c.output, c.code)) === 'check')
            if (currentChecks.length !== verification.commands.length)
              this.store.event(p, 'verification-retry', `${verification.commands.length - currentChecks.length} 条先前失败已有相同源码、命令和证据范围的后续实跑通过；原失败保留在命令记录中。`, f.id)
            f.verificationChecks = verification.commands.map(c => ({ id: c.id || '', command: c.command, code: c.code,
              output: this.store.redact(c.output), sourceFingerprint: c.sourceFingerprint || beforeReview, at: c.at || now(),
              durationMs: c.durationMs || 0, evidenceKind: c.evidenceKind, evidenceKinds: commandEvidenceKinds(c), measurements: c.measurements, runId: c.runId }))
            const evidence = hasTest && currentChecks.every(c => c.code === 0) && !changed
            f.verificationPending = false
            f.results = f.criteria.map((criterion) => {
              const item = Array.isArray(result.results)
                ? result.results.find((r: any) => r?.criterion === criterion)
                : null
              const linked = Array.isArray(item?.commandIds) ? verification.commands.filter(c => item.commandIds.includes(c.id)) : verification.commands
              const previousResult = previousResults.find(r => r.criterion === criterion && r.status === 'failed' && r.sourceFingerprint && failureSources.has(r.sourceFingerprint))
              for (const id of previousResult?.commandIds ?? []) {
                const retained = retainedFailures.get(id)
                if (retained && !linked.includes(retained)) linked.push(retained)
              }
              const failedItemCheck = linked.some(c => c.code !== 0 && (c.failureKind ?? commandFailure(c.output, c.code)) === 'check')
              const specificEvidence = !changed && linked.some(c => c.isTest) && linked.every(c => c.code === 0 && (!c.sourceFingerprint || c.sourceFingerprint === beforeReview))
              const kindMatches = !['application', 'desktop', 'duration'].includes(item?.evidenceKind) || linked.some(c => commandEvidenceKinds(c).includes(item.evidenceKind))
              const measurements = linked.filter(c => c.code === 0 && commandEvidenceKinds(c).includes('duration')).flatMap(c => c.measurements ?? [])
              const measuredDurationSeconds = measuredDuration(item?.measuredDurationSeconds)
              const durationMatches = item?.evidenceKind !== 'duration' || (measuredDurationSeconds !== undefined &&
                (!measurements.length || measuredDurationSeconds <= Math.max(...measurements.map(m => m.durationSeconds))) &&
                measuredDurationSeconds * 1000 <= linked.filter(c => commandEvidenceKinds(c).includes('duration')).reduce((sum, c) => sum + (c.durationMs || 0), 0))
              const nativeEvidence = nativeEvidenceSupported(criterion, item) && linked.every(c =>
                nativeEvidenceSupported(criterion, { evidenceKind: item?.evidenceKind, evidence: c.output }))
              const itemEvidence = specificEvidence && kindMatches && durationMatches && nativeEvidence && (item?.commandIds === undefined || linked.length === item.commandIds.length && linked.length > 0)
                && item?.evidenceKind !== 'history' && linked.some(c => c.isTest && !commandEvidenceKinds(c).includes('history'))
              const status = changed ? 'unverified' : failedItemCheck ? 'failed' : verificationStatus(item, itemEvidence)
              return {
                criterion,
                status,
                passed: status === 'passed',
                sourceFingerprint: beforeReview, checkedAt: now(), commandIds: linked.map(c => c.id!).filter(Boolean),
                ...(item?.evidenceKind === 'duration' ? { measurements, measuredDurationSeconds: durationMatches ? measuredDurationSeconds : undefined } : {}),
                evidenceKind: ['unit', 'mock', 'application', 'desktop', 'duration', 'history', 'inspection'].includes(item?.evidenceKind) ? item.evidenceKind : undefined,
                evidence: this.store.redact(
                  changed
                    ? '验证过程中源文件发生变化，必须重新检查。'
                    : status === 'passed' ? item?.evidenceKind === 'duration' && measurements.length
                      ? '本轮实际命令 ' + linked.filter(c => commandEvidenceKinds(c).includes('duration')).map(c => c.id).join('、') + ' 的结构化测量：' + measurementSummary(measurements) + '。各模式独立记录，时长不相加。'
                      : text(item?.evidence ?? '', '验证证据', 6000)
                    : failedItemCheck ? '关联的实际检查失败：' + linked.filter(c => c.code !== 0).map(c => c.command + '\n' + c.output.slice(-1800)).join('\n')
                    : status === 'failed' ? text(item?.evidence ?? '实际检查未通过。', '验证证据', 6000)
                    : !nativeEvidence ? '该验收项包含原生界面交互，但报告只有应用 API/菜单回调证据或承认未完成真实输入；必须补齐对应鼠标、悬停或菜单交互的实际证据，不能据此通过。'
                    : !kindMatches || !durationMatches ? '证据类型或实测时长与本轮执行不匹配，不能据此通过。'
                    : !hasTest
                      ? '缺少实际执行的测试命令。'
                      : !evidence
                        ? failedCheck ? '实际检查存在失败命令。' : '实际检查缺少运行条件，需诊断命令记录后补齐。'
                        : !itemEvidence && item?.passed === true
                          ? '缺少本轮有效命令关联，或仅检查历史证据；需要重新执行对应检查。'
                        : text(item?.evidence ?? '未提供此项证据。', '验证证据', 6000),
                ),
              }
            })
            if (f.prototypeId) {
              const review = result.prototypeReview
              const status = changed ? 'unverified' : failedCheck ? 'failed' : verificationStatus(review, evidence && review?.prototypeId === f.prototypeId)
              f.prototypeResult = { prototypeId: f.prototypeId, status, passed: status === 'passed', evidence: this.store.redact(typeof review?.evidence === 'string' ? review.evidence.slice(0, 6000) : '缺少与已验收原型的对照证据。') }
            }
            if (!failedCheck && f.results.every((r) => r.passed) && (!f.prototypeId || f.prototypeResult?.passed)) {
              f.verificationFingerprint = beforeReview
              f.verificationContractFingerprint = verificationContract(p, f)
              if (f.verificationPreparation) { f.verificationPreparation.phase = 'complete'; f.verificationPreparation.summary = '验证准备已完成，独立检查通过；仍等待最终人工验收。' }
              f.stage = 'acceptance'
              f.tasks.forEach((task) => {
                task.done = true
              })
              f.feedback = ''
              p.context.push({
                id: uid(),
                title: `工程结果：${f.title}`,
                content: `开发智能体的总结（复用前仍须核对实际文件）：\n${development.text.slice(0, 12000)}\n\n实际运行检查后的逐项验证记录：${JSON.stringify(f.results)}\n\n涉及文件：${p.changes
                  .filter((c) => c.featureId === f.id)
                  .map((c) => c.path)
                  .join('、')}\n此功能等待用户最终验收。`,
                source: `功能 ${f.id} 的开发与验证执行记录`,
                at: now(),
              })
              this.store.event(p, 'acceptance', '独立验证通过，等待你试用并最终验收。', f.id)
              const executionPlan = p.executionPlan
              if (
                executionPlan?.status === 'running' &&
                executionPlan.orderedFeatureIds[executionPlan.currentIndex] === f.id
              ) {
                executionPlan.status = 'waiting-acceptance'
                this.store.event(p, 'plan', `「${f.title}」已通过独立验证，请先最终验收后继续执行计划。`, f.id)
              }
              return
            }
            const verdict = `独立验证尚未通过：${f.results.filter(r => r.passed).length} 项通过、${f.results.filter(r => r.status === 'failed').length} 项失败、${f.results.filter(r => r.status === 'unverified').length} 项未验证。`
            const findings = f.results.map(r => `${r.criterion}：${r.status === 'passed' ? '通过' : r.status === 'failed' ? '失败' : '未验证'}；${r.evidence}`).join('\n')
            feedback = `${verdict}\n${findings}\n测试输出：${verification.commands
              .map((c) => c.output)
              .join('\n')
              .slice(-10000)}`
            if (f.prototypeResult && !f.prototypeResult.passed) feedback += '\n原型对照未通过：' + f.prototypeResult.evidence
            f.feedback = verdict + '\n' + findings + (f.prototypeResult && !f.prototypeResult.passed ? '\n原型对照：' + f.prototypeResult.evidence : '')
            const checks = [...f.results, ...(f.prototypeResult ? [f.prototypeResult] : [])]
            // Repair actual defects first while that budget is available. At
            // its limit, independent evidence gaps still get their own bounded
            // diagnosis/preparation; failures remain in the ledger and gate.
            if (checks.some(check => check.status === 'unverified') &&
              (round === 3 || !failedCheck && checks.every(check => check.passed || check.status === 'unverified'))) {
              const outcome = await this.prepareVerification(p, f, developer, reviewer, signal, development.text)
              if (outcome === 'recheck') continue
              if (outcome === 'blocked') { this.pauseVerification(p, f); return }
              preparationDefect = true
              feedback = f.feedback
            }
            break
          }
          if (preparationDefect) feedback = f.feedback
          if (f.verificationPreparation) { f.verificationPreparation.phase = 'blocked'; f.verificationPreparation.summary = '实际检查失败或已发现缺陷，交回原修复流程；验证准备预算保持不变。' }
          this.store.event(
            p,
            'repair',
            round < 3
              ? `验证未通过，将进行第 ${round + 1} 轮修复。\n${feedback}`
              : `3 轮修复后仍未通过，暂停并保留现场。\n${feedback}`,
            f.id,
          )
        }
        f.stage = 'blocked'
      },
      f,
    )
  }
  private pauseVerification(p: Project, f: Feature): void {
    f.verificationPending = true; f.stage = 'blocked'
    f.feedback = (f.verificationPreparation?.summary || '尚缺验证条件。') + '\n未验证不等于通过，不消耗代码修复轮次；条件补齐后继续验证。'
    if (p.executionPlan?.status === 'running' && p.executionPlan.orderedFeatureIds[p.executionPlan.currentIndex] === f.id) p.executionPlan.status = 'stopped'
    this.store.event(p, 'stopped', f.feedback, f.id)
  }
  deleteFeature = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (!['requirements', 'solution', 'ready'].includes(f.stage))
      throw new Error('开发、验证、待验收、已暂停或已完成的功能不能删除，请保留工程记录。')
    if (p.executionPlan?.featureIds.includes(f.id))
      throw new Error('此功能已加入执行计划，请先完成或重新规划后再删除。')
    if (p.features.some((other) => other.id !== f.id && other.dependencies.includes(f.id)))
      throw new Error('还有功能依赖此功能，请先移除依赖关系。')
    if (p.changes.some((change) => change.featureId === f.id))
      throw new Error('此功能已有工程修改记录，不能删除。')
    p.features = p.features.filter((item) => item.id !== f.id)
    this.store.event(p, 'deleted', `已删除功能「${f.title}」。`)
    this.save(p)
  }
  stop = (projectId: string) => {
    this.jobs.get(projectId)?.abort()
  }
  accept = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (f.stage !== 'acceptance') throw new Error('此功能尚未通过独立验证。')
    if (f.verificationFingerprint && (f.verificationFingerprint !== this.sourceFingerprint(p) ||
      f.verificationContractFingerprint !== verificationContract(p, f))) {
      f.stage = 'blocked'; f.verificationPending = true
      f.tasks.forEach(task => { task.done = false })
      if (f.prototypeResult) f.prototypeResult = { ...f.prototypeResult, passed: false, status: 'unverified', evidence: '工程已变化，原型对照证据需要重新检查。' }
      if (p.executionPlan?.status === 'waiting-acceptance') p.executionPlan.status = 'stopped'
      f.results = f.results.map(r => ({ ...r, passed: false, status: 'unverified', evidence: '源码、依赖锁文件或确认范围已变化，原证据已过期；请重新验证。' }))
      if (f.verificationPreparation) {
        f.verificationPreparation.phase = 'blocked'
        f.verificationPreparation.summary = '原验证证据已过期，需要重新检查当前版本。'
        f.verificationPreparation.gaps = pendingGaps(f).map(g => ({ ...g, reason: g.description, nextStep: '继续验证当前源码和确认范围。' }))
      }
      this.store.event(p, 'verification-blocked', '最终验收前检测到工程变化，需要重新独立验证。', f.id)
      this.save(p)
      throw new Error('工程已变化，旧验证证据不能用于当前最终验收。请继续验证。')
    }
    f.stage = 'done'
    this.store.event(p, 'accepted', '开发者已最终验收。', f.id)
    const executionPlan = p.executionPlan
    if (
      executionPlan?.status === 'waiting-acceptance' &&
      executionPlan.orderedFeatureIds[executionPlan.currentIndex] === f.id
    ) {
      executionPlan.currentIndex += 1
      executionPlan.status =
        executionPlan.currentIndex >= executionPlan.orderedFeatureIds.length ? 'completed' : 'planned'
      this.store.event(
        p,
        'plan',
        executionPlan.status === 'completed'
          ? 'LLM 执行计划已全部完成。'
          : '当前功能已验收，可以继续执行计划中的下一项。',
        f.id,
      )
    }
    p.context.push({
      id: uid(),
      title: `已交付：${f.title}`,
      content: `${f.description}\n验收标准：${f.criteria.join('；')}`,
      source: `用户最终验收 · ${f.id}`,
      at: now(),
    })
    this.save(p)
  }
  reject = (projectId: string, featureId: string, reason: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (f.stage !== 'acceptance') throw new Error('此功能当前不在验收阶段。')
    const feedback = text(reason, '退回原因')
    if (!feedback) throw new Error('请说明需要修正的内容。')
    f.stage = 'blocked'
    f.feedback = feedback
    f.tasks.forEach((t) => {
      t.done = false
    })
    this.store.event(p, 'rejected', feedback, f.id)
    const executionPlan = p.executionPlan
    if (
      executionPlan?.status === 'waiting-acceptance' &&
      executionPlan.orderedFeatureIds[executionPlan.currentIndex] === f.id
    ) {
      executionPlan.status = 'stopped'
      this.store.event(p, 'plan', `「${f.title}」已退回修改，执行计划已暂停。`, f.id)
    }
    this.save(p)
  }
  saveContext = (projectId: string, id: string | null, title: string, content: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const index = p.context.findIndex((c) => c.id === id)
    const existing = index >= 0 ? p.context[index] : undefined
    const item = {
      ...existing,
      id: id || uid(),
      title: text(title, '上下文标题', 120),
      content: text(content, '上下文内容', 40000),
      source: existing?.source ?? '用户编辑',
      at: now(),
      revision: (existing?.revision || 0) + 1,
    }
    if (!item.title || !item.content) throw new Error('请填写标题和内容。')
    if (index >= 0) {
      if (
        p.context[index].source.includes('用户需求确认') ||
        p.context[index].source.includes('用户最终验收')
      )
        throw new Error('已确认的需求与验收记录不能在上下文中改写，请新增补充说明。')
      p.context[index] = item
    } else p.context.push(item)
    this.save(p)
  }
  openProject = async (projectId: string) => {
    const error = await shell.openPath(this.store.project(projectId).root)
    if (error) throw new Error(error)
  }
  startPreview = async (projectId: string, script: string): Promise<string> => {
    if (this.previewStarting.has(projectId)) throw new Error('项目预览正在启动，请稍候。')
    this.previewStarting.add(projectId)
    try {
      return await this.launchPreview(projectId, script)
    } finally {
      this.previewStarting.delete(projectId)
    }
  }
  private launchPreview = async (projectId: string, script: string): Promise<string> => {
    const p = this.store.project(projectId)
    this.idle(p)
    if (this.previews.has(projectId) && p.previewUrl) return p.previewUrl
    const name = text(script, '启动脚本', 60)
    if (!/^[\w:-]+$/.test(name)) throw new Error('请输入 package.json 中的脚本名，如 dev。')
    const pkg = JSON.parse(readFileSync(safePath(p.root, 'package.json'), 'utf8'))
    if (!pkg.scripts?.[name]) throw new Error(`package.json 中没有 ${name} 脚本。`)
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const server = createServer()
      server.on('error', () =>
        rejectPort(
          new Error(`预览端口 ${p.previewPort ?? ''} 不可用，请先关闭占用它的服务后重试。`),
        ),
      )
      server.listen(p.previewPort ?? 0, '127.0.0.1', () => {
        const address = server.address()
        const value = typeof address === 'object' && address ? address.port : 0
        server.close(() => resolvePort(value))
      })
    })
    p.previewPort = port
    this.store.save()
    const command = nodeCommand('npm', [
      'run',
      name,
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ])
    const child = spawn(command.executable, command.args, {
      cwd: p.root,
      windowsHide: true,
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.previews.set(projectId, child)
    child.stdout?.on('data', (chunk) => this.store.event(p, 'preview', chunk.toString()))
    child.stderr?.on('data', (chunk) => this.store.event(p, 'preview', chunk.toString()))
    child.on('error', (error) => this.store.event(p, 'error', error.message))
    child.on('close', () => {
      if (this.previews.get(projectId) === child) {
        this.previews.delete(projectId)
        p.previewUrl = null
        this.store.save()
      }
    })
    const url = `http://127.0.0.1:${port}`
    for (let retry = 0; retry < 60; retry++) {
      if (!this.previews.has(projectId)) throw new Error('启动脚本已退出，请检查活动记录。')
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(500) })
        if (response.ok) {
          p.previewUrl = url
          this.store.save()
          return url
        }
      } catch {
        /* Server is starting. */
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    this.stopPreview(projectId)
    throw new Error('未检测到本地页面，请检查启动脚本是否支持 --host 和 --port。')
  }
  stopPreview = (projectId: string) => {
    const child = this.previews.get(projectId)
    if (child?.pid) killTree(child.pid)
    this.previews.delete(projectId)
    const p = this.store.project(projectId)
    p.previewUrl = null
    this.store.save()
  }
  openPreview = async (projectId: string) => {
    const url = this.store.project(projectId).previewUrl
    if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('请先启动预览。')
    await shell.openExternal(url)
  }
  dispose(): void {
    this.aliyun.dispose()
    this.research.dispose()
    for (const controller of this.jobs.values()) controller.abort()
    for (const child of this.previews.values()) if (child.pid) killTree(child.pid)
  }
  setProjectModel = (projectId: string, modelId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    this.model(modelId)
    p.discussionModelId = modelId
    this.save(p)
  }
  private context(project: Project): string { return assembleContext(project).text }
  private agentContext(project: Project, feature?: Feature): string { return assembleContext(project, feature).text }
  private beginResult<T>(
    project: Project,
    activity: string,
    work: (signal: AbortSignal) => Promise<T>,
    feature?: Feature,
  ): Promise<T> {
    this.idle(project)
    const controller = new AbortController()
    this.jobs.set(project.id, controller)
    project.activity = activity
    this.store.event(project, 'start', activity, feature?.id)
    return work(controller.signal)
      .catch((error) => {
        if (feature?.stage === 'verifying') feature.verificationPending = true
        if (feature && ['developing', 'verifying'].includes(feature.stage)) feature.stage = 'blocked'
        const preparation = feature?.verificationPreparation
        if (feature && preparation && ['diagnosing', 'preparing', 'rechecking'].includes(preparation.phase)) {
          preparation.phase = 'blocked'; feature.verificationPending = true
          const attempt = preparation.attempts.at(-1)
          if (attempt?.status === 'running') {
            attempt.status = controller.signal.aborted ? 'interrupted' : 'failed'
            attempt.result = this.store.redact(error instanceof Error ? error.message : String(error))
            attempt.afterFingerprint = this.sourceFingerprint(project)
            attempt.nextStep = '继续验证将核对当前工程，并恢复未完成阶段；不会重放已完成的写入。'
          }
          preparation.summary = controller.signal.aborted ? '验证准备或复验已取消，动作和现场已保存，可继续验证。'
            : '验证准备或复验遇到技术阻塞：' + (error instanceof Error ? error.message : String(error))
          feature.feedback = preparation.summary
          const key = executionKey(project.id, feature.id)
          const checkpoint = this.store.data.executionCheckpoints?.[key]
          if (error instanceof PreparationBoundaryError) delete this.store.data.executionCheckpoints?.[key]
          else if (checkpoint && checkpoint.role !== 'developer' && checkpoint.sourceFingerprint === this.sourceFingerprint(project))
            checkpoint.fingerprint = this.executionFingerprint(project, feature)
        }
        const executionPlan = project.executionPlan
        if (
          feature &&
          executionPlan?.status === 'running' &&
          executionPlan.orderedFeatureIds[executionPlan.currentIndex] === feature.id
        )
          executionPlan.status = 'stopped'
        this.store.event(
          project,
          controller.signal.aborted || error instanceof ExecutionBudgetPause || error instanceof ExecutionProgressPause || error instanceof ContextBudgetError ? 'stopped' : 'error',
          controller.signal.aborted
            ? '执行已停止，代码与记录已保留。'
            : error instanceof Error
              ? error.message
              : String(error),
          feature?.id,
        )
        throw error
      })
      .finally(() => {
        this.jobs.delete(project.id)
        project.activity = null
        try {
          this.save(project)
        } catch (error) {
          this.store.event(project, 'error', `导出工程文档失败：${String(error)}`, feature?.id)
        }
      })
  }
  private begin(
    project: Project,
    activity: string,
    work: (signal: AbortSignal) => Promise<void>,
    feature?: Feature,
  ): void {
    void this.beginResult(project, activity, async (signal) => {
      await work(signal)
    }, feature).catch(() => undefined)
  }
}
