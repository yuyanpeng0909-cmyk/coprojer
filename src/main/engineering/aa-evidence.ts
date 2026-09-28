import type { AgentConfig, ModelConfig } from '../../shared/engineering'
import { agentModelLabel, resolveReasoning } from '../../shared/reasoning'
import type { AAScore, ModelCapability, ModelCapabilityEvidence, ModelEvidenceCandidate } from '../../shared/model-evidence'
import { collectModelEvidence, downloadEvidence, markPareto } from './model-evidence'
import { modelNameDifference, modelNameSimilarity, nearbyModelRows } from './model-name-reference'

export const aaSource = 'https://artificialanalysis.ai/models'
export interface AARow {
  slug: string; name: string; release: string; isReasoning: boolean; effort?: string
  intelligence?: number; coding?: number; estimated: boolean; inputPrice?: number; outputPrice?: number
}
interface AACatalogEntry { slug: string; name: string; releaseSlug: string }
export interface AAPage { rows: AARow[]; catalog: AACatalogEntry[] }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const slug = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,180}$/.test(v)
const name = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[<>\r\n]/.test(v)

/** Parse JSON embedded in the public page. Never run downloaded JavaScript or call private APIs. */
export function parseAAPage(html: string): AAPage {
  if (html.length > 6_000_000 || !/<title[^>]*>[^<]*Artificial Analysis/i.test(html)) throw new Error('AA 页面结构不匹配。')
  const chunks: string[] = []
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const prefix = 'self.__next_f.push(', start = script[1].indexOf(prefix)
    if (start < 0) continue
    try {
      const value: unknown = JSON.parse(script[1].slice(start + prefix.length, script[1].lastIndexOf(')')))
      if (Array.isArray(value) && value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1])
    } catch { /* Not a public data chunk. No execution fallback. */ }
  }
  const rows: AARow[] = [], catalog: AACatalogEntry[] = []
  let visited = 0
  function visit(value: unknown, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 50) return
    if (++visited > 200000) throw new Error('AA 页面数据过大。')
    if (record(value) && slug(value.slug) && name(value.name)) {
      if (slug(value.releaseSlug)) catalog.push({ slug: value.slug, name: value.name, releaseSlug: value.releaseSlug })
      if (record(value.release) && slug(value.release.slug) && typeof value.isReasoning === 'boolean' && Object.hasOwn(value, 'intelligenceIndex')) {
        rows.push({ slug: value.slug, name: value.name, release: value.release.slug, isReasoning: value.isReasoning,
          effort: record(value.effort) && slug(value.effort.slug) ? value.effort.slug : undefined,
          intelligence: number(value.intelligenceIndex) ? value.intelligenceIndex : undefined,
          coding: number(value.terminalBench40) && value.terminalBench40 <= 1 ? value.terminalBench40 * 100 : undefined,
          estimated: value.intelligenceIndexIsEstimated !== false,
          inputPrice: number(value.price1mInputTokens) ? value.price1mInputTokens : undefined,
          outputPrice: number(value.price1mOutputTokens) ? value.price1mOutputTokens : undefined,
        })
        return
      }
    }
    for (const item of Object.values(value)) visit(item, depth + 1)
  }
  for (const line of chunks.join('').split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    let value: unknown
    try { value = JSON.parse(line.slice(colon + 1)) } catch { continue }
    visit(value)
  }
  if (!rows.length && !catalog.length) throw new Error('AA 公开数据结构已变化，未推测分数。')
  // Identical repeated render nodes are harmless; conflicting rows remain ambiguous.
  return { rows: [...new Map(rows.map(row => [JSON.stringify(row), row])).values()], catalog: [...new Map(catalog.map(item => [JSON.stringify(item), item])).values()] }
}

// Explicit provider IDs to AA releases. No generic punctuation/version/prefix stripping.
const releases: Record<string, string> = {
  'glm-5.3': 'glm-5-3', 'glm-5.3-flash': 'glm-5-3-flash', 'zhipu/glm-5.3': 'glm-5-3', 'zhipu/glm-5.3-flash': 'glm-5-3-flash',
  'kimi-k3': 'kimi-k3', 'kimi/kimi-k3': 'kimi-k3', 'qwen3.7-flash': 'qwen3-7-flash',
  'qwen3.8-max': 'qwen3-8-max', 'qwen3.8-flash': 'qwen3-8-flash', 'qwen3.8-27b': 'qwen3-8-27b',
}
function aaScore(row: AARow, category: 'aa-intelligence' | 'aa-coding'): AAScore | undefined {
  const score = category === 'aa-intelligence' ? row.intelligence : row.coding
  if (score === undefined) return undefined
  return { model: row.name + (row.effort && !row.name.toLowerCase().includes('(' + row.effort + ')') ? ' (' + row.effort + ')' : ''), score, metric: category, url: aaSource + '/' + row.slug, preliminary: row.estimated, inputPrice: row.inputPrice, outputPrice: row.outputPrice }
}
export function matchAAEvidence(rows: AARow[], models: ModelConfig[], agent: Pick<AgentConfig, 'reasoning'>, category: 'aa-intelligence' | 'aa-coding'): ModelEvidenceCandidate[] {
  return markPareto(models.map(model => {
    const base: ModelEvidenceCandidate = { connectionId: model.id, model: model.model, displayName: agentModelLabel(model, agent.reasoning), match: 'unmatched', pareto: 'unknown' }
    const reference = (candidate: ModelEvidenceCandidate): ModelEvidenceCandidate => {
      // Conflicting source rows cannot serve as a unique reference either.
      const unique = rows.filter(row => rows.filter(other => other.slug === row.slug).length === 1 && aaScore(row, category))
      const query = releases[model.model.toLowerCase()] || model.model
      return { ...candidate, similar: nearbyModelRows(query, unique, row => row.release).map(row => ({
        score: aaScore(row, category)!, url: aaSource + '/' + row.slug,
        note: (row.release === query ? '同型号，档位、开关或预算尚未核实一致。' : modelNameDifference(query, row.release)) + ' 榜单推理配置：' + (row.isReasoning ? row.effort || '已开启，未公布档位 / 预算' : '关闭') + '。',
      })) }
    }
    let reasoning
    try { reasoning = resolveReasoning(model, agent.reasoning) } catch { return reference({ ...base, matchNote: '此候选不支持该智能体的推理设置；不会自动改变档位。' }) }
    base.query = model.model + (reasoning?.enabled ? reasoning.effort ? ' (' + reasoning.effort + ')' : ' (thinking budget ' + (reasoning.budget ?? 'maximum') + ')' : reasoning ? ' (non-reasoning)' : ' (reasoning unverified)')
    if (!reasoning || !releases[model.model.toLowerCase()]) return reference({ ...base, matchNote: '缺少已核实的型号 / 推理参数映射。' })
    if (reasoning.enabled && !reasoning.effort) return reference({ ...base, matchNote: 'AA 未提供可核实的相同思考预算；近似配置仅供参考。' })
    const matches = rows.filter(row => row.release === releases[model.model.toLowerCase()] && row.isReasoning === reasoning.enabled && (reasoning.enabled ? row.effort === reasoning.effort : !row.effort || row.effort === 'none'))
    if (matches.length > 1) return { ...base, match: 'ambiguous', matchNote: '同型号同档位出现多个条目，暂不自动选择。' }
    if (!matches.length) return reference({ ...base, matchNote: 'AA 暂无唯一的同型号同档位成绩；未上榜不代表能力差。' })
    const score = aaScore(matches[0], category)
    if (!score) return reference({ ...base, matchNote: '已找到对应型号与档位，但缺少该指标成绩。' })
    return { ...base, match: 'exact', score, matchNote: '型号版本、推理开关及 effort 与 AA 公开元数据一致。' }
  }))
}

export async function collectAgentModelEvidence(agents: Pick<AgentConfig, 'id' | 'reasoning'>[], categories: ModelCapability[], models: ModelConfig[]): Promise<ModelCapabilityEvidence[]> {
  const fetchedAt = new Date().toISOString()
  const arenaCategories = categories.filter(c => !c.startsWith('aa-'))
  // Fetch once within this request; no previous request's data is reused.
  const arenaPromise = collectModelEvidence(arenaCategories, models)
  let page: AAPage = { rows: [], catalog: [] }, error = '', detailFailures = 0
  try {
    page = parseAAPage(await downloadEvidence(aaSource))
    const needed = new Map<string, AACatalogEntry>()
    for (const agent of agents) for (const model of models) {
      let reasoning
      try { reasoning = resolveReasoning(model, agent.reasoning) } catch { continue }
      const release = releases[model.model.toLowerCase()]
      if (!release || !reasoning || reasoning.enabled && !reasoning.effort) continue
      for (const item of page.catalog.filter(c => c.releaseSlug === release)) {
        const statedEffort = /\((low|medium|high|xhigh|max)\)$/i.exec(item.name)?.[1].toLowerCase()
        if (statedEffort && statedEffort !== reasoning.effort) continue
        if (!page.rows.some(row => row.slug === item.slug)) needed.set(item.slug, item)
      }
    }
    // Exact details take priority; then fetch nearby public catalog entries so
    // missing budgets, unverified mappings and absent efforts are inspectable.
    for (const model of models) {
      const query = releases[model.model.toLowerCase()] || model.model
      for (const item of nearbyModelRows(query, page.catalog, item => item.releaseSlug)) {
        if (!page.rows.some(row => row.slug === item.slug)) needed.set(item.slug, item)
      }
    }
    const missing = [...needed.values()].slice(0, 32)
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(missing.slice(i, i + 4).map(async item => {
        try { const detail = parseAAPage(await downloadEvidence(aaSource + '/' + item.slug)); page.rows.push(...detail.rows.filter(row => row.slug === item.slug && row.release === item.releaseSlug)) }
        catch { detailFailures++ }
      }))
    }
  } catch (e) { error = e instanceof Error && !/fetch|network|abort|timeout/i.test(e.message) ? e.message : '无法联网获取 AA 数据。' }
  const arena = await arenaPromise
  const evidence: ModelCapabilityEvidence[] = []
  agents.forEach((agent, i) => {
    const category = categories[i]
    if (!category.startsWith('aa-')) {
      const source = arena.find(e => e.category === category)!
      // Keep unverified scores separately for inspection. They never become an
      // exact score simply by adding or removing an effort suffix.
      const candidates = source.candidates.map(candidate => {
        const model = models.find(m => m.id === candidate.connectionId)!
        const displayName = agentModelLabel(model, agent.reasoning)
        const references = candidate.score ? [{ score: candidate.score, url: source.url, note: '名称相同，但榜单未核实此实例的推理设置。' }] : candidate.similar
        const unmatched = { ...candidate, displayName, score: undefined, match: 'unmatched' as const, pareto: 'unknown' as const, similar: references }
        let reasoning
        try { reasoning = resolveReasoning(model, agent.reasoning) } catch { return { ...unmatched, matchNote: '候选不支持此实例的推理设置。' } }
        if (!reasoning) return { ...candidate, displayName }
        const query = model.model + (reasoning.enabled ? reasoning.effort ? '-' + reasoning.effort : ' (thinking budget ' + (reasoning.budget ?? 'maximum') + ')' : ' (non-reasoning)')
        return { ...unmatched, query, similar: references?.slice().sort((a, b) => modelNameSimilarity(query, b.score.model) - modelNameSimilarity(query, a.score.model)), matchNote: 'Arena 条目尚未核实当前推理设置；下列为名称近似参考，不用于自动改绑。' }
      })
      evidence.push({ ...source, source: 'arena', agentId: agent.id, candidates: markPareto(candidates) })
    }
    const aaCategory = category === 'aa-intelligence' ? category : 'aa-coding'
    evidence.push({ agentId: agent.id, source: 'aa', category: aaCategory, url: aaSource, fetchedAt, status: error ? 'unavailable' : 'fresh',
      candidates: matchAAEvidence(page.rows, models, agent, aaCategory),
      note: error ? error + ' 本次保留当前绑定。' : '本次重新读取 AA 公开页面，按型号版本和推理设置匹配；来源未公布统一更新日期，抓取时间不是评测日期。' + (detailFailures ? ' 部分档位详情获取失败，缺失候选不参与自动选择。' : '') + (!category.startsWith('aa-') ? ' 此处仅作终端编程参考，不代替所选 Web / 前端专项榜。' : ''),
    })
  })
  return evidence
}
