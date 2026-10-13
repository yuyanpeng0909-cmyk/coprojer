// Real HTTP/SSE, deterministic provider-side stimuli. No application imports.
const http = require('node:http')
function stream(res, protocol, reply, mode = 'complete') {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let serial = 0
  const emit = (data, duplicate = false) => {
    const frame = `id: ${++serial}\ndata: ${JSON.stringify(data)}\n\n`
    res.write(frame); if (duplicate) res.write(frame)
  }
  const calls = reply.calls || [], text = reply.text || '', output = []
  if (protocol === 'chat') {
    if (text) emit({ choices: [{ delta: { content: text } }] })
    calls.forEach((c, index) => {
      emit({ choices: [{ delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] })
      const mid = Math.floor(c.arguments.length / 2)
      emit({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: c.arguments.slice(0, mid) } }] } }] }, mode === 'duplicate')
      if (mode !== 'disconnect') emit({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: c.arguments.slice(mid) } }] } }] })
    })
    if (mode !== 'disconnect') {
      emit({ usage: reply.usage, choices: [{ delta: {}, finish_reason: mode === 'truncate' ? 'length' : calls.length ? 'tool_calls' : 'stop' }] })
      res.write('data: [DONE]\n\n')
    }
  } else if (protocol === 'responses') {
    if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
    calls.forEach((c, output_index) => {
      emit({ type: 'response.output_item.added', output_index, item: { type: 'function_call', call_id: c.id, name: c.name, arguments: '' } })
      const mid = Math.floor(c.arguments.length / 2)
      emit({ type: 'response.function_call_arguments.delta', output_index, delta: c.arguments.slice(0, mid) }, mode === 'duplicate')
      if (mode !== 'disconnect') emit({ type: 'response.function_call_arguments.delta', output_index, delta: c.arguments.slice(mid) })
      output.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })
    })
    if (mode !== 'disconnect') emit({ type: mode === 'truncate' ? 'response.incomplete' : 'response.completed', response: { output, usage: reply.usage, status: mode === 'truncate' ? 'incomplete' : 'completed' } })
  } else {
    let index = 0
    if (text) {
      emit({ type: 'content_block_start', index, content_block: { type: 'text', text } }); index++
    }
    for (const c of calls) {
      emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } })
      const mid = Math.floor(c.arguments.length / 2)
      emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: c.arguments.slice(0, mid) } }, mode === 'duplicate')
      if (mode !== 'disconnect') emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: c.arguments.slice(mid) } })
      emit({ type: 'content_block_stop', index }); index++
    }
    if (mode !== 'disconnect') {
      emit({ type: 'message_delta', usage: reply.usage, delta: { stop_reason: mode === 'truncate' ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn' } })
      emit({ type: 'message_stop' })
    }
  }
  res.end()
}
async function provider(handler) {
  const requests = [], errors = [], transport = []
  const server = http.createServer(async (req, res) => {
    // Durable saves can block the shared event loop beyond the idle socket timer.
    // These workflow fixtures test state recovery, not pooled-connection races.
    res.setHeader('connection', 'close')
    transport.push({ kind: 'request', socket: req.socket.remotePort, at: Date.now() })
    res.on('finish', () => transport.push({ kind: 'response', socket: req.socket.remotePort, at: Date.now() }))
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw), protocol = req.url.endsWith('/messages') ? 'anthropic' : req.url.endsWith('/responses') ? 'responses' : 'chat'
      const request = { body, protocol, path: req.url, system: protocol === 'chat' ? body.messages[0].content : protocol === 'responses' ? body.instructions : body.system }
      requests.push(request)
      const result = await handler(request, requests.length)
      if (result.httpStatus) { res.writeHead(result.httpStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: result.error })); return }
      stream(res, protocol, result.reply || result, result.mode)
    } catch (error) { errors.push(error.stack); res.writeHead(500); res.end('controlled provider failure') }
  })
  server.on('connection', socket => {
    const id = socket.remotePort
    socket.on('timeout', () => transport.push({ kind: 'idle-timeout', socket: id, at: Date.now() }))
    socket.on('close', () => transport.push({ kind: 'close', socket: id, at: Date.now() }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { requests, errors, transport, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => server.close(resolve)) }
}
module.exports = { provider, stream }
