const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
function load(file) {
  const api = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('exports', 'require', code)(api, () => load('src/main/engineering/stream.ts'))
  return api
}
const { complete } = load('src/main/engineering/model.ts')
const connection = { model: 'test', protocol: 'chat', baseUrl: 'http://localhost:9000', apiKey: 'secret-marker' }
async function main() {
  const original = global.fetch
  try {
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
