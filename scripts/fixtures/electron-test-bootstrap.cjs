// Loaded as the entry point only by the isolated test launcher.
const electron = require('electron'), path = require('node:path'), fs = require('node:fs')
// Fail the owned test process with its stack instead of opening an unplaced
// native error dialog. Application exceptions still fail the test.
process.on('uncaughtException', error => { console.error(error.stack || error); electron.app.exit(1) })
const root = process.env.COPROJER_TEST_APP_ROOT
if (!root || !process.env.COPROJER_TEST_DISPLAY) throw Error('Missing explicit test application/display')
const selected = JSON.parse(process.env.COPROJER_TEST_DISPLAY)
const Native = electron.BrowserWindow
const TestWindow = class BrowserWindow extends Native {
  constructor(options = {}) {
    const area = selected.workArea
    super({ ...options, show: false, x: area.x + 16, y: area.y + 16 })
    this.setMinimumSize(1, 1)
    this.setPosition(area.x + 16, area.y + 16)
    if (options.show !== false) this.show()
  }
}
// Electron exports non-configurable getters. Substitute only the module view
// consumed by this isolated entry point; never redefine native exports.
const Module = require('node:module'), originalLoad = Module._load
const testElectron = { ...electron, BrowserWindow: TestWindow }
Module._load = function (name, ...args) {
  return name === 'electron' ? testElectron : originalLoad.call(this, name, ...args)
}
if (process.env.COPROJER_CAPTURE_TRAY === '1') {
  const setTip = electron.Tray.prototype.setToolTip
  electron.Tray.prototype.setToolTip = function (tip) {
    global.__coprojerNativeTray = this; global.__coprojerNativeTip = tip
    return setTip.call(this, tip)
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
electron.app.setAppPath(root)
electron.app.setName(manifest.productName || manifest.name)
const entryIndex = process.argv.indexOf(__filename)
if (entryIndex >= 0) process.argv[entryIndex] = root
require(path.resolve(root, manifest.main || 'index.js'))
