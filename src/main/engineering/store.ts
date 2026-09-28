import { app, safeStorage } from 'electron'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultAgentTools } from '../../shared/engineering'
import { builtinSkills, defaultAgents, migrateAgentSkills } from '../../shared/agents'
import { normalizeContext } from './context'
import { syncPrototypeBriefs } from '../../shared/prototype-workflow'
import type { SkillDefinition } from '../../shared/engineering'
import type { AgentConfig, EngineeringState, ModelConfig, Project } from '../../shared/engineering'
import type { ExecutionCheckpoint } from './execution'
import { cleanupVerificationRuns } from './files'
import { nativeEvidenceSupported, pendingGaps } from './verification'

export const uid = () => randomUUID()
export const now = () => new Date().toISOString()
interface DiskState {
  version: 1
  onboarding?: EngineeringState['onboarding']
  defaultTeamAgentIds?: string[]
  assistant?: EngineeringState['assistant']
  defaultAssistantModelId?: EngineeringState['defaultAssistantModelId']
  assistantChat?: EngineeringState['assistantChat']
  skillSearches?: EngineeringState['skillSearches']
  models: (ModelConfig & { cipher: string })[]
  agents: AgentConfig[]
  skills?: SkillDefinition[]
  projects: Project[]
  executionCheckpoints?: Record<string, ExecutionCheckpoint>
}
export class EngineeringStore {
  readonly path: string
  data: DiskState
  constructor() {
    this.path = join(app.getPath('userData'), 'engineering-v1.json')
    mkdirSync(app.getPath('userData'), { recursive: true })
    this.data = {
      version: 1,
      models: [],
      projects: [],
      agents: defaultAgents(),
      skills: [],
    }
    if (existsSync(this.path)) {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'))
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.projects) ||
        !Array.isArray(saved.models) ||
        !Array.isArray(saved.agents)
      )
        throw new Error('工程资料格式无法识别，原文件已保留。')
      this.data = saved
      for (const agent of this.data.agents) agent.tools ??= defaultAgentTools(agent.role)
      this.data.skills ??= []
      for (const agent of defaultAgents(this.data.models[0]?.id || '')) {
        if (!this.data.agents.some(a => a.role === agent.role)) {
          if (this.data.agents.some(a => a.id === agent.id)) { agent.id = uid(); agent.skillIds = undefined }
          this.data.agents.push(agent)
        }
      }
      for (const agent of this.data.agents)
        agent.skillIds ??= builtinSkills.filter(s => s.roles.includes(agent.role) && s.requiredTools.every(t => agent.tools.includes(t))).map(s => s.id)
      for (const project of this.data.projects) {
        cleanupVerificationRuns(project.root)
        project.features ??= []
        project.context ??= []
        project.events ??= []
        project.changes ??= []
        project.agentRuns ??= []
        project.prototypes ??= []
        project.targets ??= []
        for (const feature of project.features) {
          feature.criteria ??= []
          feature.dependencies ??= []
          feature.plan ??= ''
          feature.tasks ??= []
          feature.results ??= []
          feature.revision ??= 1
          feature.repairRound ??= 0
          feature.feedback ??= ''
          // Preserve final human acceptance, but do not reuse unsupported native
          // interaction claims from an older verifier in unfinished deliveries.
          const invalid = feature.stage === 'done' ? [] : feature.results.filter(r => r.passed && !nativeEvidenceSupported(r.criterion, r))
          if (invalid.length) {
            for (const result of invalid) {
              result.passed = false; result.status = 'unverified'
              result.evidence = '旧报告缺少对应原生交互的有效证据，不能作为当前通过依据。原报告：' + result.evidence
            }
            delete feature.verificationFingerprint; delete feature.verificationContractFingerprint
            const failedChecks = feature.verificationChecks?.filter(c => c.code !== 0) ?? []
            if (!failedChecks.length && !feature.results.some(r => r.status === 'failed')) feature.verificationPending = true
            if (feature.stage === 'acceptance') {
              feature.stage = 'blocked'; feature.tasks.forEach(t => { t.done = false })
              if (project.executionPlan?.status === 'waiting-acceptance' && project.executionPlan.orderedFeatureIds[project.executionPlan.currentIndex] === feature.id) project.executionPlan.status = 'stopped'
            }
            feature.feedback = '原生界面交互仍缺有效证据，旧报告不能据此通过。' +
              (failedChecks.length ? '\n同时有实际检查失败：' + failedChecks.map(c => c.command).join('；') + '。失败记录保留。' : '') +
              '\n' + invalid.map(r => r.criterion + '：' + r.evidence).join('\n')
            if (feature.verificationPreparation) {
              feature.verificationPreparation.phase = 'blocked'
              feature.verificationPreparation.summary = feature.feedback
              feature.verificationPreparation.gaps = pendingGaps(feature)
            }
            project.events.push({ id: uid(), at: now(), featureId: feature.id, kind: 'verification-invalidated', message: '旧报告有 ' + invalid.length + ' 项原生交互证据不完整，已保留原文并恢复未验证；未修改验收标准、修复轮次或最终人工验收。' })
          }
        }
        normalizeContext(project)
        if (
          project.roundtable &&
          ['running', 'awaiting-decision'].includes(project.roundtable.status)
        ) {
          project.roundtable.status = 'stopped'
          project.roundtable.phase = '上次圆桌已中断，可补充反馈后继续'
        }
        project.designActivity = false
        for (const brief of Object.values(project.prototypeBriefs || {}))
          if (brief.status === 'designing') { brief.status = 'error'; brief.error = '上次设计已中断，设计意见与已有版本保留；提交意见后继续。' }
        syncPrototypeBriefs(project)
        if (project.prd?.status === 'generating') { project.prd.status = 'error'; project.prd.error = '上次 PRD 生成已中断，已确认原型保留，可重新整理。' }
        for (const entry of project.chat)
          if (entry.status === 'streaming') {
            entry.status = 'stopped'
            entry.finishedAt ??= now()
            entry.error = '上次响应已中断，已收到的内容已保存。'
            for (const tool of entry.tools ?? [])
              if (['receiving', 'running'].includes(tool.status)) tool.status = 'error'
          }
        if (project.activity) {
          for (const feature of project.features) {
            if (['developing', 'verifying'].includes(feature.stage)) {
              if (feature.stage === 'verifying') feature.verificationPending = true
              feature.stage = 'blocked'
            }
            const preparation = feature.verificationPreparation
            if (preparation && ['diagnosing', 'preparing', 'rechecking'].includes(preparation.phase)) {
              const attempt = preparation.attempts.at(-1)
              if (attempt?.status === 'running') { attempt.status = 'interrupted'; attempt.result = '应用退出中断，已完成动作保留。'; attempt.nextStep = '继续验证，核对当前文件后接续。' }
              preparation.phase = 'blocked'; preparation.summary = '上次验证条件准备或复验已中断，可继续验证。'
              feature.verificationPending = true
            }
          }
          if (project.executionPlan?.status === 'running') project.executionPlan.status = 'stopped'
          project.events.push({
            id: uid(),
            kind: 'interrupted',
            message: '上次执行已中断，现场已保留。请检查后继续。',
            at: now(),
          })
        }
        project.activity = null
        project.previewUrl = null
      }
    }
    this.data.assistantChat ??= []
    if (!this.data.assistant) {
      const id = uid(), at = now(), messages = this.data.assistantChat
      this.data.assistant = { version: 1, activeSessionId: messages.length ? id : '', memories: [], plans: [], dismissedHints: [],
        sessions: messages.length ? [{ id, title: '历史对话', createdAt: messages[0].at || at, updatedAt: messages.at(-1)?.at || at, draft: '', modelId: '', scrollTop: 0, pinned: false, archived: false, messages }] : [] }
    }
    for (const session of this.data.assistant.sessions) for (const entry of session.messages) if (entry.status === 'pending') {
      entry.status = 'error'; entry.error = '上次回复已中断，已收到的内容已保留。可重新发送。'
    }
    for (const plan of this.data.assistant.plans) if (plan.status === 'preview') plan.status = 'stale'
    this.data.assistantChat = this.data.assistant.sessions.find(s => s.id === this.data.assistant?.activeSessionId)?.messages || []
    this.data.skillSearches ??= {}
    for (const entry of this.data.assistantChat) if (entry.status === 'pending') {
      entry.status = 'error'; entry.error = '上次通用助手响应已中断，请重新发送。'
    }
    this.data.skills = migrateAgentSkills(this.data.agents, this.data.skills || [])
    this.save()
  }
  save(): void {
    const temp = `${this.path}.tmp`
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    // Windows readers may briefly prevent replacement. Retry the atomic rename;
    // never delete the last good file or fall back to a partial in-place write.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, this.path)
        break
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          attempt >= 5 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code || '')
        )
          throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt)
      }
    }
  }
  snapshot(): EngineeringState {
    const { executionCheckpoints: _checkpoints, ...visible } = this.data
    return JSON.parse(
      JSON.stringify({
        ...visible,
        skills: this.skills(),
        models: this.data.models.map(({ cipher, ...model }) => ({ ...model, hasKey: !!cipher })),
      }),
    )
  }
  skills(): SkillDefinition[] { return this.data.skills || [] }
  encrypt(key: string): string {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('系统密钥保护不可用，无法安全保存 API Key。')
    return safeStorage.encryptString(key).toString('base64')
  }
  key(id: string): string {
    const model = this.data.models.find((m) => m.id === id)
    if (!model?.cipher) return ''
    try {
      return safeStorage.decryptString(Buffer.from(model.cipher, 'base64'))
    } catch {
      throw new Error('无法读取此模型的密钥，请重新填写并保存。')
    }
  }
  project(id: string): Project {
    const project = this.data.projects.find((p) => p.id === id)
    if (!project) throw new Error('项目不存在。')
    return project
  }
  event(project: Project, kind: string, message: string, featureId?: string): void {
    project.events.push({
      id: uid(),
      kind,
      message: this.redact(message).slice(0, 18000),
      featureId,
      at: now(),
    })
    if (project.events.length > 1200) project.events.splice(0, project.events.length - 1200)
    this.save()
  }
  redact(value: string): string {
    let text = value
    for (const model of this.data.models) {
      try {
        const key = this.key(model.id)
        if (key) text = text.split(key).join('[已隐藏密钥]')
      } catch {
        /* No plaintext fallback. */
      }
    }
    return text.replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[已隐藏密钥]')
  }
  export(project: Project): void {
    const directory = join(project.root, '.coprojer')
    for (const path of [
      project.root,
      directory,
      ...[
        'FEATURES.md',
        'PROJECT_TARGETS.json',
        'ROUNDTABLE.json',
        'DECISIONS.json',
        'CONTEXT.md',
        'ACTIVITY.md',
        'DISCUSSION.md',
        'PROTOTYPES.json',
        'REQUIREMENTS.md',
      ].map((name) => join(directory, name)),
    ]) {
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (stat?.isSymbolicLink()) throw new Error('工程资料导出路径不能是符号链接。')
    }
    mkdirSync(directory, { recursive: true })
    const text =
      `# ${project.name}\n\n${project.brief}\n\n` +
      project.features
        .map(
          (f) =>
            `## ${f.title}\n\n子项目：${project.targets?.find((t) => t.id === f.targetId)?.name || '未分配'}\n模块：${f.module} · 范围：${f.scope} · 状态：${f.stage}\n\n${f.description}\n\n### 验收标准\n${f.criteria.map((c) => '- ' + c).join('\n')}\n\n### 实现方案\n${f.plan}\n\n### 验证\n${f.results.map((r) => '- ' + (r.status === 'unverified' ? '待补验证' : r.passed ? '通过' : '未通过') + '：' + r.criterion + ' — ' + r.evidence).join('\n')}`,
        )
        .join('\n\n')
    writeFileSync(join(directory, 'FEATURES.md'), this.redact(text))
    writeFileSync(
      join(directory, 'REQUIREMENTS.md'),
      this.redact(
        '# 完整需求文档（讨论草稿）\n\n' + (project.requirementsDocument || project.brief),
      ),
    )
    writeFileSync(
      join(directory, 'DISCUSSION.md'),
      this.redact(
        '# 完整需求讨论\n\n' +
          project.chat
            .map(
              (c) =>
                `## ${c.role === 'user' ? '你' : c.modelName || '协作者'} · ${c.at}${c.meetingRound ? ` · 圆桌第 ${c.meetingRound} 轮 · ${c.speaker || ''}` : ''}\n\n${c.text}\n\n${c.reasoning ? `### 模型返回的思考\n${c.reasoning}\n` : ''}${(c.tools ?? []).map((t) => `### 工具：${t.name} · ${t.status}\n${t.arguments}\n${t.result ?? ''}`).join('\n')}${c.error ? `\n${c.error}` : ''}`,
            )
            .join('\n\n'),
      ),
    )
    writeFileSync(
      join(directory, 'PROTOTYPES.json'),
      this.redact(JSON.stringify(project.prototypes ?? [], null, 2)),
    )
    writeFileSync(
      join(directory, 'PROJECT_TARGETS.json'),
      this.redact(JSON.stringify(project.targets || [], null, 2)),
    )
    writeFileSync(
      join(directory, 'ROUNDTABLE.json'),
      this.redact(JSON.stringify(project.roundtable || null, null, 2)),
    )
    writeFileSync(
      join(directory, 'DECISIONS.json'),
      this.redact(JSON.stringify(project.decisions || [], null, 2)),
    )
    writeFileSync(
      join(directory, 'CONTEXT.md'),
      this.redact(
        `# 工程共享上下文\n\n` +
          project.context
            .map((c) => `## ${c.title}\n\n${c.content}\n\n来源：${c.source}\n更新：${c.at}`)
            .join('\n\n'),
      ),
    )
    writeFileSync(
      join(directory, 'ACTIVITY.md'),
      '# 工程活动\n\n' + project.events.map((e) => `- ${e.at} [${e.kind}] ${e.message}`).join('\n'),
    )
  }
}
