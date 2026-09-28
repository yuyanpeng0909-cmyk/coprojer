import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { shell } from 'electron'

// Official CLI transport reference (read-only calls):
// https://github.com/modelstudioai/cli/blob/main/packages/core/src/console/gateway.ts
// https://github.com/modelstudioai/cli/blob/main/packages/commands/src/commands/auth/login-console.ts
const origin = 'https://bailian.console.aliyun.com'
export const quotaApi = 'zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota'
export const autoStopApi = 'zeldaEasy.bailian-commerce.freeTrial.queryFreeTierOnlyStatus'

export async function aliyunJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]) })
  } catch {
    throw new Error(signal?.aborted ? '已取消阿里云导入。' : '无法连接阿里云，请检查网络后重试。')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 401 || response.status === 403
      ? '阿里云拒绝访问，请检查北京地域的普通 API Key 或重新进行控制台授权。'
      : '阿里云暂时无法完成请求（HTTP ' + response.status + '），请稍后重试。')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('阿里云返回空响应。')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 2_000_000) throw new Error('阿里云返回内容过大，请缩小导入范围。')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error(signal?.aborted ? '已取消阿里云导入。' : '阿里云响应不完整或格式不受支持，请重试。')
  } finally { await reader.cancel().catch(() => {}) }
}

export async function queryAliyunQuota(token: string, models: string[], signal?: AbortSignal): Promise<{ quotas: any[]; statuses: any[] }> {
  const query = async (api: string, requestName: string, field: string, batch: string[]) => {
    const params = JSON.stringify({ Api: api, V: '1.0', Data: {
      [requestName]: { models: batch },
      cornerstoneParam: { protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm', switchUserType: 3, consoleSite: 'BAILIAN_ALIYUN' },
    } })
    const json = await aliyunJson('https://bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=' + encodeURIComponent(api), {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ params, region: 'cn-beijing' }).toString(),
    }, signal)
    const layers = [json, json?.data, json?.data?.DataV2, json?.data?.DataV2?.data]
    if (layers.some(layer => layer?.success === false || layer?.Success === false || layer?.errorCode))
      throw new Error('额度查询被拒绝或登录已过期，请重新授权。')
    const data = json?.data?.DataV2?.data?.data ?? json?.data?.data
    if (!Array.isArray(data?.[field])) throw new Error('阿里云额度接口格式已变化，暂时无法确认免费额度。')
    return data[field]
  }
  const quotas: any[] = [], statuses: any[] = []
  // The console status endpoint has a batch limit. Query only discovered chat models.
  for (let offset = 0; offset < models.length; offset += 20) {
    signal?.throwIfAborted()
    const batch = models.slice(offset, offset + 20)
    quotas.push(...await query(quotaApi, 'queryFreeTierQuotaRequest', 'freeTierQuotas', batch))
    statuses.push(...await query(autoStopApi, 'queryFreeTierOnlyStatusRequest', 'freeTierOnlyStatuses', batch))
  }
  return { quotas, statuses }
}

async function readCallback(req: IncomingMessage, url: URL): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> = Object.fromEntries(url.searchParams)
  if (req.method === 'GET') return result
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('授权响应过大。')
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8'), type = req.headers['content-type'] || ''
  let body: any = {}
  if (type.includes('application/json')) body = JSON.parse(raw)
  else if (type.includes('multipart/form-data')) {
    body = Object.fromEntries(await new Request(origin, { method: 'POST', headers: { 'content-type': type }, body: raw }).formData())
  } else if (raw.trim().startsWith('{')) body = JSON.parse(raw)
  else if (raw.includes('=')) body = Object.fromEntries(new URLSearchParams(raw))
  else body = { access_token: raw.trim() }
  if (body && typeof body === 'object') {
    if (typeof body.data === 'string') { try { body.data = JSON.parse(body.data) } catch {} }
    result = { ...body.data, ...body, ...result }
  }
  return result
}

export async function authorizeAliyunConsole(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const state = randomBytes(32).toString('hex')
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (error?: Error, token?: string) => {
      if (finished) return
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel)
      server.close(); server.closeAllConnections()
      error ? reject(error) : resolve(token!)
    }
    const cancel = () => finish(new Error('已取消百炼登录授权。'))
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      const requestOrigin = req.headers.origin
      if (requestOrigin && requestOrigin !== origin) { res.writeHead(403); res.end(); return }
      if (requestOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      try {
        if (!['GET', 'POST', 'PUT', 'PATCH'].includes(req.method || '')) { res.writeHead(405); res.end(); return }
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.searchParams.get('state') !== state) { res.writeHead(400); res.end('Invalid state'); return }
        const data = await readCallback(req, url)
        const token = data.access_token ?? data.accessToken
        const region = data.console_region ?? data.consoleRegion, site = data.console_site ?? data.consoleSite
        if ((region && region !== 'cn-beijing') || (site && site !== 'domestic') || data.console_switch_agent || data.consoleSwitchAgent) {
          res.writeHead(400); res.end('Use a direct Beijing China account'); finish(new Error('请使用中国站北京地域的直接账户授权。')); return
        }
        if (typeof token !== 'string' || !token.trim() || token.length > 16000) { res.writeHead(400); res.end('Missing access token'); return }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('授权完成，请返回 Coprojer。')
        // Console credentials live only in this import session, never in renderer state or on disk.
        res.once('finish', () => finish(undefined, token.trim()))
      } catch { res.writeHead(400); res.end('Invalid authorization response') }
    })
    const timer = setTimeout(() => finish(new Error('百炼授权已超时，请重新点击登录。')), 180000)
    signal.addEventListener('abort', cancel, { once: true })
    server.on('error', () => finish(new Error('无法启动本机授权回调，请稍后重试。')))
    server.listen(0, '127.0.0.1', () => {
      if (finished || signal.aborted) { cancel(); server.close(); return }
      const address = server.address()
      if (!address || typeof address === 'string') { finish(new Error('无法启动本机授权回调。')); return }
      // Deliberately omit needapikey: importing a pasted key must not create cloud keys.
      void shell.openExternal(origin + '/console-login?notice=127.0.0.1:' + address.port + '?state=' + state)
        .catch(() => finish(new Error('无法打开百炼登录页，请检查默认浏览器。')))
    })
  })
}
