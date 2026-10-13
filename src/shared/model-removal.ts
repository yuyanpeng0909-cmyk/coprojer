export interface ModelRemovalPreview {
  modelId: string
  references: string[]
  blockers: string[]
  suggestedReplacementId?: string
}
