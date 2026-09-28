const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { join, resolve } = require('node:path')
const http = require('node:http')
const { _electron: electron } = require('playwright')
const { allocationFixture, categories } = require('./fixtures/arena.cjs')

async function main() {
  const output = resolve('output/playwright/agent-skills'); await fs.mkdir(output,{recursive:true})
  const profile = await fs.mkdtemp(join(output,'profile-')), source = await fs.mkdtemp(join(output,'source-')), parent = await fs.mkdtemp(join(output,'projects-'))
  await fs.mkdir(join(source,'references'))
  await fs.writeFile(join(source,'SKILL.md'),'---\nname: fixture-design\ndescription: 本地布局与交互规范\n---\n按需读取 references/guide.md。')
  await fs.writeFile(join(source,'references/guide.md'),'LOCAL_RESOURCE_MARKER')
  const requests = [], failures = []
  const server = http.createServer(async(req,res)=>{
    try {
      let raw=''; for await (const chunk of req) raw+=chunk
      const body=JSON.parse(raw), system=body.messages[0].content, input=body.messages.filter(m=>m.role==='user').at(-1)?.content
      requests.push(body)
      let text='', calls=[]
      if(system.includes('SKILL_SEARCH_QUERY')) text=JSON.stringify({query:'frontend'})
      else if(system.includes('SKILL_RECOMMENDATIONS')) text=JSON.stringify({recommendations:[{index:0,reason:'适合原型设计，来源正文已核实，运行能力需按项目检查。'}]})
      else if(system.includes('AGENT_MODEL_ALLOCATION')) { const parsed=JSON.parse(input);text=JSON.stringify({choices:parsed.agents.map(a=>({agentId:a.id,modelId:parsed.constraints.find(c=>c.agentId===a.id).allowedModelIds[0]}))}) }
      else {
        const previous=body.messages.filter(m=>m.role==='tool')
        if(!previous.length) calls=[{id:'foreign',type:'function',function:{name:'read_skill',arguments:JSON.stringify({id:'designer::fixture-design'})}}]
        else if(previous.length===1) { assert.match(previous[0].content,/不属于/); calls=[{id:'own',type:'function',function:{name:'read_skill',arguments:JSON.stringify({id:'planner::requirements'})}}] }
        else { assert.match(previous.at(-1).content,/梳理|区分本期/); text='专属技能已按需读取，跨智能体调用已被拒绝。' }
      }
      if(body.stream) {
        res.writeHead(200,{'content-type':'text/event-stream'})
        const delta=calls.length?{tool_calls:calls.map((c,index)=>({...c,index}))}:{content:text}
        res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n')
        res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:calls.length?'tool_calls':'stop'}]})+'\n\n')
        res.end('data: [DONE]\n\n')
      } else { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{role:'assistant',content:text,tool_calls:calls},finish_reason:calls.length?'tool_calls':'stop'}]})) }
    } catch(e) {failures.push(e.message);res.writeHead(500);res.end(String(e))}
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const env={...process.env,COPROJER_USER_DATA:profile}; delete env.ELECTRON_RUN_AS_NODE
  let desktop
  try {
    desktop=await electron.launch({args:['.','--disable-gpu'],env,timeout:30000})
    const page=await desktop.firstWindow(), errors=[]; page.on('pageerror',e=>errors.push(e.message))
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.getByRole('heading',{name:'项目管理',exact:true}).waitFor()
    const invoke=(method,...args)=>page.evaluate(({method,args})=>window.desktop.engineering[method](...args),{method,args})
    const state=()=>invoke('state')
    const baseUrl='http://127.0.0.1:'+server.address().port+'/v1'
    for(const [id,name] of [['model-a','规划模型'],['model-b','开发模型']]) await invoke('saveModel',{id,name,model:id,protocol:'chat',baseUrl,apiKey:''})
    await invoke('setDefaultAssistantModel','model-a')
    const designer=(await state()).agents.find(a=>a.id==='designer')
    await invoke('saveAgent',{...designer,id:'designer-2',name:'第二设计实例',skillIds:[]})
    await page.getByRole('button',{name:'智能体',exact:true}).click()
    await page.locator('.eng-agent-card').filter({hasText:'第二设计实例'}).waitFor()
    const screenshot=async(name,width,height)=>{
      await desktop.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height})
      await page.screenshot({path:join(output,name+'-'+width+'.png'),animations:'disabled',scale:'css'})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'window must not overflow')
      const dialogs=page.locator('dialog[open]'); if(await dialogs.count()) assert.ok(await dialogs.evaluate(d=>d.scrollWidth<=d.clientWidth+1),'dialog must not overflow')
    }
    await screenshot('agents',1280,840); await screenshot('agents',860,600)
    await page.locator('.eng-agent-card').filter({hasText:'原型前端智能体'}).getByRole('button',{name:'技能',exact:true}).click()
    const skills=page.getByRole('dialog',{name:'智能体专属技能'})
    await desktop.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]})},source)
    await skills.getByRole('button',{name:'导入本地技能',exact:true}).click()
    await skills.getByRole('button',{name:'确认安装并启用',exact:true}).waitFor()
    assert.ok(!(await state()).skills.some(s=>s.sourceId==='fixture-design'))
    await screenshot('local-preview',860,600)
    await skills.getByRole('button',{name:'确认安装并启用',exact:true}).click()
    await skills.getByText('已安装并启用，仅供「原型前端智能体」使用。').waitFor()
    assert.equal((await state()).skills.find(s=>s.sourceId==='fixture-design').ownerAgentId,'designer')
    await skills.getByRole('checkbox',{name:/fixture-design/}).uncheck()
    await page.waitForFunction(()=>document.querySelector('.eng-owned-skill input:not(:checked)'))
    await skills.getByRole('checkbox',{name:/fixture-design/}).check()
    await desktop.evaluate((_, arenaFixtures)=>{
      const original=globalThis.fetch
      globalThis.fetch=async(input,init)=>{
        const url=String(input), sha='a'.repeat(40)
        if(url.startsWith('https://artificialanalysis.ai/')) return new Response('Isolated Arena regression; AA covered separately', {status:503})
        if(url.startsWith('https://arena.ai/')) return new Response(arenaFixtures[new URL(url).pathname], { headers: { 'content-type': 'text/html' } })
        if(url.startsWith('https://skills.sh/')) return new Response(JSON.stringify({skills:[{name:'fixture-remote',source:'fixture/skills'}]}))
        if(url.includes('api.github.com')&&url.includes('/commits/')) return new Response(JSON.stringify({sha}))
        if(url.includes('api.github.com')&&url.includes('/git/trees/')) return new Response(JSON.stringify({tree:[{path:'skills/fixture-remote/SKILL.md',type:'blob',mode:'100644',size:140}]}))
        if(url.startsWith('https://raw.githubusercontent.com/fixture/skills/')) return new Response('---\nname: fixture-remote\ndescription: 用于原型设计的公开技能测试包\n---\n检查页面交互。')
        return original(input,init)
      }
    }, Object.fromEntries(Object.keys(categories).map(p=>[p,allocationFixture('https://arena.ai'+p,'model-a','model-b')])))
    await skills.getByLabel('需要补充什么能力？').fill('界面布局')
    await skills.getByRole('button',{name:'联网推荐',exact:true}).click()
    await skills.getByRole('button',{name:'预览安装',exact:true}).waitFor({timeout:30000})
    await skills.getByRole('button',{name:'预览安装',exact:true}).click()
    await skills.getByRole('heading',{name:'确认安装 · fixture-remote'}).waitFor()
    await skills.getByRole('button',{name:'确认安装并启用',exact:true}).click()
    await skills.getByRole('checkbox',{name:/fixture-remote/}).waitFor()
    await screenshot('skills-installed',1280,840)
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark'})
    await screenshot('skills-installed-dark',860,600)
    await page.evaluate(()=>{document.documentElement.dataset.theme='light'})
    await skills.getByRole('button',{name:'关闭面板',exact:true}).click()
    await page.locator('.eng-agent-card').filter({hasText:'第二设计实例'}).getByRole('button',{name:'技能',exact:true}).click()
    assert.equal(await skills.getByRole('checkbox',{name:/fixture-design|fixture-remote/}).count(),0)
    await skills.getByRole('button',{name:'关闭面板',exact:true}).click()
    const second=(await state()).agents.find(a=>a.id==='designer-2')
    await assert.rejects(invoke('saveAgent',{...second,skillIds:['designer::fixture-design']}),/其他智能体/)
    await page.getByRole('button',{name:'模型配置助手',exact:true}).click()
    const assistant=page.getByRole('dialog',{name:'模型配置助手'})
    await assistant.getByLabel('任务规划智能体能力类别',{exact:true}).selectOption('text')
    await assistant.getByLabel('开发智能体能力类别',{exact:true}).selectOption('coding')
    await assistant.getByLabel('验证智能体能力类别',{exact:true}).selectOption('coding')
    await assistant.getByRole('button',{name:'一键推荐模型',exact:true}).click()
    await assistant.getByRole('button',{name:'一键应用模型配置',exact:true}).waitFor()
    assert.equal((await state()).agents.find(a=>a.id==='developer').modelId,'model-a')
    await screenshot('model-plan',1280,840); await screenshot('model-plan',860,600)
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark'})
    await screenshot('model-plan-dark',860,600)
    await page.evaluate(()=>{document.documentElement.dataset.theme='light'})
    await assistant.getByRole('button',{name:'一键应用模型配置',exact:true}).click()
    await assistant.getByText(/已应用 \d+ 项模型变更/).waitFor()
    assert.equal((await state()).agents.find(a=>a.id==='developer').modelId,'model-b')
    await assistant.getByRole('button',{name:'关闭面板',exact:true}).click()
    const pid=await invoke('createProject',{name:'隔离技能验证',parent,brief:'验证按需加载',modelId:'model-a'})
    await invoke('discuss',pid,'请检查当前任务的规划技能。')
    const deadline=Date.now()+30000
    for (;;) {
      const p=(await state()).projects.find(p=>p.id===pid)
      if(p && !p.activity && p.chat.some(c=>c.status==='complete'&&c.text.includes('跨智能体调用已被拒绝'))) break
      if(Date.now()>deadline) throw Error('Timed out waiting for actual skill-read completion')
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    const project=(await state()).projects.find(p=>p.id===pid)
    assert.ok(project.events.some(e=>e.kind==='skill'&&e.message.includes('planner::requirements')), JSON.stringify({events:project.events,chat:project.chat,requests:requests.length}))
    assert.ok(requests.some(b=>b.tools?.some(t=>t.function?.name==='read_skill')))
    assert.deepEqual(errors,[]); assert.deepEqual(failures,[])
    console.log('PASS: real Electron local preview/install/toggle, remote recommendation+confirmed install (mock services), per-instance isolation, model assistant preview/apply, on-demand skill tool calls, 1280x840 and 860x600 layouts')
  } finally { if(desktop) await desktop.close(); await new Promise(r=>server.close(r)) }
}
main().catch(e=>{console.error(e);process.exitCode=1})
