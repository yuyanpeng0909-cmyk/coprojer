// Shared opt-in harness: route isolated Electron test windows before first show.
const path = require('node:path')
const { execFileSync } = require('node:child_process')
function nativeDisplays() {
  if (process.platform !== 'win32') return []
  try {
    return JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class CoprojerTestDpi { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value); }\'; $previousContext = [CoprojerTestDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)); Add-Type -AssemblyName System.Windows.Forms; $displays = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ device=$_.DeviceName; primary=$_.Primary; bounds=@{x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height} } }); ConvertTo-Json -InputObject $displays -Depth 4 -Compress'
    ], { encoding: 'utf8', windowsHide: true }).trim())
  } catch { return [] }
}
function install() {
  if (process.versions.electron) return
  const { _electron: electron } = require('playwright')
  if (electron.__coprojerDisplayRouting) return
  electron.__coprojerDisplayRouting = true
  const launch = electron.launch.bind(electron), root = path.resolve(__dirname, '..')
  const displays = nativeDisplays()
  electron.launch = options => {
    const args = [...(options.args || [])]
    if (path.resolve(options.cwd || process.cwd(), args[0] || '.') !== root) return launch(options)
    args[0] = path.join(__dirname, 'fixtures', 'test-display-entry.cjs')
    return launch({ ...options, args, env: { ...(options.env || process.env), COPROJER_TEST_NATIVE_DISPLAYS: JSON.stringify(displays) } })
  }
}
module.exports = { install, nativeDisplays }
if (process.env.COPROJER_ROUTE_TEST_WINDOWS === '1') install()
