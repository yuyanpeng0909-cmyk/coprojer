export type Protocol = 'chat' | 'responses' | 'anthropic'
export interface ModelConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  protocol: Protocol
  hasKey: boolean
}
export interface ModelInput extends Omit<ModelConfig, 'hasKey'> {
  apiKey?: string
}
export const toolLabels = {
  read_context: '共享上下文',
  list_files: '目录浏览',
  read_file: '读取文件',
  write_file: '修改文件',
  run_command: '运行命令与测试',
}
export type EngineeringToolName = keyof typeof toolLabels
export type AgentRole = 'planner' | 'designer' | 'developer' | 'reviewer'
export const agentRoleLabels: Record<AgentRole, string> = {
  planner: '任务规划', designer: '原型前端', developer: '开发', reviewer: '测试校验',
}
export const defaultAgentTools = (role: AgentRole): EngineeringToolName[] =>
  (Object.keys(toolLabels) as EngineeringToolName[]).filter(
    (name) => role === 'developer' || (role === 'reviewer' ? name !== 'write_file' : !['write_file', 'run_command'].includes(name)),
  )
export interface AgentConfig {
  id: string
  name: string
  role: AgentRole
  modelId: string
  instructions: string
  tools: EngineeringToolName[]
  skillIds?: string[]
}
export interface SkillDefinition {
  id: string
  name: string
  version: string
  description: string
  roles: AgentRole[]
  requiredTools: EngineeringToolName[]
  content: string
  origin: 'builtin' | 'local'
}
export interface AgentRunSnapshot {
  id: string
  at: string
  role: AgentRole
  agentId: string
  modelId: string
  featureId?: string
  skills: { id: string; version: string; hash: string }[]
  contextIds: string[]
  contextCharacters: number
  omittedCount: number
}
export type FeatureStage =
  | 'requirements'
  | 'solution'
  | 'ready'
  | 'developing'
  | 'verifying'
  | 'acceptance'
  | 'done'
  | 'blocked'
export type Scope = 'discussion' | 'current' | 'later'
export interface TaskItem {
  id: string
  title: string
  done: boolean
}
export interface CriterionResult {
  criterion: string
  passed: boolean
  evidence: string
}
export interface Feature {
  prototypeResult?: { prototypeId: string; passed: boolean; evidence: string }
  targetId?: string
  id: string
  module: string
  title: string
  description: string
  criteria: string[]
  scope: Scope
  stage: FeatureStage
  revision: number
  dependencies: string[]
  plan: string
  tasks: TaskItem[]
  developerId: string
  reviewerId: string
  results: CriterionResult[]
  repairRound: number
  feedback: string
  planSource?: 'manual' | 'llm'
  planGenerationError?: string
  planConfirmationError?: string
  baselineId?: string
  prototypeId?: string
}
export interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  modelId?: string
  modelName?: string
  status?: 'streaming' | 'complete' | 'stopped' | 'error'
  reasoning?: string
  tools?: DiscussionToolEvent[]
  error?: string
  purpose?: 'discussion' | 'design' | 'roundtable'
  meetingRound?: number
  speaker?: string
  targetId?: string
  updatedAt?: string
  finishedAt?: string
  designOutput?: string
}
export interface DiscussionToolEvent {
  id: string
  name: string
  arguments: string
  result?: string
  status: 'receiving' | 'running' | 'complete' | 'error'
}
export interface PrototypeRevision {
  designBrief?: string
  designFingerprint?: string
  targetId?: string
  id: string
  title: string
  html: string
  at: string
  modelId: string
  sourceMessageId: string
}
export interface RequirementsBaseline {
  id: string
  at: string
  fingerprint: string
  messageCount: number
  prototypeIds?: string[]
}
export interface ContextEntry {
  id: string
  title: string
  content: string
  source: string
  at: string
  kind?: 'goal' | 'requirements' | 'decision' | 'result' | 'acceptance' | 'manual'
  featureId?: string
  targetId?: string
  baselineId?: string
  status?: 'active' | 'superseded' | 'stale' | 'archived'
  revision?: number
  sourceRefs?: string[]
}
export interface ExecutionEvent {
  id: string
  featureId?: string
  kind: string
  message: string
  at: string
}
export interface FileChange {
  path: string
  before: string | null
  after: string | null
  featureId: string
}
export interface ExecutionPlan {
  id: string
  featureIds: string[]
  orderedFeatureIds: string[]
  rationale: string
  currentIndex: number
  status: 'planned' | 'running' | 'waiting-acceptance' | 'completed' | 'stopped'
  at: string
}
export interface BatchPlanResult {
  featureId: string
  success: boolean
  plan?: string
  tasks?: string[]
  error?: string
  skipped?: boolean
}
export interface BatchConfirmResult {
  featureId: string
  success: boolean
  plan?: string
  tasks?: string[]
  error?: string
}
export interface Project {
  prd?: {
    status: 'generating' | 'review' | 'confirmed' | 'error' | 'stale'
    sources: { prototypeId: string; targetId?: string; fingerprint: string; derivedFingerprint?: string }[]
    error?: string
  }
  prototypeBriefs?: Record<string, PrototypeBrief>
  plannerId?: string
  designerId?: string
  selectedPrototypeIds?: Record<string, string>
  agentRuns?: AgentRunSnapshot[]
  contextBudget?: number
  targets?: ProjectTarget[]
  roundtable?: Roundtable
  decisions?: RoundtableDecision[]
  id: string
  name: string
  root: string
  brief: string
  createdAt: string
  features: Feature[]
  chat: ChatEntry[]
  context: ContextEntry[]
  events: ExecutionEvent[]
  changes: FileChange[]
  discussionModelId: string
  activity: string | null
  previewUrl: string | null
  previewPort?: number
  prototypes?: PrototypeRevision[]
  designModelId?: string
  designActivity?: boolean
  requirementsBaseline?: RequirementsBaseline
  requirementsDocument?: string
  executionPlan?: ExecutionPlan
}
export interface PrototypeBrief {
  targetId?: string
  status: 'preferences' | 'designing' | 'review' | 'accepted' | 'error'
  preferences: string
  fingerprint: string
  prototypeId?: string
  acceptedAt?: string
  error?: string
}
export const targetKinds = {
  web: '前端 Web',
  backend: '后台服务',
  admin: '管理后台',
  mobile: '移动端',
  desktop: '桌面端',
  iot: 'IoT / 设备',
  other: '其他',
}
export interface ProjectTarget {
  id: string
  name: string
  kind: keyof typeof targetKinds
  directory: string
  responsibility: string
  contracts: string
}
export interface RoundtableParticipant {
  modelId: string
  role: string
}
export interface RoundtableConfig {
  participants: RoundtableParticipant[]
  passes: number
}
export interface Roundtable extends RoundtableConfig {
  round: number
  status: 'running' | 'awaiting-decision' | 'awaiting-human' | 'confirmed' | 'stopped' | 'error'
  cursor?: number
  phase: string
  summaryMessageId?: string
  error?: string
}
export interface RoundtableDecision {
  id: string
  question: string
  context: string
  options: { label: string; description: string }[]
  targetId?: string
  status: 'pending' | 'answered' | 'deferred' | 'resolved'
  round: number
  modelId: string
  modelName: string
  speaker: string
  sourceMessageId: string
  at: string
  answer?: string
  answeredAt?: string
  resolution?: string
  resolvedBy?: string
  resolvedAt?: string
}
export interface DecisionAnswer {
  choice?: number
  text?: string
  defer?: boolean
}
export function requirementsFingerprint(project: Project): string {
  return JSON.stringify({
    brief: project.brief,
    document: project.requirementsDocument || '',
    targets: project.targets || [],
    ...(project.decisions?.length ? { decisions: project.decisions } : {}),
    features: project.features.map((f) => ({
      id: f.id,
      targetId: f.targetId || '',
      title: f.title,
      module: f.module,
      description: f.description,
      criteria: f.criteria,
      scope: f.scope,
      dependencies: f.dependencies,
    })),
    prototype: project.selectedPrototypeIds?.[''] || project.prototypes?.filter(p => !p.targetId).at(-1)?.id || null,
    targetPrototypes: (project.targets || []).map(
      (t) => project.selectedPrototypeIds?.[t.id] || project.prototypes?.filter((p) => p.targetId === t.id).at(-1)?.id || null,
    ),
  })
}
export interface EngineeringState {
  skills?: SkillDefinition[]
  models: ModelConfig[]
  agents: AgentConfig[]
  projects: Project[]
}
export interface FeatureInput {
  targetId?: string
  title: string
  module: string
  description: string
  criteria: string[]
  scope: Scope
  developerId: string
  reviewerId: string
  dependencies: string[]
}
export interface EngineeringApi {
  acceptPrototypeAndPreparePrd(projectId: string, prototypeId: string): Promise<void>
  preparePrd(projectId: string): Promise<void>
  submitPrototypePreferences(projectId: string, preferences: string, targetId?: string): Promise<void>
  confirmRequirementsAndPrepare(projectId: string, fingerprint: string, messageCount: number): Promise<BatchPlanResult[]>
  configureProject(projectId: string, input: { plannerId: string; designerId: string; contextBudget: number }): Promise<void>
  archiveContext(projectId: string, id: string, archived: boolean): Promise<void>
  importSkill(directory: string): Promise<void>
  selectPrototype(projectId: string, prototypeId: string): Promise<void>
  preparePlans(projectId: string): Promise<BatchPlanResult[]>
  confirmPlansAndStart(projectId: string, featureIds: string[], revisions: number[]): Promise<BatchConfirmResult[]>
  acceptAndContinue(projectId: string, featureId: string): Promise<void>
  preflight(parent?: string): Promise<{ ready: boolean; checks: { name: string; ok: boolean; detail: string }[] }>
  testCapabilities(input: ModelInput): Promise<string>
  state(): Promise<EngineeringState>
  saveModel(input: ModelInput): Promise<ModelConfig>
  deleteModel(id: string): Promise<void>
  testModel(input: ModelInput): Promise<string>
  listModels(input: ModelInput): Promise<string[]>
  saveAgent(input: AgentConfig): Promise<void>
  createProject(input: {
    name: string
    parent: string
    brief: string
    modelId: string
  }): Promise<string>
  setProjectModel(projectId: string, modelId: string): Promise<void>
  discuss(projectId: string, text: string): Promise<void>
  roundtableTurn(projectId: string, text: string, config: RoundtableConfig): Promise<void>
  answerDecision(projectId: string, decisionId: string, answer: DecisionAnswer): Promise<void>
  saveTargets(projectId: string, targets: ProjectTarget[]): Promise<void>
  confirmProjectRequirements(
    projectId: string,
    fingerprint: string,
    messageCount: number,
  ): Promise<void>
  reopenProjectRequirements(projectId: string): Promise<void>
  saveRequirementsDocument(projectId: string, content: string, previous: string): Promise<void>
  generatePrototype(
    projectId: string,
    instruction: string,
    modelId: string,
    targetId?: string,
  ): Promise<void>
  stopDesign(projectId: string): Promise<void>
  saveFeature(projectId: string, id: string | null, input: FeatureInput): Promise<string>
  assignAgents(
    projectId: string,
    featureId: string,
    developerId: string,
    reviewerId: string,
  ): Promise<void>
  confirmRequirements(projectId: string, featureId: string): Promise<void>
  generatePlan(projectId: string, featureId: string): Promise<void>
  savePlan(projectId: string, featureId: string, plan: string, tasks: string[]): Promise<void>
  confirmPlan(projectId: string, featureId: string): Promise<void>
  generatePlans(
    projectId: string,
    featureIds: string[],
    overwriteExisting?: boolean,
  ): Promise<BatchPlanResult[]>
  confirmPlans(projectId: string, featureIds: string[]): Promise<BatchConfirmResult[]>
  planExecution(projectId: string, featureIds: string[]): Promise<ExecutionPlan>
  runExecutionPlan(projectId: string): Promise<void>
  runFeature(projectId: string, featureId: string): Promise<void>
  deleteFeature(projectId: string, featureId: string): Promise<void>
  stop(projectId: string): Promise<void>
  accept(projectId: string, featureId: string): Promise<void>
  reject(projectId: string, featureId: string, reason: string): Promise<void>
  saveContext(projectId: string, id: string | null, title: string, content: string): Promise<void>
  openProject(projectId: string): Promise<void>
  startPreview(projectId: string, script: string): Promise<string>
  stopPreview(projectId: string): Promise<void>
  openPreview(projectId: string): Promise<void>
}
export const stageLabels: Record<FeatureStage, string> = {
  requirements: '需求讨论',
  solution: '方案确认',
  ready: '待开发',
  developing: '开发中',
  verifying: '验证中',
  acceptance: '待验收',
  done: '已完成',
  blocked: '已暂停',
}
export const scopeLabels: Record<Scope, string> = {
  discussion: '待讨论',
  current: '本期',
  later: '暂缓',
}
export const engineeringMethods: (keyof EngineeringApi)[] = [
  'acceptPrototypeAndPreparePrd',
  'preparePrd',
  'submitPrototypePreferences',
  'confirmRequirementsAndPrepare', 'configureProject', 'archiveContext',
  'importSkill', 'selectPrototype', 'preparePlans', 'confirmPlansAndStart', 'acceptAndContinue', 'preflight', 'testCapabilities',
  'state',
  'saveModel',
  'deleteModel',
  'testModel',
  'listModels',
  'saveAgent',
  'createProject',
  'setProjectModel',
  'discuss',
  'roundtableTurn',
  'answerDecision',
  'saveTargets',
  'confirmProjectRequirements',
  'reopenProjectRequirements',
  'saveRequirementsDocument',
  'generatePrototype',
  'stopDesign',
  'saveFeature',
  'assignAgents',
  'confirmRequirements',
  'generatePlan',
  'savePlan',
  'confirmPlan',
  'generatePlans',
  'confirmPlans',
  'planExecution',
  'runExecutionPlan',
  'runFeature',
  'deleteFeature',
  'stop',
  'accept',
  'reject',
  'saveContext',
  'openProject',
  'startPreview',
  'stopPreview',
  'openPreview',
]
