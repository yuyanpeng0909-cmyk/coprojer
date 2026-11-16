export interface RunRef {
  executionRunId: string
  parentExecutionRunId?: string
  parentCallId?: string
}

export interface RunRecordRef {
  executionRunId?: string
  stepId?: string
}
