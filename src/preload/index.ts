import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/desktop'
import { engineeringMethods, type EngineeringApi } from '../shared/engineering'
import { quietRequests, requestLabels, type PendingRequest } from '../shared/request-feedback'

let requestSequence = 0
const requests = new Map<number, PendingRequest>()
const listeners = new Set<(requests: PendingRequest[]) => void>()
const publish = () => { for (const listener of listeners) { try { listener([...requests.values()]) } catch { /* A closed renderer subscriber must not interrupt IPC. */ } } }
async function tracked<T>(label: string, action: () => Promise<T>): Promise<T> {
  const id = ++requestSequence
  requests.set(id, { id, label, startedAt: Date.now() }); publish()
  try { return await action() } finally { requests.delete(id); publish() }
}

const desktop: DesktopApi = {
  onEngineeringRequests: listener => { listeners.add(listener); listener([...requests.values()]); return () => { listeners.delete(listener) } },
  researchPanel: () => ipcRenderer.invoke('panel:context'),
  openResearchPanel: (projectId, panel, targetId) =>
    tracked('打开项目独立窗口', () => ipcRenderer.invoke('panel:open', projectId, panel, targetId)),
  saveArtifact: (name, dataUrl) => tracked('导出文件', () => ipcRenderer.invoke('artifact:save', name, dataUrl)),
  engineering: Object.fromEntries(
    engineeringMethods.map((method) => [
      method,
      (...args: unknown[]) => quietRequests.has(method) ? ipcRenderer.invoke('engineering:invoke', method, args) : tracked(requestLabels[method] || '处理操作', () => ipcRenderer.invoke('engineering:invoke', method, args)),
    ]),
  ) as unknown as EngineeringApi,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  selectFolder: () => tracked('等待选择目录', () => ipcRenderer.invoke('dialog:folder')),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  onBeforeClose: (save) => {
    const handler = () => { void Promise.resolve().then(save).then(() => ipcRenderer.send('window:close-result', true), () => ipcRenderer.send('window:close-result', false)) }
    ipcRenderer.on('window:save-before-close', handler)
    ipcRenderer.send('window:close-hook', true)
    return () => { ipcRenderer.removeListener('window:save-before-close', handler); ipcRenderer.send('window:close-hook', false) }
  },
}

contextBridge.exposeInMainWorld('desktop', desktop)
