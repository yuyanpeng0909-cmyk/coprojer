import type { ModelConfig } from '../../shared/engineering'
import { modelCapabilityLabels, type ArenaScore, type ModelCapability, type ModelCapabilityEvidence, type ModelEvidenceCandidate, type ModelSelectionPolicy } from '../../shared/model-evidence'
import { modelNameDifference, nearbyModelRows } from './model-name-reference'

// Fixed public sources only. No connection URL, credential or user prompt is sent to Arena.
export const arenaSources: Record<Exclude<ModelCapability, 'aa-intelligence' | 'aa-coding'>, { url: string; heading: RegExp }> = {
  webdev: { url: 'https://arena.ai/leaderboard/code', heading: /Code Arena.*WebDev.*Overall/ },
  frontend: { url: 'https://arena.ai/leaderboard/code/webdev/frontend', heading: /Code Arena.*WebDev.*Frontend/ },
  fullstack: { url: 'https://arena.ai/leaderboard/code/webdev/fullstack', heading: /Code Arena.*WebDev.*Fullstack/ },
  coding: { url: 'https://arena.ai/leaderboard/text/coding', heading: /Text Arena.*Coding/ },
  text: { url: 'https://arena.ai/leaderboard/text', heading: /Text Arena.*Overall/ },
}
const maxBytes = 6_000_000
const clean = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, s => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' }[s] || s)).replace(/\s+/g, ' ').trim()
const key = (model: string) => model.trim().toLowerCase()

/** Read the public server-rendered table; never execute page scripts or guess hidden API routes. */
export function parseArenaTable(html: string, category: ModelCapability): { updatedAt: string; rows: ArenaScore[] } {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (!h1 || !Object.hasOwn(arenaSources, category) || !arenaSources[category as keyof typeof arenaSources].heading.test(clean(h1[1]))) throw new Error('榜单类别不匹配，已停止使用此来源。')
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html)
  const headers = [...(table?.[1] || '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => clean(m[1]))
  if (headers.join('|') !== 'Rank|Rank Spread|Model|Score|Votes|Price $/M|Context') throw new Error('榜单表格结构已变化，未使用旧格式推测分数。')
  const metadata = clean(html.slice(h1.index, table!.index))
  const date = metadata.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}/)?.[0]
  const timestamp = date ? Date.parse(date + ' 00:00:00 GMT') : NaN
  if (!Number.isFinite(timestamp)) throw new Error('未找到可靠的榜单更新日期。')
  const updatedAt = new Date(timestamp).toISOString().slice(0, 10)
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(table![1])?.[1] || ''
  const rows: ArenaScore[] = []
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1])
    if (cells.length !== 7) throw new Error('榜单列数发生变化。')
    const model = /<span\b[^>]*title="([^"]+)"[^>]*>/i.exec(cells[2])?.[1]
    const rank = Number(clean(cells[0])), scoreText = clean(cells[3])
    const score = Number(scoreText.match(/^\d+(?:\.\d+)?/)?.[0])
    const votes = Number(clean(cells[4]).replace(/,/g, ''))
    if (!model || model.length > 200 || /[<>&\r\n]/.test(model) || !Number.isInteger(rank) || rank < 1 || !Number.isFinite(score) || score <= 0 || !Number.isInteger(votes) || votes < 0) throw new Error('榜单存在无法核实的型号 / 分数。')
    const interval = scoreText.match(/\+(\d+(?:\.\d+)?)\s*\/\s*-(\d+(?:\.\d+)?)/)
    const symmetric = scoreText.match(/±\s*(\d+(?:\.\d+)?)/)
    const plus = interval ? Number(interval[1]) : symmetric ? Number(symmetric[1]) : undefined
    const minus = interval ? Number(interval[2]) : plus
    const prices = clean(cells[5]).match(/^\$([\d,.]+)\s*\/\s*\$([\d,.]+)$/)
    const inputPrice = prices ? Number(prices[1].replace(/,/g, '')) : undefined
    const outputPrice = prices ? Number(prices[2].replace(/,/g, '')) : undefined
    rows.push({ model, rank, score, votes, preliminary: /preliminary/i.test(scoreText),
      ...(plus !== undefined && minus !== undefined ? { lower: score - minus, upper: score + plus } : {}),
      ...(inputPrice !== undefined && outputPrice !== undefined && Number.isFinite(inputPrice) && Number.isFinite(outputPrice) ? { inputPrice, outputPrice } : {}) })
  }
  const count = metadata.match(/([\d,]+) models/)?.[1]
  if (!rows.length || rows.length > 2000 || !count || Number(count.replace(/,/g, '')) !== rows.length) throw new Error('榜单未完整加载，不能据此推荐。')
  return { updatedAt, rows }
}
export async function downloadEvidence(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000), headers: { Accept: 'text/html', 'Accept-Language': 'en-US', 'Cache-Control': 'no-cache', 'User-Agent': 'Coprojer-Model-Evidence' } })
  if (!response.ok) throw new Error('榜单请求失败（' + response.status + '）。')
  if (!(response.headers.get('content-type') || '').includes('text/html')) throw new Error('未返回榜单页面。')
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('榜单响应过大。')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('榜单响应为空。')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      size += part.value.length; if (size > maxBytes) throw new Error('榜单响应过大。')
      chunks.push(part.value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks).toString('utf8')
}
type Score = NonNullable<ModelEvidenceCandidate['score']>
const priced = (s: Score) => s.inputPrice !== undefined && s.outputPrice !== undefined
const dominates = (a: Score, b: Score) => priced(a) && priced(b) && a.score >= b.score && a.inputPrice! <= b.inputPrice! && a.outputPrice! <= b.outputPrice! && (a.score > b.score || a.inputPrice! < b.inputPrice! || a.outputPrice! < b.outputPrice!)
export const validModelScore = (s?: Score): s is Score => !!s && !s.preliminary && ('metric' in s || s.votes > 0)
export function markPareto(candidates: ModelEvidenceCandidate[]): ModelEvidenceCandidate[] {
  const valid = candidates.filter(c => c.match === 'exact' && validModelScore(c.score))
  for (const c of valid) if (priced(c.score!)) c.pareto = valid.some(other => dominates(other.score!, c.score!)) ? 'dominated' : 'frontier'
  return candidates
}
export function matchModelEvidence(rows: ArenaScore[], models: Pick<ModelConfig, 'id' | 'model'>[], sourceUrl = arenaSources.webdev.url): ModelEvidenceCandidate[] {
  const indexed = new Map(rows.map(row => [key(row.model), row]))
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(key(row.model), (counts.get(key(row.model)) || 0) + 1)
  const candidates: ModelEvidenceCandidate[] = models.map(model => {
    if ((counts.get(key(model.model)) || 0) > 1) return { connectionId: model.id, model: model.model, match: 'ambiguous', pareto: 'unknown' }
    const score = indexed.get(key(model.model))
    const similar = score ? undefined : nearbyModelRows(model.model, rows.filter(row => counts.get(key(row.model)) === 1), row => row.model)
      .map(score => ({ score, url: sourceUrl, note: modelNameDifference(model.model, score.model) }))
    return { connectionId: model.id, model: model.model, match: score ? 'exact' : 'unmatched', score, similar, pareto: 'unknown' }
  })
  return markPareto(candidates)
}
export async function collectModelEvidence(categories: ModelCapability[], models: Pick<ModelConfig, 'id' | 'model'>[]): Promise<ModelCapabilityEvidence[]> {
  return Promise.all([...new Set(categories)].map(async category => {
    const url = arenaSources[category as keyof typeof arenaSources].url, fetchedAt = new Date().toISOString()
    try {
      const { rows, updatedAt } = parseArenaTable(await downloadEvidence(url), category)
      const age = Date.now() - Date.parse(updatedAt + 'T00:00:00Z')
      const status = age > 30 * 86400000 || age < -86400000 ? 'stale' : 'fresh'
      return { category, url, fetchedAt, updatedAt, status, candidates: matchModelEvidence(rows, models, url),
        note: status === 'stale' ? '榜单日期超过 30 天或异常，仅供查看，本次不据此改绑。' : '精确成绩与名称近似参考分开展示；近似条目仅供查看，不参与自动推荐或 Pareto。' } as ModelCapabilityEvidence
    } catch (error) {
      return { category, url, fetchedAt, status: 'unavailable', candidates: matchModelEvidence([], models), note: (error instanceof Error && !/fetch|network|abort|timeout/i.test(error.message) ? error.message : '无法获取 Arena 榜单，请检查网络后重试。') + ' 本类别保留当前绑定。' } as ModelCapabilityEvidence
    }
  }))
}
export function eligibleModelIds(evidence: ModelCapabilityEvidence, policy: ModelSelectionPolicy): string[] {
  if (evidence.status !== 'fresh') return []
  const candidates = evidence.candidates.filter(c => c.match === 'exact' && validModelScore(c.score))
  if (!candidates.length) return []
  const best = candidates.reduce((a, b) => a.score!.score >= b.score!.score ? a : b).score!
  const highest = candidates.filter(c => c.score!.score === best.score)
  if (policy === 'quality') return highest.map(c => c.connectionId)
  // Price never substitutes for capability: only overlapping reported score intervals enter the trade-off.
  // Missing prices/intervals do not become zero or an invented confidence interval.
  const comparable = candidates.filter(c => c.score!.score === best.score || best.lower !== undefined && best.upper !== undefined && c.score!.upper !== undefined && c.score!.lower !== undefined && c.score!.upper >= best.lower && c.score!.lower <= best.upper)
  return comparable.filter(c => c.pareto !== 'dominated' && (priced(c.score!) || c.score!.score === best.score)).map(c => c.connectionId)
}
export function modelSelectionReason(evidence: ModelCapabilityEvidence, selected: string, policy: ModelSelectionPolicy): string {
  const c = evidence.candidates.find(c => c.connectionId === selected), s = c?.score
  if (!s) return '证据不足，保留当前绑定；不会根据型号名称推断能力。'
  if ('metric' in s) return modelCapabilityLabels[evidence.category] + '：Artificial Analysis 精确匹配 ' + s.model + '，得分 ' + s.score.toFixed(2) + (s.metric === 'aa-coding' ? '%' : '') + '。在本次已接入且推理设置一致的有效候选中得分最高。' + (policy === 'pareto' && c?.pareto === 'frontier' ? '同分候选按输入 / 输出参考费用比较，位于 Pareto 前沿。' : '') + '本指标不等同于前端设计质量或当前工程成功率；来源未提供置信区间，不推断分数相近即能力相同。'
  const interval = s.lower !== undefined ? `，区间 ${s.lower}–${s.upper}` : '，来源未提供分数区间'
  const highest = Math.max(...evidence.candidates.filter(candidate => validModelScore(candidate.score)).map(candidate => candidate.score!.score))
  const lead = policy === 'quality' ? '在本次已接入且有有效证据的型号中，此类别得分最高（同分可并列）。' : c?.pareto === 'frontier' ? (s.score === highest ? '此类别得分最高，' : '与最高分候选的榜单区间重叠，') + '且处于已接入、价格齐全候选的能力 / 费用 Pareto 前沿。' : '此类别得分最高；费用信息不足，未宣称 Pareto 最优。'
  return `${modelCapabilityLabels[evidence.category]}：Arena 精确匹配 ${s.model}，得分 ${s.score}${interval}，${s.votes.toLocaleString('en-US')} 票。${lead}榜单反映该类别的用户偏好，不等于工程测试通过率；区间重叠不证明能力相同。`
}
