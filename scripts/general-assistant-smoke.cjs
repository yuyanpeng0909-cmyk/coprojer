const assert=require('node:assert/strict'), fs=require('node:fs/promises'), {join,resolve}=require('node:path'), http=require('node:http')
const {_electron:electron}=require('playwright')
async function main(){
  const output=resolve('output/playwright/general-assistant');await fs.mkdir(output,{recursive:true})
  const profile=await fs.mkdtemp(join(output,'profile-')), requests=[],failures=[],errors=[]
  let releaseSearch, searchStarted=false, failSearch=false,desktop,page
  const server=http.createServer(async(req,res)=>{try{
    if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'qwen3.7-flash-from-catalog'},{id:'execution-model'}]}));return}
    let raw='';for await(const chunk of req)raw+=chunk
    const body=JSON.parse(raw), system=body.messages[0].content;requests.push(body)
    if(['execution-model','qwen3.7-flash-from-catalog'].includes(body.model))assert.equal(req.headers.authorization,'Bearer fixture-only-key','must reuse source credentials')
    let content=''
    if(system.includes('GENERAL_ASSISTANT'))content='可以从智能体卡片的技能入口导入 SKILL.md，预览后确认安装。'
    else if(system.includes('SKILL_SEARCH_QUERY')){
      searchStarted=true;if(releaseSearch!==undefined)await new Promise(r=>{releaseSearch=r})
      if(failSearch){res.writeHead(503);res.end('fixture search unavailable');return}
      content=JSON.stringify({query:'frontend'})
    }else if(system.includes('SKILL_RECOMMENDATIONS'))content=JSON.stringify({recommendations:[{index:0,reason:'适用于当前实例的受控推荐。'}]})
    else if(system.includes('AGENT_MODEL_ALLOCATION')){const input=JSON.parse(body.messages.at(-1).content);content=JSON.stringify({choices:input.agents.map(a=>({agentId:a.id,modelId:a.modelId,reason:'保持各执行成员当前绑定'}))})}
    else content='工程模型完成讨论，仍使用任务绑定。'
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:body.model+'-served',choices:[{message:{role:'assistant',content,tool_calls:[]}}]}))
  }catch(e){failures.push(e.message);res.writeHead(500);res.end('fixture failure')}})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const env={...process.env,COPROJER_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE
  const invoke=(method,...args)=>page.evaluate(({method,args})=>window.desktop.engineering[method](...args),{method,args})
  const state=()=>invoke('state')
  const until=async(predicate,label)=>{const deadline=Date.now()+30000;while(!await predicate()){if(Date.now()>deadline)throw Error('Timeout: '+label);await new Promise(r=>setTimeout(r,80))}}
  const launch=async()=>{
    desktop=await electron.launch({args:['.','--disable-gpu'],env,timeout:30000});page=await desktop.firstWindow()
    page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'})
    await page.getByRole('heading',{name:'项目管理',exact:true}).waitFor()
    await desktop.evaluate(()=>{const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{
      const url=String(input),sha='a'.repeat(40)
      if(url.startsWith('https://skills.sh/'))return new Response(JSON.stringify({skills:[{name:'fixture-skill',source:'fixture/skills'}]}))
      if(url.includes('api.github.com')&&url.includes('/commits/'))return new Response(JSON.stringify({sha}))
      if(url.includes('api.github.com')&&url.includes('/git/trees/'))return new Response(JSON.stringify({tree:[{path:'skills/fixture-skill/SKILL.md',type:'blob',mode:'100644',size:100}]}))
      if(url.startsWith('https://raw.githubusercontent.com/fixture/skills/'))return new Response(['---','name: fixture-skill','description: 技能恢复测试','---','辅助当前实例。'].join(String.fromCharCode(10)))
      return original(input,init)
    }})
  }
  const screenshot=async(name,width,height)=>{
    await desktop.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height})
    await page.screenshot({path:join(output,name+'-'+width+'.png'),animations:'disabled',scale:'css'})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow')
    for(const d of await page.locator('dialog[open]').all())assert.ok(await d.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'dialog overflow')
    if(name==='chat'){const box=await page.getByRole('dialog',{name:'通用助手',exact:true}).getByRole('button',{name:'发送',exact:true}).boundingBox();assert.ok(box&&box.y+box.height<=height,'chat send must stay in view')}
  }
  try{
    await launch()
    const baseUrl='http://127.0.0.1:'+server.address().port+'/compatible-mode/v1'
    await invoke('saveModel',{id:'source',name:'已有连接',model:'execution-model',protocol:'chat',baseUrl,apiKey:'fixture-only-key'})
    await invoke('saveModel',{id:'alternate',name:'单次助手',model:'alternate-model',protocol:'chat',baseUrl,apiKey:''})
    const originalAgents=(await state()).agents,originalSkills=(await state()).skills
    await page.getByRole('button',{name:'模型连接',exact:true}).click()
    await page.locator('.eng-model-card').filter({hasText:'execution-model'}).getByRole('button',{name:'复用连接',exact:true}).click()
    const model=page.getByRole('dialog',{name:'新增模型'})
    assert.equal(await model.getByLabel('显示名称',{exact:true}).count(),0)
    await model.getByRole('button',{name:'获取列表',exact:true}).click()
    await model.getByText('获取到 2 个模型，可在模型标识中选择。').waitFor()
    await model.getByPlaceholder('填写或选择模型 ID').fill('qwen3.7-flash-from-catalog')
    await model.getByRole('button',{name:'保存模型',exact:true}).click();await model.waitFor({state:'hidden'})
    const qwen=(await state()).models.find(m=>m.model==='qwen3.7-flash-from-catalog');assert.ok(qwen);assert.equal(qwen.baseUrl,baseUrl)
    const settings=page.getByRole('region',{name:'默认通用助手模型设置'})
    await settings.getByLabel('默认通用助手模型',{exact:true}).selectOption(qwen.id)
    await settings.getByRole('button',{name:'保存默认模型',exact:true}).click()
    await until(async()=>(await state()).defaultAssistantModelId===qwen.id,'save default')
    await screenshot('models',1280,840);await screenshot('models',860,600);console.log('Verified connection reuse and default setting')
    await page.getByRole('button',{name:'通用助手',exact:true}).click()
    const assistant=page.getByRole('dialog',{name:'通用助手',exact:true})
    await assistant.getByLabel('消息',{exact:true}).fill('如何导入 Skill？');await assistant.getByRole('button',{name:'发送',exact:true}).click()
    await until(async()=>(await state()).assistantChat.at(-1)?.status==='complete','default chat response')
    await assistant.getByText(/本次实际使用：qwen3.7-flash-from-catalog-served/).waitFor()
    await assistant.getByLabel('本次使用的通用助手模型').selectOption('alternate')
    await assistant.getByLabel('消息',{exact:true}).fill('单次请求');await assistant.getByRole('button',{name:'发送',exact:true}).click()
    await until(async()=>{const c=(await state()).assistantChat.at(-1);return c.usage?.connectionId==='alternate'&&c.status==='complete'},'override chat')
    assert.equal(await assistant.getByLabel('本次使用的通用助手模型').inputValue(),'');assert.equal((await state()).defaultAssistantModelId,qwen.id)
    await screenshot('chat',1280,840);await screenshot('chat',860,600);console.log('Verified chat default and one-shot model receipts')
    await assistant.getByRole('button',{name:'关闭面板',exact:true}).click();await page.getByRole('button',{name:'智能体',exact:true}).click()
    const openSkills=async(name)=>page.locator('.eng-agent-card').filter({hasText:name}).getByRole('button',{name:'技能',exact:true}).click()
    await openSkills('任务规划智能体')
    const skills=page.getByRole('dialog',{name:'智能体专属技能'})
    await skills.getByLabel('需要补充什么能力？').fill('规划测试能力');releaseSearch=null
    await skills.getByRole('button',{name:'联网推荐',exact:true}).click();await until(()=>searchStarted,'search started')
    await skills.getByRole('button',{name:'关闭面板',exact:true}).click();await openSkills('任务规划智能体')
    await skills.getByText(/本次正在请求/).waitFor();assert.ok(await skills.getByRole('button',{name:'联网推荐',exact:true}).isDisabled())
    releaseSearch();releaseSearch=undefined
    await skills.getByRole('button',{name:'预览安装',exact:true}).waitFor();assert.equal((await state()).skillSearches.planner.usage.connectionId,qwen.id)
    const requestsBefore=requests.length
    await skills.getByRole('button',{name:'关闭面板',exact:true}).click();await openSkills('任务规划智能体')
    await skills.getByRole('button',{name:'预览安装',exact:true}).waitFor()
    assert.equal(await skills.getByLabel('需要补充什么能力？').inputValue(),'规划测试能力');assert.equal(requests.length,requestsBefore,'reopening must not repeat search')
    await skills.getByLabel('本次使用的通用助手模型').selectOption('alternate');await skills.getByLabel('需要补充什么能力？').fill('单次能力搜索')
    await skills.getByRole('button',{name:'联网推荐',exact:true}).click()
    await until(async()=>(await state()).skillSearches.planner.query==='单次能力搜索','override skill search')
    assert.equal((await state()).skillSearches.planner.usage.connectionId,'alternate');assert.equal((await state()).defaultAssistantModelId,qwen.id)
    failSearch=true;await skills.getByLabel('需要补充什么能力？').fill('失败仍保留')
    await skills.getByRole('button',{name:'联网推荐',exact:true}).click();await skills.getByRole('alert').waitFor()
    assert.equal((await state()).skillSearches.planner.query,'单次能力搜索');failSearch=false
    await skills.getByRole('button',{name:'关闭面板',exact:true}).click();await openSkills('任务规划智能体')
    await screenshot('restored-skills',1280,840);await screenshot('restored-skills',860,600);console.log('Verified search close/reopen, one-shot selection and failure preservation')
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');await screenshot('restored-skills-dark',860,600)
    await page.evaluate(()=>document.documentElement.dataset.theme='light')
    await skills.getByRole('button',{name:'关闭面板',exact:true}).click();await openSkills('原型前端智能体')
    assert.equal(await skills.getByRole('button',{name:'预览安装',exact:true}).count(),0)
    await skills.getByRole('button',{name:'关闭面板',exact:true}).click();await page.getByRole('button',{name:'模型配置助手',exact:true}).click()
    const allocation=page.getByRole('dialog',{name:'模型配置助手'})
    await allocation.getByRole('button',{name:'一键推荐模型',exact:true}).click();await allocation.getByRole('button',{name:'一键应用模型配置',exact:true}).waitFor()
    await allocation.getByText(/本次实际使用：qwen3.7-flash-from-catalog-served/).waitFor()
    await allocation.getByLabel('本次使用的通用助手模型').selectOption('alternate');await allocation.getByRole('button',{name:'一键推荐模型',exact:true}).click()
    await allocation.getByText(/本次实际使用：alternate-model-served/).waitFor();assert.equal((await state()).defaultAssistantModelId,qwen.id)
    await screenshot('allocation',860,600);await allocation.getByRole('button',{name:'关闭面板',exact:true}).click()
    assert.deepEqual((await state()).agents,originalAgents);assert.deepEqual((await state()).skills,originalSkills)
    const parent=await fs.mkdtemp(join(output,'project-')),pid=await invoke('createProject',{name:'模型边界测试',parent,brief:'独立任务模型',modelId:'source'})
    await invoke('discuss',pid,'测试任务模型')
    await until(async()=>{const p=(await state()).projects.find(p=>p.id===pid);return !p.activity&&p.chat.some(c=>c.role==='assistant'&&c.status==='complete')},'project execution route')
    const execution=requests.filter(r=>!['GENERAL_ASSISTANT','SKILL_SEARCH_QUERY','SKILL_RECOMMENDATIONS','AGENT_MODEL_ALLOCATION'].some(k=>r.messages[0].content.includes(k)))
    assert.ok(execution.length);assert.ok(execution.every(r=>r.model==='execution-model'))
    await assert.rejects(invoke('deleteModel',qwen.id),/默认通用助手/)
    await desktop.close();desktop=null;await launch()
    assert.equal((await state()).defaultAssistantModelId,qwen.id);assert.ok((await state()).assistantChat.length>=4)
    const beforeRestartOpen=requests.length
    await page.getByRole('button',{name:'智能体',exact:true}).click();await openSkills('任务规划智能体')
    const restored=page.getByRole('dialog',{name:'智能体专属技能'})
    await restored.getByRole('button',{name:'预览安装',exact:true}).waitFor();assert.equal(await restored.getByLabel('需要补充什么能力？').inputValue(),'单次能力搜索')
    assert.equal(requests.length,beforeRestartOpen)
    await restored.getByRole('button',{name:'清空推荐记录',exact:true}).click();await until(async()=>!(await state()).skillSearches.planner,'clear saved recommendation')
    assert.deepEqual(errors,[]);assert.deepEqual(failures,[])
    await fs.writeFile(join(output,'evidence.json'),JSON.stringify({profile,requests:requests.map(r=>({model:r.model,system:r.messages[0].content.split('：')[0]})),checked:['default','one-shot','actual model','reuse connection','close-reopen','restart','failed-search preserves results','per-instance isolation','execution model unchanged','1280x840','860x600','dark','explicit clear']},null,2))
    console.log('PASS: real Electron default/override, receipts, reuse connection, role routing, saved search reopen/restart/isolation/failure/clear, both layouts and dark theme')
  }catch(e){if(page){await fs.writeFile(join(output,'failure.txt'),JSON.stringify({error:e.message,errors,failures,snapshot:await page.locator('body').ariaSnapshot()},null,2));await page.screenshot({path:join(output,'failure.png')})}throw e}
  finally{if(desktop)await desktop.close();await new Promise(r=>server.close(r))}
}
main().catch(e=>{console.error(e);process.exitCode=1})
