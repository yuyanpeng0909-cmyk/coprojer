export type ReceiptStatus = 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain'
export interface ToolReceiptView {
  logicalId: string
  tool: string
  taskRevision: number
  status: ReceiptStatus
  at: string
  updatedAt: string
  attempts: number
  reason?: string
  effects: string[]
  nextStep?: string
  applied: boolean
  partialCommand?: { runId: string; stoppedConfirmed: false; observedAt: string; artifact?: { id: string; complete: boolean } }
}
