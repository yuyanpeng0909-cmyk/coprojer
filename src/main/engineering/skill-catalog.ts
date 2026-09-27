import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { skillLimits, skillResourcePath, parseSkill } from './skills'
import type { AgentRole, SkillRecommendation } from '../../shared/engineering'

// Only public catalog/GitHub endpoints. A skill cannot choose an arbitrary request host.
async function download(url: string, maxBytes = 2_000_000): Promise<Buffer> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !['skills.sh', 'api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw new Error('不支持此技能来源。')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Coprojer-Skills', Accept: 'application/json' } })
  if (!response.ok) throw new Error('技能来源请求失败（' + response.status + '），请稍后重试或使用本地目录。')
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('技能来源响应过大。')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('技能来源返回空响应。')
  const chunks: Uint8Array[] = []; let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) throw new Error('技能来源响应过大。')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}
const json = async (url: string) => JSON.parse((await download(url, 5_000_000)).toString('utf8'))
type TreeEntry = { path: string; type: string; mode: string; size?: number }
export function parseGithubSource(location: string) {
  const url = new URL(location)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) throw new Error('请提供公开 GitHub 技能目录地址。')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const [owner, repo, kind, ref, ...path] = parts
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || repo.endsWith('.git') || kind && !['tree', 'blob'].includes(kind)) throw new Error('GitHub 地址格式无效，请选择技能所在目录。')
  const directory = path.join('/').replace(/\/?SKILL\.md$/, '')
  if (directory && directory.split('/').some(p => !p || p === '..' || p === '.' || /[\\:\x00]/.test(p))) throw new Error('技能目录路径无效。')
  return { repo: owner + '/' + repo, ref: ref || 'HEAD', directory, skillName: url.searchParams.get('skill') || '' }
}
async function resolveGithub(location: string) {
  const source = parseGithubSource(location), base = 'https://api.github.com/repos/' + source.repo
  const commit = await json(base + '/commits/' + encodeURIComponent(source.ref))
  if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('技能来源没有可固定的版本。')
  const listing = await json(base + '/git/trees/' + commit.sha + '?recursive=1')
  if (listing.truncated || !Array.isArray(listing.tree)) throw new Error('技能仓库过大，请下载技能目录后本地导入。')
  const tree: TreeEntry[] = listing.tree
  let directory = source.directory
  if (!tree.some(e => e.path === (directory ? directory + '/' : '') + 'SKILL.md')) {
    if (directory) throw new Error('指定的 GitHub 目录没有 SKILL.md，请检查目录地址。')
    const candidates = tree.filter(e => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path) && (!source.skillName || e.path.split('/').at(-2) === source.skillName))
    if (candidates.length !== 1) throw new Error('请提供具体技能目录地址，仓库中存在多个技能或没有匹配的 SKILL.md。')
    directory = candidates[0].path.replace(/\/?SKILL\.md$/, '')
  }
  const prefix = directory ? directory + '/' : ''
  const files = tree.filter(e => e.type !== 'tree' && e.path.startsWith(prefix)).map(e => ({ ...e, path: e.path.slice(prefix.length) }))
  if (!files.length || files.length > skillLimits.files || files.some(e => e.type !== 'blob' || !['100644', '100755'].includes(e.mode) || (e.size || 0) > skillLimits.fileBytes) || files.reduce((n, f) => n + (f.size || 0), 0) > skillLimits.packageBytes) throw new Error('技能包过大或包含符号链接/子模块，请使用合规的独立技能目录。')
  const encodedDirectory = directory.split('/').map(encodeURIComponent).join('/')
  const raw = 'https://raw.githubusercontent.com/' + source.repo + '/' + commit.sha + '/' + (directory ? encodedDirectory + '/' : '')
  const url = 'https://github.com/' + source.repo + '/tree/' + commit.sha + (directory ? '/' + encodedDirectory : '')
  return { files, raw, url, revision: commit.sha }
}
export async function downloadGithubSkill(location: string, destination: string) {
  const resolved = await resolveGithub(location)
  let totalBytes = 0
  for (const file of resolved.files) {
    const target = skillResourcePath(destination, file.path)
    const bytes = await download(resolved.raw + file.path.split('/').map(encodeURIComponent).join('/'), skillLimits.fileBytes)
    totalBytes += bytes.length
    if (totalBytes > skillLimits.packageBytes) throw new Error('技能包超过 12 MB。')
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
    file.size = bytes.length
  }
  return { files: resolved.files.map(f => ({ path: f.path, size: f.size || 0 })), totalBytes, location: resolved.url, revision: resolved.revision }
}
export async function searchPublicSkills(query: string, role: AgentRole): Promise<SkillRecommendation[]> {
  const data = await json('https://skills.sh/api/search?q=' + encodeURIComponent(query) + '&limit=5')
  if (!Array.isArray(data.skills)) throw new Error('技能索引返回格式已变化，请改用 GitHub 地址或本地导入。')
  const candidates = data.skills.filter((s: any) => typeof s.name === 'string' && /^[a-z0-9-]{1,64}$/.test(s.name) && typeof s.source === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s.source)).slice(0, 5)
  const results = await Promise.allSettled(candidates.map(async (candidate: any) => {
    const resolved = await resolveGithub('https://github.com/' + candidate.source + '?skill=' + encodeURIComponent(candidate.name))
    const content = (await download(resolved.raw + 'SKILL.md')).toString('utf8')
    const skill = parseSkill(content, candidate.name, role)
    return { name: skill.name, description: skill.description, url: resolved.url, reason: '' }
  }))
  const valid = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
  if (candidates.length && !valid.length) throw new Error('找到了候选，但无法核实技能正文。请重试或使用本地导入。')
  return valid
}
