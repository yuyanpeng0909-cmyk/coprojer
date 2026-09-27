import { useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, LoaderCircle, Search, Trash2 } from 'lucide-react'
import { agentRoleLabels, toolLabels, type AgentConfig, type EngineeringState, type SkillDefinition, type SkillImportPreview } from '../../../shared/engineering'
import { AssistantModelSelect, hasAssistantModel, ModelUsage } from './AssistantModels'

const api = () => window.desktop.engineering
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')
export default function AgentSkills({ agent, skills, state, refresh }: { agent: AgentConfig; skills: SkillDefinition[]; state: EngineeringState; refresh: () => Promise<void> }) {
  const saved = state.skillSearches?.[agent.id], searching = state.skillSearchActivity?.[agent.id]
  const [localBusy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const busy = localBusy || (searching ? '联网搜索并评估适配性' : '')
  const [query, setQuery] = useState(searching?.query || saved?.query || ''), [url, setUrl] = useState('')
  const [override, setOverride] = useState('')
  const results = saved?.recommendations
  useEffect(() => { if (saved) setQuery(saved.query) }, [saved?.at])
  const [preview, setPreview] = useState<SkillImportPreview | null>(null)
  const [pendingToggle, setPendingToggle] = useState<{ id: string; enabled: boolean } | null>(null)
  const previewElement = useRef<HTMLElement | null>(null)
  const resultsElement = useRef<HTMLElement | null>(null)
  const previewId = useRef<string | null>(null), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (previewId.current) void api().discardSkillPreview(agent.id, previewId.current).catch(() => {}) } }, [agent.id])
  useEffect(() => { if (preview) previewElement.current?.scrollIntoView({ block: 'nearest' }) }, [preview])
  useEffect(() => { if (saved && !searching) resultsElement.current?.scrollIntoView({ block: 'nearest' }) }, [saved?.at, !!searching])
  const owned = skills.filter(s => s.ownerAgentId === agent.id)
  const work = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError(''); setNotice('')
    try { await action(); if (mounted.current) await refresh() }
    catch (e) { if (mounted.current) setError(message(e)) }
    finally { if (mounted.current) setBusy('') }
  }
  const inspect = async (kind: 'local' | 'github', location: string) => {
    const next = await api().previewSkill(agent.id, { kind, location })
    if (!mounted.current) { await api().discardSkillPreview(agent.id, next.id); return }
    previewId.current = next.id; setPreview(next)
  }
  const missing = preview?.skill.requiredTools.filter(t => !agent.tools.includes(t)) || []
  return <div className="eng-form eng-agent-skills">
    <p className="eng-hint">所属智能体：<strong>{agent.name}</strong> · {agentRoleLabels[agent.role]}。只有这个实例可以使用以下技能，已启用的技能按任务需要加载。</p>
    <section aria-label="已安装的专属技能">
      <h3>专属技能 <span className="eng-tag">{owned.length}</span></h3>
      {owned.length === 0 && <p className="eng-hint">还没有安装技能。可以导入本地目录，或让当前智能体联网推荐。</p>}
      {owned.map(skill => {
        const missingTools = skill.requiredTools.filter(t => !agent.tools.includes(t)), enabled = pendingToggle?.id === skill.id ? pendingToggle.enabled : agent.skillIds?.includes(skill.id) || false
        return <div className="eng-owned-skill" key={skill.id}>
          <label><input type="checkbox" checked={enabled} disabled={!!busy || !!missingTools.length} onChange={e => {
            const checked = e.target.checked
            setPendingToggle({ id: skill.id, enabled: checked })
            void work('保存启用状态', async () => {
              await api().saveAgent({ ...agent, skillIds: checked ? [...(agent.skillIds || []), skill.id] : agent.skillIds?.filter(id => id !== skill.id) })
            }).finally(() => setPendingToggle(null))
          }} /><span><strong>{skill.name}</strong><small>{skill.description}</small><small>{skill.version} · {skill.origin === 'builtin' ? '内置专属副本' : skill.origin === 'local' ? '本地导入' : 'GitHub 导入'} · {enabled ? '已启用' : '未启用'}</small>{missingTools.length > 0 && <small>需先在配置中启用：{missingTools.map(t => toolLabels[t]).join('、')}</small>}</span></label>
          {skill.origin !== 'builtin' && <button type="button" className="icon-button" aria-label={'移除 ' + skill.name} disabled={!!busy} onClick={() => void work('移除技能', async () => { await api().removeSkill(agent.id, skill.id); setNotice('已从此智能体移除。') })}><Trash2 size={14} /></button>}
        </div>
      })}
    </section>
    <section className="eng-skill-install" aria-label="导入技能">
      <h3>添加技能</h3>
      <button className="ui-button secondary" disabled={!!busy} onClick={() => void work('读取本地技能', async () => { const directory = await window.desktop.selectFolder(); if (directory) await inspect('local', directory) })}><FolderOpen size={14} />导入本地技能</button>
      <p className="eng-hint">选择包含 SKILL.md 的目录，支持配套 scripts、references、assets；兼容旧版 skill.json。先预览，确认后安装。</p>
      <label className="eng-field"><span>GitHub 技能目录</span><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/tree/main/skills/example" /></label>
      <button className="ui-button secondary" disabled={!!busy || !url.trim()} onClick={() => void work('下载技能预览', () => inspect('github', url.trim()))}><Download size={14} />预览在线技能</button>
    </section>
    <section className="eng-skill-install" aria-label="联网推荐技能">
      <h3>推荐专属技能</h3>
      <AssistantModelSelect state={state} value={override} onChange={setOverride} disabled={!!busy} />
      <label className="eng-field"><span>需要补充什么能力？</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="例如：React 性能优化、接口测试、交互原型" maxLength={200} /></label>
      <div className="eng-assistant-actions"><button className="ui-button secondary" disabled={!!busy || query.trim().length < 2 || !hasAssistantModel(state, override)} onClick={() => void work('联网搜索并评估适配性', async () => { const selected = override; setOverride(''); await api().recommendSkills(agent.id, query.trim(), selected) })}><Search size={14} />联网推荐</button>
        {saved && <button className="ui-button secondary" disabled={!!busy} onClick={() => void work('清空推荐记录', async () => { await api().clearSkillSearch(agent.id); setQuery('') })}>清空推荐记录</button>}</div>
      <p className="eng-hint">使用通用助手生成搜索词并评估公开候选，推荐技能仍只安装给当前实例。搜索访问 skills.sh 与 GitHub；推荐不会自动安装。</p>
      {!hasAssistantModel(state, override) && <p className="eng-hint">请设置默认通用助手模型或选择本次模型，也可直接导入本地技能。</p>}
      {searching && <ModelUsage usage={searching.usage} pending />}
      {saved && <section className="eng-saved-recommendations" aria-label="已保存的技能推荐" ref={resultsElement}><p className="eng-hint">已保存搜索：{saved.query} · {new Date(saved.at).toLocaleString()}。关闭面板或重启后可继续查看。</p><ModelUsage usage={saved.usage} />
      {results?.length === 0 && <p role="status" className="eng-hint">没有找到适合当前职责的技能，试试更具体的关键词或本地导入。</p>}
      {results?.map(result => <article className="eng-skill-result" key={result.url}><h4>{result.name}</h4><p>{result.description}</p><p>{result.reason}</p><a href={result.url} target="_blank" rel="noreferrer">查看 GitHub 来源</a><button className="ui-button secondary" disabled={!!busy} onClick={() => void work('下载推荐技能预览', () => inspect('github', result.url))}>预览安装</button></article>)}
      </section>}
    </section>
    {preview && <section ref={previewElement} className="eng-skill-preview" aria-label="安装预览">
      <h3>确认安装 · {preview.skill.name}</h3><p>{preview.skill.description}</p>
      <dl><dt>所属智能体</dt><dd>{agent.name}</dd><dt>文件</dt><dd>{preview.fileCount} 个 · {(preview.totalBytes / 1024).toFixed(1)} KB</dd><dt>版本</dt><dd>{preview.skill.version}</dd><dt>来源</dt><dd>{preview.skill.source?.location}</dd></dl>
      {preview.skill.compatibility && <p>运行要求：{preview.skill.compatibility}</p>}
      {preview.notices.map(note => <p className="eng-hint" key={note}>{note}</p>)}
      <details><summary>查看技能正文与文件清单</summary><pre>{preview.skill.content}</pre><ul>{preview.skill.resources?.map(r => <li key={r.path}>{r.path}</li>)}</ul></details>
      <div className="eng-skill-actions"><button className="ui-button secondary" disabled={!!busy} onClick={() => void work('取消安装', async () => { await api().discardSkillPreview(agent.id, preview.id); previewId.current = null; setPreview(null) })}>取消安装</button><button className="ui-button primary" disabled={!!busy || !!missing.length} onClick={() => void work('安装专属技能', async () => { await api().installSkill(agent.id, preview.id); previewId.current = null; setPreview(null); setNotice('已安装并启用，仅供「' + agent.name + '」使用。') })}>确认安装并启用</button></div>
    </section>}
    {busy && <p className="eng-inline-result" role="status"><LoaderCircle size={13} /> {busy}…</p>}
    {notice && <p className="eng-inline-result" role="status">{notice}</p>}
    {error && <p className="eng-inline-error" role="alert">{error}</p>}
  </div>
}
