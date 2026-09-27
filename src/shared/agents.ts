import { defaultAgentTools, type AgentConfig, type AgentRole, type SkillDefinition } from './engineering'

export const builtinSkills: SkillDefinition[] = [
  { id: 'requirements', name: '需求与任务规划', version: '1.0.0', description: '梳理范围、依赖和可验证的验收标准。', roles: ['planner'], requiredTools: [], origin: 'builtin', content: '区分本期与暂缓范围；补全业务规则、边界和可验证验收项。按依赖拆分可独立验收的功能，保留人工决策与未决问题。复用已有功能，不降低已确认目标。方案说明实现、测试、启动方式；不要代替用户确认。' },
  { id: 'prototype', name: '交互原型与交接', version: '1.0.0', description: '设计页面、响应式状态，并给真实工程留下实现依据。', roles: ['designer'], requiredTools: [], origin: 'builtin', content: '根据用户目标设计可交互原型。覆盖主要操作、空状态、错误反馈、键盘焦点及窄窗口布局；尊重已有视觉规范。用语义化 HTML 和可访问标签。原型与真实工程不同，交接时说明页面、交互状态和验收办法；不得声称原型已成为实际应用。' },
  { id: 'delivery', name: '工程实现与修复', version: '1.0.0', description: '复用现有代码，实现功能并运行检查。', roles: ['developer'], requiredTools: ['write_file', 'run_command'], origin: 'builtin', content: '先读取实际工程和当前批准原型，再实现已确认范围。按原型页面和状态落实到真实工程，保持公共样式与交互一致。使用最小可靠改动，提供 dev/build/test 脚本。验证真实行为，失败时修复根因。报告变更文件、实际检查与未完成项，不把实现声明当作证据。' },
  { id: 'verification', name: '独立测试与验收', version: '1.0.0', description: '运行真实检查，逐项保留证据和缺口。', roles: ['reviewer'], requiredTools: ['run_command'], origin: 'builtin', content: '独立读取实际代码，按原验收条件运行真实测试与必要构建。不要修改源代码或测试以使其通过。区分自动测试、运行界面、批准原型符合度与人工验收。没有浏览器或截图证据时，视觉符合度写明未验证，不凭开发总结通过。失败项提供可复现原因与修复建议。' },
]

export function defaultAgents(modelId = ''): AgentConfig[] {
  const definitions: [AgentRole, string, string][] = [
    ['planner', '任务规划智能体', '整理需求与任务依赖，准备可执行方案，保留人工确认。'],
    ['designer', '原型前端智能体', '根据需求制作可交互原型，保留页面与状态的交接依据。'],
    ['developer', '开发智能体', '实现已确认需求，复用项目公共内容，修改后运行必要检查。'],
    ['reviewer', '验证智能体', '独立检查实际代码，运行测试并逐项核对验收标准。不要仅复述开发者的完成声明。'],
  ]
  return definitions.map(([role, name, instructions]) => ({
    id: role, role, name, instructions, modelId, tools: defaultAgentTools(role),
    skillIds: builtinSkills.filter(skill => skill.roles.includes(role)).map(skill => ownedSkillId(role, skill.id)),
  }))
}

export const ownedSkillId = (agentId: string, sourceId: string) => `${agentId}::${sourceId}`
export function ownSkill(skill: SkillDefinition, agentId: string): SkillDefinition {
  const sourceId = skill.sourceId || skill.id
  return { ...structuredClone(skill), id: ownedSkillId(agentId, sourceId), sourceId, ownerAgentId: agentId }
}

// Keep unassigned legacy definitions for recovery; only owned copies may execute.
export function migrateAgentSkills(agents: AgentConfig[], skills: SkillDefinition[]): SkillDefinition[] {
  const result = [...skills]
  for (const agent of agents) {
    agent.tools = [...new Set([...agent.tools, 'read_skill' as const])]
    const defaults = builtinSkills.filter(s => s.roles.includes(agent.role) && s.requiredTools.every(t => agent.tools.includes(t)))
    for (const template of defaults) {
      const owned = ownSkill(template, agent.id)
      if (!result.some(s => s.id === owned.id)) result.push(owned)
    }
    agent.skillIds = (agent.skillIds ?? defaults.map(s => s.id)).map(id => {
      const skill = result.find(s => s.id === id) || builtinSkills.find(s => s.id === id)
      if (!skill || skill.ownerAgentId) return id
      const owned = ownSkill(skill, agent.id)
      if (!result.some(s => s.id === owned.id)) result.push(owned)
      return owned.id
    })
  }
  return result
}
