const { app, screen } = require('electron')
const probe = global.__coprojerTestDisplay = { selection: null, windows: [], events: [] }
let target
app.whenReady().then(() => {
  const displays = screen.getAllDisplays(), primary = screen.getPrimaryDisplay()
  const native = JSON.parse(process.env.COPROJER_TEST_NATIVE_DISPLAYS || '[]')
  const preferred = native.find(d => d.device.endsWith('DISPLAY1') && !d.primary)
  const dip = preferred && screen.screenToDipRect(null, preferred.bounds)
  const match = dip && displays.find(d => d.id !== primary.id && ['x', 'y', 'width', 'height'].every(k => Math.abs(d.bounds[k] - dip[k]) <= 2))
  target = match || primary
  probe.selection = { reason: match ? 'display-1-non-primary' : 'primary-fallback', targetId: target.id, primaryId: primary.id, workArea: target.workArea, native }
  if (!match) console.log('测试窗口回退主屏幕：未能可靠匹配 1 号非主屏幕。')
})
app.on('browser-window-created', (_, window) => {
  const initiallyVisible = window.isVisible(), original = window.getBounds(), area = target.workArea
  // At 125% Windows scaling the native minimum can add two CSS pixels.
  // Isolated layout tests must be able to request the exact 860 x 600 viewport.
  window.setMinimumSize(1, 1)
  const width = Math.min(original.width, area.width), height = Math.min(original.height, area.height)
  window.setBounds({ x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height })
  // The constructor reapplies native minimums and DPI sizing after this event.
  // Reapply the test bounds when initialization finishes, before the app shows it.
  window.once('ready-to-show', () => {
    window.setMinimumSize(1, 1)
    window.setBounds({ x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height })
  })
  probe.windows.push({ id: window.id, initiallyVisible, displayId: screen.getDisplayMatching(window.getBounds()).id })
  for (const event of ['show', 'maximize', 'enter-full-screen']) window.on(event, () => probe.events.push({ event, id: window.id, displayId: screen.getDisplayMatching(window.getBounds()).id }))
})
require('../../out/main/index.js')
