import type { ChatEntry, FeatureInput, Project, RoundtableConfig } from '../../shared/engineering'
import { mergeTargets } from './targets'
import { boundMessages, discussionHistory, readContext, readPage } from './context'
import { completeWithContext } from './planning'
import { requirementsFingerprint } from '../../shared/engineering'
import { extractPrototypeHtml } from '../../shared/prototype'
import { activePrototypeBriefs, designFingerprint, requirePrototypeReview, requirePrd } from '../../shared/prototype-workflow'
import {
  complete,
  parseJson,
  type Connection,
  type ModelMessage,
  type ToolDefinition,
} from './model'
import { EngineeringStore, now, uid } from './store'
import type { ModelDelta } from './stream'
import { decisionTools, RoundtableDecisions } from './roundtable-decisions'

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
})
const tools: ToolDefinition[] = [
  {
    name: 'update_project_targets',
    description:
      '建立或更新本产品的子项目边界。先明确前端、后台、移动端、IoT 等实际需要的子项目，再将功能关联到子项目 id；已有标识保持稳定，不删除旧记录。',
    parameters: schema(
      {
        targets: {
          type: 'array',
          items: schema(
            {
              id: { type: 'string' },
              name: { type: 'string' },
              kind: {
                type: 'string',
                enum: ['web', 'backend', 'admin', 'mobile', 'desktop', 'iot', 'other'],
              },
              directory: { type: 'string' },
              responsibility: { type: 'string' },
              contracts: { type: 'string' },
            },
            ['id', 'name', 'kind', 'directory', 'responsibility', 'contracts'],
          ),
        },
      },
      ['targets'],
    ),
  },
  {
    name: 'update_requirements',
    description:
      '更新完整需求文档草稿，包含产品目标、用户与场景、业务规则、范围、数据、非功能要求、开放问题和备选方案。它是讨论材料，不是确认。',
    parameters: schema({ content: { type: 'string' } }, ['content']),
  },
  {
    name: 'update_features',
    description:
      '在讨论中同步已经谈到的模块和功能草稿；不确认需求、不进入开发。只提交有变化的功能。',
    parameters: schema(
      {
        features: {
          type: 'array',
          items: schema(
            {
              id: { type: 'string' },
              targetId: {
                type: 'string',
                description: '所属子项目 id；跨端功能按子项目分别记录并说明接口。',
              },
              module: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              criteria: { type: 'array', items: { type: 'string' } },
              scope: { type: 'string', enum: ['discussion', 'later'] },
            },
            ['title', 'module', 'description', 'criteria'],
          ),
        },
      },
      ['features'],
    ),
  },
  {
    name: 'read_discussion',
    description: '读取完整讨论中的任意区间。切换模型后可回查早期原始消息。',
    parameters: schema({ start: { type: 'integer' }, count: { type: 'integer' }, offset: { type: 'integer' }, version: { type: 'string' } }, ['start']),
  },
  {
    name: 'read_context',
    description: '按 ID 分页读取共享上下文；不填 ID 列出索引。用 nextOffset 和 version 继续读取。',
    parameters: schema({ id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer', maximum: 6000 }, version: { type: 'string' } }),
  },
  {
    name: 'design_prototype',
    description:
      '用户希望查看或修改原型时，将设计要求交给设计 AI。它独立生成可预览的 HTML 原型，讨论可继续。',
    parameters: schema({ instruction: { type: 'string' }, targetId: { type: 'string' } }, [
      'instruction',
    ]),
  },
]

export class RequirementsWorkspace {
  private designJobs = new Map<string, AbortController>()
  readonly decisions: RoundtableDecisions
  constructor(
    private deps: {
      store: EngineeringStore
      model(id: string): Connection
      save(p: Project): void
      context(p: Project): string
      agentInstructions(p: Project, role: 'planner' | 'designer', modelId: string): string
      upsert(p: Project, id: string | null, input: FeatureInput): string
    },
  ) {
    this.decisions = new RoundtableDecisions(deps.store, deps.save)
  }
  private get store() {
    return this.deps.store
  }
  private entry(
    p: Project,
    connection: Connection,
    purpose: 'discussion' | 'design' | 'roundtable',
  ): ChatEntry {
    const entry: ChatEntry = {
      id: uid(),
      role: 'assistant',
      text: '',
      at: now(),
      modelId: connection.id,
      modelName: connection.name,
      status: 'streaming',
      purpose,
      tools: [],
    }
    p.chat.push(entry)
    this.store.save()
    return entry
  }
  private listener(entry: ChatEntry) {
    let lastSaved = 0
    return (delta: ModelDelta) => {
      if (entry.status !== 'streaming') return
      entry.updatedAt = now()
      if (delta.kind === 'text') entry.text = this.store.redact(entry.text + delta.text)
      else if (delta.kind === 'reasoning')
        entry.reasoning = this.store.redact((entry.reasoning || '') + delta.text)
      else {
        let tool = entry.tools!.find((t) => t.id === delta.id)
        if (!tool) {
          tool = {
            id: delta.id || uid(),
            name: delta.name || '工具调用',
            arguments: '',
            status: 'receiving',
          }
          entry.tools!.push(tool)
        }
        tool.name = delta.name || tool.name
        tool.arguments = this.store.redact(delta.text)
      }
      if (Date.now() - lastSaved > 200) {
        this.store.save()
        lastSaved = Date.now()
      }
    }
  }
  private history(p: Project): ModelMessage[] { return discussionHistory(p) }
  private apply(p: Project, items: unknown, versions: Map<string, number>): string {
    if (!Array.isArray(items) || items.length > 100)
      throw new Error('功能数据必须为数组，最多 100 项。')
    const report: string[] = []
    for (const item of items) {
      if (!item || typeof item.title !== 'string') throw new Error('功能缺少标题。')
      const f = p.features.find(
        (f) =>
          f.id === item.id ||
          (f.title === item.title && (f.targetId || '') === (item.targetId || '')),
      )
      if (f && (f.stage !== 'requirements' || f.revision !== versions.get(f.id))) {
        this.store.event(p, 'notice', `保留「${f.title}」的最新记录，未应用过期的模型修改。`)
        report.push(
          `保留「${f.title}」的最新记录，未应用过期的模型修改。已确认目标的修改请作为新候选功能讨论。`,
        )
        continue
      }
      if (!f && p.features.length >= 100) throw new Error('当前工程最多保留 100 项功能。')
      const id = this.deps.upsert(p, f?.id ?? null, {
        targetId: item.targetId ?? f?.targetId,
        title: item.title,
        module: item.module || '未分组',
        description: item.description || '',
        criteria: item.criteria || [],
        scope: item.scope === 'later' ? 'later' : 'discussion',
        dependencies: f?.dependencies ?? [],
        developerId:
          f?.developerId || this.store.data.agents.find((a) => a.role === 'developer')?.id || '',
        reviewerId:
          f?.reviewerId || this.store.data.agents.find((a) => a.role === 'reviewer')?.id || '',
      })
      versions.set(id, p.features.find((f) => f.id === id)!.revision)
      report.push(`已更新 ${item.title}`)
    }
    this.deps.save(p)
    return report.join('\n') || '没有功能变更。'
  }
  async discuss(
    p: Project,
    connection: Connection,
    signal: AbortSignal,
    meeting?: { round: number; role: string; chair?: boolean; pass?: number },
  ): Promise<void> {
    const versions = new Map(p.features.map((f) => [f.id, f.revision]))
    let documentVersion = p.requirementsDocument || ''
    const messages = this.history(p)
    const instructions = this.deps.agentInstructions(p, 'planner', connection.id)
    const system = instructions + '\n' + `你是软件需求协作者。使用中文，先理解用户的完整产品，充分探索目标、使用场景、边界、替代方案与开放问题。不要机械地每次追问或急于进入开发。用户掌控节奏，可随时重新讨论。\n项目：${p.name}\n目标：${p.brief}\n共享上下文：${this.deps.context(p)}\n完整需求文档草稿：${(p.requirementsDocument || '尚未整理').slice(0, 8000) + '（完整原文：read_context id=requirements:current）'}\n当前功能记录：${JSON.stringify(p.features.map(({ id, title, targetId, scope }) => ({ id, title, targetId, scope })))}\n讨论记录会完整保存，你接收的是跨模型的对话。以最新直接编辑的记录为准。自然地使用 Markdown 回复，绝不要要求把每次讨论变成固定 JSON。流程必须先确定原型，再从已验收原型生成 PRD，最后基于同一原型设计方案和开发。在原型尚未验收时，只整理初步目标、业务约束与设计偏好，不要求用户先完成 PRD；用 update_requirements 保存的只是讨论草稿，保留业务规则、非功能要求、开放问题和备选方案，不能只记录功能标题。你可在回复过程中用 update_features 同步新想法到功能图，可多次调用；暂缓的想法标为 later。已有交付中的目标不能被静默覆盖，提出变更方案作为新的候选。没有得到用户确认，不自动进入方案或代码开发。在目标和主要使用场景已清楚时主动询问设计风格、主要设备与关键操作；用户已给设计意见时主动调用 design_prototype，不等用户再点击生成。原型等待用户验收，验收后系统自动生成 PRD。无需为使用已提供工具再索取许可。`
    const additional =
      `\n子项目规划：${JSON.stringify(p.targets || [])}。需求涉及多端时，用 update_project_targets 建立实际需要的子项目，明确各自职责、相对目录、接口与共享数据约定；update_features 的 targetId 必须关联已建立的子项目。不要因为列举了端类型就默认全部都要开发。` +
      (meeting
        ? `\n你参与软件需求圆桌，第 ${meeting.round} 轮，职责：${meeting.role}。${
            meeting.chair
              ? '你是本轮圆桌主持人。综合所有参会模型和人的意见形成完整方案，保留分歧与待决事项。必须通过工具同步完整需求文档、子项目及功能归属，最后给出可供人工审阅的汇总。'
              : meeting.pass === 0
                ? '先提出你负责领域的方案，也回应已经出现的观点。'
                : '针对其他参会者的方案评审，发现遗漏、冲突和跨端接口问题，给出修改建议，避免重复附和。'
          }
重要：边讨论边用 update_project_targets / update_features 同步已经明确的结构和功能，一小步一更新，先发工具调用再继续文字，不要攒到发言末尾或等主持人汇总。没有变化时不重复写入。
遇到需要人类决定的范围、预算、体验取舍立即用 ask_human 提出一张简短决策卡，每次只问一件事；不要在长文本中堆积问题。先同步不依赖该决定的功能，再提问。系统会等待选择、自由输入或“后面再说”，不能替用户回答。已经暂缓的问题不要反复弹卡，交给后续模型研究；其他模型可以用 resolve_deferred_decision 给出有依据的建议，解决不了就保留未决。尊重所有人工回答，模型建议不等于人工确认。禁止自行确认方案或开工。`
        : '')
    let entry: ChatEntry | undefined
    // Human input starts a new autonomous segment. Bound only uninterrupted
    // model work, then give the model one tool-free turn to hand off its findings.
    let autonomousSteps = 0
    let failedSteps = 0
    try {
      while (true) {
        const closing = autonomousSteps >= 32 || failedSteps >= 3
        entry = this.entry(p, connection, meeting ? 'roundtable' : 'discussion')
        if (meeting) {
          entry.meetingRound = meeting.round
          entry.speaker = meeting.role
        }
        boundMessages(messages)
        const reply = await complete(
          connection,
          system +
            additional +
            (closing
              ? '\n本段连续工具操作已结束。本次不提供工具，请用文字整理已完成的实际修改、未完成事项与原因，交给后续参会者或人工继续。不要声称未执行的操作已完成，不要自行确认需求。'
              : '') +
            `\n已记录的决策（人工答案优先，暂缓不是同意）：${JSON.stringify(p.decisions || [])}`,
          messages,
          closing ? [] : meeting ? [...tools, ...decisionTools] : tools,
          signal,
          this.listener(entry),
        )
        signal.throwIfAborted()
        if (closing && reply.calls.length)
          throw new Error('模型在发言收尾时仍返回工具调用；已有修改已保存，请继续讨论。')
        if (meeting && !reply.calls.length && !reply.text.trim())
          throw new Error('参会模型未返回讨论内容，已有记录已保留。')
        entry.text = this.store.redact(reply.text)
        if (reply.reasoning) entry.reasoning = this.store.redact(reply.reasoning)
        // Retain compatibility with providers returning legacy JSON instead of tool calls.
        if (!reply.calls.length && /^\s*(?:```json\s*)?\{/.test(reply.text)) {
          let value: any
          try {
            value = parseJson(reply.text)
          } catch {
            /* Natural text is always retained. */
          }
          if (value && typeof value.reply === 'string') {
            entry.text = this.store.redact(value.reply)
            if (!closing && Array.isArray(value.features)) {
              const result = this.apply(p, value.features, versions)
              entry.tools!.push({
                id: uid(),
                name: 'update_features',
                arguments: this.store.redact(JSON.stringify(value.features)),
                result,
                status: 'complete',
              })
            }
          }
        }
        messages.push({
          role: 'assistant',
          content: reply.text,
          calls: reply.calls,
          reasoning: reply.reasoning,
          responseItems: reply.responseItems,
          anthropicBlocks: reply.anthropicBlocks,
        })
        let humanAnswered = false
        let allFailed = reply.calls.length > 0
        for (const call of reply.calls) {
          signal.throwIfAborted()
          let t = entry.tools!.find((t) => t.id === call.id)
          if (!t) {
            t = { ...call, status: 'running' }
            entry.tools!.push(t)
          }
          t.arguments = this.store.redact(call.arguments)
          t.status = 'running'
          this.store.save()
          try {
            const args = parseJson(call.arguments)
            if (call.name === 'ask_human' && meeting) {
              t.result = await this.decisions.ask(p, entry, connection, args, signal)
              humanAnswered = true
            } else if (call.name === 'resolve_deferred_decision' && meeting) {
              t.result = this.decisions.resolve(p, connection, args)
            } else if (call.name === 'update_project_targets') {
              mergeTargets(p, args.targets)
              this.deps.save(p)
              t.result = JSON.stringify(p.targets)
            } else if (call.name === 'update_features')
              t.result = this.apply(p, args.features, versions)
            else if (call.name === 'update_requirements') {
              if ((p.requirementsDocument || '') !== documentVersion)
                throw new Error('用户已更新需求文档，保留最新编辑；请在下一轮继续。')
              if (
                typeof args.content !== 'string' ||
                !args.content.trim() ||
                args.content.length > 80000
              )
                throw new Error('需求文档内容无效或过长。')
              p.requirementsDocument = this.store.redact(args.content)
              documentVersion = p.requirementsDocument
              t.result = '完整需求文档草稿已更新，等待用户整体确认。'
              this.deps.save(p)
            } else if (call.name === 'read_discussion') {
              const start = Math.max(0, Math.floor(Number(args.start) || 0)),
                count = Math.min(100, Math.max(1, Math.floor(Number(args.count) || 30)))
              t.result = readPage(JSON.stringify({
                total: p.chat.length,
                entries: p.chat
                  .slice(start, start + count)
                  .map(({ id, role, text, at, status }) => ({ id, role, text, at, status })),
              }), args)
            } else if (call.name === 'read_context') t.result = readContext(p, args)
            else if (call.name === 'design_prototype') {
              this.generatePrototype(
                p.id,
                args.instruction,
                p.designModelId || this.store.data.agents.find(a => a.role === 'designer')?.modelId || connection.id,
                args.targetId,
              )
              t.result = '设计 AI 已开始工作。原型完成后自动显示在右侧；你可继续讨论。'
            } else throw new Error('未提供此工具。')
            t.status = 'complete'
            allFailed = false
          } catch (error) {
            t.result = this.store.redact(String(error))
            t.status = 'error'
            if (signal.aborted) throw error
          }
          messages.push({ role: 'tool', callId: call.id, content: t.result || '' })
          this.store.save()
        }
        entry.status = 'complete'
        entry.finishedAt = now()
        this.deps.save(p)
        autonomousSteps = humanAnswered ? 0 : autonomousSteps + 1
        failedSteps = humanAnswered || !allFailed ? 0 : failedSteps + 1
        if (!reply.calls.length) {
          this.store.event(p, 'discussion', '讨论已保存，功能图与原型按本次操作同步。')
          return
        }
      }
    } catch (error) {
      if (entry) {
        entry.status = signal.aborted ? 'stopped' : 'error'
        entry.error = this.store.redact(signal.aborted ? '已停止，部分响应已保存。' : String(error))
        for (const t of entry.tools ?? [])
          if (['running', 'receiving'].includes(t.status)) t.status = 'error'
      }
      this.store.save()
      throw error
    }
  }
  async roundtable(p: Project, config: RoundtableConfig, signal: AbortSignal): Promise<void> {
    const meeting = p.roundtable!
    try {
      const stages = config.passes * config.participants.length
      for (let index = meeting.cursor || 0; index <= stages; index++) {
        const chair = index === stages
        const pass = Math.floor(index / config.participants.length)
        const participant = config.participants[chair ? 0 : index % config.participants.length]
        signal.throwIfAborted()
        const connection = this.deps.model(participant.modelId)
        meeting.cursor = index
        meeting.status = 'running'
        meeting.error = undefined
        meeting.phase = chair
          ? '主持人汇总'
          : `${pass === 0 ? '提出方案' : '交叉评审'} · ${participant.role}`
        p.activity = `圆桌第 ${meeting.round} 轮 · ${meeting.phase}`
        this.deps.save(p)
        await this.discuss(p, connection, signal, {
          round: meeting.round,
          role: chair ? '主持人汇总' : participant.role,
          chair,
          pass,
        })
        signal.throwIfAborted()
        meeting.cursor = index + 1
        this.deps.save(p)
      }
      meeting.summaryMessageId = p.chat
        .filter((c) => c.purpose === 'roundtable' && c.meetingRound === meeting.round)
        .at(-1)?.id
      meeting.status = 'awaiting-human'
      meeting.phase = '等待人工反馈'
    } catch (error) {
      meeting.status = signal.aborted ? 'stopped' : 'error'
      meeting.phase = signal.aborted ? '讨论已停止' : '本轮未完成'
      meeting.error = this.store.redact(String(error))
      throw error
    } finally {
      this.deps.save(p)
    }
  }
  generatePrototype = (
    projectId: string,
    instruction: string,
    modelId: string,
    targetId?: string,
  ): void => {
    const p = this.store.project(projectId)
    if (this.designJobs.has(projectId)) throw new Error('设计 AI 正在生成原型，请等待完成或停止。')
    if (p.prd?.status === 'generating') throw new Error('正在根据已确认原型整理 PRD，请等待完成或停止后再修改原型。')
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 20000)
      throw new Error('请填写有效的原型设计要求。')
    modelId ||= this.store.data.agents.find(a => a.id === p.designerId)?.modelId || this.store.data.agents.find(a => a.role === 'designer')?.modelId || p.discussionModelId
    const instructions = this.deps.agentInstructions(p, 'designer', modelId) + '\n原型运行于无同源权限的沙箱，交互状态使用内存变量；不要使用 localStorage、sessionStorage、cookie 或外部接口。开发角色会在正式项目中接入真实状态。'
    const connection = this.deps.model(modelId),
      controller = new AbortController()
    const target = targetId ? p.targets?.find((t) => t.id === targetId) : undefined
    if (targetId && !target) throw new Error('子项目不存在。')
    const prototypeFingerprint = designFingerprint(p, targetId)
    const brief = p.prototypeBriefs?.[targetId || '']
    if (brief) { brief.status = 'designing'; brief.error = undefined; brief.fingerprint = prototypeFingerprint; brief.acceptedAt = undefined }
    if (target)
      instruction = `仅设计子项目「${target.name}」：${target.responsibility}。接口约定：${target.contracts}。本次要求：${instruction}`
    p.designModelId = modelId
    p.designActivity = true
    this.designJobs.set(projectId, controller)
    p.chat.push({
      id: uid(),
      role: 'user',
      purpose: 'design',
      targetId,
      text: `原型设计：${instruction}`,
      at: now(),
    })
    const messages = this.history(p),
      entry = this.entry(p, connection, 'design')
    entry.targetId = targetId
    const latest = p.prototypes?.filter((r) => (r.targetId || '') === (targetId || '')).at(-1)
    void (async () => {
      try {
        const reply = await completeWithContext(
          connection,
          instructions + '\n' +           `你是产品界面设计 AI。根据初步目标、用户设计意见和已有讨论设计高质量的可交互 HTML 原型。不要求先有 PRD；用户确定原型后，规划角色会据此生成 PRD。它是讨论材料，尚未进入交付。项目：${p.name}\n目标：${p.brief}\n完整需求文档：${(p.requirementsDocument || '尚未整理').slice(0, 8000) + '（完整原文：read_context id=requirements:current）'}\n功能：${JSON.stringify(p.features.map(({ id, title, targetId, scope }) => ({ id, title, targetId, scope })))}\n共享上下文：${this.deps.context(p)}\n上版原型：${latest ? '通过 read_context 读取 prototype:' + latest.id : '无'}\n本次要求：${instruction}\n只输出完整 HTML 文档（可带 html 代码围栏），内联 CSS 和 JavaScript，无网络请求、无外部依赖、无 iframe、不访问父窗口或桌面接口。遵循用户确认的设备、风格与布局偏好，兼顾窄屏和真实中文业务文案。交互数据只存在当前预览中。`,
          messages,
          p,
          controller.signal,
          this.listener(entry),
        )
        controller.signal.throwIfAborted()
        entry.designOutput = this.store.redact(reply.text)
        const html = extractPrototypeHtml(reply.text)
        const revision = {
          id: uid(),
          title: `原型 ${(p.prototypes?.length ?? 0) + 1}`,
          html: this.store.redact(html),
          at: now(),
          modelId,
          sourceMessageId: entry.id,
          targetId,
          designFingerprint: prototypeFingerprint,
          designBrief: this.store.redact(instruction),
        }
        ;(p.prototypes ??= []).push(revision)
        if (brief) { brief.status = 'review'; brief.prototypeId = revision.id }
        entry.text = `已完成 **${revision.title}**，可在右侧「原型」预览并切换历史版本。`
        if (reply.reasoning) entry.reasoning = this.store.redact(reply.reasoning)
        entry.status = 'complete'
        this.store.event(p, 'prototype', `${revision.title}已保存。`)
      } catch (error) {
        entry.status = controller.signal.aborted ? 'stopped' : 'error'
        entry.error = this.store.redact(
          controller.signal.aborted
            ? String(controller.signal.reason?.message || '原型生成已停止，输出已保留。')
            : String(error),
        )
        if (brief) { brief.status = 'error'; brief.error = entry.error }
      } finally {
        entry.finishedAt ??= now()
        p.designActivity = false
        this.designJobs.delete(projectId)
        try {
          this.deps.save(p)
        } catch (error) {
          this.store.event(p, 'error', `原型记录已保存，导出失败：${String(error)}`)
        }
      }
    })()
  }
  confirm(p: Project, fingerprint: string, messageCount: number): void {
    if (p.activity || p.designActivity) throw new Error('请等待讨论和设计完成，再确认完整需求。')
    if (fingerprint !== requirementsFingerprint(p) || messageCount !== p.chat.length)
      throw new Error('需求内容已有更新，请重新查看后确认。')
    const included = p.features.filter((f) => f.scope !== 'later')
    const newBaselineFeatures = included.filter(f => f.stage === 'requirements')
    if (p.decisions?.some((d) => d.status === 'pending')) throw new Error('请先处理待决卡。')
    if (
      p.roundtable &&
      p.roundtable.status !== 'awaiting-human' &&
      p.roundtable.status !== 'confirmed'
    )
      throw new Error('请先完成一轮圆桌汇总，再审阅确认。')
    if (p.targets?.length && included.some((f) => !p.targets!.some((t) => t.id === f.targetId)))
      throw new Error('请先为本期每项功能指定所属子项目。')
    if (!included.length || included.some((f) => !f.description.trim() || !f.criteria.length))
      throw new Error('请为本期每项功能补全说明和验收标准，再确认完整需求。')
    requirePrototypeReview(p)
    requirePrd(p)
    for (const f of included)
      if (f.stage === 'requirements') {
        f.stage = 'solution'
        f.scope = 'current'
        f.revision++
      }
    const at = now(),
      id = uid()
    p.requirementsBaseline = {
      id,
      at,
      fingerprint: requirementsFingerprint(p),
      messageCount: p.chat.length,
      prototypeIds: activePrototypeBriefs(p).filter(b => b.status === 'accepted').map(b => b.prototypeId!).filter(Boolean),
    }
    if (p.prd) p.prd.status = 'confirmed'
    for (const entry of p.context) if (entry.kind === 'requirements' || entry.kind === 'decision' && entry.baselineId || entry.source.includes('项目全量')) entry.status = 'superseded'
    for (const f of newBaselineFeatures) {
      f.baselineId = id
      f.prototypeId = p.requirementsBaseline.prototypeIds?.find(prototypeId => (p.prototypes?.find(r => r.id === prototypeId)?.targetId || '') === (f.targetId || ''))
    }
    const prototypeReferences = (p.requirementsBaseline.prototypeIds || []).map(prototypeId => {
      const prototype = p.prototypes!.find(r => r.id === prototypeId)!
      return prototype.title + '（ID: ' + prototype.id + '；子项目：' + (p.targets?.find(t => t.id === prototype.targetId)?.name || '项目整体') + '；read_context: prototype:' + prototype.id + '）'
    }).join('\n') || '尚未设计'
    p.context.push({
      kind: 'requirements', status: 'active', baselineId: id,
      sourceRefs: (p.requirementsBaseline.prototypeIds || []).map(prototypeId => 'prototype:' + prototypeId),
      id,
      title: `完整需求基线 · ${at.slice(0, 10)}`,
      at,
      source: `用户需求确认 · 项目全量 · ${id}`,
      content: `# ${p.name}\n\n## 产品目标\n${p.brief}\n\n## 完整需求文档\n${p.requirementsDocument || '需求以以下功能范围和验收标准为准。'}\n\n## 模块、功能、范围与验收\n${p.features.map((f) => `### ${f.module} / ${f.title}\n范围：${f.scope === 'later' ? '暂缓' : '本期'}\n${f.description}\n${f.criteria.map((c) => '- ' + c).join('\n')}\n依赖：${f.dependencies.join(', ') || '无'}`).join('\n\n')}\n\n## 原型依据\n${prototypeReferences}；历史原型见 .coprojer/PROTOTYPES.json。\n\n## 讨论来源\n已确认时共 ${p.chat.length} 条消息，原始内容完整保存在 .coprojer/DISCUSSION.md；讨论中的备选和未决项不等于已确认范围。\n\n## 既有工程知识\n${p.context
        .filter((c) => !c.source.includes('项目全量'))
        .map((c) => `${c.title}\n${c.content}`)
        .join('\n\n')}`,
    })
    if (p.decisions?.length)
      p.context.push({
        kind: 'decision', baselineId: id, status: 'active',
        id: uid(),
        title: '需求决策记录',
        at,
        source: `用户需求确认 · ${id}`,
        content:
          '人工答案与模型建议分别记录；暂缓未解决的问题仍是未决事项。\n' +
          JSON.stringify(p.decisions, null, 2),
      })
    if (p.targets?.length)
      p.context.push({
        kind: 'requirements', baselineId: id, status: 'active',
        id: uid(),
        title: '已确认的多端项目边界',
        at,
        source: `用户需求确认 · ${id}`,
        content: JSON.stringify(
          {
            targets: p.targets,
            features: p.features.map((f) => ({
              id: f.id,
              title: f.title,
              targetId: f.targetId,
              dependencies: f.dependencies,
            })),
          },
          null,
          2,
        ),
      })
    if (p.roundtable) {
      p.roundtable.status = 'confirmed'
      p.roundtable.phase = '人工已确认完整方案'
    }
    this.store.event(p, 'confirmed', '完整需求已确认并写入共享上下文；后续讨论继续保存。')
    this.deps.save(p)
  }
  stopDesign = (id: string): void => {
    this.cancelDesign(id, '已主动停止原型生成，收到的内容已保留。可点击「设计原型」重新生成。')
  }
  private cancelDesign(id: string, reason: string): void {
    const controller = this.designJobs.get(id)
    if (!controller || controller.signal.aborted) return
    const p = this.store.project(id)
    const entry = [...p.chat].reverse().find((e) => e.purpose === 'design' && e.status === 'streaming')
    if (entry) {
      entry.status = 'stopped'
      entry.error = reason
      entry.finishedAt = now()
    }
    p.designActivity = false
    controller.abort(new Error(reason))
    // before-quit cannot rely on the rejected fetch's asynchronous catch/finally.
    // Persist the cause and latest partial output before Electron exits.
    this.store.save()
  }
  dispose(): void {
    for (const id of this.designJobs.keys())
      this.cancelDesign(id, '应用退出导致原型生成中断，收到的内容已保留。重新打开后可点击「设计原型」重新生成。')
  }
}
