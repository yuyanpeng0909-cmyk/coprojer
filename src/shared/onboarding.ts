export interface OnboardingPreferences {
  version: 1
  projectId?: string
  featureId?: string
  paused?: boolean
  cardCollapsed?: boolean
  hintsHidden?: boolean
}

export type OnboardingPatch = Partial<Omit<OnboardingPreferences, 'version'>>
export type ModelCheckKind = 'connection' | 'capabilities'
export interface ModelCheckResult { status: 'passed' | 'failed'; at: string }
export type ModelChecks = Partial<Record<ModelCheckKind, ModelCheckResult>>
