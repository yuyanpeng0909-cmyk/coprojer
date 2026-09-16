import type {
  ChatEntry,
  DecisionAnswer,
  Project,
  RoundtableDecision,
} from '../../shared/engineering'
import type { Connection, ToolDefinition } from './model'
import { now, uid, type EngineeringStore } from './store'

export const decisionTools: ToolDefinition[] = [
  {
    name: 'ask_human',
    description:
      '讨论中遇到影响范围、体验或成本的人工取舍时立即提出一张决策卡，一次只问一个问题。先更新已明确的功能图，不等最终汇总，不重复追问已暂缓的问题。卡片自带“后面再说”。等待用户选择或输入后继续。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '一个明确、简短的问题' },
        context: { type: 'string', description: '为什么现在要决定、对功能的影响' },
        targetId: { type: 'string' },
        options: {
          type: 'array',
          description: '只列业务选项；不要包含系统自带的“后面再说”。',
          maxItems: 4,
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, description: { type: 'string' } },
            required: ['label', 'description'],
          },
        },
      },
      required: ['question', 'context', 'options'],
    },
  },
  {
    name: 'resolve_deferred_decision',
    description:
      '处理其他模型提出、人工选择“后面再说”的问题。能依据讨论推导时给出有理由的方案建议并同步功能图；不能确定则继续保留。模型建议不等于人工确认，不覆盖人类已作出的决定。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, resolution: { type: 'string' } },
      required: ['id', 'resolution'],
    },
  },
]

export class RoundtableDecisions {
  private waiters = new Map<string, () => void>()
  constructor(
    private store: EngineeringStore,
    private save: (p: Project) => void,
  ) {}

  isWaiting(id: string): boolean {
    return this.waiters.has(id)
  }

  private text(value: unknown, label: string, limit: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > limit)
      throw new Error(`${label}不能为空或过长。`)
    return this.store.redact(value.trim())
  }

  async ask(
    p: Project,
    entry: ChatEntry,
    c: Connection,
    args: any,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted()
    if (!p.roundtable) throw new Error('决策卡只用于圆桌讨论。')
    if (p.decisions?.some((d) => d.status === 'pending')) throw new Error('请先处理当前决策卡。')
    const question = this.text(args.question, '决策问题', 240)
    if (p.decisions?.some((d) => d.question === question))
      throw new Error('该问题已记录，请参考已有决定；暂缓事项交给其他模型研究，不要重复弹卡。')
    if (!Array.isArray(args.options) || args.options.length > 5)
      throw new Error('建议选项最多四项，也可以只允许自由输入。')
    // Models sometimes repeat the built-in defer action. It must remain the
    // system action, never an ordinary answer and never a failed question.
    const businessOptions = args.options.filter((o: any) => o?.label?.trim?.() !== '后面再说')
    if (businessOptions.length > 4) throw new Error('建议选项最多四项，也可以只允许自由输入。')
    const options = businessOptions.map((o: any) => ({
      label: this.text(o?.label, '选项', 80),
      description: this.text(o?.description, '选项说明', 300),
    }))
    if (new Set(options.map((o: { label: string }) => o.label)).size !== options.length)
      throw new Error('选项不能重复；“后面再说”由系统提供。')
    if (args.targetId !== undefined && !p.targets?.some((t) => t.id === args.targetId))
      throw new Error('子项目不存在。')
    const decision: RoundtableDecision = {
      id: uid(),
      question,
      context: this.text(args.context, '决策背景', 1200),
      options,
      targetId: args.targetId,
      status: 'pending',
      round: p.roundtable.round,
      modelId: c.id,
      modelName: c.name,
      speaker: entry.speaker || c.name,
      sourceMessageId: entry.id,
      at: now(),
    }
    ;(p.decisions ??= []).push(decision)
    entry.status = 'complete'
    entry.finishedAt = now()
    const phase = p.roundtable.phase
    p.roundtable.status = 'awaiting-decision'
    p.roundtable.phase = '等待人工决定'
    p.activity = `等待人工决定 · ${question}`
    let onAbort: () => void = () => {}
    const waiting = new Promise<void>((resolve, reject) => {
      this.waiters.set(decision.id, resolve)
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      this.save(p)
      await waiting
      signal.throwIfAborted()
      p.roundtable.status = 'running'
      p.roundtable.phase = phase
      p.activity = `圆桌第 ${p.roundtable.round} 轮 · ${phase}`
      this.save(p)
      return JSON.stringify(decision)
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.waiters.delete(decision.id)
    }
  }

  answer(p: Project, id: string, input: DecisionAnswer): void {
    const d = p.decisions?.find((d) => d.id === id)
    if (!d || d.status !== 'pending')
      throw new Error('这张决策卡已经处理或不存在，请查看最新状态。')
    if (
      !input ||
      typeof input !== 'object' ||
      (input.defer !== undefined && typeof input.defer !== 'boolean')
    )
      throw new Error('决策答复格式无效。')
    const note =
      input.text === undefined || input.text === '' ? '' : this.text(input.text, '你的想法', 5000)
    if (input.choice !== undefined && (!Number.isInteger(input.choice) || !d.options[input.choice]))
      throw new Error('请选择有效选项。')
    const choice = input.choice === undefined ? '' : d.options[input.choice].label
    if (!input.defer && !choice && !note) throw new Error('请选择一个选项或输入自己的想法。')
    const previous = { status: d.status, answer: d.answer, answeredAt: d.answeredAt }
    const messageCount = p.chat.length
    d.status = input.defer ? 'deferred' : 'answered'
    d.answer = [input.defer ? '后面再说：交给后续模型继续研究，仍不确定则保留未决。' : choice, note]
      .filter(Boolean)
      .join('\n')
    d.answeredAt = now()
    p.chat.push({
      id: uid(),
      role: 'user',
      purpose: 'roundtable',
      meetingRound: d.round,
      speaker: '人工',
      text: `关于「${d.question}」\n${d.answer}`,
      at: d.answeredAt,
    })
    try {
      this.store.save()
    } catch (error) {
      Object.assign(d, previous)
      p.chat.splice(messageCount)
      throw new Error(`未能保存决定，请重试；卡片和输入仍保留。${String(error)}`)
    }
    // Export is secondary to the committed answer. An export failure must not
    // strand a waiting tool or prevent a stopped meeting from resuming.
    try {
      this.save(p)
    } catch (error) {
      try {
        this.store.event(p, 'error', `决定已保存，导出失败：${String(error)}`)
      } catch {
        /* Answer already committed. */
      }
    }
    this.waiters.get(id)?.()
  }

  resolve(p: Project, c: Connection, args: any): string {
    const d = p.decisions?.find((d) => d.id === args.id)
    if (!d || d.status !== 'deferred') throw new Error('只能研究人工已暂缓、尚未解决的决策。')
    if (d.modelId === c.id) throw new Error('此问题已交给后续其他模型研究，请勿自己立即撤销暂缓。')
    d.resolution = this.text(args.resolution, '解决建议及理由', 4000)
    d.status = 'resolved'
    d.resolvedBy = c.name
    d.resolvedAt = now()
    this.save(p)
    return JSON.stringify(d)
  }
}
