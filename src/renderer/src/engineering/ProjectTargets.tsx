import { useState } from 'react'
import { FolderTree, Maximize2, Plus } from 'lucide-react'
import { Overlay } from '../components/ui'
import { targetKinds, type Project, type ProjectTarget } from '../../../shared/engineering'

export default function ProjectTargets({
  project,
  onFeature,
}: {
  project: Project
  onFeature?(id: string): void
}) {
  const [draft, setDraft] = useState<ProjectTarget>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const targets = project.targets || []
  const openWindow = (id: string, panel: 'map' | 'prototype') =>
    void window.desktop.openResearchPanel(project.id, panel, id).catch((e) => setError(String(e)))
  const unassigned = project.features.filter((f) => !f.targetId)
  return (
    <div className="project-targets">
      <header>
        <div>
          <strong>{targets.length} 个子项目</strong>
          <span>明确端边界、功能归属与接口约定</span>
        </div>
        <button
          className="ui-button secondary"
          disabled={!!project.activity}
          onClick={() => {
            const id = 'app-' + crypto.randomUUID().slice(0, 6)
            setDraft({
              id,
              name: '',
              kind: 'web',
              directory: 'apps/' + id,
              responsibility: '',
              contracts: '',
            })
          }}
        >
          <Plus size={13} />
          新增子项目
        </button>
      </header>
      {error && (
        <p role="alert" className="message-error">
          {error}
        </p>
      )}
      {!targets.length && (
        <div className="target-empty">
          <FolderTree size={28} />
          <h3>先明确这个产品由哪些项目组成</h3>
          <p>讨论前端、后台、移动端或设备的职责，AI 会随方案整理子项目；也可以手动建立。</p>
        </div>
      )}
      <div className="target-grid">
        {targets.map((target) => {
          const features = project.features.filter((f) => f.targetId === target.id)
          return (
            <article className="target-card" key={target.id}>
              <header>
                <div>
                  <small>{targetKinds[target.kind]}</small>
                  <h3>{target.name}</h3>
                </div>
                <button
                  className="design-process-link"
                  disabled={!!project.activity}
                  onClick={() => setDraft({ ...target })}
                >
                  编辑
                </button>
              </header>
              <p>{target.responsibility}</p>
              <code>{target.directory}</code>
              <div className="target-feature-list">
                <strong>{features.length} 项功能</strong>
                {features.map((f) => (
                  <button key={f.id} onClick={() => onFeature?.(f.id)} disabled={!onFeature}>
                    {f.module} / {f.title}
                  </button>
                ))}
              </div>
              {target.contracts && (
                <details>
                  <summary>接口与共享数据约定</summary>
                  <p>{target.contracts}</p>
                </details>
              )}
              <footer>
                <button
                  className="ui-button secondary"
                  onClick={() => openWindow(target.id, 'map')}
                >
                  <Maximize2 size={12} />
                  功能窗口
                </button>
                <button
                  className="ui-button secondary"
                  onClick={() => openWindow(target.id, 'prototype')}
                >
                  原型窗口
                </button>
              </footer>
            </article>
          )
        })}
      </div>
      {unassigned.length > 0 && (
        <section className="target-unassigned">
          <strong>{unassigned.length} 项功能尚未分配子项目</strong>
          {unassigned.map((f) => (
            <button key={f.id} className="design-process-link" onClick={() => onFeature?.(f.id)}>
              {f.title}
            </button>
          ))}
        </section>
      )}
      {draft && (
        <Overlay open title="子项目边界" onClose={() => setDraft(undefined)}>
          <form
            className="target-form"
            onSubmit={(e) => {
              e.preventDefault()
              setPending(true)
              void window.desktop.engineering
                .saveTargets(project.id, [draft])
                .then(() => setDraft(undefined))
                .catch((e) => setError(String(e)))
                .finally(() => setPending(false))
            }}
          >
            {error && (
              <p role="alert" className="message-error">
                {error}
              </p>
            )}
            <label>
              项目名称
              <input
                required
                aria-label="子项目名称"
                value={draft.name}
                maxLength={80}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              端类型
              <select
                aria-label="子项目端类型"
                value={draft.kind}
                onChange={(e) =>
                  setDraft({ ...draft, kind: e.target.value as ProjectTarget['kind'] })
                }
              >
                {Object.entries(targetKinds).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              项目标识
              <input
                required
                aria-label="子项目标识"
                disabled={targets.some((t) => t.id === draft.id)}
                value={draft.id}
                pattern="[a-z][a-z0-9-]*"
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              />
            </label>
            <label>
              规划目录
              <input
                required
                aria-label="子项目目录"
                value={draft.directory}
                onChange={(e) => setDraft({ ...draft, directory: e.target.value })}
              />
            </label>
            <label>
              职责与边界
              <textarea
                required
                aria-label="子项目职责"
                rows={3}
                value={draft.responsibility}
                onChange={(e) => setDraft({ ...draft, responsibility: e.target.value })}
              />
            </label>
            <label>
              接口与共享数据约定
              <textarea
                aria-label="子项目接口"
                rows={3}
                value={draft.contracts}
                onChange={(e) => setDraft({ ...draft, contracts: e.target.value })}
              />
            </label>
            <small>需求期记录目录规划，确认开发前不会创建子项目代码。</small>
            <footer>
              <button
                type="button"
                className="ui-button secondary"
                onClick={() => setDraft(undefined)}
              >
                取消
              </button>
              <button className="ui-button primary" disabled={pending}>
                保存子项目
              </button>
            </footer>
          </form>
        </Overlay>
      )}
    </div>
  )
}
