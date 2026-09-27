import { readFileSync, realpathSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { builtinSkills } from '../../shared/agents'
import { agentRoleLabels, toolLabels, type AgentConfig, type SkillDefinition } from '../../shared/engineering'
import { contextHash } from './context'

export function loadLocalSkill(directory: string): SkillDefinition {
  const root = realpathSync(directory)
  const read = (name: string) => {
    const path = join(root, name)
    if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 30000) throw new Error('技能文件不能是符号链接或超过 30 KB。')
    return readFileSync(path, 'utf8')
  }
  const manifest = JSON.parse(read('skill.json'))
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(manifest.id) || builtinSkills.some(s => s.id === manifest.id)) throw new Error('本地技能 ID 无效或与内置技能冲突。')
  for (const key of ['name', 'description', 'version']) if (typeof manifest[key] !== 'string' || !manifest[key].trim() || manifest[key].length > 500) throw new Error('技能缺少有效的 ' + key)
  if (!Array.isArray(manifest.roles) || !manifest.roles.length || manifest.roles.some((r: string) => !Object.hasOwn(agentRoleLabels, r))) throw new Error('技能适用角色无效。')
  if (!Array.isArray(manifest.requiredTools) || manifest.requiredTools.some((t: string) => !Object.hasOwn(toolLabels, t))) throw new Error('技能要求当前尚未提供的工具能力。')
  const content = read('SKILL.md').trim()
  if (!content || content.length > 16000) throw new Error('技能正文为空或超过 16000 字符。')
  return { id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version, roles: manifest.roles, requiredTools: manifest.requiredTools, content, origin: 'local' }
}

export function agentSkills(agent: AgentConfig, skills: SkillDefinition[]) {
  const selected = (agent.skillIds || []).map(id => {
    const skill = skills.find(s => s.id === id)
    if (!skill) throw new Error('已装配技能不存在：' + id)
    if (!skill.roles.includes(agent.role)) throw new Error('技能“' + skill.name + '”不适用于此角色。')
    if (skill.requiredTools.some(t => !agent.tools.includes(t))) throw new Error('技能“' + skill.name + '”缺少所需工具，请调整装配或启用相应工具。')
    return skill
  })
  return {
    text: selected.map(s => '[' + s.name + ' ' + s.version + ']\n' + s.content).join('\n\n'),
    snapshots: selected.map(s => ({ id: s.id, version: s.version, hash: contextHash(s.content) })),
  }
}
