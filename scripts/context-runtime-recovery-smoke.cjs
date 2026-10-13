require('./test-display.cjs').install()
const {_electron:electron}=require('playwright'),fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {provider}=require('./fixtures/context-runtime-provider.cjs')
async function main(){
 const until=async(fn)=>{const end=Date.now()+25000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw new Error('actual process fixture did not become ready')}
 const output=path.resolve('output/playwright/context-runtime/m4');await fs.mkdir(output,{recursive:true})
 const sandbox=await fs.mkdtemp(path.join(output,'isolated-')),profile=path.join(sandbox,'profile'),root=path.join(sandbox,'project');await fs.mkdir(profile);await fs.mkdir(path.join(root,'tests'),{recursive:true})
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'recovery-ui',private:true}))
 await fs.writeFile(path.join(root,'tests/check.cjs'),"const fs=require('node:fs');fs.mkdirSync('.runtime',{recursive:true});const p='.runtime/count',n=fs.existsSync(p)?+fs.readFileSync(p)+1:1;fs.writeFileSync(p,String(n));fs.writeFileSync('partial.txt','effect '+n);console.log('ACTUAL_PARTIAL_OUTPUT_'+n+'X'.repeat(2048));setInterval(()=>{},1000)")
 const feature={id:'f',title:'恢复与累计额度',description:'隔离 Electron',runtimePolicy:'receipts-effects-v1',module:'核心',scope:'current',stage:'ready',criteria:['实际效果可核对'],plan:'隔离实际进程',tasks:[{id:'t',title:'执行',done:false}],dependencies:[],developerId:'developer',reviewerId:'reviewer',revision:1,repairRound:0,results:[],feedback:''}
 const project={id:'p',name:'可靠恢复 UI 验证',root,brief:'隔离测试',createdAt:new Date().toISOString(),features:[feature],context:[],chat:[],events:[],changes:[],prototypes:[],agentRuns:[],activity:null,previewUrl:null}
 const server=await provider((_req,n)=>({text:'',calls:[{id:'cmd-'+n,name:'run_command',arguments:JSON.stringify({program:'node',args:['tests/check.cjs'],timeoutSeconds:30,evidenceKind:'unit'})},{id:'queue-'+n,name:'write_file',arguments:JSON.stringify({path:'queued.txt',content:'must not execute'})}]}))
 await fs.writeFile(path.join(profile,'engineering-v1.json'),JSON.stringify({version:1,projects:[project],agents:[],models:[{id:'fixture',name:'fixture',model:'fixture',protocol:'chat',baseUrl:server.url,cipher:''}]}))
 const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
 let app;const errors=[]
 try{
  app=await electron.launch({args:['.','--disable-gpu'],cwd:process.cwd(),env});const page=await app.firstWindow();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'})
  await page.getByRole('button',{name:'继续开发 '+project.name,exact:true}).click();await page.locator('.sidebar-lifecycle').getByRole('button',{name:'开发执行',exact:true}).click()
  const open=async()=>{await page.locator('.delivery-table').getByRole('button',{name:feature.title,exact:true}).click();await page.getByRole('dialog',{name:feature.title,exact:true}).getByRole('tab',{name:'日志',exact:true}).click()}
  await open();const drawer=page.getByRole('dialog',{name:feature.title,exact:true});await drawer.getByText('任务累计额度 · 待明确授予',{exact:true}).click()
  await drawer.getByRole('button',{name:'授予后续有限额度',exact:true}).click();await drawer.getByLabel('模型请求总额度').fill('4');await drawer.getByLabel('工具调用总额度').fill('4');await drawer.getByLabel('活动分钟总额度').fill('3');await drawer.getByLabel('调整原因').fill('隔离 UI 明确授予有限时间，历史仍未知');await drawer.getByRole('button',{name:'保存额度',exact:true}).click()
  await drawer.getByText('任务累计额度 · 已启用',{exact:true}).waitFor();await drawer.getByRole('button',{name:'开始开发',exact:true}).click()
  await until(()=>sync.existsSync(path.join(root,'.runtime/count'))&&sync.readFileSync(path.join(root,'.runtime/count'),'utf8')==='1')
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'停止执行',exact:true}).click();await page.waitForFunction(async()=>!(await window.desktop.engineering.state()).projects[0].activity)
  assert.equal(sync.existsSync(path.join(root,'queued.txt')),false);await open();await drawer.getByRole('button',{name:'继续执行',exact:true}).click()
  await until(()=>sync.existsSync(path.join(root,'.runtime/count'))&&sync.readFileSync(path.join(root,'.runtime/count'),'utf8')==='2')
  const disk=JSON.parse(await fs.readFile(path.join(profile,'engineering-v1.json'))),record=Object.values(disk.receiptJournals[JSON.stringify(['p','f'])].receipts).filter(r=>r.tool==='run_command').at(-1)
  const directory=path.join(profile,'engineering-commands',require('node:crypto').createHash('sha256').update(JSON.stringify(['p','f'])).digest('hex'),record.command.runId),launch=JSON.parse(await fs.readFile(path.join(directory,'launch.json')))
  // Kill only the native guard belonging to this fixture's actual second invocation.
  process.kill(launch.childPid);await page.waitForFunction(async()=>!(await window.desktop.engineering.state()).projects[0].activity)
  await drawer.getByText(/^上下文与运行详情/).click();await drawer.getByText(/^调用记录（/).click();const partial=drawer.getByRole('button',{name:'查看部分命令输出',exact:true});await partial.waitFor();await partial.focus();assert.ok(await partial.evaluate(el=>el===document.activeElement));await page.keyboard.press('Enter')
  await drawer.getByLabel('归档分页').getByText('仅部分内容，归档不完整',{exact:true}).waitFor();assert.match(await drawer.getByLabel('归档分页').innerText(),/ACTUAL_PARTIAL_OUTPUT_2/)
  for(const size of [[1280,840],[860,600]]){await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),size);await page.waitForFunction(size=>innerWidth===size[0]&&innerHeight===size[1],size);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await partial.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'recovery-'+size.join('x')+'.png'),animations:'disabled'})
   const budget=drawer.getByText('任务累计额度 · 已启用',{exact:true});await budget.click();await budget.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'budget-'+size.join('x')+'.png'),animations:'disabled'});await budget.click()
  }
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'切换主题',exact:true}).click();await open();await drawer.getByText(/^上下文与运行详情/).click();await drawer.getByText(/^调用记录（/).click();await drawer.getByRole('button',{name:'查看部分命令输出',exact:true}).click();await page.screenshot({path:path.join(output,'recovery-dark-860x600.png'),animations:'disabled'})
  const state=await page.evaluate(()=>window.desktop.engineering.state()),current=state.projects[0],display=await app.evaluate(()=>global.__coprojerTestDisplay)
  assert.equal(server.requests.length,2);assert.equal(sync.readFileSync(path.join(root,'.runtime/count'),'utf8'),'2');assert.equal(sync.existsSync(path.join(root,'queued.txt')),false);assert.equal(current.features[0].stage,'blocked');assert.equal(current.features[0].runtimeBudget.historical.kind,'unknown');assert.equal(current.features[0].runtimeBudget.used.tools,2)
  assert.ok(display.windows.every(w=>!w.initiallyVisible&&w.displayId===display.selection.targetId));assert.ok(display.events.every(e=>e.displayId===display.selection.targetId));assert.deepEqual(errors,[])
  await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify({at:new Date().toISOString(),level:'real isolated Electron + HTTP/SSE + actual Node and native guard termination',display,requests:server.requests.length,feature:current.features[0],errors},null,2));console.log('PASS: actual UI grants unknown history budget, cancels and continues without old queue, reads uncertain partial archive, themes, keyboard, two sizes')
 }catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'failure.txt'),await page.locator('body').innerText()).catch(()=>{});await fs.writeFile(path.join(output,'failure-state.json'),JSON.stringify(await page.evaluate(()=>window.desktop.engineering.state()),null,2));await fs.copyFile(path.join(profile,'engineering-v1.json'),path.join(output,'failure-disk.json'));await fs.writeFile(path.join(output,'failure-files.json'),JSON.stringify(await fs.readdir(profile,{recursive:true}),null,2))}throw error}
 finally{if(app)await app.close();await server.close();await fs.rm(sandbox,{recursive:true,force:true,maxRetries:3})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
