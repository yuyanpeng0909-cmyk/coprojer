import type { EngineeringApi } from './engineering'
export type ResearchPanelKind = 'map' | 'prototype' | 'projects'
export interface ResearchPanelContext {
  projectId: string
  panel: ResearchPanelKind
  targetId?: string
}
export interface AppInfo {
  name: string
  version: string
  platform: string
  electron: string
}

export interface DesktopApi {
  researchPanel: () => Promise<ResearchPanelContext | null>
  openResearchPanel: (
    projectId: string,
    panel: ResearchPanelKind,
    targetId?: string,
  ) => Promise<void>
  saveArtifact: (name: string, dataUrl: string) => Promise<boolean>
  engineering: EngineeringApi
  getAppInfo: () => Promise<AppInfo>
  selectFolder: () => Promise<string | null>
  windowControl: (action: 'minimize' | 'maximize' | 'close') => Promise<void>
}
