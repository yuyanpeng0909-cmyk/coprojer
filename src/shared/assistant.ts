import type { AgentRole, AssistantChatEntry, AssistantModelUsage } from './engineering'

export type AssistantDestination = 'models' | 'agents' | 'requirements' | 'board' | 'overview' | 'projects'
export interface AssistantAction {
  kind: 'navigate' | 'remember'
  label: string
  destination?: AssistantDestination
  text?: string
}
export interface AssistantSession {
  id: string
  title: string
  projectId?: string
  createdAt: string
  updatedAt: string
  draft: string
  modelId: string
  scrollTop: number
  pinned: boolean
  archived: boolean
  messages: AssistantChatEntry[]
  summary?: { text: string; throughMessageId: string }
}
export type AssistantSessionPatch = Partial<Pick<AssistantSession, 'title' | 'draft' | 'modelId' | 'scrollTop' | 'pinned' | 'archived'>>
export interface AssistantMemory {
  id: string
  text: string
  projectId?: string
  sourceSessionId?: string
  createdAt: string
  updatedAt: string
}
export type AssistantMemoryInput = Pick<AssistantMemory, 'text' | 'projectId' | 'sourceSessionId'> & { id?: string }
export interface AssistantTeamMember {
  key: string
  role: AgentRole
  name: string
  modelId: string
  sourceAgentId?: string
  previousModelId?: string
  reason: string
}
export interface AssistantTeamPlan {
  id: string
  sessionId: string
  projectId?: string
  createdAt: string
  expiresAt: string
  fingerprint: string
  status: 'preview' | 'applied' | 'stale'
  members: AssistantTeamMember[]
  usage: AssistantModelUsage
  appliedAt?: string
  result?: string
  affectedProjects: string[]
}
export interface AssistantWorkspace {
  version: 1
  activeSessionId: string
  sessions: AssistantSession[]
  memories: AssistantMemory[]
  plans: AssistantTeamPlan[]
  dismissedHints: string[]
}
