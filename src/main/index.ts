import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import type { AppInfo, ResearchPanelContext } from '../shared/desktop'
import { EngineeringService } from './engineering/service'
import { engineeringMethods, type EngineeringApi } from '../shared/engineering'

let engineering: EngineeringService | undefined
const researchPanels = new Map<number, ResearchPanelContext>()
const closeHooks = new Set<number>(), pendingClose = new Set<number>(), readyToClose = new Set<number>()

app.setName('Coprojer')
// Give development, production, and automated tests separate application data.
if (process.env.COPROJER_USER_DATA) {
  app.setPath('userData', process.env.COPROJER_USER_DATA)
} else if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'Coprojer-dev'))
}

const rendererFile = join(__dirname, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const rendererUrl = developmentUrl ? new URL(developmentUrl).href : pathToFileURL(rendererFile).href

function registerHandlers(): void {
  const channels = [
    'app:info',
    'dialog:folder',
    'window:control',
    'engineering:invoke',
    'panel:context',
    'panel:open',
    'artifact:save',
  ]
  for (const channel of channels) ipcMain.removeHandler(channel)

  function trustedWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender)
    const frame = event.senderFrame
    if (!window || !frame || frame !== event.sender.mainFrame || frame.url !== rendererUrl) {
      throw new Error('Untrusted IPC sender')
    }
    return window
  }

  ipcMain.handle('engineering:invoke', async (event, method: unknown, args: unknown) => {
    trustedWindow(event)
    if (
      typeof method !== 'string' ||
      !engineeringMethods.includes(method as keyof EngineeringApi) ||
      !Array.isArray(args) ||
      JSON.stringify(args).length > 500000
    )
      throw new Error('无效的工程操作。')
    engineering ??= new EngineeringService()
    try {
      const operation = engineering[method as keyof EngineeringApi] as (...params: any[]) => unknown
      return await operation(...args)
    } catch (error) {
      throw new Error(
        engineering.store.redact(error instanceof Error ? error.message : String(error)),
      )
    }
  })

  ipcMain.handle('app:info', (event): AppInfo => {
    trustedWindow(event)
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
    }
  })

  ipcMain.handle('panel:context', (event) => {
    trustedWindow(event)
    return researchPanels.get(event.sender.id) ?? null
  })
  ipcMain.handle('panel:open', (event, projectId, panel, targetId) => {
    trustedWindow(event)
    if (typeof projectId !== 'string' || !['map', 'prototype', 'projects'].includes(panel))
      throw new Error('无效的预览面板。')
    engineering ??= new EngineeringService()
    const project = engineering.store.project(projectId)
    if (
      targetId !== undefined &&
      (typeof targetId !== 'string' || !project.targets?.some((t) => t.id === targetId))
    )
      throw new Error('子项目不存在。')
    for (const window of BrowserWindow.getAllWindows()) {
      const context = researchPanels.get(window.webContents.id)
      if (
        context?.projectId === projectId &&
        context.panel === panel &&
        context.targetId === targetId
      ) {
        window.show()
        window.focus()
        return
      }
    }
    createWindow({ projectId, panel, targetId })
  })
  ipcMain.handle('artifact:save', async (event, name, dataUrl) => {
    const window = trustedWindow(event)
    if (
      typeof name !== 'string' ||
      !/^[^<>:"/\\|?*\x00-\x1f]{1,150}\.(svg|png|md|json|html)$/.test(name) ||
      typeof dataUrl !== 'string' ||
      dataUrl.length > 8000000
    )
      throw new Error('导出文件格式无效。')
    const match =
      /^data:(image\/svg\+xml|image\/png|text\/plain|application\/json|text\/html)(;base64)?,([\s\S]*)$/.exec(
        dataUrl,
      )
    if (!match) throw new Error('导出内容格式无效。')
    const content = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf8')
    const result = await dialog.showSaveDialog(window, {
      defaultPath: name,
      filters: [{ name: '导出文件', extensions: [name.split('.').at(-1)!] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, content)
    return true
  })

  ipcMain.handle('dialog:folder', async (event) => {
    const window = trustedWindow(event)
    const result = await dialog.showOpenDialog(window, {
      title: '选择工作区文件夹',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('window:control', (event, action: unknown) => {
    const window = trustedWindow(event)
    if (action === 'minimize') window.minimize()
    else if (action === 'maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (action === 'close') window.close()
    else throw new Error('Unknown window action')
  })
  ipcMain.on('window:close-hook', (event, enabled: unknown) => {
    try { const window = trustedWindow(event); if (enabled === true) closeHooks.add(window.id); else closeHooks.delete(window.id) } catch { /* Ignore messages outside the trusted renderer. */ }
  })
  ipcMain.on('window:close-result', (event, saved: unknown) => {
    try {
      const window = trustedWindow(event)
      if (!pendingClose.delete(window.id)) return
      if (saved === true) { readyToClose.add(window.id); window.close() }
    } catch { /* A renderer can disappear during application shutdown. */ }
  })
}

function createWindow(panel?: ResearchPanelContext): void {
  const window = new BrowserWindow({
    title: 'Coprojer',
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (panel) {
    researchPanels.set(window.webContents.id, panel)
    const id = window.webContents.id
    window.on('closed', () => researchPanels.delete(id))
  }

  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!closeHooks.has(window.id) || readyToClose.has(window.id)) return
    event.preventDefault()
    if (!pendingClose.has(window.id)) { pendingClose.add(window.id); window.webContents.send('window:save-before-close') }
  })
  const clearCloseState = () => { closeHooks.delete(window.id); pendingClose.delete(window.id); readyToClose.delete(window.id) }
  window.once('closed', clearCloseState)
  window.webContents.on('render-process-gone', clearCloseState)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !event.url.startsWith('about:srcdoc')) event.preventDefault()
  })
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(rendererFile)
}

// One writer per user-data directory; test profiles use their own independent lock.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerHandlers()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => engineering?.dispose())
