import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/desktop'
import { engineeringMethods, type EngineeringApi } from '../shared/engineering'

const desktop: DesktopApi = {
  researchPanel: () => ipcRenderer.invoke('panel:context'),
  openResearchPanel: (projectId, panel, targetId) =>
    ipcRenderer.invoke('panel:open', projectId, panel, targetId),
  saveArtifact: (name, dataUrl) => ipcRenderer.invoke('artifact:save', name, dataUrl),
  engineering: Object.fromEntries(
    engineeringMethods.map((method) => [
      method,
      (...args: unknown[]) => ipcRenderer.invoke('engineering:invoke', method, args),
    ]),
  ) as unknown as EngineeringApi,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  selectFolder: () => ipcRenderer.invoke('dialog:folder'),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
}

contextBridge.exposeInMainWorld('desktop', desktop)
