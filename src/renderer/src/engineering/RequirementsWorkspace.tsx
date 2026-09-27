import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  GitBranch,
  GripVertical,
  Maximize2,
  MessageSquare,
  PanelsTopLeft,
  PencilRuler,
  Square,
  WandSparkles,
  FolderTree,
} from 'lucide-react'
import { Overlay } from '../components/ui'
import {
  requirementsFingerprint,
  type ChatEntry,
  type EngineeringState,
  type Project,
  type RoundtableConfig,
} from '../../../shared/engineering'
import FeatureMindMap from './FeatureMindMap'
import PrototypePreview from './PrototypePreview'
import PrototypeWorkflow from './PrototypeWorkflow'
import RoundtableControls from './RoundtableControls'
import DecisionCard from './DecisionCard'
import ProjectTargets from './ProjectTargets'
import type { ResearchPanelKind } from '../../../shared/desktop'
import './requirements.css'

type Panel = ResearchPanelKind
function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const index = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true')
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
  event.preventDefault()
  buttons[next]?.click()
  buttons[next]?.focus()
}
export type ResearchTab = 'requirements' | Panel
const toolNames: Record<string, string> = {
  ask_human: '等待人工决定',
  resolve_deferred_decision: '研究暂缓问题',
  update_project_targets: '规划多端子项目',
  update_requirements: '整理完整需求文档',
  update_features: '更新功能图',
  read_discussion: '读取讨论记录',
  read_context: '读取共享上下文',
  design_prototype: '委派原型设计',
}
const markdown = (text: string) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ children }) => <span className="research-link">{children}</span>,
      img: () => null,
    }}
  >
    {text}
  </ReactMarkdown>
)
function DiscussionMessage({ entry }: { entry: ChatEntry }) {
  const [copied, setCopied] = useState(false)
  return (
    <article className={`research-message ${entry.role}`} data-message-id={entry.id}>
      <div className="message-byline">
        <span className="message-avatar">
          {entry.role === 'user' ? (
            '你'
          ) : entry.purpose === 'design' ? (
            <PencilRuler size={13} />
          ) : (
            <Bot size={13} />
          )}
        </span>
        <strong>
          {entry.role === 'user'
            ? '你'
            : entry.speaker || (entry.purpose === 'design' ? '设计 AI' : '需求协作者')}
        </strong>
        <small>{entry.modelName}</small>
        {entry.meetingRound && <small>圆桌第 {entry.meetingRound} 轮</small>}
        <time>
          {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        {entry.status === 'streaming' && <span className="streaming-label">生成中</span>}
      </div>
      <div className="message-bubble">
        {entry.reasoning && (
          <details className="message-detail reasoning">
            <summary>
              <ChevronDown size={12} />
              模型返回的思考 <small>{entry.status === 'streaming' ? '正在接收' : '已完成'}</small>
            </summary>
            <div className="message-markdown">{markdown(entry.reasoning)}</div>
          </details>
        )}
        {entry.purpose === 'design' && /<(?:!doctype|html)|```html/i.test(entry.text) ? (
          <details className="message-detail">
            <summary>
              <ChevronDown size={12} />
              原型生成内容 <small>{entry.text.length.toLocaleString()} 字符</small>
            </summary>
            <pre>{entry.text}</pre>
          </details>
        ) : entry.text ? (
          <div className="message-markdown">{markdown(entry.text)}</div>
        ) : entry.status === 'streaming' ? (
          <div className="message-waiting">
            等待模型响应<span>…</span>
          </div>
        ) : null}
        {entry.tools?.map((tool) => (
          <details className="message-detail tool" key={tool.id}>
            <summary>
              <ChevronDown size={12} />
              <GitBranch size={12} />
              {toolNames[tool.name] || tool.name}
              <small>
                {
                  { receiving: '接收参数', running: '执行中', complete: '已完成', error: '未完成' }[
                    tool.status
                  ]
                }
              </small>
            </summary>
            <div>
              <label>调用参数</label>
              <pre>{tool.arguments || '等待参数…'}</pre>
              {tool.result && (
                <>
                  <label>执行结果</label>
                  <pre>{tool.result}</pre>
                </>
              )}
            </div>
          </details>
        ))}
        {entry.error && (
          <p className="message-error" role="status">
            {entry.error}
          </p>
        )}
      </div>
      {entry.role === 'assistant' && entry.status !== 'streaming' && entry.text && (
        <button
          className="message-copy"
          onClick={() =>
            void navigator.clipboard
              .writeText(entry.text)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? '已复制' : '复制回复'}
        </button>
      )}
    </article>
  )
}

export function ResearchPreview({
  project,
  panel,
  onPanel,
  onFeature,
  detached = false,
  targetId = '',
  onTarget,
}: {
  project: Project
  panel: Panel
  onPanel?(panel: Panel): void
  onFeature?(id: string): void
  detached?: boolean
  targetId?: string
  onTarget?(id: string): void
}) {
  const [scope, setScope] = useState(targetId)
  useEffect(() => setScope(targetId), [targetId])
  const target = project.targets?.find((t) => t.id === scope)
  const scoped = target
    ? {
        ...project,
        name: target.name,
        targets: [],
        features: project.features.filter((f) => f.targetId === target.id),
        prototypes: project.prototypes?.filter((p) => p.targetId === target.id),
        chat: project.chat.filter((c) => c.purpose !== 'design' || c.targetId === target.id),
        designActivity:
          project.designActivity &&
          project.chat.some(
            (c) => c.purpose === 'design' && c.status === 'streaming' && c.targetId === target.id,
          ),
      }
    : project
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const detach = () =>
    void window.desktop
      .openResearchPanel(project.id, panel, scope || undefined)
      .catch((e) => setError(String(e)))
  const dragStart = (e: PointerEvent<HTMLButtonElement>) => {
    start.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const dragMove = (e: PointerEvent) => {
    if (
      start.current &&
      Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 55
    ) {
      start.current = null
      setDragging(false)
      detach()
    }
  }
  return (
    <section
      className="research-preview"
      aria-label={
        panel === 'map'
          ? '功能图预览面板'
          : panel === 'projects'
            ? '子项目规划面板'
            : '原型预览面板'
      }
    >
      <header>
        <div className="preview-tabs" role="tablist" aria-label="右侧预览" onKeyDown={tabKeys}>
          {(['map', 'prototype', 'projects'] as const)
            .filter((p) => !detached || p === panel)
            .map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={panel === p}
                tabIndex={panel === p ? 0 : -1}
                onClick={() => onPanel?.(p)}
              >
                {p === 'map' ? (
                  <GitBranch size={13} />
                ) : p === 'projects' ? (
                  <FolderTree size={13} />
                ) : (
                  <PanelsTopLeft size={13} />
                )}{' '}
                {p === 'map' ? '功能图' : p === 'projects' ? '子项目' : '原型'}
                {p === 'prototype' && project.designActivity && <i className="design-dot" />}
              </button>
            ))}
        </div>
        {!detached && (
          <div className="preview-window-actions">
            <button
              className="eng-icon preview-grip"
              aria-label="拖出预览窗口"
              title="拖动此处分离为独立窗口"
              onPointerDown={dragStart}
              onPointerMove={dragMove}
              onPointerUp={() => {
                start.current = null
                setDragging(false)
              }}
              onPointerCancel={() => {
                start.current = null
                setDragging(false)
              }}
            >
              <GripVertical size={14} />
            </button>
            <button
              className="eng-icon"
              aria-label={panel === 'map' ? '独立窗口打开功能图' : '独立窗口打开原型'}
              onClick={detach}
            >
              <Maximize2 size={13} />
            </button>
          </div>
        )}
      </header>
      {panel !== 'projects' && !!project.targets?.length && (
        <div className="preview-project-scope">
          <label>
            子项目
            <select
              aria-label="预览子项目"
              value={scope}
              disabled={detached && !!targetId}
              onChange={(e) => {
                setScope(e.target.value)
                onTarget?.(e.target.value)
              }}
            >
              <option value="">整体方案</option>
              {project.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {target && <span>{target.directory}</span>}
        </div>
      )}
      {dragging && (
        <div
          className="preview-drag-overlay"
          onPointerMove={dragMove}
          onPointerUp={() => {
            start.current = null
            setDragging(false)
          }}
        >
          拖动以打开独立窗口
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {panel === 'map' ? (
        <FeatureMindMap project={scoped} onFeature={onFeature} />
      ) : panel === 'projects' ? (
        <ProjectTargets project={project} onFeature={onFeature} />
      ) : (
        <PrototypePreview project={scoped} />
      )}
    </section>
  )
}

export default function RequirementsWorkspace({
  project,
  state,
  onFeature,
  perform,
  tab,
  onTab,
  onReview,
}: {
  project: Project
  state: EngineeringState
  onFeature(id: string): void
  perform(work: () => Promise<unknown>, success?: string): Promise<boolean>
  tab: ResearchTab
  onTab(tab: ResearchTab): void
  onReview(): void
}) {
  const [panel, setPanel] = useState<Panel>('map'),
    [draft, setDraft] = useState(() => {
      try {
        return localStorage.getItem(`coprojer.discussion.draft.${project.id}`) || ''
      } catch {
        return ''
      }
    })
  const [targetId, setTargetId] = useState('')
  const [roundtableMode, setRoundtableMode] = useState(!!project.roundtable)
  const [meetingConfig, setMeetingConfig] = useState<RoundtableConfig>(() =>
    project.roundtable
      ? { participants: project.roundtable.participants, passes: project.roundtable.passes }
      : { participants: [], passes: 2 },
  )
  const [designOpen, setDesignOpen] = useState(false),
    [instruction, setInstruction] = useState(''),
    [designModel, setDesignModel] = useState(project.designModelId || state.agents.find(a => a.role === 'designer')?.modelId || project.discussionModelId)
  const [documentOpen, setDocumentOpen] = useState(false),
    [documentDraft, setDocumentDraft] = useState(''),
    [documentPrevious, setDocumentPrevious] = useState('')
  const [pending, setPending] = useState(false),
    [ratio, setRatio] = useState(46)
  const scroll = useRef<HTMLDivElement>(null),
    stick = useRef(true)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const input = composerInput.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(160, Math.max(44, input.scrollHeight))}px`
  }, [draft, tab])
  const fingerprint = requirementsFingerprint(project)
  const confirmed =
    project.requirementsBaseline?.fingerprint === fingerprint &&
    project.requirementsBaseline?.messageCount === project.chat.length
  useEffect(() => {
    try {
      localStorage.setItem(`coprojer.discussion.draft.${project.id}`, draft)
    } catch {
      /* The draft remains available in memory. */
    }
  }, [draft, project.id])
  const lastMessage = project.chat.at(-1)
  const scrollRevision = `${project.chat.length}:${lastMessage?.id}:${lastMessage?.text.length}:${lastMessage?.reasoning?.length}:${lastMessage?.tools?.map((t) => `${t.arguments.length}:${t.result?.length}:${t.status}`).join('|')}:${lastMessage?.status}`
  useLayoutEffect(() => {
    if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [scrollRevision, tab])
  const send = async () => {
    if (!draft.trim() || pending || project.activity) return
    setPending(true)
    const content = draft
    try {
      if (
        await perform(() =>
          roundtableMode
            ? window.desktop.engineering.roundtableTurn(project.id, content, meetingConfig)
            : window.desktop.engineering.discuss(project.id, content),
        )
      ) {
        setDraft('')
        stick.current = true
      }
    } finally {
      setPending(false)
    }
  }
  const openDesign = () => {
    setDesignModel(project.designModelId || state.agents.find(a => a.role === 'designer')?.modelId || project.discussionModelId)
    setDesignOpen(true)
  }
  const preview = (
    <ResearchPreview
      project={project}
      panel={tab === 'requirements' ? panel : tab}
      onPanel={(p) => {
        setPanel(p)
        if (tab !== 'requirements') onTab(p)
      }}
      onFeature={onFeature}
      targetId={targetId}
      onTarget={setTargetId}
    />
  )
  return (
    <div className="requirements-workspace">
      <div className="research-navigation">
        <div role="tablist" aria-label="需求工作区子模块" onKeyDown={tabKeys}>
          {(
            [
              ['requirements', '需求', MessageSquare],
              ['map', '功能图', GitBranch],
              ['prototype', '原型', PanelsTopLeft],
              ['projects', '子项目', FolderTree],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              key={id}
              onClick={() => onTab(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        <div className="research-actions">
          <button
            className="ui-button secondary"
            onClick={() => {
              setDocumentDraft(project.requirementsDocument || '')
              setDocumentPrevious(project.requirementsDocument || '')
              setDocumentOpen(true)
            }}
          >
            需求文档
          </button>
          <span className={`baseline-status ${confirmed ? 'confirmed' : ''}`}>
            {confirmed
              ? '已确认基线'
              : project.requirementsBaseline
                ? '基线后有新讨论'
                : '自由讨论中'}
          </span>
          {project.requirementsBaseline &&
            project.features.some((f) => ['solution', 'ready'].includes(f.stage)) && (
              <button
                className="ui-button secondary"
                disabled={!!project.activity || project.designActivity}
                onClick={() =>
                  void perform(
                    () => window.desktop.engineering.reopenProjectRequirements(project.id),
                    '未开发功能已重新进入需求修订',
                  )
                }
              >
                继续修订
              </button>
            )}
          <button
            className="ui-button secondary"
            disabled={project.designActivity || !state.models.length}
            onClick={openDesign}
          >
            <WandSparkles size={13} />
            设计原型
          </button>
          <button
            className="ui-button primary"
            disabled={
              !!project.activity || project.designActivity || !project.features.length || confirmed
            }
            onClick={() => void onReview()}
          >
            <Check size={13} />
            确认完整需求
          </button>
        </div>
      </div>
      <PrototypeWorkflow project={project} targetId={targetId || undefined} onPreview={id => { setTargetId(id || ''); setPanel('prototype'); onTab('prototype') }} onReview={() => void onReview()} />
      {tab === 'requirements' ? (
        <div
          className="research-split"
          style={{
            gridTemplateColumns: `minmax(280px, ${ratio}fr) 7px minmax(280px, ${100 - ratio}fr)`,
          }}
        >
          <section className="research-conversation" aria-label="需求讨论">
            <div className="conversation-heading">
              <span>产品讨论</span>
              <small>记录自动保存 · 支持切换模型接续</small>
            </div>
            <RoundtableControls
              project={project}
              state={state}
              mode={roundtableMode}
              onMode={setRoundtableMode}
              config={meetingConfig}
              onConfig={setMeetingConfig}
              onReview={() => void onReview()}
            />
            <div
              className="conversation-scroll"
              ref={scroll}
              onScroll={() => {
                const e = scroll.current
                if (e) stick.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80
              }}
            >
              {!project.chat.length && (
                <div className="research-welcome">
                  <span className="welcome-mark">
                    <MessageSquare size={23} />
                  </span>
                  <h2>先把产品想清楚。</h2>
                  <p>
                    {project.brief ||
                      '从使用者、场景和想解决的问题聊起。想法不必一次完整，也不必按固定步骤展开。'}
                  </p>
                  <div className="discussion-prompts">
                    {['先梳理核心使用场景', '一起探索模块与功能', '讨论产品的界面方向'].map(
                      (text) => (
                        <button key={text} onClick={() => setDraft(text)}>
                          {text}
                          <ArrowUp size={12} />
                        </button>
                      ),
                    )}
                  </div>
                  <small>讨论内容会保存，功能图和原型跟随讨论逐步完善。</small>
                </div>
              )}
              {project.chat.map((entry) => (
                <DiscussionMessage key={entry.id} entry={entry} />
              ))}
            </div>
            <form
              className="research-composer"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <textarea
                ref={composerInput}
                rows={2}
                aria-label="需求讨论内容"
                placeholder={
                  roundtableMode
                    ? project.roundtable
                      ? '填写你的反馈，让参会模型继续完善方案…'
                      : '提出圆桌议题，模型讨论后会交回给你…'
                    : '聊想法、补充场景，或让设计 AI 画个原型…'
                }
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={20000}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="composer-toolbar">
                <select
                  aria-label="讨论模型"
                  hidden={roundtableMode}
                  value={project.discussionModelId}
                  disabled={!!project.activity || pending}
                  onChange={(e) =>
                    void perform(() =>
                      window.desktop.engineering.setProjectModel(project.id, e.target.value),
                    )
                  }
                >
                  <option value="">选择模型</option>
                  {state.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.model}
                    </option>
                  ))}
                </select>
                <span>Enter 发送 · Shift Enter 换行</span>
                {project.activity ? (
                  <button
                    type="button"
                    className="composer-send"
                    aria-label="停止讨论"
                    onClick={() => void perform(() => window.desktop.engineering.stop(project.id))}
                  >
                    <Square size={13} />
                  </button>
                ) : (
                  <button
                    className="composer-send"
                    aria-label="发送"
                    type="submit"
                    disabled={
                      pending ||
                      !draft.trim() ||
                      (roundtableMode
                        ? meetingConfig.participants.length < 2
                        : !project.discussionModelId)
                    }
                  >
                    <ArrowUp size={16} />
                  </button>
                )}
              </div>
              {project.designActivity && (
                <div className="design-progress">
                  <PencilRuler size={12} />
                  <span>设计 AI 正在生成原型，可以继续讨论</span>
                  <button
                    type="button"
                    onClick={() =>
                      void perform(() => window.desktop.engineering.stopDesign(project.id))
                    }
                  >
                    停止设计
                  </button>
                </div>
              )}
            </form>
            <DecisionCard project={project} />
          </section>
          <div
            className="research-divider"
            role="separator"
            aria-label="调整讨论与预览宽度"
            aria-orientation="vertical"
            tabIndex={0}
            aria-valuenow={ratio}
            aria-valuemin={30}
            aria-valuemax={70}
            onKeyDown={(e) => {
              if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault()
                setRatio((v) => Math.max(30, Math.min(70, v + (e.key === 'ArrowLeft' ? -2 : 2))))
              }
            }}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                const rect = e.currentTarget.parentElement!.getBoundingClientRect()
                setRatio(Math.max(30, Math.min(70, ((e.clientX - rect.left) / rect.width) * 100)))
              }
            }}
          />
          {preview}
        </div>
      ) : (
        <div className="research-full-preview">{preview}</div>
      )}
      {documentOpen && (
        <Overlay open title="完整需求文档" onClose={() => setDocumentOpen(false)}>
          <div className="research-dialog-form">
            <p>
              讨论中的产品目标、场景、业务规则、非功能要求与开放问题。可由 AI
              随讨论整理，也可直接编辑；统一确认后写入共享基线。
            </p>
            <textarea
              aria-label="完整需求文档内容"
              value={documentDraft}
              onChange={(e) => setDocumentDraft(e.target.value)}
              rows={16}
              maxLength={80000}
            />
            <footer>
              <button className="ui-button secondary" onClick={() => setDocumentOpen(false)}>
                关闭
              </button>
              <button
                className="ui-button primary"
                disabled={pending}
                onClick={() => {
                  setPending(true)
                  void perform(
                    () =>
                      window.desktop.engineering.saveRequirementsDocument(
                        project.id,
                        documentDraft,
                        documentPrevious,
                      ),
                    '需求文档已保存',
                  )
                    .then((ok) => {
                      if (ok) setDocumentOpen(false)
                    })
                    .finally(() => setPending(false))
                }}
              >
                保存文档
              </button>
            </footer>
          </div>
        </Overlay>
      )}
      {designOpen && (
        <Overlay open title="设计原型" onClose={() => setDesignOpen(false)}>
          <form
            className="research-dialog-form"
            onSubmit={(e) => {
              e.preventDefault()
              setPending(true)
              void perform(() =>
                window.desktop.engineering.generatePrototype(
                  project.id,
                  instruction,
                  designModel,
                  targetId || undefined,
                ),
              )
                .then((ok) => {
                  if (ok) {
                    setDesignOpen(false)
                    setPanel('prototype')
                    if (tab !== 'requirements') onTab('prototype')
                    setInstruction('')
                  }
                })
                .finally(() => setPending(false))
            }}
          >
            <p>设计 AI 将读取当前需求、完整讨论与已有原型，生成新的可预览版本。</p>
            <label>
              设计模型
              <select
                aria-label="设计模型"
                value={designModel}
                onChange={(e) => setDesignModel(e.target.value)}
              >
                <option value="">选择模型</option>
                {state.models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.model}
                  </option>
                ))}
              </select>
            </label>
            <label>
              设计要求
              <textarea
                aria-label="原型设计要求"
                required
                maxLength={20000}
                rows={5}
                value={instruction}
                placeholder="例如：先设计记账首页，包含快捷记账、月度收支和账单列表…"
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            {!!project.targets?.length && (
              <label>
                设计子项目
                <select
                  aria-label="设计子项目"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">整体方案</option>
                  {project.targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <footer>
              <button
                className="ui-button secondary"
                type="button"
                onClick={() => setDesignOpen(false)}
              >
                取消
              </button>
              <button
                className="ui-button primary"
                disabled={pending || !designModel || !instruction.trim()}
              >
                开始设计
              </button>
            </footer>
          </form>
        </Overlay>
      )}
      {tab !== 'requirements' && <DecisionCard project={project} />}
    </div>
  )
}

export function DetachedResearchPanel({
  context,
}: {
  context: { projectId: string; panel: Panel; targetId?: string }
}) {
  const [project, setProject] = useState<Project>(),
    [panel, setPanel] = useState(context.panel),
    [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  useEffect(() => {
    let live = true,
      fetching = false
    const read = async () => {
      if (fetching) return
      fetching = true
      try {
        const state = await window.desktop.engineering.state()
        if (live) setProject(state.projects.find((p) => p.id === context.projectId))
      } catch (e) {
        if (live) setError(String(e))
      } finally {
        fetching = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 250)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [context.projectId])
  const feature = project?.features.find((f) => f.id === selected)
  return (
    <main className="detached-research">
      <header>
        <strong>
          {project?.name || '加载工程'} /{' '}
          {project?.targets?.find((t) => t.id === context.targetId)?.name || '整体方案'} /{' '}
          {panel === 'map' ? '功能图' : panel === 'projects' ? '子项目' : '原型'}
        </strong>
        <small>独立预览 · 与工作台实时同步</small>
      </header>
      {error && <p role="alert">{error}</p>}
      {project && (
        <ResearchPreview
          project={project}
          panel={panel}
          onPanel={setPanel}
          onFeature={setSelected}
          detached
          targetId={context.targetId}
        />
      )}
      {feature && (
        <Overlay open title={feature.title} onClose={() => setSelected('')}>
          <div className="research-dialog-form">
            <p>{feature.description}</p>
            <ul>
              {feature.criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </Overlay>
      )}
    </main>
  )
}
