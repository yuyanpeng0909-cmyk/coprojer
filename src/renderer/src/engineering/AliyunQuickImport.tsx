import { useEffect, useRef, useState } from 'react'
import { Cloud, ExternalLink, LoaderCircle } from 'lucide-react'
import { Overlay } from '../components/ui'
import { agentRoleLabels, type EngineeringState } from '../../../shared/engineering'
import { chooseAliyunModel, hasUsableFreeQuota, type AliyunImportPreview, type AliyunModelCandidate, type aliyunPages } from '../../../shared/aliyun'

const roles = ['assistant', 'planner', 'designer', 'developer', 'reviewer'] as const
function recommended(preview: AliyunImportPreview, freeOnly: boolean) {
  const models = preview.models.filter(m => !freeOnly || hasUsableFreeQuota(m)).map(m => m.model)
  return [...new Set(roles.map(role => chooseAliyunModel(models, role)).filter(Boolean))]
}
function quotaLabel(model: AliyunModelCandidate, checked: boolean) {
  if (!checked) return '额度未核实'
  if (model.remaining === undefined) return '未返回额度'
  if (model.expiresAt !== undefined && model.expiresAt <= Date.now()) return '已过期'
  if (model.remaining <= 0) return '额度已用尽'
  return model.remaining.toLocaleString('zh-CN') + ' Token · ' + (model.expiresAt ? new Date(model.expiresAt).toLocaleDateString('zh-CN') + ' 到期' : '有效期未确认')
}

export default function AliyunQuickImport({ state, refresh, onClose, onImported }: { state: EngineeringState; refresh: () => Promise<void>; onClose: () => void; onImported: (message: string) => void }) {
  const [key, setKey] = useState(''), [preview, setPreview] = useState<AliyunImportPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([]), [query, setQuery] = useState('')
  const [freeOnly, setFreeOnly] = useState(true), [sameAccount, setSameAccount] = useState(false), [configure, setConfigure] = useState(true)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const alive = useRef(true), previewId = useRef('')
  useEffect(() => { alive.current = true; return () => {
    alive.current = false
    if (previewId.current) void window.desktop.engineering.discardAliyunImport(previewId.current).catch(() => {})
  } }, [])
  const fail = (e: unknown) => { if (alive.current) setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')) }
  const changeKey = (value: string) => {
    setKey(value); setError(''); setSameAccount(false); setSelected([]); setPreview(null)
    if (previewId.current) void window.desktop.engineering.discardAliyunImport(previewId.current).catch(() => {})
    previewId.current = ''
  }
  const open = (page: keyof typeof aliyunPages) => { void window.desktop.engineering.openAliyunPage(page).catch(fail) }
  const scan = async () => {
    setBusy('scan'); setError('')
    try {
      if (previewId.current) await window.desktop.engineering.discardAliyunImport(previewId.current)
      previewId.current = ''; setPreview(null); setSelected([]); setSameAccount(false)
      const result = await window.desktop.engineering.scanAliyunModels(key)
      if (!alive.current) { await window.desktop.engineering.discardAliyunImport(result.id); return }
      previewId.current = result.id; setPreview(result); setKey(''); setSelected(recommended(result, freeOnly))
    } catch (e) { fail(e) } finally { if (alive.current) setBusy('') }
  }
  const sync = async () => {
    if (!preview) return
    setBusy('quota'); setError(''); setSameAccount(false)
    try {
      const result = await window.desktop.engineering.syncAliyunQuota(preview.id)
      if (!alive.current) return
      setPreview(result); setSelected(recommended(result, freeOnly))
    } catch (e) { fail(e); setSelected([]) } finally { if (alive.current) setBusy('') }
  }
  const save = async () => {
    if (!preview) return
    setBusy('save'); setError('')
    try {
      const result = await window.desktop.engineering.importAliyunModels({ previewId: preview.id, models: selected, freeOnly, sameAccountConfirmed: sameAccount, configureUnbound: configure })
      previewId.current = ''
      await refresh()
      onImported('已导入 ' + result.imported + ' 个型号，复用 ' + result.reused + ' 个已有连接；装配 ' + result.configuredAgents + ' 个未配置智能体。' + (result.defaultModel ? ' 默认通用助手：' + result.defaultModel + '。' : ''))
      onClose()
    } catch (e) { fail(e) } finally { if (alive.current) setBusy('') }
  }
  const candidates = preview?.models.filter(m => m.model.toLowerCase().includes(query.toLowerCase())) || []
  const validSelection = selected.length > 0 && selected.length <= 100 && selected.every(id => preview?.models.some(m => m.model === id && (!freeOnly || hasUsableFreeQuota(m))))
  const assignments = state.agents.filter(a => !a.ownerProjectId && !a.modelId)
  return <Overlay open title="阿里云快速导入" description="粘贴北京地域的百炼 Key，识别型号并装配工程成员。" onClose={() => { if (busy !== 'save') onClose() }} footer={<>
    <button className="ui-button secondary" disabled={busy === 'save'} onClick={onClose}>取消</button>
    <button className="ui-button primary" disabled={!!busy || !validSelection || (freeOnly && (!preview?.quotaCheckedAt || !sameAccount))} onClick={() => void save()}>{busy === 'save' && <LoaderCircle size={13} />}一键导入并装配</button>
  </>}>
    <div className="eng-form eng-aliyun-import">
      <div className="eng-aliyun-links"><button className="ui-button secondary" onClick={() => open('quota')}><ExternalLink size={13} />注册 / 查看免费额度</button><button className="ui-button secondary" onClick={() => open('key')}>获取 API Key</button><button className="ui-button ghost" onClick={() => open('guide')}>免费额度规则</button></div>
      <p className="eng-hint">先在百炼开通北京地域服务并创建普通 API Key。额度发放、到期时间与适用模型以账号实际记录为准。</p>
      <label className="eng-field"><span>百炼 API Key</span><div className="eng-input-action"><input type="password" autoComplete="off" spellCheck={false} value={key} disabled={!!busy} placeholder={preview ? '已识别；粘贴其他 Key 可重新识别' : '粘贴 sk- 开头的普通 API Key'} onChange={e => changeKey(e.target.value)} /><button className="ui-button secondary" disabled={!!busy || !key.trim()} onClick={() => void scan()}>{busy === 'scan' && <LoaderCircle size={13} />}识别模型</button></div><small>Key 只发送给阿里云官方接口，确认导入后按现有方式加密保存。识别与额度查询不发送推理请求。</small></label>
      {error && <p className="eng-inline-error" role="alert">{error}</p>}
      {preview && <>
        <div className="eng-aliyun-quota"><h3>免费额度</h3><p className="eng-hint">Key 本身不能查询账户剩余额度。登录百炼授权后，可读取余额、有效期与用完即停状态。</p><div className="eng-aliyun-links"><button className="ui-button secondary" disabled={!!busy} onClick={() => void sync()}>{busy === 'quota' && <LoaderCircle size={13} />}{preview.quotaCheckedAt ? '刷新免费额度' : '登录并扫描免费额度'}</button><button className="ui-button ghost" onClick={() => open('quota')}>去控制台开启用完即停</button></div>
          {busy === 'quota' && <p role="status" className="eng-hint">正在等待浏览器授权或读取额度；完成后返回此窗口。关闭面板可取消。</p>}
          {preview.quotaCheckedAt && <p className="eng-hint">上次扫描：{new Date(preview.quotaCheckedAt).toLocaleString('zh-CN')}。导入前会再次核实。</p>}
          <label className="eng-aliyun-check"><input type="checkbox" checked={freeOnly} disabled={!!busy} onChange={e => { setFreeOnly(e.target.checked); setSelected(recommended(preview, e.target.checked)) }} />仅选择有免费额度且已开启“用完即停”的型号</label>
          {!freeOnly && <p className="eng-hint">当前为普通导入：不保证后续调用免费，费用遵循阿里云账户设置。</p>}
          {freeOnly && preview.quotaCheckedAt && <label className="eng-aliyun-check"><input type="checkbox" checked={sameAccount} disabled={!!busy} onChange={e => setSameAccount(e.target.checked)} />我确认刚登录的账户与此 Key 属于同一阿里云账号</label>}
        </div>
        <div className="eng-aliyun-model-heading"><h3>对话候选 · {preview.models.length} 个</h3><button className="ui-button ghost" disabled={!!busy} onClick={() => setSelected(recommended(preview, freeOnly))}>选择建议型号</button></div>
        <p className="eng-hint">已按型号排除 {preview.excludedCount} 项非对话候选。工具调用能力仍需任务验证。</p>
        <label className="eng-field"><span>搜索型号</span><input value={query} placeholder="输入模型 ID" onChange={e => setQuery(e.target.value)} /></label>
        <div className="eng-aliyun-model-list" aria-label="阿里云模型候选">{candidates.map(m => {
          const eligible = !freeOnly || hasUsableFreeQuota(m)
          return <label className="eng-aliyun-model-row" key={m.model}><input type="checkbox" aria-label={'导入 ' + m.model} checked={selected.includes(m.model)} disabled={!!busy || !eligible || (!selected.includes(m.model) && selected.length >= 100)} onChange={e => setSelected(ids => e.target.checked ? [...ids, m.model] : ids.filter(id => id !== m.model))} /><span><strong>{m.model}</strong><small>{quotaLabel(m, !!preview.quotaCheckedAt)}</small>{preview.quotaCheckedAt && <small>用完即停：{m.autoStop === true ? '已开启' : m.autoStop === false ? '未开启' : '状态未确认'}</small>}</span></label>
        })}{!candidates.length && <p className="eng-hint">没有匹配的型号。</p>}</div>
        {freeOnly && !preview.models.some(m => hasUsableFreeQuota(m)) && <p className="eng-hint">暂无已确认可安全使用免费额度的型号。请登录扫描，或到控制台开启用完即停后刷新。</p>}
        <label className="eng-aliyun-check"><input type="checkbox" checked={configure} disabled={!!busy} onChange={e => setConfigure(e.target.checked)} />同时补齐未配置的智能体与默认通用助手</label>
        <section className="eng-aliyun-assignment" aria-label="阿里云装配预览"><h3>装配预览 · 已选 {selected.length} 个型号</h3>
          {configure && selected.length > 0 && <>{!state.defaultAssistantModelId && <p>默认通用助手：{chooseAliyunModel(selected, 'assistant')}</p>}{assignments.map(a => <p key={a.id}>{a.name}（{agentRoleLabels[a.role]}）：{chooseAliyunModel(selected, a.role)}</p>)}</>}
          <p className="eng-hint">按职责和型号关键词做初始搭配，尚未进行模型质量评测。保留已有默认值、绑定及所有实例的专属 Skill。</p>
        </section>
      </>}
    </div>
  </Overlay>
}

export function AliyunImportButton({ onClick }: { onClick: () => void }) {
  return <button className="ui-button secondary" onClick={onClick}><Cloud size={14} />阿里云快速导入</button>
}
