// Deterministic protocol fixture. Never imported by application code.
const http = require('node:http')
const assert = require('node:assert/strict')

const ledgerFiles = {
  'package.json': JSON.stringify(
    {
      name: 'ledger-fixture',
      version: '1.0.0',
      private: true,
      scripts: {
        dev: 'node server.cjs',
        build: 'node build.cjs',
        test: 'node --test ledger.test.cjs',
      },
    },
    null,
    2,
  ),
  'ledger.cjs': `exports.total = items => items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;\nexports.restore = json => JSON.parse(json);\n`,
  'ledger.test.cjs': `const {test} = require('node:test'); const assert = require('node:assert/strict'); const {total,restore} = require('./ledger.cjs');\ntest('income and expense use exact cents', () => assert.equal(total([{amount:20.1},{amount:-9.2}]),10.9));\ntest('stored transactions survive serialization', () => {const items = [{amount:-2.5,note:'早餐'}]; assert.deepEqual(restore(JSON.stringify(items)),items)});\n`,
  'index.html': `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>个人记账</title><style>body{max-width:650px;margin:60px auto;font:14px system-ui;color:#1a1c1f;background:#fafafa}input,button{padding:10px;border:1px solid #ddd;border-radius:6px}li{padding:12px;background:white;margin:6px 0}h1{font-size:24px}</style><h1>个人记账</h1><p>正数记收入，负数记支出。</p><form><input type="number" step="0.01" placeholder="金额" required aria-label="金额"><input placeholder="备注" aria-label="备注"><button>记一笔</button></form><h2></h2><ul></ul><script>const data=JSON.parse(localStorage.getItem('entries')||'[]');function render(){document.querySelector('h2').textContent='结余 '+(data.reduce((n,x)=>n+Math.round(x.amount*100),0)/100).toFixed(2);const ul=document.querySelector('ul');ul.replaceChildren();data.forEach(x=>{const li=document.createElement('li');li.textContent=x.note+' '+x.amount;ul.append(li)})}document.querySelector('form').onsubmit=e=>{e.preventDefault();const inputs=document.querySelectorAll('input');data.push({amount:Number(inputs[0].value),note:inputs[1].value});localStorage.setItem('entries',JSON.stringify(data));e.target.reset();render()};render()</script></html>`,
  'build.cjs': `const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('index.html','dist/index.html');console.log('Build complete');`,
  'server.cjs': `const http=require('node:http'),fs=require('node:fs');const port=Number(process.argv[process.argv.indexOf('--port')+1]||5173);http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(fs.readFileSync('index.html'))}).listen(port,'127.0.0.1',()=>console.log('Listening '+port));`,
}

async function startProvider() {
  const control = {
    requests: [],
    errors: [],
    hold: false,
    held: [],
    failing: false,
    noTest: false,
    reviews: 0,
    developments: 0,
    lastFeature: null,
  }
  const call = (name, input) => ({
    id: `call_${Math.random().toString(36).slice(2)}`,
    name,
    arguments: JSON.stringify(input),
  })
  const streamReply = (res, protocol, text, calls) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    if (protocol === 'chat') {
      emit({ choices: [{ delta: { reasoning_content: 'fixture reasoning' }, finish_reason: null }] })
      if (text) emit({ choices: [{ delta: { content: text }, finish_reason: null }] })
      calls.forEach((c, index) => {
        emit({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        emit({
          choices: [
            {
              delta: { tool_calls: [{ index, function: { arguments: c.arguments } }] },
              finish_reason: null,
            },
          ],
        })
      })
      emit({ choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })
      res.end('data: [DONE]\n\n')
      return
    }
    if (protocol === 'responses') {
      const output = []
      if (text) {
        emit({ type: 'response.output_text.delta', delta: text })
        output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      calls.forEach((c, output_index) => {
        emit({
          type: 'response.output_item.added',
          output_index,
          item: { type: 'function_call', call_id: c.id, name: c.name, arguments: '' },
        })
        emit({
          type: 'response.function_call_arguments.delta',
          output_index,
          delta: c.arguments,
        })
        output.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })
      })
      emit({ type: 'response.completed', response: { output } })
      res.end()
      return
    }
    let index = 0
    if (text) {
      emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
      emit({ type: 'content_block_stop', index })
      index++
    }
    calls.forEach((c) => {
      emit({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} },
      })
      emit({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: c.arguments },
      })
      emit({ type: 'content_block_stop', index })
      index++
    })
    emit({ type: 'message_stop' })
    res.end()
  }
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      control.requests.push({ path: req.url, body })
      res.setHeader('content-type', 'application/json')
      if (
        (req.headers.authorization || req.headers['x-api-key'] || '').includes('invalid-test-key')
      ) {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'bad key invalid-test-key' }))
        return
      }
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'fixture-coder' }, { id: 'fixture-reviewer' }] }))
        return
      }
      const protocol =
        req.url === '/v1/messages'
          ? 'anthropic'
          : req.url === '/v1/responses'
            ? 'responses'
            : 'chat'
      assert.ok(['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(req.url))
      if (protocol === 'anthropic') assert.equal(req.headers['anthropic-version'], '2023-06-01')
      const system =
        protocol === 'chat'
          ? body.messages[0].content
          : protocol === 'responses'
            ? body.instructions
            : body.system
      const input = protocol === 'responses' ? body.input : body.messages
      const priorTools =
        protocol === 'chat'
          ? input.filter((m) => m.role === 'tool')
          : protocol === 'responses'
            ? input.filter((m) => m.type === 'function_call_output')
            : input.flatMap((m) =>
                Array.isArray(m.content) ? m.content.filter((p) => p.type === 'tool_result') : [],
              )
      let text = '',
        calls = []
      if (system.includes('连接测试'))
        text =
          '连接成功 ' +
          (req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '') || '')
      else if (system.includes('软件需求协作者')) {
        const feature = {
          module: '账目管理',
          title: '记录收支',
          description: '记录收入与支出，显示结余，刷新页面后保留记录。',
          criteria: ['能够新增收入和支出', '刷新后记录保留'],
          scope: 'discussion',
        }
        control.lastFeature = feature
        text = JSON.stringify({
          reply: '已整理账目管理模块。请确认范围和验收标准。',
          features: [feature],
        })
      } else if (system.includes('软件方案设计者'))
        text = JSON.stringify({
          plan: '创建本地网页工程，使用本地存储保存账目。抽取金额汇总函数并运行测试，提供 dev/build/test 脚本。',
          tasks: ['建立网页工程', '实现账目与存储', '验证精度、保存与启动'],
        })
      else {
        const reviewer = system.includes('你是 Coprojer 的验证智能体')
        const featureText = system.split('已确认功能：')[1]?.split('\n')[0]
        const feature = JSON.parse(featureText)
        if (reviewer) {
          assert.ok(!body.tools.some((t) => (t.function?.name ?? t.name) === 'write_file'))
          if (!priorTools.length) control.reviews++
          if (control.noTest)
            text = JSON.stringify({
              results: feature.criteria.map((criterion) => ({
                criterion,
                passed: true,
                evidence: '未经测试的模型自述',
              })),
            })
          else if (!priorTools.length) calls = [call('read_file', { path: 'ledger.cjs' })]
          else if (priorTools.length === 1)
            calls = [
              call('run_command', { program: 'npm', args: ['test'] }),
              call('run_command', { program: 'npm', args: ['run', 'build'] }),
            ]
          else
            text = JSON.stringify({
              summary: '已读取代码并运行测试与构建。',
              results: feature.criteria.map((criterion) => ({
                criterion,
                passed: true,
                evidence:
                  'ledger.test.cjs 检查收支精度与序列化；已运行 npm test 和 npm run build。',
              })),
            })
        } else {
          if (!priorTools.length) {
            control.developments++
            calls = [call('list_files', {})]
          } else if (priorTools.length === 1) {
            const files = { ...ledgerFiles }
            if (control.failing)
              files['ledger.test.cjs'] += "\ntest('deliberate failure',()=>assert.equal(1,2));"
            calls = [
              ...Object.entries(files).map(([path, content]) =>
                call('write_file', { path, content }),
              ),
              call('write_file', { path: '../escape.txt', content: 'must never be written' }),
              call('write_file', {
                path: '.coprojer/FEATURES.md',
                content: 'must never overwrite metadata',
              }),
            ]
          } else if (priorTools.length === 9)
            calls = [
              call('read_context', {}),
              call('run_command', {
                program: 'node',
                args: [
                  '-e',
                  "require('node:fs').writeFileSync('via-command.txt','created by a real command')",
                ],
              }),
              call('run_command', { program: 'npm', args: ['test'] }),
            ]
          else text = '已创建记账页面、金额汇总模块、持久化逻辑和测试。公共文件为 ledger.cjs。'
        }
      }
      if (control.hold) await new Promise((resolve) => control.held.push(resolve))
      if (res.destroyed) return
      if (body.stream === true) {
        streamReply(res, protocol, text, calls)
        return
      }
      if (protocol === 'chat')
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: text,
                  reasoning_content: 'fixture reasoning',
                  ...(calls.length
                    ? {
                        tool_calls: calls.map((c) => ({
                          id: c.id,
                          type: 'function',
                          function: { name: c.name, arguments: c.arguments },
                        })),
                      }
                    : {}),
                },
              },
            ],
          }),
        )
      else if (protocol === 'responses')
        res.end(
          JSON.stringify({
            output: [
              ...(text
                ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
                : []),
              ...calls.map((c) => ({
                type: 'function_call',
                call_id: c.id,
                name: c.name,
                arguments: c.arguments,
              })),
            ],
          }),
        )
      else
        res.end(
          JSON.stringify({
            content: [
              ...(text ? [{ type: 'text', text }] : []),
              ...calls.map((c) => ({
                type: 'tool_use',
                id: c.id,
                name: c.name,
                input: JSON.parse(c.arguments),
              })),
            ],
          }),
        )
    } catch (e) {
      control.errors.push(e.message)
      res.statusCode = 500
      res.end(JSON.stringify({ error: e.message }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    control,
    release() {
      control.hold = false
      control.held.splice(0).forEach((resolve) => resolve())
    },
    async close() {
      control.held.splice(0).forEach((resolve) => resolve())
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
module.exports = { startProvider }
