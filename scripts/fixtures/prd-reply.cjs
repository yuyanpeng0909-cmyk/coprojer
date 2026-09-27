// Shared deterministic PRD fixture; exercises all real paginated read_context calls.
function prdReply(body, control = {}) {
  const system = body.instructions || body.system || body.messages?.[0]?.content || ''
  if (!system.includes('PRD_FROM_APPROVED_PROTOTYPE')) return null
  const input = body.input || body.messages
  const user = input.find(m => m.role === 'user' && typeof m.content === 'string')
  const request = JSON.parse(user.content)
  const calls = input.flatMap(m => m.tool_calls?.map(c => ({ id: c.id, ...c.function })) ||
    (m.type === 'function_call' ? [{ ...m, id: m.call_id }] :
      Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.input) })) : []))
  const results = input.flatMap(m => m.role === 'tool' ? [{ id: m.tool_call_id, content: m.content }] :
    m.type === 'function_call_output' ? [{ id: m.call_id, content: m.output }] :
      Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_result').map(c => ({ id: c.tool_use_id, content: c.content })) : [])
  const pending = []
  for (const source of request.sources) {
    const id = 'prototype:' + source.prototypeId
    const pages = results.flatMap(result => {
      const call = calls.find(c => c.id === result.id)
      if (!call || JSON.parse(call.arguments).id !== id) return []
      return [JSON.parse(result.content)]
    }).sort((a, b) => a.offset - b.offset)
    let read = 0, total = Infinity, version
    for (const page of pages) { if (page.offset <= read) read = Math.max(read, page.offset + page.content.length); total = page.totalCharacters; version = page.version }
    if (read < total) pending.push({ id: 'prd-read-' + source.prototypeId + '-' + read, name: 'read_context', arguments: JSON.stringify({ id, offset: read, ...(version ? { version } : {}) }) })
  }
  if (pending.length && !control.skipPrdRead) return { text: '', calls: pending }
  const features = request.currentFeatures.length ? request.currentFeatures : [
    { title: '记录收支', module: '账目', description: '沿用已验收的金额、备注表单记录收入支出并保存。', criteria: ['能够新增收入和支出', '刷新后记录保留'] },
    { title: '查看结余', module: '账目', description: '沿用已验收的结余区域汇总记录。', criteria: ['金额汇总正确'] },
  ]
  return { calls: [], text: JSON.stringify(control.invalidPrd ? { document: '', features: [] } : {
    document: '# 根据已确认原型生成的 PRD\n\n原型版本：' + request.sources.map(s => s.prototypeId).join('、') + '\n\n## 产品目标\n' + request.goal + '\n\n## 页面与交互\n沿用原型已确认的页面结构、输入表单、记录列表和结果区。\n\n## 业务与数据\n实际工程接入持久化；原型内存示例不代表真实数据。\n\n## 已有业务约束\n' + request.currentDocument + '\n\n## 验收\n逐项检查功能标准，并对照以上原型版本。',
    features,
  }) }
}
function sendPrdJson(body, res, control) {
  if (body.stream) return false
  const reply = prdReply(body, control)
  if (!reply) return false
  const { text, calls } = reply
  const result = body.instructions ? { output: [
    ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
    ...calls.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })),
  ] } : body.system ? { content: [
    ...(text ? [{ type: 'text', text }] : []),
    ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: JSON.parse(c.arguments) })),
  ] } : { choices: [{ message: { role: 'assistant', content: text, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } }] }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result))
  return true
}
module.exports = { prdReply, sendPrdJson }
