import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label = '视图切换',
  style = 'underline',
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode }[]
  label?: string
  style?: 'underline' | 'segment' | 'workspace'
}) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (style === 'workspace') {
      container.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      })
    }
  }, [value, style])
  return (
    <div
      ref={container}
      role="tablist"
      aria-label={label}
      className={`ui-tabs ${style}`}
      onKeyDown={(event) => {
        const index = options.findIndex((option) => option.value === value)
        let next: number
        if (event.key === 'ArrowRight') next = (index + 1) % options.length
        else if (event.key === 'ArrowLeft') next = (index + options.length - 1) % options.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = options.length - 1
        else return
        event.preventDefault()
        onChange(options[next].value)
        container.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Overlay({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  drawer = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  drawer?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const headingId = useId()
  const descriptionId = useId()
  const closeCallback = useRef(onClose)
  closeCallback.current = onClose
  useEffect(() => {
    const element = dialog.current
    const previousFocus = document.activeElement
    if (open && element && !element.open) element.showModal()
    else if (!open && element?.open) element.close()
    return () => {
      if (element?.open) element.close()
      if (open && previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus()
    }
  }, [open])
  return (
    <dialog
      ref={dialog}
      className={`ui-dialog ${drawer ? 'drawer' : ''}`}
      aria-labelledby={headingId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault()
        closeCallback.current()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose()
        }
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id={headingId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button className="icon-button" aria-label="关闭面板" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="dialog-body">{open && children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>
  )
}
