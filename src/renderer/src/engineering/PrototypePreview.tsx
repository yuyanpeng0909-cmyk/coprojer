import { useEffect, useMemo, useState } from 'react'
import { Download, Monitor, Smartphone, RefreshCw } from 'lucide-react'
import type { Project } from '../../../shared/engineering'
import DesignProcess from './DesignProcess'
import { extractPrototypeHtml } from '../../../shared/prototype'

function isolatedDocument(html: string): string {
  const doc = new DOMParser().parseFromString(extractPrototypeHtml(html), 'text/html')
  doc
    .querySelectorAll('meta[http-equiv],base,iframe,frame,object,embed,link')
    .forEach((n) => n.remove())
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
  doc.head.prepend(policy)
  return '<!doctype html>' + doc.documentElement.outerHTML
}
export default function PrototypePreview({ project }: { project: Project }) {
  const [revisionId, setRevisionId] = useState(''),
    [mobile, setMobile] = useState(false),
    [reload, setReload] = useState(0),
    [error, setError] = useState('')
  const revision =
    project.prototypes?.find((p) => p.id === revisionId) ?? project.prototypes?.at(-1)
  useEffect(() => { setError('') }, [revision?.id, project.prd?.status])
  const prepared = useMemo(() => {
    try {
      return { document: revision ? isolatedDocument(revision.html) : '', error: '' }
    } catch (error) {
      return { document: '', error: String(error) }
    }
  }, [revision?.html])
  const document = prepared.document
  return (
    <div className="research-prototype">
      <div className="canvas-toolbar">
        <select
          aria-label="原型版本"
          value={revisionId}
          onChange={(e) => setRevisionId(e.target.value)}
        >
          <option value="">最新版本{project.designActivity ? ' · 设计中' : ''}</option>
          {project.prototypes?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} ·{' '}
              {new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </option>
          ))}
        </select>
        <div>
          {revision && <button className="ui-button secondary small" disabled={!!project.activity || !!project.designActivity || project.prototypeBriefs?.[revision.targetId || '']?.status === 'accepted' && project.selectedPrototypeIds?.[revision.targetId || ''] === revision.id} onClick={() => { setError(''); void window.desktop.engineering.acceptPrototypeAndPreparePrd(project.id, revision.id).catch(e => setError(String(e))) }}>
            {project.prototypeBriefs?.[revision.targetId || '']?.status === 'accepted' && project.selectedPrototypeIds?.[revision.targetId || ''] === revision.id ? '已验收 · 开发依据' : '验收此原型'}
          </button>}
          <button
            className={`eng-icon ${!mobile ? 'selected' : ''}`}
            aria-label="桌面原型"
            onClick={() => setMobile(false)}
          >
            <Monitor size={14} />
          </button>
          <button
            className={`eng-icon ${mobile ? 'selected' : ''}`}
            aria-label="手机原型"
            onClick={() => setMobile(true)}
          >
            <Smartphone size={14} />
          </button>
          <button
            className="eng-icon"
            aria-label="重新加载原型"
            disabled={!document}
            onClick={() => setReload(reload + 1)}
          >
            <RefreshCw size={13} />
          </button>
          <button
            className="eng-icon"
            aria-label="导出原型"
            disabled={!document}
            onClick={() => {
              if (revision)
                void window.desktop
                  .saveArtifact(
                    `${project.name.slice(0, 80)}-${revision.title}.html`,
                    'data:text/html,' + encodeURIComponent(document),
                  )
                  .catch((e) => setError(String(e)))
            }}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
      <DesignProcess project={project} />
      <div className={`prototype-viewport ${mobile ? 'mobile' : ''}`}>
        {prepared.error ? (
          <div className="prototype-empty" role="alert">
            <h3>这个版本暂时无法预览</h3>
            <p>{prepared.error}</p>
          </div>
        ) : revision ? (
          <iframe
            key={`${revision.id}-${reload}`}
            title="原型实时预览"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={document}
          />
        ) : (
          <div className="prototype-empty">
            <div className="prototype-placeholder" aria-hidden="true">
              <div className="placeholder-toolbar">
                <i />
                <i />
                <i />
              </div>
              <div className="placeholder-layout">
                <div className="placeholder-sidebar">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="placeholder-content">
                  <i />
                  <div>
                    <i />
                    <i />
                  </div>
                  <i />
                  <i />
                </div>
              </div>
            </div>
            <h3>{project.designActivity ? '原型正在生成' : '这里将展示你的原型'}</h3>
            <p>
              {project.designActivity
                ? '完成后自动呈现，你可以继续讨论需求。'
                : '描述项目目标后，系统会征集设计意见并生成原型；原型验收后自动整理 PRD。'}
            </p>
          </div>
        )}
      </div>
      <div className="canvas-footer">
        <span>
          {error ||
            (project.designActivity
              ? '正在设计，完成后自动更新预览'
              : revision
                ? `${revision.title} · 交互数据仅保留在当前预览`
                : '尚无原型')}
        </span>
      </div>
    </div>
  )
}
