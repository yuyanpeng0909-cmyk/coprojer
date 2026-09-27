import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'

export interface BoardBatchAction {
  label: string
  icon?: ReactNode
  disabled?: boolean
  primary?: boolean
  onSelect: () => void
}

export default function BoardBatchActions({ label, summary, selected = 0, disabled, actions, compact = false }: {
  label: string
  summary: string
  selected?: number
  disabled?: boolean
  actions: BoardBatchAction[]
  compact?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return
      menu.current?.hidePopover()
    }
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [open])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={compact ? 'eng-icon project-menu-trigger' : 'ui-button secondary small eng-board-batch-trigger'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        disabled={disabled}
        title={summary}
      >
        {compact ? <MoreHorizontal size={16} /> : <>批量操作{selected > 0 && <span>{selected}</span>}<ChevronDown size={11} /></>}
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className="eng-board-action-menu"
        onBeforeToggle={(event) => {
          if (event.newState !== 'open' || !trigger.current) return
          const bounds = trigger.current.getBoundingClientRect()
          const element = event.currentTarget
          element.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - 204))}px`
          const top = Math.max(12, Math.min(bounds.bottom + 5, window.innerHeight - Math.min(240, actions.length * 32 + 48)))
          element.style.top = `${top}px`
          element.style.maxHeight = `${window.innerHeight - top - 12}px`
        }}
        onToggle={(event) => {
          const visible = event.newState === 'open'
          setOpen(visible)
          if (visible) event.currentTarget.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        }}
        onKeyDown={(event) => {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : event.key === 'ArrowDown' ? (index + 1) % buttons.length
              : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : -1
          if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
          if (event.key === 'Tab') { menu.current?.hidePopover(); trigger.current?.focus() }
        }}
      >
        <small>{summary}</small>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            className={action.primary ? 'primary' : undefined}
            disabled={action.disabled}
            onClick={() => {
              menu.current?.hidePopover()
              trigger.current?.focus()
              action.onSelect()
            }}
          >{action.icon}{action.label}</button>
        ))}
      </div>
    </>
  )
}
