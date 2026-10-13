require('./test-display.cjs').install()
const { _electron: electron } = require('playwright')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict')
async function main() {
  const output = path.resolve('output/playwright/prototype-interaction',process.argv[2]?'actual':'minimal'); fs.mkdirSync(output, {recursive:true})
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'coprojer-prototype-click-')), root=path.join(profile,'project');fs.mkdirSync(root)
  const input = process.argv[2]
  const html = input ? fs.readFileSync(input,'utf8') : '<!doctype html><html><body><form id="addForm"><input id="taskInput"><button id="addBtn">添加</button></form><ul id="list"></ul><script>document.getElementById("addForm").addEventListener("submit",event=>{event.preventDefault();const li=document.createElement("li");li.textContent=document.getElementById("taskInput").value;document.getElementById("list").append(li)})</script></body></html>'
  const project={id:'prototype-click',name:'原型交互回归',root,brief:'隔离原型预览',createdAt:new Date().toISOString(),features:[],context:[],chat:[],events:[],changes:[],prototypes:[{id:'revision',title:'原型 2',html,at:new Date().toISOString()}],agentRuns:[],activity:null,previewUrl:null}
  fs.writeFileSync(path.join(profile,'engineering-v1.json'),JSON.stringify({version:1,models:[],agents:[],projects:[project]}))
  const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
  let desktop;const errors=[]
  try{
    desktop=await electron.launch({args:['.'],env});const page=await desktop.firstWindow();page.setDefaultTimeout(10000)
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
    await page.getByRole('button',{name:'继续开发 原型交互回归',exact:true}).click()
    await page.getByRole('button',{name:'需求与功能图',exact:true}).click()
    await page.getByRole('tab',{name:'原型',exact:true}).first().click()
    const frame=page.frameLocator('iframe[title="原型实时预览"]')
    await frame.locator('#taskInput').fill('交互验收任务');await frame.locator('#addBtn').click()
    await frame.locator('#list li').first().waitFor({timeout:3000})
    assert.ok((await frame.locator('#list').innerText()).includes('交互验收任务'))
    if(input){
      await frame.getByRole('button',{name:'标记为完成：交互验收任务',exact:true}).click()
      assert.equal(await frame.locator('#doneCount').innerText(),'1')
      await frame.getByRole('button',{name:'删除任务：交互验收任务',exact:true}).click()
      await frame.locator('#list li').waitFor({state:'detached'})
      for(const name of ['第一件','第二件','第三件']){await frame.locator('#taskInput').fill(name);await frame.locator('#addBtn').click()}
      assert.equal(await frame.locator('#list li').count(),3);assert.ok(await frame.locator('#addBtn').isDisabled())
    }
    const iframe=page.locator('iframe[title="原型实时预览"]')
    assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts allow-forms')
    const child=await (await iframe.elementHandle()).contentFrame()
    assert.equal(await child.evaluate(()=>typeof window.desktop),'undefined')
    assert.ok(await child.evaluate(()=>document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("form-action 'none'")))
    const attempted=[];page.on('request',r=>{if(r.url().includes('prototype-submit.invalid'))attempted.push(r.url())})
    for(const [width,height] of [[1280,840],[860,600]]){
      await desktop.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setContentSize(width,height),{width,height})
      if(input){
        await frame.getByRole('button',{name:'删除任务：第三件',exact:true}).click()
        await frame.locator('#taskInput').fill('第三件');await frame.locator('#addBtn').click()
        assert.equal(await frame.locator('#list li').count(),3)
      }
      await page.screenshot({path:path.join(output,`preview-${width}x${height}.png`)})
    }
    await child.evaluate(()=>{const f=document.createElement('form');f.action='https://prototype-submit.invalid/';f.method='post';document.body.append(f);f.submit()})
    await page.waitForTimeout(150)
    assert.deepEqual(attempted,[]);assert.ok(!child.url().startsWith('https://prototype-submit.invalid/'))
    assert.ok(errors.some(e=>e.includes("form-action 'none'")))
    fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({input:input||'minimal regression',formInteraction:true,externalSubmissionBlocked:true,hostBridgeAbsent:true,layouts:[[1280,840],[860,600]],display:await desktop.evaluate(()=>global.__coprojerTestDisplay)},null,2))
    console.log('PASS: actual Electron prototype form interaction; external form submission remains blocked; host bridge unavailable; both layouts')
  }finally{
    fs.writeFileSync(path.join(output,'errors.json'),JSON.stringify(errors,null,2));console.log('PREVIEW_ERRORS',JSON.stringify(errors));if(desktop)await desktop.close()
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
