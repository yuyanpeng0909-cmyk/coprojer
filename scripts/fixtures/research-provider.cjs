const http = require('node:http')
const assert = require('node:assert/strict')
const { prdReply, sendPrdJson } = require('./prd-reply.cjs')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:13px system-ui;color:#202020;background:#fafafa}header{padding:22px 25px;border-bottom:1px solid #e7e7e7;background:white;display:flex;justify-content:space-between}header span{font-size:11px;color:#777}main{padding:24px}h1{font-size:19px;font-weight:550;margin:0 0 6px}p{color:#777;font-size:12px}.stats{display:grid;grid-template-columns:repeat(3,1fr);background:#fff;border:1px solid #eee;border-radius:8px;margin:22px 0}.stats section{padding:16px}.stats small{color:#777;font-size:11px}.stats strong{display:block;font-size:23px;font-weight:450;margin-top:9px}.list{background:white;border:1px solid #eee;border-radius:8px;padding:18px}button{background:#202020;color:white;border:0;border-radius:6px;padding:8px 13px;cursor:pointer}article{padding:14px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between}footer{padding:15px 0;display:flex;justify-content:flex-end}</style></head><body><header><b>轻记 / Ledger</b><span>个人账本 · 九月</span></header><main><h1>把生活，记得清楚。</h1><p>本月的每一笔收支，都有迹可循。</p><div class="stats"><section><small>月度收入</small><strong>8,500</strong></section><section><small>月度支出</small><strong>2,360</strong></section><section><small>本月结余</small><strong>6,140</strong></section></div><div class="list"><b>最近账目</b><article><span>午间餐饮</span><span>− 32.00</span></article><article><span>日常交通</span><span>− 18.00</span></article><footer><button id="add">记一笔</button></footer><p id="result"></p></div></main><script>document.getElementById('add').onclick=()=>document.getElementById('result').textContent='已打开记账表单';try{parent.document.body.dataset.escape='yes'}catch{document.body.dataset.isolated='yes'}document.body.dataset.bridge=typeof window.desktop;</script></body></html>`
async function startResearchProvider() {
  const control = {
    requests: [],
    errors: [],
    holdFinal: false,
    holdDesign: false,
    invalidDesign: false,
    waitingFinal: [],
    waitingDesign: [],
    interrupted: false,
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      control.requests.push(body)
      if (sendPrdJson(body, res, control)) return
      assert.equal(body.stream, true)
      const protocol = req.url.endsWith('messages')
        ? 'anthropic'
        : req.url.endsWith('responses')
          ? 'responses'
          : 'chat'
      const input = body.messages || body.input
      const system = body.system || body.instructions || body.messages[0].content
      const isDesign = system.includes('产品界面设计 AI')
      const prior =
        protocol === 'chat'
          ? input.filter((m) => m.role === 'tool')
          : protocol === 'responses'
            ? input.filter((m) => m.type === 'function_call_output')
            : input.flatMap((m) =>
                Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_result') : [],
              )
      const lastUser = input.filter((m) => m.role === 'user').at(-1)?.content || ''
      const long = typeof lastUser === 'string' && lastUser.includes('测试中断')
      const short = typeof lastUser === 'string' && lastUser.startsWith('补充历史')
      const prd = prdReply(body, control)
      const calls = prd?.calls ?? (
        !isDesign && !prior.length && !long && !short
          ? [
              {
                id: 'feature_call',
                name: 'update_features',
                arguments: JSON.stringify({
                  features: [
                    {
                      module: '账目管理',
                      title: '收支记录',
                      description: '记录收入支出，并可按月份浏览账单。',
                      criteria: ['新增收入支出后出现在账单列表', '切换月份可查看历史账目'],
                      scope: 'discussion',
                    },
                    {
                      module: '数据与隐私',
                      title: '本地账本',
                      description: '账目只保存在用户的本机。',
                      criteria: ['重新打开应用后数据仍然存在'],
                      scope: 'discussion',
                    },
                    {
                      module: '报表分析',
                      title: '消费趋势',
                      description: '后续版本再增加趋势分析。',
                      criteria: ['按月份查看收支趋势'],
                      scope: 'later',
                    },
                  ],
                }),
              },
            ]
          : [])
      if (!prd && calls.length)
        calls.push({
          id: 'document_call',
          name: 'update_requirements',
          arguments: JSON.stringify({
            content:
              '# 轻记产品需求\n\n## 目标与用户\n帮助个人用户掌握收支。\n\n## 业务规则\n金额保留两位小数，支持收入和支出。\n\n## 数据与隐私\n数据只保存在本机，导出由用户主动操作。\n\n## 非功能要求\n无需账号，首屏快速可用。\n\n## 开放问题\n多账本先作为备选，不自动列入本期。',
          }),
        })
      const text = prd?.text ?? (isDesign
        ? control.invalidDesign
          ? '这次只返回了说明，没有完整原型。'
          : 'PROTOTYPE_INTRO_MARKER：这是设计说明，应保留在过程记录中。\n\n```html\n' +
            html +
            '\n```\n\nPROTOTYPE_OUTRO_MARKER：这是原型之外的解释。'
        : long
          ? '这是已收到的部分响应，中断后应当保留。'
          : short
            ? '已保存这条补充信息。'
            : prior.length
              ? '### 本轮整理\n\n功能图已经更新。我们可以继续探索使用场景，也可以开始讨论界面原型。\n\n- 收支记录与本地账本作为本期候选。\n- 消费趋势先放在暂缓范围。'
              : '可以先围绕**记录习惯**和**数据归属**展开。\n\n我会把已谈到的功能同步到右侧，暂时不进入开发。')
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      const emit = async (event) => {
        const bytes = Buffer.from('data: ' + JSON.stringify(event) + '\r\n\r\n')
        // Split inside UTF-8 and SSE frame boundaries.
        const midpoint = Math.max(1, bytes.indexOf(Buffer.from('记')) + 1)
        res.write(bytes.subarray(0, midpoint))
        await delay(1)
        res.write(bytes.subarray(midpoint))
      }
      const wait = (queue) =>
        new Promise((resolve) => {
          queue.push(resolve)
          res.on('close', resolve)
        })
      if (protocol === 'chat') {
        await emit({
          choices: [
            {
              delta: { reasoning_content: '先理解完整需求，再区分当前范围和后续想法。' },
              finish_reason: null,
            },
          ],
        })
        for (let i = 0; i < text.length; i += isDesign ? 170 : 18) {
          await emit({
            choices: [
              { delta: { content: text.slice(i, i + (isDesign ? 170 : 18)) }, finish_reason: null },
            ],
          })
          await delay(8)
        }
        if (long) {
          await wait(control.waitingFinal)
          control.interrupted = true
          return
        }
        if (isDesign && control.holdDesign) await wait(control.waitingDesign)
        if (prior.length && control.holdFinal) await wait(control.waitingFinal)
        for (const [callIndex, call] of calls.entries()) {
          await emit({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: callIndex, id: call.id, function: { name: call.name, arguments: '' } },
                  ],
                },
              },
            ],
          })
          for (let i = 0; i < call.arguments.length; i += 37)
            await emit({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: callIndex,
                        function: { arguments: call.arguments.slice(i, i + 37) },
                      },
                    ],
                  },
                },
              ],
            })
        }
        await emit({
          choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        })
        res.end('data: [DONE]\n\n')
      } else if (protocol === 'anthropic') {
        if (prior.length)
          assert.ok(
            input.some(
              (m) =>
                Array.isArray(m.content) &&
                m.content.some((c) => c.type === 'thinking' && c.signature === 'fixture-signature'),
            ),
          )
        await emit({
          type: 'message_start',
          message: { id: 'msg', role: 'assistant', content: [] },
        })
        await emit({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        })
        await emit({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '先理解用户场景。' },
        })
        await emit({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'fixture-signature' },
        })
        await emit({ type: 'content_block_stop', index: 0 })
        await emit({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        })
        for (let i = 0; i < text.length; i += 18)
          await emit({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: text.slice(i, i + 18) },
          })
        await emit({ type: 'content_block_stop', index: 1 })
        for (const [callIndex, call] of calls.entries()) {
          await emit({
            type: 'content_block_start',
            index: 2 + callIndex,
            content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
          })
          for (let i = 0; i < call.arguments.length; i += 37)
            await emit({
              type: 'content_block_delta',
              index: 2 + callIndex,
              delta: { type: 'input_json_delta', partial_json: call.arguments.slice(i, i + 37) },
            })
          await emit({ type: 'content_block_stop', index: 2 + callIndex })
        }
        await emit({
          type: 'message_delta',
          delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' },
        })
        await emit({ type: 'message_stop' })
        res.end()
      } else {
        if (prior.length)
          assert.ok(
            input.some(
              (m) => m.type === 'reasoning' && m.encrypted_content === 'fixture-encrypted',
            ),
          )
        const output = [
          {
            type: 'reasoning',
            id: 'reasoning',
            summary: [{ type: 'summary_text', text: '整理目标和边界。' }],
            encrypted_content: 'fixture-encrypted',
          },
          {
            type: 'message',
            id: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        ]
        await emit({ type: 'response.reasoning_summary_text.delta', delta: '整理目标和边界。' })
        for (let i = 0; i < text.length; i += 18)
          await emit({
            type: 'response.output_text.delta',
            output_index: 1,
            delta: text.slice(i, i + 18),
          })
        for (const [callIndex, call] of calls.entries()) {
          const item = {
            type: 'function_call',
            id: 'item_call',
            call_id: call.id,
            name: call.name,
            arguments: '',
          }
          await emit({ type: 'response.output_item.added', output_index: 2 + callIndex, item })
          for (let i = 0; i < call.arguments.length; i += 37)
            await emit({
              type: 'response.function_call_arguments.delta',
              output_index: 2 + callIndex,
              delta: call.arguments.slice(i, i + 37),
            })
          output.push({ ...item, arguments: call.arguments })
        }
        await emit({ type: 'response.completed', response: { status: 'completed', output } })
        res.end()
      }
    } catch (e) {
      control.errors.push(String(e))
      res.end('data: ' + JSON.stringify({ error: { message: String(e) } }) + '\n\n')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    control,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    releaseFinal() {
      control.holdFinal = false
      for (const r of control.waitingFinal.splice(0)) r()
    },
    releaseDesign() {
      control.holdDesign = false
      for (const r of control.waitingDesign.splice(0)) r()
    },
    close() {
      this.releaseFinal()
      this.releaseDesign()
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    },
  }
}
module.exports = { startResearchProvider }
