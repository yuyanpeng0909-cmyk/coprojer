import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { PendingRequest } from '../../../shared/request-feedback'

export function LoadingStatus({ label, startedAt, compact = false }: { label: string; startedAt?: number; compact?: boolean }) {
  const [since] = useState(Date.now), [time, setTime] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const seconds = Math.max(0, Math.floor((time - (startedAt || since)) / 1000))
  return <span className={'ui-request-status' + (compact ? ' compact' : '')} role="status"><LoaderCircle size={13} aria-hidden="true" /><span>{label}…</span>{seconds >= 3 && <small aria-hidden="true">{seconds}s</small>}</span>
}

export function RequestActivity() {
  const [requests, setRequests] = useState<PendingRequest[]>([])
  useEffect(() => window.desktop.onEngineeringRequests?.(setRequests), [])
  const current = requests.at(-1)
  // Avoid flashes from immediate local saves; the action remains disabled by its owner.
  const [visible, setVisible] = useState(false)
  useEffect(() => { setVisible(false); if (!current) return; const timer = setTimeout(() => setVisible(true), Math.max(0, 180 - (Date.now() - current.startedAt))); return () => clearTimeout(timer) }, [current?.id])
  return current && visible ? <LoadingStatus key={current.id} startedAt={current.startedAt} compact label={current.label + (requests.length > 1 ? ` · 共 ${requests.length} 项处理中` : '')} /> : null
}

export function CountProgress({ completed, total, label }: { completed: number; total: number; label: string }) {
  if (!total) return null
  const value = Math.max(0, Math.min(completed, total))
  return <div className="ui-count-progress"><span>{label} · {value} / {total}</span><div className="eng-mini-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}><i style={{ width: `${value / total * 100}%` }} /></div></div>
}
