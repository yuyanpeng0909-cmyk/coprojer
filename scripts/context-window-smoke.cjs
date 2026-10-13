require('./test-display.cjs').install()
const { _electron: electron } = require('playwright'), fs = require('node:fs/promises'), path=require('node:path'), assert=require('node:assert/strict')
async function main(){
 const output=path.resolve('output/playwright/context-window');await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(output,'profile-'))
 const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
 let app,page;const errors=[]
 try{
 app=await electron.launch({args:['.','--disable-gpu'],cwd:process.cwd(),env});page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
 await page.getByRole('heading',{name:'项目管理',exact:true}).waitFor()
 await page.evaluate(()=>window.desktop.engineering.saveModel({id:'window-fixture',name:'window-fixture',model:'window-fixture',protocol:'chat',baseUrl:'http://127.0.0.1:1/v1',apiKey:''}))
 await page.getByRole('button',{name:'模型连接',exact:true}).click()
 await page.locator('.eng-model-card').filter({hasText:'window-fixture'}).getByRole('button',{name:'编辑',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'编辑模型',exact:true});await dialog.getByText('上下文容量与整理策略',{exact:true}).click()
 await dialog.getByLabel('模型窗口（token）',{exact:true}).fill('256000');await dialog.getByLabel('单次最大输出（token）',{exact:true}).fill('16000')
 await dialog.getByLabel('窗口计量',{exact:true}).selectOption('input-plus-output');await dialog.getByLabel('推理计量',{exact:true}).selectOption('included-in-output')
 await dialog.getByLabel('整理模式',{exact:true}).selectOption('adaptive');await dialog.getByLabel('期望后续工作回合',{exact:true}).fill('6')
 const screenshots=[]
 for(const [width,height]of[[1280,840],[860,600]])for(const theme of['light','dark']){
 await app.evaluate(({BrowserWindow},size)=>{const w=BrowserWindow.getAllWindows()[0];w.unmaximize();w.setMinimumSize(1,1);w.setContentSize(...size)},[width,height]);await page.waitForFunction(size=>innerWidth===size[0]&&innerHeight===size[1],[width,height])
 await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await dialog.getByLabel('整理模式',{exact:true}).scrollIntoViewIfNeeded()
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 const file=path.join(output,`settings-${width}-${theme}.png`);await page.screenshot({path:file,animations:'disabled'});screenshots.push(file)
 }
 await dialog.getByLabel('整理模式',{exact:true}).focus();assert.ok(await dialog.getByLabel('整理模式',{exact:true}).evaluate(e=>document.activeElement===e))
 await dialog.getByRole('button',{name:'保存模型',exact:true}).click();await dialog.waitFor({state:'hidden'})
 let saved=await page.evaluate(()=>window.desktop.engineering.state());assert.equal(saved.models[0].capabilities.contextPolicy.mode,'adaptive');assert.equal(saved.models[0].capabilities.contextWindowTokens,256000)
 const display=await app.evaluate(()=>global.__coprojerTestDisplay);assert.ok(display.windows.every(w=>!w.initiallyVisible&&w.displayId===display.selection.targetId))
 await app.close();app=await electron.launch({args:['.','--disable-gpu'],cwd:process.cwd(),env});page=await app.firstWindow();await page.waitForFunction(()=>!!window.desktop?.engineering)
 saved=await page.evaluate(()=>window.desktop.engineering.state());assert.equal(saved.models[0].capabilities.contextPolicy.mode,'adaptive')
 await page.evaluate(async()=>{const s=await window.desktop.engineering.state(),m=s.models[0];await window.desktop.engineering.saveModel({...m,apiKey:'',capabilities:{...m.capabilities,contextPolicy:{...m.capabilities.contextPolicy,mode:'legacy'}}})})
 saved=await page.evaluate(()=>window.desktop.engineering.state());assert.equal(saved.models[0].capabilities.contextPolicy.mode,'legacy');assert.deepEqual(errors,[])
 await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify({status:'passed',level:'real isolated Electron controls + IPC + persistence',display,screenshots,checks:['edit adaptive capacity','keyboard focus','four layouts','restart','legacy fallback'],errors},null,2));console.log('PASS context settings: real Electron, four layouts, keyboard, save, restart and legacy fallback')
 }catch(e){if(page){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-5000))}throw e}finally{if(app)await app.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
