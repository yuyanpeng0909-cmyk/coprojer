const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
function load(file) {
  const api = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('exports', 'require', code)(api, name => load(require('node:path').resolve(require('node:path').dirname(file), name + '.ts')))
  return api
}
const { complete } = load('src/main/engineering/model.ts')
const connection = { model: 'test', protocol: 'chat', baseUrl: 'http://localhost:9000', apiKey: 'secret-marker' }
async function main() {
  const original = global.fetch
  try {
    let oversizeRequests = 0
    global.fetch = async () => { oversizeRequests++; throw new Error('must not send') }
    for (const protocol of ['chat', 'responses', 'anthropic'])
      await assert.rejects(complete({ ...connection, protocol }, 'x'.repeat(160001), []), /160000 字符上限/)
    assert.equal(oversizeRequests, 0)
    for (const protocol of ['chat', 'responses', 'anthropic']) {
      const model = 'provider-specific-model-id'
      const data = protocol === 'chat' ? {model,choices:[{message:{content:'ok'}}]} : protocol === 'responses' ? {model,output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]} : {model,content:[{type:'text',text:'ok'}]}
      global.fetch = async () => new Response(JSON.stringify(data), {headers:{'content-type':'application/json'}})
      assert.equal((await complete({...connection,protocol},'',[])).model,model)
      const events = protocol === 'chat' ? [{model,choices:[{delta:{content:'ok'},finish_reason:'stop'}]}] : protocol === 'responses' ? [{type:'response.completed',response:data}] : [{type:'message_start',message:{model}},{type:'content_block_start',index:0,content_block:{type:'text',text:'ok'}},{type:'message_stop'}]
      const newline = String.fromCharCode(10)
      global.fetch = async () => new Response(events.map(e=>'data: '+JSON.stringify(e)+newline+newline).join(''),{headers:{'content-type':'text/event-stream'}})
      const streamed = await complete({...connection,protocol},'',[],[],undefined,()=>{})
      assert.equal(streamed.model,model);assert.equal(streamed.text,'ok')
    }
    for (const [code, label] of [
      ['UND_ERR_HEADERS_TIMEOUT', '底层网络超时'], ['ECONNRESET', '连接中断'],
      ['ENOTFOUND', '域名解析失败'], ['CERT_HAS_EXPIRED', 'TLS 或证书校验失败'],
    ]) {
      global.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('secret-marker'), { code }) }) }
      await assert.rejects(complete(connection, '', []), e => {
        assert.ok(e.message.includes(code) && e.message.includes(label))
        assert.ok(!e.message.includes('secret-marker'))
        return true
      })
    }
    global.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })) },
    }), { headers: { 'content-type': 'text/event-stream' } })
    await assert.rejects(complete(connection, '', [], [], undefined, () => {}), /连接中断.*UND_ERR_SOCKET/)
    global.fetch = async () => new Response('provider unavailable', { status: 503 })
    await assert.rejects(complete(connection, '', []), /模型服务返回 503/)
    const controller = new AbortController()
    controller.abort(new Error('user stopped'))
    global.fetch = async () => { throw controller.signal.reason }
    await assert.rejects(complete(connection, '', [], [], controller.signal), /user stopped/)
    console.log('PASS: real model request preserves transport cause codes, redacts secrets, distinguishes HTTP failure and cancellation')
  } finally { global.fetch = original }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
