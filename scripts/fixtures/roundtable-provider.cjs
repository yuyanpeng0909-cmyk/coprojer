const http = require('node:http')
const targets = [
  {
    id: 'web',
    name: '用户前端',
    kind: 'web',
    directory: 'apps/web',
    responsibility: '用户查看设备和告警，管理自己的场景。',
    contracts: '调用后台 REST /devices；共享设备 ID 与告警状态。',
  },
  {
    id: 'api',
    name: '后台服务',
    kind: 'backend',
    directory: 'services/api',
    responsibility: '认证授权、设备注册、遥测数据和告警规则。',
    contracts: '提供 REST /devices；消费 MQTT telemetry，校验设备身份。',
  },
  {
    id: 'mobile',
    name: '移动应用',
    kind: 'mobile',
    directory: 'apps/mobile',
    responsibility: '设备配网、现场操作和推送通知。',
    contracts: '使用后台认证与设备 API，蓝牙配网协议 v1。',
  },
  {
    id: 'device',
    name: 'IoT 设备',
    kind: 'iot',
    directory: 'devices/firmware',
    responsibility: '采集传感器数据、离线缓存和设备状态上报。',
    contracts: 'MQTT telemetry v1；设备 ID、时间戳、温度与固件版本。',
  },
]
async function startRoundtableProvider() {
  const control = { requests: [], hold: false, waiting: [], fail: false, decisions: '' }
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    control.requests.push(body)
    if (control.fail || control.failModel === body.model) {
      res.writeHead(503)
      res.end('fixture unavailable')
      return
    }
    const responses = req.url.endsWith('/responses')
    const input = body.input || body.messages
    const system = body.instructions || body.messages[0].content
    // DeepSeek accepts plain assistant history until tools are offered. In thinking
    // mode every assistant turn then needs its original reasoning_text item.
    if (responses && body.tools?.length) {
      let reasoning = false
      for (const item of input) {
        if (item.type === 'reasoning')
          reasoning = item.content?.some((part) => part.type === 'reasoning_text' && part.text)
        if (item.role === 'assistant') {
          if (!reasoning) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                error: {
                  message:
                    'The `reasoning_text` in the thinking mode must be passed back to the API.',
                  type: 'invalid_request_error',
                },
              }),
            )
            return
          }
          reasoning = false
        }
      }
    }
    const chair = system.includes('你是本轮圆桌主持人')
    const toolsDone = input.some((m) => m.role === 'tool' || m.type === 'function_call_output')
    const design = system.includes('产品界面设计 AI')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const output = [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    ]
    const send = (event) => res.write('data: ' + JSON.stringify(event) + '\n\n')
    const emit = (delta) => {
      if (!responses) return send({ choices: [{ delta, finish_reason: null }] })
      if (delta.reasoning_content) {
        output[0].content[0].text += delta.reasoning_content
        send({ type: 'response.reasoning_text.delta', delta: delta.reasoning_content })
      }
      if (delta.content) {
        output[1].content[0].text += delta.content
        send({ type: 'response.output_text.delta', delta: delta.content })
      }
      for (const call of delta.tool_calls || [])
        output.push({ type: 'function_call', call_id: call.id, ...call.function })
    }
    emit({ reasoning_content: '先核对端边界，再检查各端功能和接口。' })
    const prose = design
      ? '<!doctype html><html><body><h1>子项目专属原型</h1></body></html>'
      : chair
        ? toolsDone
          ? '## 第一版完整方案\n\n四个子项目边界已整理。需要人工确认设备离线策略与移动端范围。\n\n请给出反馈，我们会在下一轮共同修订。'
          : '正在整理各位意见，合并多端项目边界与功能。'
        : `### ${body.model} 的意见\n\n${system.includes('交叉') || system.includes('针对其他') ? '已复核其他成员的意见，补充离线数据冲突与移动端权限。' : '建议分别建立前端、后台、移动应用、IoT 设备项目。'}\n\n- 各端职责独立，接口版本必须明确。\n- 需要人工决定离线可用范围。`
    emit({ content: prose.slice(0, 20) })
    if (control.hold && !chair && !design)
      await new Promise((resolve) => {
        control.waiting.push(resolve)
        res.on('close', resolve)
      })
    emit({ content: prose.slice(20) })
    const emitCalls = (calls) =>
      calls.forEach((call, index) =>
        emit({
          tool_calls: [
            {
              index,
              id: 'call-' + index,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
      )
    if (
      ['long', 'reserved', 'endless', 'errors'].includes(control.decisions) &&
      !chair &&
      !design
    ) {
      const step = input.filter(
        (m) => m.role === 'tool' || m.type === 'function_call_output',
      ).length
      if (body.tools?.length && body.model === '产品模型') {
        if (control.decisions === 'errors') {
          emitCalls([{ name: 'update_requirements', args: { content: '' } }])
        } else if (control.decisions === 'reserved' && step === 0) {
          emitCalls([
            {
              name: 'ask_human',
              args: {
                question: '请选择离线范围',
                context: '测试固定暂缓按钮的兼容性。',
                options: [
                  { label: '仅在线', description: '本期不做离线缓存。' },
                  { label: '后面再说', description: '交给其他模型研究。' },
                ],
              },
            },
          ])
        } else if (
          control.decisions !== 'reserved' &&
          (step < 36 || control.decisions === 'endless')
        ) {
          emitCalls([
            control.decisions === 'long' && step % 9 === 8
              ? {
                  name: 'ask_human',
                  args: {
                    question: `第 ${step} 步需要决定范围`,
                    context: '连续整理需求时及时征求人工意见。',
                    options: [{ label: '继续细化', description: '保留当前范围，继续整理。' }],
                  },
                }
              : { name: 'update_requirements', args: { content: `# 已整理到第 ${step} 步` } },
          ])
        }
      }
    } else if (control.decisions && !chair && !design && !toolsDone) {
      const decisions = JSON.parse(
        system.split('已记录的决策（人工答案优先，暂缓不是同意）：').at(-1),
      )
      const first = body.model === '产品模型'
      const question =
        (first ? '设备离线时，需要保留多长时间的数据？' : '移动端本期面向哪些用户？') +
        (control.decisions === 'main' ? '' : '（继续讨论）')
      const calls = []
      if (!decisions.some((d) => d.question === question)) {
        if (first)
          calls.push(
            { name: 'update_project_targets', args: { targets } },
            {
              name: 'update_features',
              args: {
                features: [
                  {
                    targetId: 'web',
                    title: '设备状态',
                    module: '设备管理',
                    description: '查看设备在线情况和最后上报时间。',
                    criteria: ['离线设备有明确状态'],
                    scope: 'discussion',
                  },
                ],
              },
            },
          )
        else {
          for (const d of decisions.filter((d) => d.status === 'deferred'))
            calls.push({
              name: 'resolve_deferred_decision',
              args: {
                id: d.id,
                resolution:
                  '建议默认保留 24 小时，按当前设备存储容量可实现；仍作为模型建议供完整方案审阅。',
              },
            })
          calls.push({
            name: 'update_features',
            args: {
              features: [
                {
                  targetId: 'device',
                  title: '离线缓存',
                  module: '数据采集',
                  description: '设备离线时保留最近 24 小时数据。',
                  criteria: ['恢复连接后补传缓存'],
                  scope: 'discussion',
                },
              ],
            },
          })
        }
        calls.push({
          name: 'ask_human',
          args: {
            question,
            context: first
              ? '这会影响设备存储容量和离线补传范围。已明确的设备状态功能已同步到右侧。'
              : '内部使用与公开使用需要不同的注册和权限范围。',
            targetId: first ? 'device' : 'mobile',
            options: first
              ? [
                  { label: '保留 24 小时', description: '覆盖日常断网，设备成本较低。' },
                  { label: '保留 7 天', description: '覆盖长时间断网，需要更大存储。' },
                ]
              : [
                  { label: '仅内部人员', description: '由管理员分配账号，先验证核心流程。' },
                  { label: '面向所有用户', description: '增加注册、账号恢复与公开服务流程。' },
                ],
          },
        })
      }
      emitCalls(calls)
    }
    if (chair && !toolsDone) {
      const calls = [
        { name: 'update_project_targets', args: { targets } },
        {
          name: 'update_features',
          args: {
            features: targets.map((t) => ({
              targetId: t.id,
              title:
                t.id === 'web' || t.id === 'device'
                  ? '设备状态'
                  : t.id === 'api'
                    ? '设备接口'
                    : '现场配网',
              module: '设备管理',
              description: t.responsibility,
              criteria: ['功能有可验证的正常流程与错误反馈'],
              scope: 'discussion',
            })),
          },
        },
        {
          name: 'update_requirements',
          args: {
            content:
              '# 多端设备平台完整方案\n\n## 子项目范围\n用户前端、后台服务、移动应用和 IoT 设备。\n\n## 接口约定\nREST /devices 与 MQTT telemetry v1。\n\n## 待人工确认\n设备离线缓存保留多久？移动应用是否首期交付？',
          },
        },
      ]
      emitCalls(calls)
    }
    if (responses) {
      send({ type: 'response.completed', response: { output } })
      res.end()
    } else res.end('data: [DONE]\n\n')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    control,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    release() {
      control.hold = false
      for (const r of control.waiting.splice(0)) r()
    },
    async close() {
      this.release()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}
module.exports = { startRoundtableProvider }
