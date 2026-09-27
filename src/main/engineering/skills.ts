import { readFileSync, realpathSync, lstatSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, isAbsolute } from 'node:path'
import { parseDocument } from 'yaml'
import { agentRoleLabels, toolLabels, type AgentConfig, type SkillDefinition } from '../../shared/engineering'
import { contextHash, readPage } from './context'

export const skillLimits = { files: 160, fileBytes: 2_000_000, packageBytes: 12_000_000, content: 80000 }
export function skillResourcePath(root: string, name: string): string {
  if (typeof name !== 'string' || !name || /[\\:\x00]/.test(name) || isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('技能资源必须使用包内相对路径。')
  const target = join(root, name), rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('技能资源路径越界。')
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('技能目录不能包含符号链接。')
  }
  return target
}
export function parseSkill(content: string, fallbackName: string, role: AgentConfig['role'], legacy?: Record<string, any>): SkillDefinition {
  if (!content.trim() || content.length > skillLimits.content) throw new Error('SKILL.md 为空或超过 80000 字符。')
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  let metadata: Record<string, any> = {}
  if (front) {
    const document = parseDocument(front[1], { uniqueKeys: true })
    if (document.errors.length) throw new Error('SKILL.md 元信息格式无效：' + document.errors[0].message)
    metadata = document.toJS({ maxAliasCount: 20 })
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('SKILL.md 元信息必须是对象。')
  } else if (!legacy) throw new Error('SKILL.md 需要 YAML 元信息（name、description），或提供兼容的 skill.json。')
  const id = legacy?.id || metadata.name || fallbackName, name = legacy?.name || metadata.name
  const description = legacy?.description || metadata.description, version = legacy?.version || metadata.metadata?.version || '未标注'
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('技能 name/id 须为小写字母、数字和连字符，最长 64 字符。')
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof description !== 'string' || !description.trim() || description.length > 2000 || typeof version !== 'string' || version.length > 100) throw new Error('技能缺少有效的名称、说明或版本。')
  const roles = legacy?.roles || [role], requiredTools = legacy?.requiredTools || []
  if (!Array.isArray(roles) || !roles.length || roles.some(r => !Object.hasOwn(agentRoleLabels, r))) throw new Error('技能适用角色无效。')
  if (!Array.isArray(requiredTools) || requiredTools.some(t => !Object.hasOwn(toolLabels, t))) throw new Error('技能要求当前尚未提供的工具能力。')
  return { id, sourceId: id, name, description, version, roles, requiredTools, content, origin: 'local', compatibility: typeof metadata.compatibility === 'string' ? metadata.compatibility.slice(0, 1000) : undefined }
}
export function loadLocalSkill(directory: string, role: AgentConfig['role'] = 'developer'): SkillDefinition {
  const root = realpathSync(directory)
  if (!lstatSync(root).isDirectory()) throw new Error('请选择包含 SKILL.md 的技能目录。')
  const read = (name: string) => {
    const path = skillResourcePath(root, name), stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw new Error('技能目录缺少 ' + name + '，请选择它所在的文件夹。')
    if (stat.size > skillLimits.fileBytes) throw new Error('技能文件过大：' + name)
    return readFileSync(path, 'utf8')
  }
  const manifest = lstatSync(join(root, 'skill.json'), { throwIfNoEntry: false }) ? JSON.parse(read('skill.json')) : undefined
  return parseSkill(read('SKILL.md'), basename(root), role, manifest)
}
export function copySkillPackage(source: string, destination: string) {
  const root = realpathSync(source), files: { path: string; size: number }[] = []
  let totalBytes = 0
  const walk = (prefix: string) => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      if (['.git', 'node_modules', '__pycache__', '.venv'].includes(entry.name)) continue
      const name = prefix ? prefix + '/' + entry.name : entry.name, sourcePath = skillResourcePath(root, name)
      if (entry.isDirectory()) { if (name.split('/').length > 8) throw new Error('技能目录层级超过 8 层。'); walk(name); continue }
      if (!entry.isFile()) throw new Error('技能包含不支持的文件：' + name)
      if (lstatSync(sourcePath).size > skillLimits.fileBytes) throw new Error('技能单文件超过 2 MB：' + name)
      const bytes = readFileSync(sourcePath)
      totalBytes += bytes.length
      if (bytes.length > skillLimits.fileBytes || totalBytes > skillLimits.packageBytes || files.length >= skillLimits.files) throw new Error('技能包超过限制（160 个文件、单文件 2 MB、总计 12 MB）。')
      const target = skillResourcePath(destination, name)
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
      files.push({ path: name, size: bytes.length })
    }
  }
  walk('')
  return { files, totalBytes }
}
export function agentSkills(agent: AgentConfig, skills: SkillDefinition[]) {
  const selected = (agent.skillIds || []).map(id => {
    const skill = skills.find(s => s.id === id)
    if (!skill) throw new Error('已装配技能不存在：' + id)
    if (skill.ownerAgentId !== agent.id) throw new Error('不能装配或使用其他智能体的专属技能。')
    if (!skill.roles.includes(agent.role)) throw new Error('技能“' + skill.name + '”不适用于此角色。')
    if (skill.requiredTools.some(t => !agent.tools.includes(t))) throw new Error('技能“' + skill.name + '”缺少所需工具，请调整装配或启用相应工具。')
    return skill
  })
  return { text: selected.map(s => JSON.stringify({ id: s.id, name: s.name, description: s.description, version: s.version })).join('\n'), snapshots: selected.map(s => ({ id: s.id, version: s.version, hash: contextHash(s.content) })), selected }
}
export function skillReader(agent: AgentConfig, skills: SkillDefinition[], onRead?: (id: string) => void) {
  const selected = structuredClone(agentSkills(agent, skills).selected)
  return (args: Record<string, any>) => {
    const skill = selected.find(s => s.id === args.id)
    if (!skill || skill.ownerAgentId !== agent.id) throw new Error('该技能未启用或不属于当前智能体。')
    if (!args.path || args.path === 'SKILL.md') {
      const page = readPage(skill.content, args); onRead?.(skill.id)
      return JSON.stringify({ ...JSON.parse(page), resources: skill.resources || [], compatibility: skill.compatibility || '' })
    }
    if (!skill.packageRoot || !skill.resources?.some(r => r.path === args.path)) throw new Error('技能中没有此资源。')
    const bytes = readFileSync(skillResourcePath(skill.packageRoot, args.path))
    if (bytes.length > skillLimits.fileBytes) throw new Error('资源超过读取限制。')
    if (bytes.includes(0)) throw new Error('这是二进制资源，不能作为文本读取。')
    onRead?.(skill.id)
    return readPage(bytes.toString('utf8'), args)
  }
}
