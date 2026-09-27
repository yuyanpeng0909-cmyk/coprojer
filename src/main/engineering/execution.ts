import type { ModelMessage } from './model'

export const executionStepLimit = 36
export interface CommandEvidence {
  code: number
  output: string
  isTest: boolean
  command: string
}
// Main-process state only. Saved at a completed tool-round boundary, never
// halfway through side effects. It is not part of the renderer's project model.
export interface ExecutionCheckpoint {
  role: 'developer' | 'reviewer'
  fingerprint: string
  sourceFingerprint: string
  round: number
  development: string
  messages: ModelMessage[]
  commands: CommandEvidence[]
  prototypeReadUntil: number
}
export const executionKey = (projectId: string, featureId: string) => JSON.stringify([projectId, featureId])
export class ExecutionBudgetPause extends Error {
  constructor(role: 'developer' | 'reviewer') {
    super(`${role === 'reviewer' ? '验证' : '开发'}已完成本次 ${executionStepLimit} 步，尚未形成完整结论，已暂停并保存执行进度。继续执行将从当前阶段接续；工程或任务变化时会重新检查。`)
    this.name = 'ExecutionBudgetPause'
  }
}
