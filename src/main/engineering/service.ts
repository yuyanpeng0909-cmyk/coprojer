import { shell } from 'electron'
import { RequirementsWorkspace } from './requirements'
import { mergeTargets } from './targets'
import type { DecisionAnswer, ProjectTarget, RoundtableConfig } from '../../shared/engineering'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type {
  AgentConfig,
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
} from './files'

function text(value: unknown, label: string, limit = 20000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label}格式无效或过长。`)
  return value.trim()
}
function lines(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 80) throw new Error(`${label}格式无效。`)
  return value.map((v) => text(v, label, 3000)).filter(Boolean)
}
export class EngineeringService {
  readonly store = new EngineeringStore()
  private research = new RequirementsWorkspace({
    store: this.store,
    model: (id) => this.model(id),
    save: (p) => this.save(p),
    context: (p) => this.context(p),
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
  state = () => this.store.snapshot()
  private idle(project: Project): void {
    if (this.jobs.has(project.id)) throw new Error('此项目正在执行，请等待完成或先停止。')
  }
  private feature(project: Project, id: string): Feature {
    const feature = project.features.find((f) => f.id === id)
    if (!feature) throw new Error('功能不存在。')
    return feature
  }
  private save(project: Project): void {
    this.store.save()
    this.store.export(project)
  }
  private connection(input: ModelInput): Connection {
    const key =
      typeof input.apiKey === 'string' && input.apiKey.trim()
        ? input.apiKey.trim()
        : this.store.key(input.id)
    if (!['chat', 'responses', 'anthropic'].includes(input.protocol))
      throw new Error('不支持的接口类型。')
    return {
      id: text(input.id, '模型 ID', 100),
      name: text(input.name, '模型名称', 100),
      baseUrl: normalizedBase(text(input.baseUrl, '服务地址', 1000)),
      model: text(input.model, '模型标识', 200),
      protocol: input.protocol,
      apiKey: key,
    }
  }
  private model(id: string): Connection {
    const model = this.store.data.models.find((m) => m.id === id)
    if (!model) throw new Error('请先新增模型，并为当前智能体选择模型。')
    return this.connection(model)
  }
  saveModel = (input: ModelInput) => {
    const c = this.connection(input)
    if (!c.name || !c.model) throw new Error('请填写显示名称和模型标识。')
    if (!c.apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.baseUrl).hostname))
      throw new Error('请填写 API Key。')
    const saved = {
      id: c.id || uid(),
      name: c.name,
      model: c.model,
      baseUrl: c.baseUrl,
      protocol: c.protocol,
      hasKey: !!c.apiKey,
      cipher: c.apiKey ? this.store.encrypt(c.apiKey) : '',
    }
    const index = this.store.data.models.findIndex((m) => m.id === saved.id)
    if (index >= 0) this.store.data.models[index] = saved
    else this.store.data.models.push(saved)
    for (const agent of this.store.data.agents) if (!agent.modelId) agent.modelId = saved.id
    this.store.save()
    const { cipher, ...publicModel } = saved
    return publicModel
  }
  deleteModel = (id: string) => {
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
    const connection = this.connection(input)
    if (!connection.model) throw new Error('请填写模型标识。')
    const result = await complete(connection, '这是连接测试。请简短回复。', [
      { role: 'user', content: '请回复：连接成功' },
    ])
    if (!result.text.trim()) throw new Error('已收到响应，但没有文本内容。请检查模型类型。')
    const safe = connection.apiKey
      ? result.text.split(connection.apiKey).join('[已隐藏密钥]')
      : result.text
    return `连接成功 · ${this.store.redact(safe).slice(0, 200)}`
  }
  listModels = (input: ModelInput) => getModels(this.connection(input))
  saveAgent = (input: AgentConfig) => {
    if (!['developer', 'reviewer'].includes(input.role)) throw new Error('智能体角色无效。')
    this.model(input.modelId)
    const tools = input.tools ?? defaultAgentTools(input.role)
    if (
      !Array.isArray(tools) ||
      tools.some(
        (name) =>
          !Object.hasOwn(toolLabels, name) || (input.role === 'reviewer' && name === 'write_file'),
      )
    )
      throw new Error('智能体工具配置无效。验证角色不提供文件修改工具。')
    const agent: AgentConfig = {
      id: input.id || uid(),
      name: text(input.name, '智能体名称', 80),
      role: input.role,
      modelId: input.modelId,
      instructions: text(input.instructions, '工作要求', 10000),
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
    const index = this.store.data.agents.findIndex((a) => a.id === agent.id)
    if (index >= 0 && this.store.data.agents[index].role !== agent.role)
      throw new Error('已有智能体不能更改职责类型，请新增智能体。')
    if (index >= 0) this.store.data.agents[index] = agent
    else this.store.data.agents.push(agent)
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
  discuss = (projectId: string, input: string) => {
    const project = this.store.project(projectId),
      message = text(input, '讨论内容')
    this.idle(project)
    if (!message) throw new Error('请输入讨论内容。')
    const connection = this.model(project.discussionModelId)
    project.chat.push({ id: uid(), role: 'user', text: message, at: now() })
    this.save(project)
    this.begin(project, '整理需求与功能图', (signal) =>
      this.research.discuss(project, connection, signal),
    )
  }
  private upsertFeature(project: Project, id: string | null, input: FeatureInput): string {
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
    f.scope = 'current'
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
    this.agent(developerId, 'developer')
    this.agent(reviewerId, 'reviewer')
    f.developerId = developerId
    f.reviewerId = reviewerId
    f.revision++
    this.store.event(p, 'agents', '已更新功能的开发与验证智能体。', f.id)
    this.save(p)
  }
  private agent(id: string, role: 'developer' | 'reviewer'): AgentConfig {
    const agent = this.store.data.agents.find((a) => a.id === id && a.role === role)
    if (!agent) throw new Error(`请选择${role === 'developer' ? '开发' : '验证'}智能体。`)
    this.model(agent.modelId)
    return { ...agent }
  }
  generatePlan = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId),
      f = this.feature(p, featureId)
    if (f.stage !== 'solution') throw new Error('请先确认需求。')
    const agent = this.agent(f.developerId, 'developer'),
      connection = this.model(agent.modelId)
    this.begin(
      p,
      `为「${f.title}」生成方案`,
      async (signal) => {
        const format = JSON.stringify({
          plan: '可实现的方案、公共模块复用、检查方式和本地启动方式',
          tasks: ['具体任务'],
        })
        const reply = await complete(
          connection,
          `你是软件方案设计者。输出中文 JSON ${format}。不改动已确认需求。首次创建项目时使用本机 npm/Node 网页技术栈，提供 npm run dev/build/test。已有文件：${JSON.stringify(listFiles(p.root))}\n共享上下文：${this.context(p)}\n职责：${agent.instructions}`,
          [
            {
              role: 'user',
              content: JSON.stringify({
                title: f.title,
                description: f.description,
                criteria: f.criteria,
                project: p.brief,
              }),
            },
          ],
          [],
          signal,
        )
        signal.throwIfAborted()
        const parsed = parseJson(reply.text)
        f.plan = text(parsed.plan, '方案', 40000)
        f.tasks = lines(parsed.tasks, '实现任务').map((title) => ({
          id: uid(),
          title,
          done: false,
        }))
        if (!f.plan || !f.tasks.length)
          throw new Error('方案缺少内容或实现任务，请重试或手动补充。')
        this.store.event(p, 'plan', '方案已生成，等待你确认。', f.id)
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
    f.tasks = lines(tasks, '实现任务').map((title) => ({ id: uid(), title, done: false }))
    this.save(p)
  }
  confirmPlan = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (f.stage !== 'solution' || !f.plan || !f.tasks.length)
      throw new Error('请先准备方案和实现任务。')
    this.executionAgents(f)
    f.stage = 'ready'
    this.store.event(p, 'confirmed', '方案与任务已确认，可以开始开发。', f.id)
    this.save(p)
  }
  private sourceSnapshot(project: Project): string {
    return JSON.stringify(
      listFiles(project.root)
        .filter((f) => !/(^package-lock\.json$|\.log$|\.tsbuildinfo$)/.test(f))
        .sort()
        .map((f) => {
          const file = safePath(project.root, f)
          return [
            f,
            lstatSync(file).size < 400_000 ? readFileSync(file, 'utf8') : lstatSync(file).mtimeMs,
          ]
        }),
    )
  }
  private async agentLoop(
    p: Project,
    f: Feature,
    agent: AgentConfig,
    feedback: string,
    signal: AbortSignal,
  ): Promise<{ text: string; commands: { code: number; output: string; isTest: boolean }[] }> {
    const role = agent.role,
      connection = this.model(agent.modelId),
      commands: { code: number; output: string; isTest: boolean }[] = []
    const schema = JSON.stringify({
      summary: '结论',
      results: [{ criterion: '原验收条件逐字保留', passed: false, evidence: '实际证据或不足' }],
    })
    const rolePrompt =
      role === 'developer'
        ? '实现完整可运行功能；首次从零建立网页工程时提供 npm run dev、build、test，测试须真实验证行为，执行 npm install 和必要检查。完成后简要报告所做修改和检查。'
        : `只检查实际工程，不得修改源代码、测试代码或通过降低测试标准使检查通过。必须运行实际测试（npm test、npm run test:* 或项目中的 test 脚本）并按需构建。最后只输出 JSON ${schema}，覆盖每一项标准，passed 为布尔值；无法确认的标 false。`
    const system = `你是 Coprojer 的${role === 'developer' ? '开发' : '验证'}智能体。\n${agent.instructions}\n当前项目根目录：${p.root}。操作仅限当前项目。只能通过已提供工具执行，不可声称未发生的操作。不能修改已确认目标、验收标准、.coprojer 管理资料或项目外文件。\n先使用 list_files/read_file 检查实际项目，再开展工作。使用 npm 和 Node；run_command 的参数是数组，不使用 shell 连接符。不要运行永久驻留的服务，应用通过预览按钮启动 npm run dev。\n共享上下文：${this.context(p)}\n已确认功能：${JSON.stringify({ title: f.title, description: f.description, criteria: f.criteria, plan: f.plan, tasks: f.tasks.map((t) => t.title) })}\n${rolePrompt}\n上一轮反馈：${feedback || '无'}`
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content:
          role === 'developer'
            ? '请开始实现并检查这个功能。'
            : '请独立核对代码，运行检查并逐项验证。',
      },
    ]
    const offered = engineeringTools.filter(
      (t) =>
        agent.tools.includes(t.name as keyof typeof toolLabels) &&
        (role !== 'reviewer' || t.name !== 'write_file'),
    )
    for (let step = 0; step < 36; step++) {
      signal.throwIfAborted()
      this.store.event(
        p,
        'model',
        `${agent.name} · ${connection.name} / ${connection.model} · 第 ${step + 1} 步`,
        f.id,
      )
      // Agent work can include long reasoning and many tool calls. Passing a
      // listener makes `complete` request SSE immediately, so a provider can
      // send headers and progress before the final tool-call payload is ready.
      // Individual deltas are intentionally not persisted as activity events:
      // tool boundaries and final replies remain the durable engineering log.
      const reply = await complete(connection, system, messages, offered, signal, () => {})
      signal.throwIfAborted()
      if (reply.text)
        this.store.event(p, role === 'reviewer' ? 'review' : 'developer', reply.text, f.id)
      messages.push({
        role: 'assistant',
        content: reply.text,
        calls: reply.calls,
        reasoning: reply.reasoning,
        responseItems: reply.responseItems,
      })
      if (!reply.calls.length) return { text: reply.text, commands }
      for (const call of reply.calls) {
        signal.throwIfAborted()
        let output: string
        try {
          if (!offered.some((t) => t.name === call.name))
            throw new Error('当前角色不可使用此工具。')
          const args = parseJson(call.arguments)
          this.store.event(
            p,
            'tool',
            `${call.name} ${call.name === 'write_file' || call.name === 'read_file' ? args.path : call.name === 'run_command' ? `${args.program} ${(args.args ?? []).join(' ')}` : ''}`,
            f.id,
          )
          output = await executeTool(this.store, p, f.id, role, call.name, args, signal)
          if (call.name === 'run_command')
            commands.push({
              ...JSON.parse(output),
              isTest:
                args.program === 'npm'
                  ? args.args[0] === 'test' ||
                    (args.args[0] === 'run' && /^test(?::|$)/.test(args.args[1] ?? ''))
                  : /(^|[/.\\_-])tests?([/.\\_-]|$)/i.test(args.args[0] ?? ''),
            })
        } catch (error) {
          output = `工具错误：${error instanceof Error ? error.message : String(error)}`
        }
        output = this.store.redact(output)
        messages.push({ role: 'tool', content: output, callId: call.id })
        this.store.event(p, 'tool-result', output, f.id)
      }
    }
    throw new Error('达到本次执行的 36 步上限，现场已保留。可调整任务或继续执行。')
  }
  private executionAgents(feature: Feature): { developer: AgentConfig; reviewer: AgentConfig } {
    const developer = this.agent(feature.developerId, 'developer'),
      reviewer = this.agent(feature.reviewerId, 'reviewer')
    if (!developer.tools.includes('write_file') && !developer.tools.includes('run_command'))
      throw new Error('开发智能体需要文件修改或命令工具。')
    if (!reviewer.tools.includes('run_command'))
      throw new Error('验证智能体需要命令工具以运行真实测试。')
    return { developer, reviewer }
  }
  runFeature = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (!['ready', 'blocked'].includes(f.stage)) throw new Error('请先确认需求与方案。')
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
    const { developer, reviewer } = this.executionAgents(f)
    this.begin(
      p,
      `实现「${f.title}」`,
      async (signal) => {
        f.repairRound = 0
        f.results = []
        let feedback = f.feedback
        for (let round = 0; round <= 3; round++) {
          signal.throwIfAborted()
          f.repairRound = round
          f.stage = 'developing'
          this.store.save()
          const development = await this.agentLoop(p, f, developer, feedback, signal)
          f.stage = 'verifying'
          this.store.event(p, 'verification', '开发已提交，开始独立验证。', f.id)
          const beforeReview = this.sourceSnapshot(p)
          const verification = await this.agentLoop(p, f, reviewer, '', signal)
          signal.throwIfAborted()
          const changed = beforeReview !== this.sourceSnapshot(p)
          let result: any
          try {
            result = parseJson(verification.text)
          } catch {
            result = { summary: '验证回复格式无效，不能判定通过。', results: [] }
          }
          const hasTest = verification.commands.some((command) => command.isTest)
          const evidence =
            hasTest && verification.commands.every((command) => command.code === 0) && !changed
          f.results = f.criteria.map((criterion) => {
            const item = Array.isArray(result.results)
              ? result.results.find((r: any) => r.criterion === criterion)
              : null
            return {
              criterion,
              passed: !!(
                evidence &&
                item?.passed === true &&
                typeof item.evidence === 'string' &&
                item.evidence.trim()
              ),
              evidence: this.store.redact(
                changed
                  ? '验证过程中源文件发生变化，必须重新检查。'
                  : !hasTest
                    ? '缺少实际执行的测试命令。'
                    : !evidence
                      ? '实际检查存在失败命令。'
                      : text(item?.evidence ?? '未提供此项证据。', '验证证据', 6000),
              ),
            }
          })
          if (f.results.every((r) => r.passed)) {
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
            return
          }
          feedback = `${result.summary ?? '验证未通过'}\n${JSON.stringify(f.results)}\n测试输出：${verification.commands
            .map((c) => c.output)
            .join('\n')
            .slice(-10000)}`
          f.feedback = feedback
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
  stop = (projectId: string) => {
    this.jobs.get(projectId)?.abort()
  }
  accept = (projectId: string, featureId: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const f = this.feature(p, featureId)
    if (f.stage !== 'acceptance') throw new Error('此功能尚未通过独立验证。')
    f.stage = 'done'
    this.store.event(p, 'accepted', '开发者已最终验收。', f.id)
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
    this.save(p)
  }
  saveContext = (projectId: string, id: string | null, title: string, content: string) => {
    const p = this.store.project(projectId)
    this.idle(p)
    const item = {
      id: id || uid(),
      title: text(title, '上下文标题', 120),
      content: text(content, '上下文内容', 40000),
      source: '用户编辑',
      at: now(),
    }
    if (!item.title || !item.content) throw new Error('请填写标题和内容。')
    const index = p.context.findIndex((c) => c.id === id)
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
  private context(project: Project): string {
    const content = project.context
      .map((c) => `[${c.title}]（来源：${c.source}）\n${c.content}`)
      .join('\n\n')
    const sources =
      '\n原始讨论与原型可通过 read_context 不填 ID 获取完整索引，再按 discussion:页码 或 prototype:ID 读取。讨论材料不覆盖已确认基线。' +
      `\n多端子项目边界（目录均相对工作区，按功能所属子项目实现）：${JSON.stringify(project.targets || [])}\n功能归属：${JSON.stringify(project.features.map((f) => ({ id: f.id, title: f.title, targetId: f.targetId })))}`
    if (content.length <= 60000) return content + sources
    return `上下文较长，以下是完整索引与最近内容。执行时请用 read_context 按 ID 读取需要复用的早期记录。\n${JSON.stringify(project.context.map(({ id, title, source }) => ({ id, title, source })))}\n最近内容：\n${content.slice(-50000)}`
  }
  private begin(
    project: Project,
    activity: string,
    work: (signal: AbortSignal) => Promise<void>,
    feature?: Feature,
  ): void {
    this.idle(project)
    const controller = new AbortController()
    this.jobs.set(project.id, controller)
    project.activity = activity
    this.store.event(project, 'start', activity, feature?.id)
    void work(controller.signal)
      .catch((error) => {
        if (feature && ['developing', 'verifying'].includes(feature.stage))
          feature.stage = 'blocked'
        this.store.event(
          project,
          controller.signal.aborted ? 'stopped' : 'error',
          controller.signal.aborted
            ? '执行已停止，代码与记录已保留。'
            : error instanceof Error
              ? error.message
              : String(error),
          feature?.id,
        )
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
}
