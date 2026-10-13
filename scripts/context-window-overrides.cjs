const {assert,fixture,load}=require('./fixtures/verification-runtime.cjs')
const {contextConnection}=load('src/main/engineering/context-policy.ts'),{requestWithContext}=load('src/main/engineering/context-request.ts'),model=load('src/main/engineering/model.ts')
async function main(){const ctx=fixture(),base={version:2,mode:'legacy',triggerScope:'total',compactor:'portable',horizonRounds:6},project={...base,mode:'shadow'},run={...base,mode:'adaptive'}
ctx.service.setContextPolicy({projectId:'p'},project);ctx.service.setContextPolicy({projectId:'p',featureId:'f'},run)
const c={id:'scope-fixture',name:'scope',protocol:'chat',baseUrl:'http://127.0.0.1:1',model:'fixture',apiKey:'',capabilities:{contextPolicy:base,contextWindowTokens:256000,maxOutputTokens:16000,outputParameter:'max_tokens',windowAccounting:'input-plus-output',reasoningAccounting:'included-in-output'}}
assert.equal(contextConnection(c,ctx.project.contextPolicy,ctx.feature.contextPolicy).capabilities.contextPolicy.mode,'adaptive');ctx.service.setContextPolicy({projectId:'p',featureId:'f'},null);assert.equal(contextConnection(c,ctx.project.contextPolicy,ctx.feature.contextPolicy).capabilities.contextPolicy.mode,'shadow')
const copy=JSON.stringify(ctx.project.contextPolicy),save=ctx.service.store.save;ctx.service.store.save=()=>{throw new Error('save fault')};assert.throws(()=>ctx.service.setContextPolicy({projectId:'p'},run),/save fault/);assert.equal(JSON.stringify(ctx.project.contextPolicy),copy);ctx.service.store.save=save
const connection=contextConnection(c,project);let captured
await requestWithContext([{role:'user',content:'short request',sequence:1}],{prepare:m=>model.prepareModelRequest(connection,'host',m,[],false),send:async p=>{captured=p;return{text:'ok',calls:[]}},assertCurrent(){},commit(){},archive(){throw new Error('unexpected archive')},event(){}},new AbortController().signal)
assert.equal(captured.budget.adaptive,false);assert.equal(captured.budget.characterLimit,160000);assert.ok(captured.budget.shadowDecision);console.log('PASS override priority, durable rollback, inherit reset and shadow-only observation')}
main().catch(e=>{console.error(e);process.exitCode=1})
