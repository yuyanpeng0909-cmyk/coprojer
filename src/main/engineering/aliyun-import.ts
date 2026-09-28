import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { EngineeringStore } from './store'
import { aliyunBaseUrl, aliyunPages, chooseAliyunModel, hasUsableFreeQuota, isAliyunChatModel, type AliyunImportInput, type AliyunImportPreview, type AliyunImportResult } from '../../shared/aliyun'
import { aliyunJson, authorizeAliyunConsole, queryAliyunQuota } from './aliyun-console'

interface ImportSession {
  preview: AliyunImportPreview
  key: string
  token?: string
  expires: number
  controller: AbortController
  busy: boolean
}
export class AliyunImport {
  private sessions = new Map<string, ImportSession>()
  constructor(private store: EngineeringStore) {}
  private cleanup() {
    for (const [id, entry] of this.sessions) if (entry.expires <= Date.now()) this.discardAliyunImport(id)
  }
  private get(id: string) {
    this.cleanup()
    const entry = this.sessions.get(id)
    if (!entry) throw new Error('导入预览已过期，请重新粘贴 Key 并识别模型。')
    return entry
  }
  openAliyunPage = async (page: keyof typeof aliyunPages) => {
    if (!Object.hasOwn(aliyunPages, page)) throw new Error('无效的百炼页面。')
    await shell.openExternal(aliyunPages[page])
  }
  discardAliyunImport = (id: string) => {
    this.sessions.get(id)?.controller.abort()
    this.sessions.delete(id)
  }
  scanAliyunModels = async (apiKey: string): Promise<AliyunImportPreview> => {
    this.cleanup()
    if (this.sessions.size >= 5) throw new Error('请先关闭其他导入预览，再重试。')
    if (typeof apiKey !== 'string' || !/^sk-[a-zA-Z0-9_-]{8,500}$/.test(apiKey.trim())) throw new Error('请粘贴北京地域的百炼 API Key。')
    const key = apiKey.trim()
    if (key.startsWith('sk-sp-')) throw new Error('这是订阅套餐 Key。新人免费额度请使用北京地域的普通 API Key。')
    const json = await aliyunJson(aliyunBaseUrl + '/models', { headers: { Authorization: 'Bearer ' + key } })
    if (!Array.isArray(json?.data)) throw new Error('阿里云没有返回可识别的模型列表。')
    if (json.has_more === true || json.data.length > 2000) throw new Error('供应商返回的模型列表不完整，请使用手动添加或稍后重试。')
    const all = [...new Set<string>(json.data.map((item: any) => item?.id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s\x00-\x1f]/.test(id)))]
    const models = all.filter(isAliyunChatModel).sort().map(model => ({ model }))
    if (!models.length) throw new Error('未发现支持当前工程流程的对话候选型号，可使用“新增模型”手动配置。')
    const preview: AliyunImportPreview = { id: randomUUID(), models, scannedAt: new Date().toISOString(), excludedCount: all.length - models.length }
    this.sessions.set(preview.id, { key, preview, expires: Date.now() + 15 * 60_000, controller: new AbortController(), busy: false })
    return structuredClone(preview)
  }
  private async refreshQuota(entry: ImportSession, selected?: string[]) {
    if (!entry.token) throw new Error('请先登录百炼并扫描免费额度。')
    const { quotas, statuses } = await queryAliyunQuota(entry.token, selected || entry.preview.models.map(m => m.model), entry.controller.signal)
    this.get(entry.preview.id)
    const mapped = entry.preview.models.map(previous => {
      const { model } = previous
      if (selected && !selected.includes(model)) return previous
      const records = quotas.filter(q => q?.model === model)
      const q = records.length === 1 ? records[0] : undefined
      const stops = statuses.filter(s => s?.model === model)
      const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
      return { model, remaining: number(q?.quotaTotal), expiresAt: number(q?.quotaValidityPeriod), quotaStatus: typeof q?.quotaStatus === 'string' ? q.quotaStatus : undefined,
        autoStop: stops.length === 1 && typeof stops[0].freeTierOnly === 'boolean' ? stops[0].freeTierOnly : undefined }
    })
    entry.preview = { ...entry.preview, models: mapped, quotaCheckedAt: new Date().toISOString() }
  }
  syncAliyunQuota = async (id: string): Promise<AliyunImportPreview> => {
    const entry = this.get(id)
    if (entry.busy) throw new Error('正在处理此导入，请稍后。')
    entry.busy = true
    try {
      if (!entry.token) entry.token = await authorizeAliyunConsole(entry.controller.signal)
      await this.refreshQuota(entry)
      return structuredClone(entry.preview)
    } catch (error) { entry.token = undefined; throw error }
    finally { entry.busy = false }
  }
  importAliyunModels = async (input: AliyunImportInput): Promise<AliyunImportResult> => {
    if (!input || !Array.isArray(input.models) || input.models.length < 1 || input.models.length > 100
      || input.models.some(m => typeof m !== 'string') || new Set(input.models).size !== input.models.length
      || typeof input.freeOnly !== 'boolean' || typeof input.configureUnbound !== 'boolean') throw new Error('请选择 1–100 个不同型号。')
    const entry = this.get(input.previewId)
    if (entry.busy) throw new Error('正在处理此导入，请稍后。')
    if (input.models.some(id => !entry.preview.models.some(m => m.model === id))) throw new Error('所选型号不在此 Key 发现的列表中。')
    entry.busy = true
    try {
      if (input.freeOnly) {
        if (input.sameAccountConfirmed !== true) throw new Error('请确认登录账户与 API Key 属于同一阿里云账号。')
        // Recheck immediately before writing; never treat a stale scan as remaining quota.
        await this.refreshQuota(entry, input.models)
        if (input.models.some(id => !hasUsableFreeQuota(entry.preview.models.find(m => m.model === id)!)))
          throw new Error('部分型号额度已耗尽、过期或未开启用完即停。请刷新额度后重新选择。')
      }
      this.get(input.previewId)
      if (input.configureUnbound && this.store.data.projects.some(p => p.activity || p.designActivity || p.executionPlan?.status === 'running'))
        throw new Error('当前有工程任务运行，请等待完成后装配，或取消自动装配只导入模型。')
      const previous = this.store.data
      const next = { ...previous, models: [...previous.models], agents: previous.agents.map(a => ({ ...a })) }
      const ids = new Map<string, string>(); let imported = 0, reused = 0
      // Reuse only the same model, endpoint, protocol AND credential. Another account stays separate.
      for (const model of input.models) {
        const existing = previous.models.find(m => {
          if (m.model !== model || m.baseUrl.replace(/\/+$/, '') !== aliyunBaseUrl || m.protocol !== 'chat') return false
          try { return this.store.key(m.id) === entry.key } catch { return false }
        })
        if (existing) { ids.set(model, existing.id); reused++; continue }
        const id = randomUUID()
        next.models.push({ id, name: model, model, baseUrl: aliyunBaseUrl, protocol: 'chat', hasKey: true, cipher: this.store.encrypt(entry.key) })
        ids.set(model, id); imported++
      }
      let configuredAgents = 0, defaultModel: string | undefined
      if (input.configureUnbound) {
        for (const agent of next.agents) if (!agent.ownerProjectId && !agent.modelId) {
          agent.modelId = ids.get(chooseAliyunModel(input.models, agent.role))!
          configuredAgents++
        }
        if (!next.defaultAssistantModelId) {
          defaultModel = chooseAliyunModel(input.models, 'assistant')
          next.defaultAssistantModelId = ids.get(defaultModel)!
        }
      }
      this.store.data = next
      try { this.store.save() } catch (error) { this.store.data = previous; throw error }
      this.discardAliyunImport(input.previewId)
      return { imported, reused, configuredAgents, defaultModel }
    } finally { entry.busy = false }
  }
  dispose() { for (const id of this.sessions.keys()) this.discardAliyunImport(id) }
}
