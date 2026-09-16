import { useEffect, useRef, useState } from 'react'
import { ChevronDown, MessageSquare, Square } from 'lucide-react'
import type { Project, RoundtableDecision } from '../../../shared/engineering'

export const decisionStatus = {
  pending: '待你决定',
  answered: '人工已决定',
  deferred: '后续模型研究中',
  resolved: '模型已给出建议',
}

export function DecisionHistory({ decisions }: { decisions: RoundtableDecision[] }) {
  if (!decisions.length) return null
  return (
    <details className="decision-history">
      <summary>
        决策记录 · {decisions.length} 项
        {decisions.some((d) => d.status === 'deferred') &&
          ` · ${decisions.filter((d) => d.status === 'deferred').length} 项未决`}
      </summary>
      <div>
        {decisions.map((d) => (
          <article key={d.id}>
            <small>
              {decisionStatus[d.status]} · {d.speaker} · 第 {d.round} 轮
            </small>
            <strong>{d.question}</strong>
            {d.answer && <p>{d.answer}</p>}
            {d.resolution && (
              <p>
                <b>{d.resolvedBy} 的建议：</b>
                {d.resolution}
              </p>
            )}
          </article>
        ))}
      </div>
    </details>
  )
}

export default function DecisionCard({ project }: { project: Project }) {
  const decision = project.decisions?.find((d) => d.status === 'pending')
  return decision ? <Card key={decision.id} project={project} decision={decision} /> : null
}

function Card({ project, decision: d }: { project: Project; decision: RoundtableDecision }) {
  const [choice, setChoice] = useState<number | undefined>(() => {
    try {
      const saved = localStorage.getItem(`coprojer.decision.choice.${d.id}`)
      const index = saved === null ? NaN : Number(saved)
      return Number.isInteger(index) && d.options[index] ? index : undefined
    } catch {
      return undefined
    }
  })
  const [note, setNote] = useState(() => {
    try {
      return localStorage.getItem(`coprojer.decision.${d.id}`) || ''
    } catch {
      return ''
    }
  })
  const [collapsed, setCollapsed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!collapsed) heading.current?.focus({ preventScroll: true })
  }, [collapsed])
  useEffect(() => {
    try {
      localStorage.setItem(`coprojer.decision.${d.id}`, note)
      if (choice !== undefined)
        localStorage.setItem(`coprojer.decision.choice.${d.id}`, String(choice))
    } catch {
      /* Keep in memory. */
    }
  }, [note, choice, d.id])
  async function answer(defer = false) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await window.desktop.engineering.answerDecision(project.id, d.id, {
        choice,
        text: note.trim(),
        defer,
      })
      try {
        localStorage.removeItem(`coprojer.decision.${d.id}`)
        localStorage.removeItem(`coprojer.decision.choice.${d.id}`)
      } catch {
        /* Optional draft cleanup. */
      }
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }
  return (
    <div className="decision-card-host">
      {collapsed ? (
        <button className="ui-button secondary decision-reopen" onClick={() => setCollapsed(false)}>
          <MessageSquare size={13} />1 项待你决定
        </button>
      ) : (
        <section className="decision-card" aria-label="待决卡" aria-busy={busy}>
          <header>
            <span>
              <MessageSquare size={13} />
              讨论到这里，需要你决定
            </span>
            <div className="decision-card-actions">
              <button
                className="eng-icon"
                aria-label="停止圆桌"
                disabled={!project.activity || busy}
                onClick={() =>
                  void window.desktop.engineering.stop(project.id).catch((e) => setError(String(e)))
                }
              >
                <Square size={12} />
              </button>
              <button
                className="eng-icon"
                aria-label="收起决策卡"
                onClick={() => setCollapsed(true)}
              >
                <ChevronDown size={14} />
              </button>
            </div>
          </header>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void answer()
            }}
          >
            <div className="decision-card-body">
              <small>
                {d.speaker} · {d.modelName} · 第 {d.round} 轮
                {d.targetId &&
                  ` · ${project.targets?.find((t) => t.id === d.targetId)?.name || d.targetId}`}
              </small>
              <h3 ref={heading} tabIndex={-1}>
                {d.question}
              </h3>
              <p>{d.context}</p>
              {!!d.options.length && (
                <fieldset disabled={busy}>
                  <legend>选择一个方向，或直接填写想法</legend>
                  {d.options.map((option, index) => (
                    <label className="decision-option" key={index}>
                      <input
                        type="radio"
                        name={`decision-${d.id}`}
                        checked={choice === index}
                        onChange={() => setChoice(index)}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="decision-note">
                你的想法或补充
                <textarea
                  aria-label="决策补充想法"
                  rows={2}
                  maxLength={5000}
                  disabled={busy}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="也可以不选建议，直接说你的想法…"
                />
              </label>
              {error && (
                <p className="message-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer>
              <button
                type="button"
                className="ui-button secondary"
                disabled={busy}
                onClick={() => void answer(true)}
              >
                后面再说
              </button>
              <button
                className="ui-button primary"
                disabled={busy || (choice === undefined && !note.trim())}
              >
                {busy ? '正在继续…' : '提交并继续'}
              </button>
            </footer>
            <small className="decision-help">
              后面再说：交给后续模型研究，无法确定则保留未决。
            </small>
          </form>
        </section>
      )}
    </div>
  )
}
