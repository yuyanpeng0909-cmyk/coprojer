import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Code2, LoaderCircle, PencilRuler, Square } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatEntry, Project } from '../../../shared/engineering'
import { Overlay } from '../components/ui'

function designOutput(project: Project, entry: ChatEntry) {
  return (
    entry.designOutput ??
    (entry.status === 'complete'
      ? project.prototypes?.find((p) => p.sourceMessageId === entry.id)?.html || ''
      : entry.text)
  )
}

function useDesignStatus(entry: ChatEntry, output: string) {
  const active = entry.status === 'streaming'
  const [clock, setClock] = useState(Date.now())
  const observedUpdate = useRef(Date.now())
  useEffect(() => {
    observedUpdate.current = Date.now()
  }, [entry.text.length, entry.reasoning?.length, entry.status])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const elapsed = Math.max(
    0,
    Math.floor(
      ((active ? clock : Date.parse(entry.finishedAt || entry.updatedAt || entry.at)) -
        Date.parse(entry.at)) /
        1000,
    ),
  )
  const silent = Math.max(
    0,
    Math.floor(
      (clock - (entry.updatedAt ? Date.parse(entry.updatedAt) : observedUpdate.current)) / 1000,
    ),
  )
  const stage = active
    ? output
      ? '正在生成界面'
      : entry.reasoning
        ? '正在梳理设计'
        : '等待模型响应'
    : entry.status === 'error'
      ? '设计未完成'
      : entry.status === 'stopped'
        ? '设计已停止'
        : '原型已就绪'
  return {
    active,
    silent,
    stage,
    duration: elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`,
  }
}

function DesignDetails({ project, entry }: { project: Project; entry: ChatEntry }) {
  const output = designOutput(project, entry)
  const { active, stage, duration } = useDesignStatus(entry, output)
  const index = project.chat.findIndex((e) => e.id === entry.id)
  const instruction = project.chat
    .slice(0, index)
    .reverse()
    .find((e) => e.purpose === 'design' && e.role === 'user')?.text
  const [sourceOpen, setSourceOpen] = useState(false)
  const outputView = useRef<HTMLPreElement>(null)
  const followOutput = useRef(true)
  useLayoutEffect(() => {
    if (followOutput.current && outputView.current)
      outputView.current.scrollTop = outputView.current.scrollHeight
  }, [output.length, sourceOpen])
  return (
    <div className="design-inspector">
      <div className="design-run-summary">
        <strong>{stage}</strong>
        <span>{duration}</span>
      </div>
      <div className="design-run-model">
        {entry.modelName || '设计 AI'} · {new Date(entry.at).toLocaleString()}
      </div>
      <ol className="design-timeline" aria-label="设计进度">
        <li data-state="done">
          <Check size={12} />
          <span>需求与上下文已提交</span>
        </li>
        <li data-state={active ? 'active' : 'done'}>
          <span className="timeline-point" />
          <span>{active ? stage : '模型响应已结束'}</span>
        </li>
        <li data-state={entry.status === 'complete' ? 'done' : 'pending'}>
          <span className="timeline-point" />
          <span>
            {entry.status === 'complete'
              ? '已校验并保存原型版本'
              : active
                ? '完成后校验并保存版本'
                : '本次未生成新版本'}
          </span>
        </li>
      </ol>
      {entry.error && (
        <p className="design-run-error" role="alert">
          {entry.error}
        </p>
      )}
      {instruction && (
        <details className="design-detail">
          <summary>
            <ChevronDown size={12} />
            设计要求
          </summary>
          <div className="design-prose">{instruction.replace(/^原型设计：/, '')}</div>
        </details>
      )}
      {entry.reasoning && (
        <details className="design-detail">
          <summary>
            <ChevronDown size={12} />
            模型返回的思考 <small>{entry.reasoning.length.toLocaleString()} 字符</small>
          </summary>
          <div className="message-markdown design-prose">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children }) => <span className="research-link">{children}</span>,
                img: () => null,
              }}
            >
              {entry.reasoning}
            </ReactMarkdown>
          </div>
        </details>
      )}
      {entry.tools?.map((tool) => (
        <details className="design-detail" key={tool.id}>
          <summary>
            <ChevronDown size={12} />
            {tool.name}
            <small>
              {
                { receiving: '接收参数', running: '执行中', complete: '已完成', error: '未完成' }[
                  tool.status
                ]
              }
            </small>
          </summary>
          <pre className="design-source">{tool.arguments}</pre>
          {tool.result && <pre className="design-source">{tool.result}</pre>}
        </details>
      ))}
      {output ? (
        <details
          className="design-detail design-output"
          open={sourceOpen}
          onToggle={(e) => setSourceOpen(e.currentTarget.open)}
        >
          <summary>
            <ChevronDown size={12} />
            <Code2 size={13} />
            生成源码 <small>{output.length.toLocaleString()} 字符</small>
          </summary>
          {sourceOpen && (
            <pre
              className="design-source"
              ref={outputView}
              onScroll={(e) => {
                const el = e.currentTarget
                followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
              }}
            >
              <code>{output}</code>
            </pre>
          )}
        </details>
      ) : (
        active && <p className="design-detail-hint">收到模型内容后，记录会在这里更新。</p>
      )}
    </div>
  )
}

function CurrentProcess({ project, entry }: { project: Project; entry: ChatEntry }) {
  const output = designOutput(project, entry)
  const { active, silent, stage, duration } = useDesignStatus(entry, output)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [stopping, setStopping] = useState(false)
  const runs = project.chat.filter((e) => e.purpose === 'design' && e.role === 'assistant')
  const viewed = runs.find((e) => e.id === selected) || entry
  return (
    <>
      <section className="design-process" aria-label="原型设计过程" data-active={active}>
        <div className="design-process-heading">
          <div className="design-process-title" role="status">
            {active ? (
              <LoaderCircle size={14} className="design-activity-icon" />
            ) : entry.status === 'complete' ? (
              <Check size={14} />
            ) : (
              <PencilRuler size={14} />
            )}
            <strong>{stage}</strong>
          </div>
          <div className="design-process-actions">
            <button
              className="design-process-link"
              aria-haspopup="dialog"
              onClick={() => {
                setSelected('')
                setOpen(true)
              }}
            >
              查看过程
            </button>
            {active && (
              <button
                className="eng-icon"
                aria-label="停止原型生成"
                title="停止设计"
                disabled={stopping}
                onClick={() => {
                  setStopping(true)
                  void window.desktop.engineering
                    .stopDesign(project.id)
                    .catch((e) => setError(String(e)))
                    .finally(() => setStopping(false))
                }}
              >
                <Square size={12} />
              </button>
            )}
          </div>
        </div>
        <div className="design-process-meta">
          <span title={entry.modelName}>{entry.modelName || '设计 AI'}</span>
          <span>{duration}</span>
          <span>
            思考 {(entry.reasoning?.length || 0).toLocaleString()} 字符 · 原型正文 {output.length.toLocaleString()} 字符
          </span>
        </div>
        {active && silent >= 15 && (
          <p className="design-process-notice">等待模型继续返回 · {silent} 秒未收到新内容</p>
        )}
        {(entry.error || error) && (
          <p className="design-process-notice design-process-error" role="alert">
            {error
              ? '停止请求失败，请重试。'
              : entry.error}
            {project.prototypes?.length ? '已有原型仍可预览。' : ''}
          </p>
        )}
      </section>
      {open && (
        <Overlay
          open
          drawer
          title="设计过程"
          description="查看设计要求、模型响应与版本生成记录。"
          onClose={() => setOpen(false)}
        >
          {runs.length > 1 && (
            <label className="design-history">
              设计记录
              <select
                aria-label="设计过程记录"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">最近一次设计</option>
                {runs.map((run, i) => (
                  <option key={run.id} value={run.id}>
                    第 {i + 1} 次 · {new Date(run.at).toLocaleTimeString()}
                  </option>
                ))}
              </select>
            </label>
          )}
          <DesignDetails key={viewed.id} project={project} entry={viewed} />
        </Overlay>
      )}
    </>
  )
}

export default function DesignProcess({ project }: { project: Project }) {
  const entry = project.chat.filter((e) => e.purpose === 'design' && e.role === 'assistant').at(-1)
  return entry ? <CurrentProcess key={entry.id} project={project} entry={entry} /> : null
}
