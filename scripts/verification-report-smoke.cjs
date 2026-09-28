require('./fixtures/test-display-launch.cjs')
const { _electron:electron }=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
async function main(){
 const output=path.resolve('output/playwright/verification-report');await fs.mkdir(output,{recursive:true})
 const profile=await fs.mkdtemp(path.join(output,'profile-')),root=await fs.mkdtemp(path.join(output,'project-'))
 const prefix='tray-runtime.cjs 尾部确认了完整断言链。',body=prefix+'\n\n原始报告正文保持完整。合法重复内容：检查；检查。'
 const feature={id:'f',title:'验证报告与失败保留',description:'隔离 UI 回归',module:'验证',scope:'current',stage:'blocked',verificationPending:true,
  criteria:['原生托盘悬停'],plan:'保留证据边界',tasks:[],dependencies:[],developerId:'developer',reviewerId:'reviewer',revision:1,repairRound:3,
  results:[{criterion:'原生托盘悬停',passed:false,status:'unverified',evidence:'准备真实输入'}],feedback:'',
  verificationChecks:[{id:'failed-1',command:'node tests/failed.cjs',code:1,output:'AssertionError',sourceFingerprint:'fixture',at:new Date().toISOString(),durationMs:1}],
  verificationPreparation:{phase:'blocked',round:1,limit:2,gaps:[{id:'native',criterion:'原生托盘悬停',description:'missing',disposition:'unknown',reason:'定位尚未完成',nextStep:'继续有界检查'}],summary:'已有失败及独立证据缺口',sourceFingerprint:'fixture',contractFingerprint:'fixture',attempts:[]}}
 const project={id:'p',name:'报告界面回归',root,brief:'隔离测试',createdAt:new Date().toISOString(),features:[feature],context:[],chat:[],events:[{id:'review',featureId:'f',kind:'review',at:new Date().toISOString(),message:body}],changes:[],prototypes:[],agentRuns:[],activity:null,previewUrl:null}
 await fs.writeFile(path.join(profile,'engineering-v1.json'),JSON.stringify({version:1,projects:[project],agents:[],models:[]}))
 const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
 let app;const errors=[]
 try{
  app=await electron.launch({args:['.','--disable-gpu'],cwd:process.cwd(),env});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
  await page.getByRole('button',{name:'继续开发 报告界面回归',exact:true}).click()
  await page.locator('.sidebar-lifecycle').getByRole('button',{name:'独立验证',exact:true}).click()
  await page.locator('.delivery-table').getByRole('button',{name:feature.title,exact:true}).click()
  const drawer=page.getByRole('dialog',{name:feature.title,exact:true})
  await drawer.getByRole('tab',{name:'日志',exact:true}).click()
  const report=drawer.locator('.event-review');await report.locator('summary').click()
  const count=(await report.innerText()).split(prefix).length-1
  assert.equal(await report.locator('pre').innerText(),body,'Persisted report and legitimate repeated words are unchanged')
  if(process.argv.includes('--reproduce')){
   assert.equal(count,2,'Reproduce expanded summary/body first-line repetition in the existing build')
   await fs.writeFile(path.join(output,'before.json'),JSON.stringify({count,persistedCount:1,body,errors},null,2))
   console.log('REPRODUCED: one persisted report renders its introductory text twice in expanded event')
   return
  }
  assert.equal(count,1,'Expanded report introduction must be shown only once')
  const captures=[]
  for(const size of [[1280,840],[860,600]]){
   await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),size)
   await page.waitForFunction(size=>innerWidth===size[0]&&innerHeight===size[1],size)
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
   if(await report.getAttribute('open')===null)await report.locator('summary').click()
   await page.screenshot({path:path.join(output,'report-'+size.join('x')+'.png')})
   await drawer.getByRole('tab',{name:'验收',exact:true}).click()
   await drawer.getByText('实际检查未通过：',{exact:false}).waitFor()
   assert.equal(await drawer.getByRole('button',{name:'验收通过',exact:true}).count(),0)
   await page.screenshot({path:path.join(output,'failure-'+size.join('x')+'.png')})
   captures.push(size);await drawer.getByRole('tab',{name:'日志',exact:true}).click()
  }
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize())
  if(await report.getAttribute('open')===null)await report.locator('summary').click()
  await page.screenshot({path:path.join(output,'report-maximized.png')})
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({count,persistedCount:1,body,captures,errors},null,2))
  console.log('PASS: actual Electron report avoids visual duplication, preserves raw text, and shows pending failures at both layouts')
 }finally{if(app)await app.close();await fs.rm(profile,{recursive:true,force:true,maxRetries:3});await fs.rm(root,{recursive:true,force:true,maxRetries:3})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
