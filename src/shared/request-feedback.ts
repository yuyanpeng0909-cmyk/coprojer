import type { EngineeringApi } from './engineering'

export interface PendingRequest { id: number; label: string; startedAt: number }
// Polling and autosave remain quiet; their views handle initial loading and failures.
export const quietRequests = new Set<keyof EngineeringApi>(['state', 'modelTraffic', 'updateAssistantSession', 'selectAssistantSession'])
export const requestLabels: Partial<Record<keyof EngineeringApi, string>> = {
  saveModel: '保存模型连接', deleteModel: '迁移并删除模型连接', previewModelRemoval: '读取模型引用', listModels: '获取模型列表', testModel: '测试模型连接', testCapabilities: '检查开发能力',
  saveAgent: '保存智能体配置', addProjectAgent: '复制项目成员与技能', isolateProjectTeam: '复制项目团队',
  recommendAgentModels: '查询能力榜单并生成建议', applyAgentModels: '应用模型配置', recommendSkills: '搜索并推荐技能', previewSkill: '读取技能安装预览', installSkill: '安装专属技能', removeSkill: '移除技能', discardSkillPreview: '取消安装', clearSkillSearch: '清空推荐记录',
  sendAssistantMessage: '等待助手回复', recommendAssistantTeam: '生成团队方案', updateAssistantTeamPlan: '保存团队方案', applyAssistantTeamPlan: '应用团队方案', stopAssistantMessage: '停止生成', setDefaultAssistantModel: '保存默认助手模型', createAssistantSession: '创建会话', deleteAssistantSession: '删除会话', clearAssistantChat: '清空会话', saveAssistantMemory: '保存助手偏好', deleteAssistantMemory: '删除助手偏好', dismissAssistantHint: '保存提示设置',
  scanAliyunModels: '识别阿里云模型', syncAliyunQuota: '等待授权或查询额度', importAliyunModels: '导入模型与配置', discardAliyunImport: '关闭导入', openAliyunPage: '打开阿里云控制台',
  createProject: '创建项目和团队', configureProject: '保存团队与预算', updateProjectMetadata: '保存项目信息', setProjectModel: '保存讨论模型', preflight: '读取运行环境', updateOnboarding: '保存入门设置',
  discuss: '启动需求讨论', roundtableTurn: '启动圆桌讨论', answerDecision: '保存决策', saveTargets: '保存子项目', confirmProjectRequirements: '确认需求基线', reopenProjectRequirements: '重新打开需求', saveRequirementsDocument: '保存需求文档',
  generatePrototype: '启动原型生成', stopDesign: '停止原型生成', selectPrototype: '保存原型选择', acceptPrototypeAndPreparePrd: '准备需求文档', preparePrd: '生成需求文档', submitPrototypePreferences: '保存设计意见',
  preparePlans: '批量生成实现方案', generatePlans: '批量生成实现方案', confirmPlans: '确认方案', confirmPlansAndStart: '确认方案并启动执行', confirmRequirementsAndPrepare: '确认需求并准备方案', generatePlan: '启动方案生成', savePlan: '保存实现方案', confirmPlan: '确认实现方案',
  saveFeature: '保存功能', deleteFeature: '删除功能', assignAgents: '分配功能成员', confirmRequirements: '确认功能需求', planExecution: '安排执行顺序', runExecutionPlan: '启动执行计划', runFeature: '启动功能执行', stop: '停止执行', accept: '保存验收结果', reject: '保存退回意见', acceptAndContinue: '验收并继续执行',
  saveContext: '保存共享上下文', archiveContext: '更新上下文', openProject: '打开项目目录', startPreview: '启动项目预览', stopPreview: '停止项目预览', openPreview: '打开项目预览',
  openModelEvidenceSource: '打开榜单来源', readRuntimeArtifact: '读取执行详情', adjustRuntimeBudget: '保存执行预算', reconcileRuntime: '恢复执行状态', prepareRuntimeHandoff: '准备任务接续',
}
