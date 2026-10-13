require('./test-display.cjs').install()
const {_electron:electron}=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
const {provider}=require('./fixtures/context-runtime-provider.cjs'),{load}=require('./fixtures/verification-runtime.cjs')
async function main(){
 const output=path.resolve('output/playwright/context-runtime/m6');await fs.mkdir(output,{recursive:true});const sandbox=await fs.mkdtemp(path.join(output,'isolated-')),profile=path.join(sandbox,'profile'),root=path.join(sandbox,'project');await fs.mkdir(profile);await fs.mkdir(root)
 const before='FACT=source-a\n',version=createHash('sha256').update(before).digest('hex');await fs.writeFile(path.join(root,'a.txt'),before);await fs.writeFile(path.join(root,'b.txt'),'FACT=source-b');await fs.writeFile(path.join(root,'package.json'),'{}')
 const feature={id:'f',title:'搜索与安全补丁',description:'隔离测试',runtimePolicy:'receipts-effects-v1',runtimeBudget:load('src/main/engineering/runtime-budget.ts').newRuntimeBudget('ui-efficiency'),module:'核心',scope:'current',stage:'ready',criteria:['保留版本和实际读取'],plan:'读取并核对',tasks:[{id:'t',title:'核对文件',done:false}],dependencies:[],developerId:'developer',reviewerId:'reviewer',revision:1,repairRound:0,results:[],feedback:''}
 const project={id:'p',name:'文件工具隔离验证',root,brief:'隔离测试',createdAt:new Date().toISOString(),features:[feature],context:[],chat:[],events:[],changes:[],prototypes:[],agentRuns:[],activity:null,previewUrl:null}
 const call=(id,name,args)=>({id,name,arguments:JSON.stringify(args)})
 const server=await provider((_req,n)=>n===1?{text:'',calls:[call('search','search_files',{scope:'a.txt',query:'FACT'}),call('b','read_file',{path:'b.txt'})]}:n===2?{text:'',calls:[call('lines','read_file_lines',{path:'a.txt',startLine:1,endLine:1,version}),call('patch','patch_file',{path:'a.txt',expectedVersion:version,startLine:1,endLine:1,oldText:'source-a',newText:'source-A'})]}:{text:JSON.stringify({status:'incomplete',summary:'已保留文件来源和实际补丁',nextStep:'独立核对'}),calls:[]})
 await fs.writeFile(path.join(profile,'engineering-v1.json'),JSON.stringify({version:1,projects:[project],agents:load('src/shared/agents.ts').defaultAgents('fixture'),models:[{id:'fixture',name:'fixture',model:'fixture',protocol:'chat',baseUrl:server.url,cipher:''}]}))
 const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;let app;const errors=[]
 try{
  app=await electron.launch({args:['.','--disable-gpu'],cwd:process.cwd(),env});const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'})
  await page.getByRole('button',{name:'智能体',exact:true}).click()
  const openAgent=async(name)=>{await page.locator('.eng-agent-card').filter({hasText:name}).getByRole('button',{name:'配置',exact:true}).click();return page.getByRole('dialog',{name:'配置智能体',exact:true})}
  let dialog=await openAgent('全栈开发');assert.equal(await dialog.getByLabel('独立读取并发').inputValue(),'1');assert.equal(await dialog.getByRole('checkbox',{name:'搜索文件',exact:true}).isChecked(),false)
  for(const name of ['搜索文件','按行读取','局部补丁'])await dialog.getByRole('checkbox',{name,exact:true}).check()
  await dialog.getByLabel('独立读取并发').selectOption('2');await dialog.getByRole('button',{name:'保存智能体',exact:true}).click();await dialog.waitFor({state:'hidden'})
  dialog=await openAgent('全栈开发');assert.equal(await dialog.getByLabel('独立读取并发').inputValue(),'2');await dialog.getByRole('checkbox',{name:'搜索文件',exact:true}).uncheck();await dialog.getByRole('button',{name:'保存智能体',exact:true}).click();await dialog.waitFor({state:'hidden'})
  dialog=await openAgent('全栈开发');assert.equal(await dialog.getByRole('checkbox',{name:'搜索文件',exact:true}).isChecked(),false);assert.equal(await dialog.getByRole('checkbox',{name:'局部补丁',exact:true}).isChecked(),true);await dialog.getByRole('checkbox',{name:'搜索文件',exact:true}).check()
  const select=dialog.getByLabel('独立读取并发');await select.focus();assert.ok(await select.evaluate(e=>e===document.activeElement))
  for(const [width,height] of [[1280,840],[860,600]]){
   await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);await page.waitForFunction(size=>innerWidth===size[0]&&innerHeight===size[1],[width,height]);await select.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.screenshot({path:path.join(output,`tools-${width}x${height}.png`),animations:'disabled'})
  }
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:path.join(output,'tools-dark-860x600.png'),animations:'disabled'});await page.evaluate(()=>document.documentElement.dataset.theme='light');await dialog.getByRole('button',{name:'保存智能体',exact:true}).click();await dialog.waitFor({state:'hidden'})
  dialog=await openAgent('独立测试');assert.equal(await dialog.getByRole('checkbox',{name:'局部补丁',exact:true}).isEnabled(),false);await dialog.getByRole('button',{name:'取消',exact:true}).click()
  await page.getByRole('button',{name:'项目管理',exact:true}).click();await page.getByRole('button',{name:'继续开发 '+project.name,exact:true}).click();await page.locator('.sidebar-lifecycle').getByRole('button',{name:'开发执行',exact:true}).click()
  const open=async()=>{await page.locator('.delivery-table').getByRole('button',{name:feature.title,exact:true}).click();await page.getByRole('dialog',{name:feature.title,exact:true}).getByRole('tab',{name:'日志',exact:true}).click()}
  await open();let drawer=page.getByRole('dialog',{name:feature.title,exact:true});await drawer.getByRole('button',{name:'开始开发',exact:true}).click()
  // waitForFunction's predicate is synchronous; a Promise is truthy before IPC settles.
  const deadline=Date.now()+30000;let settled=false
  while(Date.now()<deadline){const p=await page.evaluate(async()=> (await window.desktop.engineering.state()).projects[0]);if(!p.activity&&p.features[0].stage==='blocked'&&p.features[0].runtimeBudget.used.requests===3){settled=true;break}await new Promise(resolve=>setTimeout(resolve,50))}
  assert.ok(settled,'the actual IPC state reaches the final third request')
  const disk=JSON.parse(await fs.readFile(path.join(profile,'engineering-v1.json'),'utf8')),records=Object.values(disk.receiptJournals[JSON.stringify(['p','f'])].receipts)
  await fs.writeFile(path.join(output,'flow-observation.json'),JSON.stringify({profile,root,providerUrl:server.url,actualProfile:await app.evaluate(({app})=>app.getPath('userData')),requests:server.requests,transport:server.transport,disk},null,2))
  assert.equal(server.requests.length,3,'three HTTP requests reached this provider');assert.equal(await fs.readFile(path.join(root,'a.txt'),'utf8'),'FACT=source-A\n');assert.equal(records.length,4);assert.ok(records.every(r=>r.attempts===1&&r.status==='completed'));assert.equal(disk.projects[0].changes.length,1)
  await page.reload();await page.getByRole('button',{name:'继续开发 '+project.name,exact:true}).click();await page.locator('.sidebar-lifecycle').getByRole('button',{name:'开发执行',exact:true}).click();await open();assert.equal(server.requests.length,3)
  const display=await app.evaluate(()=>global.__coprojerTestDisplay);assert.ok(display.windows.every(w=>!w.initiallyVisible&&w.displayId===display.selection.targetId));assert.ok(display.events.every(e=>e.displayId===display.selection.targetId));assert.deepEqual(errors,[])
  await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify({at:new Date().toISOString(),level:'real isolated Electron + controlled HTTP',display,records,requests:server.requests,errors,stage:'blocked'},null,2));console.log('PASS: optional tool controls persist independently, readonly patch denied, default one/configured two, actual search/line/patch, reload no repeat, two sizes/theme/focus')
 }catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'failure.txt'),await page.locator('body').innerText()).catch(()=>{})}throw error}finally{if(app)await app.close();await server.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
