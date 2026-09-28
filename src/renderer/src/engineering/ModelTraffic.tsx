import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ModelConfig } from '../../../shared/engineering'
import type { ModelTrafficSnapshot, TrafficRequest, TrafficWindow } from '../../../shared/model-traffic'
import './model-traffic.css'

const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN')
const duration = (value: number | null | undefined) => value == null ? '—' : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' s'
const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const statuses: Record<TrafficRequest['status'], string> = { running: '进行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '退出中断' }
const errors = { 'rate-limit': '限流', auth: '鉴权失败', server: '服务异常', network: '网络异常', timeout: '超时', response: '响应异常' }

export default function ModelTraffic({ models }: { models: ModelConfig[] }) {
  const [window, setWindow] = useState<TrafficWindow>('today')
  const [connectionId, setConnectionId] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [snapshot, setSnapshot] = useState<ModelTrafficSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const connections = models.map(m => [m.id, m.model, m.baseUrl].join(':')).join('|')
  const duplicates = new Set(models.filter(m => models.some(other => other.id !== m.id && other.model === m.model)).map(m => m.id))
  const connectionSuffix = (id: string) => duplicates.has(id) ? ' · 连接 ' + id.slice(0, 8) : ''
  useEffect(() => {
    if (connectionId && !models.some(m => m.id === connectionId)) setConnectionId('')
  }, [connections, connectionId])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true); setSnapshot(null); setError('')
    const load = async () => {
      try {
        const value = await globalThis.window.desktop.engineering.modelTraffic({ window, connectionId })
        if (!disposed) { setSnapshot(value); setError('') }
      } catch {
        if (!disposed) setError('无法刷新流量记录，请重试。')
      } finally {
        if (!disposed) { setLoading(false); timer = setTimeout(load, 5000) }
      }
    }
    void load()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [window, connectionId, connections, refresh])
  const totals = snapshot?.totals
  const settled = totals ? totals.succeeded + totals.failed : 0
  const failureRate = settled ? (totals!.failed / settled * 100).toFixed(1) + '%' : '—'
  const peak = Math.max(1, ...(snapshot?.buckets.map(b => b.requests) ?? []))
  return <section className="eng-traffic" aria-label="模型流量监控">
    <div className="eng-traffic-toolbar">
      <label className="eng-field">统计时间<select aria-label="统计时间" value={window} onChange={e => setWindow(e.target.value as TrafficWindow)}>
        <option value="today">今天</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option>
      </select></label>
      <label className="eng-field eng-traffic-filter">模型连接<select aria-label="模型连接" value={connectionId} onChange={e => setConnectionId(e.target.value)}>
        <option value="">全部已接入模型</option>
        {models.map(m => <option key={m.id} value={m.id}>{m.model}{connectionSuffix(m.id)} · {m.baseUrl}</option>)}
      </select></label>
      <button className="ui-button secondary" disabled={loading} onClick={() => setRefresh(v => v + 1)}><RefreshCw size={13} />刷新</button>
    </div>
    <p className="eng-traffic-caption">已自动开启 · 每 5 秒刷新 · 仅统计本机 Coprojer 的模型调用，包含连接测试。</p>
    {error && <p role="alert" className="eng-traffic-warning">{error}{snapshot ? ' 当前保留上次成功刷新的数据。' : ''}</p>}
    {snapshot?.storageError && <p role="alert" className="eng-traffic-warning">{snapshot.storageError}</p>}
    {loading && <p role="status" className="eng-hint">正在读取流量记录…</p>}
    {snapshot && totals && <>
      <dl className="eng-traffic-metrics">
        <div><dt>请求数</dt><dd data-testid="traffic-requests">{number(totals.requests)}</dd><small>当前 {totals.running} 进行中 · 近一分钟 {totals.rpm} 次</small></div>
        <div><dt>已报告 Token</dt><dd data-testid="traffic-tokens">{number(totals.totalTokens)}</dd><small>{totals.usageReported} / {totals.requests} 次返回 Token 用量</small></div>
        <div><dt>失败率</dt><dd>{failureRate}</dd><small>{totals.failed} 失败 · {totals.cancelled} 取消 · {totals.interrupted} 中断</small></div>
        <div><dt>平均耗时</dt><dd>{duration(totals.averageDurationMs)}</dd><small>仅已成功完成的 {totals.succeeded} 次请求</small></div>
      </dl>
      {snapshot.truncatedBefore && Date.parse(snapshot.truncatedBefore) >= Date.parse(snapshot.from) && <p className="eng-traffic-warning">记录已达到 {number(snapshot.recordLimit)} 条上限；{dateTime(snapshot.truncatedBefore)} 及此前的部分记录已清理，汇总可能不覆盖整个所选时间段。</p>}
      <div className="eng-traffic-block">
        <div className="eng-traffic-heading"><h3>请求趋势</h3><span>{window === 'today' || window === '24h' ? '按小时' : '按天'} · 深色为请求，红色为失败</span></div>
        {!totals.requests ? <p className="eng-traffic-empty">该时间段暂无调用。通过已保存的模型发起对话、执行任务或测试连接后，会自动产生记录。</p> : <>
          <ol className="eng-traffic-chart" aria-label="各时段请求与失败数">{snapshot.buckets.map(b => {
            const label = dateTime(b.start) + ' 起：' + b.requests + ' 次请求，' + b.failed + ' 次失败'
            return <li key={b.start} title={label} aria-label={label}><span aria-hidden="true" className="eng-traffic-bar" style={{ height: b.requests / peak * 100 + '%' }} /><span aria-hidden="true" className="eng-traffic-bar failed" style={{ height: b.failed / peak * 100 + '%' }} /></li>
          })}</ol>
          <div className="eng-traffic-axis"><span>{dateTime(snapshot.from)}</span><span>{dateTime(window === 'today' ? new Date(Date.parse(snapshot.from) + 86_400_000).toISOString() : snapshot.capturedAt)}</span></div>
        </>}
      </div>
      <div className="eng-traffic-block">
        <div className="eng-traffic-heading"><h3>按模型统计</h3><span>{snapshot.models.length} 个已接入连接</span></div>
        <div className="eng-traffic-table-scroll" tabIndex={0} aria-label="各模型流量统计表，可横向滚动">
          <table className="eng-traffic-table"><thead><tr><th>模型 / 服务地址</th><th>请求</th><th>失败</th><th>输入 Token</th><th>输出 Token</th><th>用量返回</th><th>平均耗时</th></tr></thead>
            <tbody>{snapshot.models.map(m => <tr key={m.id}><th scope="row" className="eng-traffic-model"><button onClick={() => setConnectionId(m.id)} title={'仅查看 ' + m.model + connectionSuffix(m.id)}>{m.model}{connectionSuffix(m.id)}</button><small>{m.baseUrl}</small></th><td>{number(m.totals.requests)}</td><td>{number(m.totals.failed)}</td><td>{number(m.totals.inputTokens)}</td><td>{number(m.totals.outputTokens)}</td><td>{m.totals.usageReported}/{m.totals.requests}</td><td>{duration(m.totals.averageDurationMs)}</td></tr>)}</tbody>
          </table>
        </div>
        {!snapshot.models.length && <p className="eng-traffic-empty">尚未接入模型，请先在「连接配置」中添加。</p>}
      </div>
      <div className="eng-traffic-block">
        <div className="eng-traffic-heading"><h3>最近调用</h3><span>最多显示最近 50 条</span></div>
        <div className="eng-traffic-table-scroll" tabIndex={0} aria-label="最近模型调用表，可横向滚动">
          <table className="eng-traffic-table"><thead><tr><th>开始时间</th><th>模型</th><th>用途</th><th>结果</th><th>输入 / 输出 Token</th><th>耗时</th></tr></thead>
            <tbody>{snapshot.recent.map(r => <tr key={r.id}><td>{dateTime(r.startedAt)}</td><th scope="row" className="eng-traffic-model">{r.model}{connectionSuffix(r.connectionId)}</th><td>{r.purpose === 'test' ? '连接测试' : '模型调用'}</td><td><span className={'eng-traffic-status ' + r.status}>{statuses[r.status]}</span>{r.errorKind && <small>{errors[r.errorKind]}{r.httpStatus ? ' · HTTP ' + r.httpStatus : ''}</small>}</td><td>{number(r.inputTokens)} / {number(r.outputTokens)}{(r.cachedInputTokens !== undefined || r.reasoningTokens !== undefined) && <small>其中缓存 {number(r.cachedInputTokens)} · 推理 {number(r.reasoningTokens)}</small>}</td><td>{duration(r.durationMs)}</td></tr>)}</tbody>
          </table>
        </div>
        {!snapshot.recent.length && <p className="eng-traffic-empty">暂无请求记录。</p>}
      </div>
      <footer className="eng-traffic-caption">
        <p>从 {dateTime(snapshot.enabledAt)} 开始记录；保留最近 {snapshot.retentionDays} 天、最多 {number(snapshot.recordLimit)} 条已结束请求。更新于 {dateTime(snapshot.capturedAt)}。</p>
        <p>“—”表示服务未返回该项用量；统计不补算缺失 Token。缓存与推理是用量明细，不重复累加。失败率不含进行中、取消和退出中断。供应商历史账单与其他客户端调用不在统计范围内。</p>
      </footer>
    </>}
  </section>
}
