// Opt-in Node preload for project tests. No user window is moved.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), {spawnSync} = require('node:child_process')
// npm's Windows launcher invokes node -p to discover its executable. Do not
// load Playwright or print monitor diagnostics into that machine-readable call.
const isTestEntry = !!process.argv[1] && /\.cjs$/i.test(process.argv[1])
if (isTestEntry && !process.versions.electron && !process.env.COPROJER_TEST_DISPLAY) {
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Add-Type -AssemblyName System.Windows.Forms; @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{device=$_.DeviceName;primary=$_.Primary;workArea=@{x=$_.WorkingArea.X;y=$_.WorkingArea.Y;width=$_.WorkingArea.Width;height=$_.WorkingArea.Height}} }) | ConvertTo-Json -Compress'],
    {encoding:'utf8',windowsHide:true,timeout:10000})
  const parsed=JSON.parse(result.stdout)
  // Windows PowerShell unwraps a single screen when serializing the pipeline.
  const screens=Array.isArray(parsed)?parsed:[parsed]
  const selected=screens.find(s=>s.device.endsWith('DISPLAY1')&&!s.primary)||screens.find(s=>s.primary)
  if(!selected) throw Error('Cannot identify test monitor')
  process.env.COPROJER_TEST_DISPLAY=JSON.stringify(selected)
  console.log('TEST_DISPLAY '+JSON.stringify(selected))
}
if(isTestEntry && !process.versions.electron){
  const { _electron } = require('playwright')
  const launch=_electron.launch.bind(_electron)
  _electron.launch=async options=>{
    const args=[...(options.args||[])],root=path.resolve(options.cwd||process.cwd(),args[0]||'.')
    // Some existing suites already install the display router with its own
    // observable window probe. Let that verified entry retain control.
    if(root===path.join(__dirname,'test-display-entry.cjs')){
      const env={...process.env,...options.env};delete env.NODE_OPTIONS
      return launch({...options,env})
    }
    if(!fs.existsSync(path.join(root,'package.json'))) throw Error('Test launcher requires an explicit app package: '+root)
    const env={...process.env,...options.env,COPROJER_TEST_APP_ROOT:root}
    delete env.NODE_OPTIONS
    args[0]=path.join(__dirname,'electron-test-bootstrap.cjs')
    return launch({...options,args,env})
  }
}
