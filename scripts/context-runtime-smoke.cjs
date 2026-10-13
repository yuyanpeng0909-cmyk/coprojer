require('./test-display.cjs').install()
const { _electron: electron } = require('playwright')
const fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { provider } = require('./fixtures/context-runtime-provider.cjs')
async function main() {
  const output = path.resolve(process.env.COPROJER_CONTEXT_SMOKE_OUTPUT || 'output/playwright/context-runtime/m1'); await fs.mkdir(output, {recursive:true})
  const sandbox = await fs.mkdtemp(path.join(output,'isolated-')), profile=path.join(sandbox,'profile'), root=path.join(sandbox,'project')
  await fs.mkdir(profile);await fs.mkdir(path.join(root,'tests'),{recursive:true})
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'context-runtime-ui-fixture',private:true}))
  await fs.writeFile(path.join(root,'tests/verify.cjs'),'const fs=require("node:fs");fs.mkdirSync(".runtime",{recursive:true});const p=".runtime/count";let n=fs.existsSync(p)?+fs.readFileSync(p):0;fs.writeFileSync(p,String(++n));console.log("ACTUAL_ATTEMPT_"+n);process.exit(n===1?1:0)')
  const feature={id:'f',title:'当前事实与工具合同',description:'隔离 Electron 验收',module:'核心',scope:'current',stage:'blocked',verificationPending:true,criteria:['实际检查成功'],plan:'检查实际命令及历史依据',tasks:[{id:'t',title:'检查',done:false}],dependencies:[],developerId:'developer',reviewerId:'reviewer',revision:1,repairRound:0,results:[],feedback:''}
  const project={id:'p',name:'上下文运行管理回归',root,brief:'隔离测试',createdAt:new Date().toISOString(),features:[feature],context:[],chat:[],events:[],changes:[],prototypes:[],agentRuns:[],activity:null,previewUrl:null}
  const server=await provider((_request,n)=> n<=2?{text:'',calls:[{id:'wire-'+n,name:'run_command',arguments:JSON.stringify({program:'node',args:['tests/verify.cjs'],evidenceKind:'unit'})}]}:
    {text:JSON.stringify({results:[{criterion:feature.criteria[0],passed:true,status:'passed',evidence:'说明不替代命令记录',evidenceKind:'unit',commandIds:['check-2']}]}),calls:[]})
  await fs.writeFile(path.join(profile,'engineering-v1.json'),JSON.stringify({version:1,projects:[project],agents:[],models:[{id:'fixture',name:'fixture',model:'fixture',protocol:'chat',baseUrl:server.url,cipher:''}]}))
  const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
  let app;const errors=[]
  try {
    app=await electron.launch({args:['.','--disable-gpu'],cwd:process.cwd(),env})
    const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'})
    await page.getByRole('button',{name:'继续开发 '+project.name,exact:true}).click()
    await page.locator('.sidebar-lifecycle').getByRole('button',{name:'独立验证',exact:true}).click()
    await page.locator('.delivery-table').getByRole('button',{name:feature.title,exact:true}).click()
    const drawer=page.getByRole('dialog',{name:feature.title,exact:true})
    await drawer.getByRole('button',{name:'继续验证',exact:true}).click()
    await page.waitForFunction(async()=>{const state=await window.desktop.engineering.state();return state.projects[0].features[0].stage==='acceptance'})
    await drawer.getByRole('tab',{name:'验收',exact:true}).click()
    const evidence=drawer.locator('.eng-results').getByText('当前检查与历史依据（2）',{exact:true})
    await evidence.click();await drawer.getByText('已被替代 · node tests/verify.cjs',{exact:true}).waitFor()
    await drawer.getByText('当前适用 · node tests/verify.cjs',{exact:true}).waitFor()
    await evidence.focus();assert.ok(await evidence.evaluate(el=>el===document.activeElement));await page.keyboard.press('Enter');await page.keyboard.press('Enter')
    await drawer.getByRole('tab',{name:'日志',exact:true}).click()
    await drawer.locator('.eng-context-details > summary').filter({hasText:'上下文与运行详情'}).click()
    const mode = drawer.getByLabel('后续上下文模式',{exact:true})
    await mode.selectOption('shadow');await page.waitForFunction(async()=>(await window.desktop.engineering.state()).projects[0].features[0].contextPolicy?.mode==='shadow')
    await drawer.getByRole('tab',{name:'验收',exact:true}).click();await drawer.getByRole('tab',{name:'日志',exact:true}).click()
    await drawer.locator('.eng-context-details > summary').filter({hasText:'上下文与运行详情'}).click();assert.equal(await mode.inputValue(),'shadow')
    await mode.selectOption('');await page.waitForFunction(async()=>!(await window.desktop.engineering.state()).projects[0].features[0].contextPolicy)
    await drawer.getByRole('tab',{name:'验收',exact:true}).click()
    for(const size of [[1280,840],[860,600]]) {
      await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),size)
      await page.waitForFunction(size=>innerWidth===size[0]&&innerHeight===size[1],size)
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
      await page.screenshot({path:path.join(output,'evidence-'+size.join('x')+'.png'),animations:'disabled'})
    }
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'切换主题',exact:true}).click()
    await page.locator('.sidebar-lifecycle').getByRole('button',{name:'成果验收',exact:true}).click()
    await page.locator('.delivery-table').getByRole('button',{name:feature.title,exact:true}).click()
    await drawer.getByRole('tab',{name:'验收',exact:true}).click()
    await evidence.click();await page.screenshot({path:path.join(output,'evidence-dark-860x600.png'),animations:'disabled'})
    const state=await page.evaluate(()=>window.desktop.engineering.state()),current=state.projects[0]
    assert.equal(current.features[0].stage,'acceptance');assert.equal(current.features[0].verificationChecks.length,2)
    assert.equal(sync.readFileSync(path.join(root,'.runtime/count'),'utf8'),'2')
    const display=await app.evaluate(()=>global.__coprojerTestDisplay)
    assert.ok(display.selection);assert.ok(display.windows.every(w=>!w.initiallyVisible&&w.displayId===display.selection.targetId))
    assert.ok(display.events.every(e=>e.displayId===display.selection.targetId));assert.deepEqual(errors,[]);assert.deepEqual(server.errors,[])
    await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify({at:new Date().toISOString(),level:'real isolated Electron + HTTP/SSE + actual Node effects',display,requests:server.requests.length,actualCommands:2,stage:current.features[0].stage,feature:current.features[0],errors},null,2))
    console.log('PASS: real Electron current/history evidence, manual acceptance boundary, keyboard, reduced motion, two sizes and dark theme')
  }catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(output,'failure.txt'),await page.locator('body').innerText()).catch(()=>{})}throw error}
  finally{if(app)await app.close();await server.close();await fs.rm(sandbox,{recursive:true,force:true,maxRetries:3})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
