// Supplemental verification only. Uses the unchanged application and real input.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {spawn}=require('node:child_process'),{createInterface}=require('node:readline'),{_electron:electron}=require('playwright')
const root=process.cwd(),output=process.env.COPROJER_EVIDENCE_DIR,profile=process.env.COPROJER_TEST_USER_DATA
assert.ok(output && profile,'Explicit isolated runner directories are required')
fs.mkdirSync(output,{recursive:true});fs.mkdirSync(profile,{recursive:true})
const delay=ms=>new Promise(r=>setTimeout(r,ms)), sha=x=>crypto.createHash('sha256').update(x).digest('hex')
function fingerprint(){const files={};for(const dir of ['src','dist']){function walk(p){for(const e of fs.readdirSync(path.join(root,p),{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else files[f]=sha(fs.readFileSync(path.join(root,f)))}}walk(dir)}return files}
let seq=0,driver,pending,driverErrors=''
async function desktop(request){
  const stem=String(++seq).padStart(2,'0')+'-'+request.action,file=path.join(output,stem+'-request.json')
  fs.writeFileSync(file,JSON.stringify(request))
  if(!driver){
    driver=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'windows-desktop.ps1'),'-Server'],{windowsHide:true,stdio:['pipe','pipe','pipe']})
    createInterface({input:driver.stdout}).on('line',line=>pending?.resolve(line))
    driver.stderr.on('data',data=>{driverErrors+=data.toString('utf8')})
    driver.on('error',error=>pending?.reject(error))
    driver.on('exit',code=>pending?.reject(Error('Owned desktop driver exited '+code+': '+driverErrors)))
  }
  let timer,line
  try{
    line=await new Promise((resolve,reject)=>{
      pending={resolve,reject};timer=setTimeout(()=>reject(Error('Bounded desktop request expired')),20000)
      driver.stdin.write(JSON.stringify(request)+'\n')
    })
  }catch(error){throw Error('DESKTOP_TECHNICAL_BLOCK: '+error.message)}
  finally{clearTimeout(timer);pending=undefined;fs.writeFileSync(path.join(output,stem+'-stderr.txt'),driverErrors)}
  fs.writeFileSync(path.join(output,stem+'-stdout.txt'),line)
  const parsed=JSON.parse(line);fs.writeFileSync(path.join(output,stem+'-result.json'),JSON.stringify(parsed,null,2))
  if(parsed.driverError)throw Error('DESKTOP_TECHNICAL_BLOCK: '+parsed.driverError)
  return parsed
}
function processPresence(pid){try{process.kill(pid,0);return {pid,status:'present'}}catch(e){return {pid,status:e.code==='ESRCH'?'absent':'unknown',error:e.code}}}
async function main(){
  const evidence={schema:1,startedAt:new Date().toISOString(),sourceAndBuild:fingerprint(),status:'running',inputEvidence:[],rendererErrors:[]}
  let app
  try{
    const capability=await desktop({action:'probe'});evidence.capability=capability
    assert.equal(capability.inputDesktop,'Default');assert.equal(capability.interactive,true)
    // Windows hosts the notification area on the primary taskbar. It cannot be
    // moved for this test, so use the documented primary-monitor fallback.
    const shell=capability.shellWindows.find(w=>w.className==='Shell_TrayWnd')
    const display=capability.screens.find(s=>s.primary)
    assert.ok(shell && display)
    evidence.display={...display,reason:'Native notification area is on Shell_TrayWnd on the primary display; use primary fallback before first show.'}
    fs.writeFileSync(path.join(profile,'state.json'),JSON.stringify({phase:'focus',remainingMs:300000,running:false,endAt:null,completedFocus:0,cycleId:0}))
    fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({soundEnabled:false,notificationEnabled:false,minimizeToTray:true}))
    const env={...process.env,COPROJER_TEST_APP_ROOT:root,COPROJER_TEST_DISPLAY:JSON.stringify(display),COPROJER_CAPTURE_TRAY:'1'}
    delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.ELECTRON_RENDERER_URL
    app=await electron.launch({executablePath:require('electron'),args:[path.join(__dirname,'electron-test-bootstrap.cjs'),'--user-data-dir='+profile,'--disable-gpu'],cwd:root,env})
    const page=await app.firstWindow();page.on('pageerror',e=>evidence.rendererErrors.push(e.message));page.setDefaultTimeout(12000)
    await page.getByRole('button',{name:/▶ (开始|继续)/}).waitFor()
    evidence.runtime=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.maximize();return {pid:process.pid,userData:app.getPath('userData'),electron:process.versions.electron,windowBounds:w.getBounds()}})
    assert.equal(path.resolve(evidence.runtime.userData),path.resolve(profile))
    await page.screenshot({path:path.join(output,'application-maximized.png')})
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus()})
    await delay(1200)
    async function trayAction(click,label){
      const initialTray=await app.evaluate(()=>({rect:global.__coprojerNativeTray.getBounds(),expectedName:global.__coprojerNativeTip}))
      const container=await desktop({action:'open-tray-overflow',...initialTray,captureRect:display.bounds,screenshot:path.join(output,label+'-container.png')})
      evidence.inputEvidence.push({label:label+'-container',...container})
      const native=await app.evaluate(()=>({rect:global.__coprojerNativeTray.getBounds(),expectedName:global.__coprojerNativeTip}))
      native.expectedPrefix=native.expectedName.replace(/\d{2}:\d{2}$/,'')
      const result=await desktop({action:'tray',...native,targetPid:evidence.runtime.pid,click,captureRect:display.bounds,screenshot:path.join(output,label+'.png')})
      evidence.inputEvidence.push({label,native,...result})
      return result
    }
    const hover=await trayAction(undefined,'native-hover-paused')
    assert.ok(hover.tooltipWindows.some(t=>t.name===hover.events[0].legacy.name&&!t.offscreen),'Actual OS tooltip must match owned tray state')
    const firstMenu=await trayAction('right','native-menu-paused')
    const labels=firstMenu.menus.flatMap(m=>m.items.map(i=>i.name))
    assert.ok(labels.includes('显示主界面')&&labels.includes('开始计时')&&labels.includes('退出'),'Native menu exposes required entries')
    async function click(label){const result=await desktop({action:'menu-click',targetPid:evidence.runtime.pid,label});evidence.inputEvidence.push({label,...result})}
    await click('开始计时');await page.waitForFunction(async()=>(await window.api.getInit()).state.running)
    evidence.runningAfterNativeClick=true
    await trayAction('right','native-menu-running');await click('暂停计时')
    await page.waitForFunction(async()=>!(await window.api.getInit()).state.running);evidence.pausedAfterNativeClick=true
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false)
    await trayAction('right','native-menu-hidden');await click('显示主界面')
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);evidence.restoredAfterNativeClick=true
    // Observe another real state/icon/tooltip through actual hovering. State
    // transition comes from the application's existing Skip button.
    const skip=page.getByRole('button',{name:/手动结束/});await skip.click();await delay(1200)
    const nextHover=await trayAction(undefined,'native-hover-break')
    assert.ok(nextHover.tooltipWindows.some(t=>/短休息/.test(t.name)&&!t.offscreen),'OS tooltip observes the new phase')
    evidence.observedPhases=['focus','shortBreak']
    evidence.processIds=await app.evaluate(({app})=>[...new Set([process.pid,...app.getAppMetrics().map(m=>m.pid)])])
    await trayAction('right','native-menu-exit')
    const closed=app.waitForEvent('close',{timeout:15000});await click('退出');await closed;app=undefined
    await delay(1000);evidence.processProbes=evidence.processIds.map(processPresence)
    assert.ok(evidence.processProbes.every(p=>p.status==='absent'),'Collected application PIDs must be absent; EPERM is unknown')
    assert.deepEqual(evidence.rendererErrors,[]);assert.deepEqual(fingerprint(),evidence.sourceAndBuild)
    evidence.status='passed';evidence.finishedAt=new Date().toISOString()
    console.log('NATIVE_DESKTOP_INPUT_PASSED '+JSON.stringify({actions:evidence.inputEvidence.flatMap(r=>r.events).map(e=>e.action),report:path.join(output,'desktop-result.json')}))
  }catch(e){evidence.status=String(e).includes('DESKTOP_TECHNICAL_BLOCK:')?'blocked':'failed';evidence.error=String(e.stack||e);evidence.finishedAt=new Date().toISOString();throw e}
  finally{
    const cleanupIds=app?await app.evaluate(({app})=>[process.pid,...app.getAppMetrics().map(m=>m.pid)]).catch(()=>[evidence.runtime?.pid]):[]
    if(app)await app.close().catch(()=>{})
    if(driver){driver.stdin.end();await Promise.race([new Promise(r=>driver.once('exit',r)),delay(1500)]);if(driver.exitCode===null)driver.kill()}
    await delay(300)
    evidence.cleanupProcessProbes=[...new Set([...cleanupIds,driver?.pid].filter(Number.isInteger))].map(processPresence)
    evidence.driverPid=driver?.pid;evidence.finishedAt=new Date().toISOString()
    fs.writeFileSync(path.join(output,'desktop-result.json'),JSON.stringify(evidence,null,2))
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
