import { agentRoleLabels, defaultAgentTools, requirementsFingerprint, type AgentRole, type EngineeringState, type Feature } from '../../../shared/engineering'
import { activePrototypeBriefs } from '../../../shared/prototype-workflow'
import { deliveryFeatures, type DeliveryStage } from './delivery'

export type OnboardingStepId = 'connection' | 'assistant' | 'team' | 'project' | 'discussion' | 'prototype' | 'specification' | 'plans' | 'development' | 'verification' | 'acceptance'
export interface OnboardingStep {
  id: OnboardingStepId
  title: string
  detail: string
  action: string
  done: boolean
  optional?: boolean
  stage?: DeliveryStage
}
export function onboardingProgress(state: EngineeringState) {
  const preferences = state.onboarding
  const project = state.projects.find(p => p.id === preferences?.projectId && !p.archivedAt)
  const features = project ? deliveryFeatures(project) : []
  // Track one concrete feature. Later milestones cannot come from other projects or features.
  const feature = preferences?.featureId ? features.find(f => f.id === preferences.featureId) : features[0]
  const roles: AgentRole[] = ['planner', 'designer', 'developer', 'reviewer']
  const available = state.agents.filter(a => project ? !a.ownerProjectId || a.ownerProjectId === project.id : !a.ownerProjectId)
  const team = roles.map(role => {
    const explicit = role === 'planner' ? project?.plannerId : role === 'designer' ? project?.designerId : role === 'developer' ? feature?.developerId : feature?.reviewerId
    const agent = explicit ? available.find(a => a.id === explicit && a.role === role)
      : available.find(a => a.role === role && (project?.teamAgentIds || state.defaultTeamAgentIds || []).includes(a.id)) || available.find(a => a.role === role && !a.ownerProjectId)
    const model = state.models.find(m => m.id === agent?.modelId)
    const missingTools = agent ? defaultAgentTools(role).filter(t => !agent.tools.includes(t)) : []
    const ready = !!agent && !!model && !missingTools.length && model.checks?.connection?.status === 'passed' && model.checks?.capabilities?.status === 'passed'
    return { role, label: agentRoleLabels[role], agent, model, missingTools, ready }
  })
  const assistant = state.models.find(m => m.id === state.defaultAssistantModelId)
  const briefs = project ? activePrototypeBriefs(project) : []
  const hasUi = !project?.targets?.length || project.targets.some(t => ['web', 'admin', 'mobile', 'desktop'].includes(t.kind))
  const verified = (f: Feature | undefined) => !!f && !f.verificationPending && ['acceptance', 'done'].includes(f.stage) && f.criteria.length > 0 && f.criteria.every(criterion => f.results.some(r => r.criterion === criterion && r.passed && (!r.status || r.status === 'passed'))) && f.results.every(r => r.passed && (!r.status || r.status === 'passed')) && (!f.prototypeResult || f.prototypeResult.passed)
  const steps: OnboardingStep[] = [
    { id: 'connection', title: '接入第一个模型', detail: state.models.length ? `已保存 ${state.models.length} 个连接。保存或导入不代表连接已测试。` : '添加服务地址、API Key 和具体型号；也可以使用阿里云快速导入。', action: '打开模型连接', done: state.models.length > 0 },
    { id: 'assistant', title: '准备通用助手', detail: assistant ? `默认使用 ${assistant.model}。测试通过后，可用于答疑与配置建议。` : '从已保存连接中设置默认助手并测试连接。工程角色仍使用各自绑定的模型。', action: '设置并测试助手', done: !!assistant && assistant.checks?.connection?.status === 'passed' },
    { id: 'team', title: '检查基础团队', detail: team.every(t => t.ready) ? '规划、原型、开发、验证四类成员已绑定模型，并通过工具能力检查。' : '补齐四类成员的模型与必要工具，再检查开发能力。同一可用型号可以用于多个角色。', action: '检查团队配置', done: team.every(t => t.ready) },
    { id: 'project', title: '选择你的真实项目', detail: project ? `正在跟随「${project.name}」。切换工作台项目不会改变入门项目。` : preferences?.projectId ? '原入门项目已归档或不存在，请重新选择。' : '选择已有项目或创建新项目；本机环境与目录权限会在创建时检查。', action: '选择或新建项目', done: !!project },
    { id: 'discussion', title: '说清楚想做什么', detail: '描述谁会使用、要解决什么问题、最重要的操作。初步想法就足够开始。', action: '描述项目想法', done: !!project && (!!project.brief.trim() || project.chat.some(m => m.role === 'user')), stage: 'discussion' },
    { id: 'prototype', title: '试用并确认原型', detail: hasUi ? '填写设计意见，试用生成的原型；需要修改就反馈，满意后点击验收此原型。' : '当前项目没有界面子项目，可直接进入需求与规格。', action: '查看原型', done: !!project && (hasUi ? briefs.length > 0 && briefs.every(b => b.status === 'accepted' && !!b.acceptedAt && project.prototypes?.some(p => p.id === b.prototypeId)) : true), optional: !!project && !hasUi, stage: 'prototype' },
    { id: 'specification', title: '确认需求与验收标准', detail: '核对 PRD 和功能规格，确认需要实现的范围。浏览文档不会自动批准需求。', action: '审阅需求', done: !!project && project.requirementsBaseline?.fingerprint === requirementsFingerprint(project) && project.requirementsBaseline.messageCount === project.chat.length && project.prd?.status !== 'stale' && project.prd?.status !== 'review' && project.prd?.status !== 'error', stage: 'specification' },
    { id: 'plans', title: '审阅方案并确认开工', detail: '选择一个本期功能，检查方案、任务和依赖；点击确认开工才会开始执行。', action: '审阅方案', done: !!feature && !!feature.plan && feature.tasks.length > 0 && ['ready', 'developing', 'verifying', 'acceptance', 'done'].includes(feature.stage), stage: 'plans' },
    { id: 'development', title: '完成第一次开发', detail: '查看真实执行记录。遇到阻塞，先查看原因，再决定继续；可以随时返回项目管理。', action: '查看开发进展', done: !!feature && (['verifying', 'acceptance', 'done'].includes(feature.stage) || !!feature.verificationPending), stage: 'development' },
    { id: 'verification', title: '核对独立验证结果', detail: '检查逐项验收证据。待补验证、失败或仅有模型完成声明，都不算通过。', action: '查看验证证据', done: verified(feature), stage: 'verification' },
    { id: 'acceptance', title: '亲自试用并验收', detail: '启动预览、试用真实功能。符合预期后点击验收通过；不符合则退回修改。', action: '试用并验收', done: verified(feature) && feature?.stage === 'done', stage: 'acceptance' },
  ]
  const completed = steps.filter(s => s.done).length
  const next = steps.find(s => !s.done)
  return { steps, completed, next, complete: !next, project, feature, features, team, assistant }
}
export type OnboardingProgress = ReturnType<typeof onboardingProgress>
