import { useState } from 'react'
import { Users } from 'lucide-react'
import { Overlay } from '../components/ui'
import type { EngineeringState, Project, RoundtableConfig } from '../../../shared/engineering'
import { DecisionHistory } from './DecisionCard'

export default function RoundtableControls({
  project,
  state,
  mode,
  onMode,
  config,
  onConfig,
  onReview,
}: {
  project: Project
  state: EngineeringState
  mode: boolean
  onMode(value: boolean): void
  config: RoundtableConfig
  onConfig(value: RoundtableConfig): void
  onReview(): void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(config)
  const busy = !!project.activity
  const meeting = project.roundtable
  return (
    <div className="roundtable-controls">
      <div className="roundtable-bar">
        <div className="discussion-mode" aria-label="讨论方式">
          <button type="button" aria-pressed={!mode} disabled={busy} onClick={() => onMode(false)}>
            单模型
          </button>
          <button
            type="button"
            aria-pressed={mode}
            disabled={busy}
            onClick={() => {
              onMode(true)
              if (config.participants.length < 2) {
                setDraft(config)
                setOpen(true)
              }
            }}
          >
            <Users size={12} />
            圆桌讨论
          </button>
        </div>
        {mode && (
          <button
            type="button"
            className="design-process-link"
            disabled={busy}
            onClick={() => {
              setDraft(config)
              setOpen(true)
            }}
          >
            {config.participants.length} 位模型 · 配置
          </button>
        )}
      </div>
      {mode && (
        <div className="roundtable-status" role="status">
          <span>
            {meeting
              ? `第 ${meeting.round} 轮 · ${meeting.phase}`
              : '边讨论边更新功能图，需要你取舍时弹出决策卡'}
          </span>
          {meeting?.status === 'awaiting-human' && (
            <button
              type="button"
              className="design-process-link"
              disabled={busy || project.designActivity}
              onClick={onReview}
            >
              审阅完整方案
            </button>
          )}
        </div>
      )}
      {mode && meeting?.error && (
        <details className="roundtable-error">
          <summary>本轮未完成，记录已保留</summary>
          <p>{meeting.error}</p>
        </details>
      )}
      {mode && <DecisionHistory decisions={project.decisions || []} />}
      {open && (
        <Overlay open title="配置圆桌会议" onClose={() => setOpen(false)}>
          <form
            className="roundtable-config"
            onSubmit={(e) => {
              e.preventDefault()
              onConfig(draft)
              onMode(true)
              setOpen(false)
            }}
          >
            <p>
              选择 2–6
              个不同模型并分配职责。各模型边讨论边更新功能图，需要人工取舍时立即弹出卡片；列表首位负责最终汇总，不会自动开工。
            </p>
            {state.models.map((model) => {
              const selected = draft.participants.find((p) => p.modelId === model.id)
              return (
                <div className="roundtable-participant" key={model.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!selected}
                      disabled={!selected && draft.participants.length >= 6}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          participants: e.target.checked
                            ? [
                                ...draft.participants,
                                {
                                  modelId: model.id,
                                  role: draft.participants.length
                                    ? '架构与风险评审'
                                    : '产品负责人 / 主持人',
                                },
                              ]
                            : draft.participants.filter((p) => p.modelId !== model.id),
                        })
                      }
                    />
                    {model.model}
                  </label>
                  {selected && (
                    <input
                      aria-label={`${model.model} 的职责`}
                      value={selected.role}
                      required
                      maxLength={500}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          participants: draft.participants.map((p) =>
                            p.modelId === model.id ? { ...p, role: e.target.value } : p,
                          ),
                        })
                      }
                    />
                  )}
                </div>
              )
            })}
            {state.models.length < 2 && <p>请先在「模型连接」新增至少两个模型。</p>}
            <label className="roundtable-pass">
              每轮模型讨论次数（可随时插入决策卡）
              <select
                aria-label="自动讨论次数"
                value={draft.passes}
                onChange={(e) => setDraft({ ...draft, passes: Number(e.target.value) })}
              >
                <option value={1}>1 次 · 提案后汇总</option>
                <option value={2}>2 次 · 提案、交叉评审后汇总</option>
                <option value={3}>3 次 · 增加一轮评审</option>
              </select>
            </label>
            <small>
              本轮最多 {draft.participants.length * draft.passes + 1}{' '}
              个发言阶段，每个阶段可多次更新功能图和提出决策卡，会分别使用所选模型的额度。等待决策时暂停模型请求。
            </small>
            <footer>
              <button type="button" className="ui-button secondary" onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                className="ui-button primary"
                disabled={
                  draft.participants.length < 2 || draft.participants.some((p) => !p.role.trim())
                }
              >
                使用此配置
              </button>
            </footer>
          </form>
        </Overlay>
      )}
    </div>
  )
}
