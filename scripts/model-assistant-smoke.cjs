const assert = require('node:assert/strict'), fs = require('node:fs/promises'), {join,resolve} = require('node:path'), http = require('node:http')
const {_electron:electron} = require('playwright')
const {arenaHtml,categories} = require('./fixtures/arena.cjs')
async function main() {
  const output=resolve('output/playwright/model-assistant');await fs.mkdir(output,{recursive:true})
  const profile=await fs.mkdtemp(join(output,'profile-')), errors=[],requests=[],captures=[]
  let desktop,page
  const server=http.createServer(async(req,res)=>{try {
    let raw='';for await(const c of req)raw+=c
    const body=JSON.parse(raw),input=JSON.parse(body.messages.at(-1).content);requests.push(body)
    assert.match(body.messages[0].content,/AGENT_MODEL_ALLOCATION/)
    const content=JSON.stringify({choices:input.agents.map(a=>({agentId:a.id,modelId:input.constraints.find(c=>c.agentId===a.id).allowedModelIds[0],reason:'Invented speed must not appear'}))})
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:body.model+'-served',choices:[{message:{role:'assistant',content}}]}))
  } catch(e) {errors.push(e.message);res.writeHead(500);res.end('fixture failed')} })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE
  const invoke=(method,...args)=>page.evaluate(({method,args})=>window.desktop.engineering[method](...args),{method,args})
  const state=()=>invoke('state')
  const fixtures=Object.fromEntries(Object.entries(categories).map(([url,c])=>[url,[0,1].map(phase=>arenaHtml(c,[
    {model:'test-general',score:c==='text'?1580:1400,input:3,output:9},
    {model:'test-code',score:['coding','fullstack'].includes(c)||phase&&c==='frontend'?1700:1450,input:2,output:7},
    {model:'test-ui',score:['frontend','webdev'].includes(c)?1600:1480,input:2,output:6},
    {model:'test-flash',score:c==='frontend'?1595:1200,input:0.1,output:0.3},
  ]))]))
  const launch=async()=>{
    desktop=await electron.launch({args:['.','--disable-gpu'],env,timeout:30000});page=await desktop.firstWindow();page.setDefaultTimeout(15000)
    page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'})
    await page.getByRole('heading',{name:'项目管理',exact:true}).waitFor()
    await desktop.evaluate((_, fixtures)=>{
      const original=globalThis.fetch;globalThis.__arenaRequests=[];globalThis.__arenaPhase=0;globalThis.__arenaOffline=false
      globalThis.fetch=async(url,init={})=>{
        if(String(url).startsWith('http://127.0.0.1:'))return original(url,init)
        if(!String(url).startsWith('https://arena.ai/'))throw Error('Unexpected outbound request')
        globalThis.__arenaRequests.push({url:String(url),headers:init.headers,cache:init.cache})
        if(globalThis.__arenaOffline)return new Response('unavailable',{status:503})
        return new Response(fixtures[new URL(url).pathname][globalThis.__arenaPhase],{headers:{'content-type':'text/html'}})
      }
    },fixtures)
  }
  const capture=async(name,width,height,theme='light',maximized=false)=>{
    if(maximized) ({width,height}=await desktop.evaluate(({BrowserWindow,screen})=>{const win=BrowserWindow.getAllWindows()[0];win.maximize();return screen.getDisplayMatching(win.getBounds()).workAreaSize}))
    else await desktop.evaluate(({BrowserWindow},{width,height})=>{const win=BrowserWindow.getAllWindows()[0];win.unmaximize();win.setSize(width,height)},{width,height})
    await page.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height})
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme},theme)
    if(name==='evidence'||name==='02-source-comparison')await page.getByRole('region',{name:'榜单证据',exact:true}).evaluate(e=>e.scrollIntoView({block:'start'}))
    if(name==='03-allocation-preview')await page.getByRole('region',{name:'模型分配预览',exact:true}).evaluate(e=>e.scrollIntoView({block:'start'}))
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    const file=name+(maximized?'-maximized':'-'+theme+'-'+width)+'.png',png=await page.screenshot({path:join(output,file),animations:'disabled',scale:'css'})
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[width,height]);captures.push({file,width,height,maximized})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    assert.ok(await page.getByRole('dialog',{name:'模型配置助手',exact:true}).evaluate(e=>e.scrollWidth<=e.clientWidth+1))
  }
  try {
    await launch()
    const baseUrl='http://127.0.0.1:'+server.address().port+'/v1'
    for(const id of ['general','code','ui','flash'])await invoke('saveModel',{id,model:'test-'+id,baseUrl,protocol:'chat',apiKey:'fixture-evidence-key'})
    await invoke('saveModel',{id:'unmatched',model:'test-ui-max-high',baseUrl,protocol:'chat',apiKey:''})
    await invoke('setDefaultAssistantModel','general')
    const dev=(await state()).agents.find(a=>a.id==='developer')
    await invoke('saveAgent',{...dev,id:'prototype-dev',name:'原型设计智能体',skillIds:[]})
    await invoke('saveAgent',{...dev,id:'unmatched-agent',name:'未匹配版本实例',modelId:'unmatched',skillIds:[]})
    await page.getByRole('button',{name:'智能体',exact:true}).click()
    await page.getByRole('button',{name:'模型配置助手',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'模型配置助手',exact:true})
    assert.equal(await dialog.getByLabel('原型设计智能体能力类别',{exact:true}).inputValue(),'frontend')
    assert.equal(await dialog.getByLabel('开发智能体能力类别',{exact:true}).inputValue(),'aa-coding')
    await dialog.getByLabel('开发智能体能力类别',{exact:true}).selectOption('fullstack')
    await capture('01-category-selection',0,0,'light',true)
    await capture('category-selection',1280,840);await capture('category-selection',860,600)
    await dialog.getByLabel('任务规划智能体能力类别',{exact:true}).selectOption('text')
    await dialog.getByLabel('验证智能体能力类别',{exact:true}).selectOption('coding')
    await dialog.getByLabel('未匹配版本实例能力类别',{exact:true}).selectOption('coding')
    const before=await state()
    await dialog.getByRole('button',{name:'一键推荐模型',exact:true}).click()
    await dialog.getByRole('heading',{name:/模型分配预览 ·/}).waitFor()
    assert.deepEqual((await state()).agents,before.agents,'preview must not mutate bindings')
    assert.equal(requests.length,1);assert.equal(requests[0].model,'test-general')
    await dialog.getByLabel('模型使用记录').filter({hasText:'test-general-served'}).waitFor()
    const article=name=>dialog.locator('.eng-model-plan article').filter({hasText:name})
    assert.match(await article('原型设计智能体').innerText(),/推荐：test-ui/)
    assert.match(await article('开发智能体').innerText(),/推荐：test-code/)
    assert.match(await article('未匹配版本实例').innerText(),/保留：test-ui-max-high/)
    assert.match(await article('未匹配版本实例').innerText(),/未上榜不代表能力差/)
    assert.ok(!(await dialog.innerText()).includes('Invented speed'))
    const initialFetches=await desktop.evaluate(()=>globalThis.__arenaRequests.length)
    assert.equal(initialFetches,4,'deduplicate categories within this request only')
    const frontend=dialog.locator('.eng-model-evidence details').filter({hasText:'前端开发 · HTML / React'}).first()
    await frontend.locator('summary').click();await frontend.scrollIntoViewIfNeeded()
    assert.equal(await frontend.getByRole('link',{name:'查看 Arena 来源'}).getAttribute('href'),'https://arena.ai/leaderboard/code/webdev/frontend')
    await frontend.getByRole('cell',{name:'$0.1 / $0.3',exact:true}).waitFor()
    await capture('evidence',1280,840);await capture('evidence',860,600);await capture('evidence',1280,840,'dark');await capture('evidence',860,600,'dark')
    await page.evaluate(()=>{document.documentElement.dataset.theme='light'})
    await frontend.scrollIntoViewIfNeeded();await capture('02-source-comparison',0,0,'light',true)
    await dialog.getByRole('heading',{name:/模型分配预览 ·/}).scrollIntoViewIfNeeded();await capture('03-allocation-preview',0,0,'light',true)
    // A second click receives changed site data; the former score is not reused.
    await desktop.evaluate(()=>{globalThis.__arenaPhase=1})
    await dialog.getByLabel('本次使用的通用助手模型',{exact:true}).selectOption('ui')
    await dialog.getByRole('button',{name:'一键推荐模型',exact:true}).click()
    await dialog.getByLabel('模型使用记录').filter({hasText:'test-ui-served'}).waitFor()
    assert.equal(await desktop.evaluate(()=>globalThis.__arenaRequests.length),initialFetches*2)
    assert.match(await article('原型设计智能体').innerText(),/推荐：test-code/)
    assert.equal((await state()).defaultAssistantModelId,'general')
    const sourceRequests=await desktop.evaluate(()=>globalThis.__arenaRequests)
    assert.ok(sourceRequests.every(r=>r.cache==='no-store'&&!r.headers.Authorization))
    assert.ok(!JSON.stringify(requests).includes('fixture-evidence-key'))
    await dialog.getByRole('button',{name:'一键应用模型配置',exact:true}).scrollIntoViewIfNeeded();await capture('04-confirm-apply',0,0,'light',true)
    await dialog.getByRole('button',{name:'一键应用模型配置',exact:true}).click()
    await dialog.getByText(/已应用 \d+ 项模型变更/).waitFor()
    const applied=await state()
    assert.equal(applied.agents.find(a=>a.id==='prototype-dev').modelId,'code')
    assert.equal(applied.agents.find(a=>a.id==='unmatched-agent').modelId,'unmatched')
    assert.deepEqual(applied.skills,before.skills)
    for(const a of before.agents){const after=applied.agents.find(b=>b.id===a.id);assert.equal(after.role,a.role);assert.deepEqual(after.skillIds,a.skillIds)}
    // No cached recommendation or advisor call on a failed refresh.
    await desktop.evaluate(()=>{globalThis.__arenaOffline=true})
    await dialog.getByRole('button',{name:'一键推荐模型',exact:true}).click()
    await dialog.getByText('没有可比较的能力证据，本次未调用建议模型。',{exact:true}).waitFor()
    assert.equal(requests.length,2)
    assert.ok(await dialog.getByRole('button',{name:'一键应用模型配置',exact:true}).isDisabled())
    assert.deepEqual((await state()).agents,applied.agents)
    await dialog.getByRole('heading',{name:'本次榜单证据',exact:true}).scrollIntoViewIfNeeded();await capture('offline',860,600)
    await dialog.press('Escape');await dialog.waitFor({state:'hidden'})
    await desktop.close();desktop=undefined;await launch()
    assert.deepEqual((await state()).agents,applied.agents);assert.deepEqual((await state()).skills,before.skills)
    await fs.writeFile(join(output,'captures.json'),JSON.stringify(captures,null,2))
    assert.deepEqual(errors,[])
    console.log('PASS: isolated Electron per-instance capabilities, live-refresh requests, changed ranking, exact-version preservation, evidence table, advisor override/receipt, confirmed apply, offline no-cache/no-call, restart/skill preservation, 1280x840 + 860x600 light/dark, maximized tutorials')
  } catch(error) {
    if(page && !page.isClosed()){await fs.writeFile(join(output,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:join(output,'failure.png')})}
    throw error
  } finally {if(desktop)await desktop.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1})
