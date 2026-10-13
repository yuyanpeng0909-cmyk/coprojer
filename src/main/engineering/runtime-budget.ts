import type { RuntimeBudget, RuntimeAllowance } from '../../shared/runtime-budget'
import { ReliabilityFailure } from './reliability'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
const ownerId = randomUUID(), pendingSettlements = new Map<string, number>()
const liveLeases = new Set<string>()
export const isBudgetRunning = (budget: RuntimeBudget | undefined) => !!budget?.activeLease && liveLeases.has(budget.activeLease.id)

/** Measured deterministic workload + bounded guardrail; not a production latency estimate. */
export const defaultRuntimeAllowance: RuntimeAllowance = { requests: 512, tools: 2048, activeMs: 60 * 60 * 1000 }
export function newRuntimeBudget(target: string, history: RuntimeBudget['historical'] = { kind: 'exact', requests: 0, tools: 0, activeMs: 0 }): RuntimeBudget {
  validateHistory(history)
  const at = new Date().toISOString(), limits = history.kind === 'exact' ? { ...defaultRuntimeAllowance } : null
  const used = history.kind === 'exact' ? { requests: history.requests!, tools: history.tools!, activeMs: history.activeMs! } : { requests: 0, tools: 0, activeMs: 0 }
  return { version: 1, policy: 'runtime-budget-v1', historical: history, used, limits,
    enabledAt: at, timeAccounting: 'active-reservation-ms-v1', adjustments: limits ? [{ at, target, before: null, after: limits, source: 'new-task-policy', reason: '新任务的版本化初始保护额度；可由本机用户调整。' }] : [] }
}
export class CumulativeBudgetPause extends ReliabilityFailure {
  constructor(message: string) { super(message); this.name = 'CumulativeBudgetPause' }
}
export function validateAllowance(value: RuntimeAllowance): void {
  if (!value || Object.keys(value).length !== 3 || !['requests', 'tools', 'activeMs'].every(key =>
    Number.isSafeInteger(value[key as keyof RuntimeAllowance]) && value[key as keyof RuntimeAllowance] >= 0 && value[key as keyof RuntimeAllowance] <= 1e12))
    throw new Error('额度需要非负整数 requests、tools、activeMs，且不能包含其他字段。')
}
export function validateBudget(value: RuntimeBudget): void {
  if (value.version !== 1 || value.policy !== 'runtime-budget-v1' || value.timeAccounting !== 'active-reservation-ms-v1' ||
    !['exact', 'unknown', 'lower-bound'].includes(value.historical?.kind)) throw new CumulativeBudgetPause('累计额度版本未知，需兼容读取器核对，不能自动执行。')
  validateAllowance(value.used); if (value.limits) validateAllowance(value.limits)
  validateHistory(value.historical)
  if (value.activeLease && (typeof value.activeLease.id !== 'string' || typeof value.activeLease.owner !== 'string' || typeof value.activeLease.startedAt !== 'string' ||
    !Number.isSafeInteger(value.activeLease.reservedMs) || value.activeLease.reservedMs < 0)) throw new CumulativeBudgetPause('活动时间预占记录无效，需核对。')
}
function validateHistory(history: RuntimeBudget['historical']): void {
  if (!history || !['exact', 'unknown', 'lower-bound'].includes(history.kind) || Object.keys(history).some(key => !['kind', 'requests', 'tools', 'activeMs'].includes(key)) ||
    ['requests', 'tools', 'activeMs'].some(key => {
      const value = history[key as keyof RuntimeAllowance]
      return value === undefined ? history.kind === 'exact' : !Number.isSafeInteger(value) || value < 0
    })) throw new CumulativeBudgetPause('历史用量记录不完整或无效，不能当作零继续。')
}
export interface BudgetHost { read(): RuntimeBudget; save(next: RuntimeBudget): void }
export function settleKnownBudget(host: BudgetHost): void {
  const next = structuredClone(host.read()); validateBudget(next)
  const lease = next.activeLease, elapsed = lease && pendingSettlements.get(lease.id)
  if (!lease || elapsed === undefined) return
  next.used.activeMs += Math.max(-lease.reservedMs, elapsed - lease.reservedMs); delete next.activeLease
  try { host.save(next); pendingSettlements.delete(lease.id) }
  catch (cause) { throw new ReliabilityFailure('活动时间结算尚未可靠保存；未结算标识已保留，禁止绕过后继续。', { cause }) }
}
export function budgetHost(owner: { runtimeBudget?: RuntimeBudget }, save: () => void): BudgetHost {
  return { read: () => { if (!owner.runtimeBudget) throw new CumulativeBudgetPause('尚未建立可靠累计记录，请明确授予额度。'); return owner.runtimeBudget },
    save: next => { const prior = owner.runtimeBudget; owner.runtimeBudget = next; try { save() } catch (error) { owner.runtimeBudget = prior; throw error } } }
}
export class RuntimeBudgetLease {
  private controller = new AbortController()
  readonly signal: AbortSignal
  private timer?: ReturnType<typeof setTimeout>
  private deadline = 0
  private started?: number
  private reserved = 0
  private reservationWindow = 1000
  private failure?: unknown
  private finished = false
  private id = randomUUID()
  constructor(private host: BudgetHost, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.controller.signal])
    signal.addEventListener('abort', () => clearTimeout(this.timer), { once: true })
  }
  private update(work: (next: RuntimeBudget) => void): void {
    const next = structuredClone(this.host.read()); validateBudget(next); work(next)
    try { this.host.save(next) } catch (cause) { throw new ReliabilityFailure('累计额度保存失败；未启动新动作，请核对存储。', { cause }) }
  }
  private ensure(): RuntimeBudget {
    this.signal.throwIfAborted()
    const value = this.host.read(); validateBudget(value)
    if (value.activeLease && value.activeLease.id !== this.id) throw new CumulativeBudgetPause('上段活动时间未结算，无法确认历史时间；可先核对工具效果，再明确授予后续时间额度。')
    if (!value.limits) throw new CumulativeBudgetPause('历史累计用量未知；请明确授予本任务后续有限额度。只读效果核对仍可进行。')
    return value
  }
  start(): void {
    settleKnownBudget(this.host); this.ensure(); this.started = performance.now(); liveLeases.add(this.id); this.reserveTime()
  }
  private reserveTime(): void {
    clearTimeout(this.timer)
    // A durable profile save may take longer than the reservation itself. Pay
    // for that elapsed time and renew before returning, rather than cancelling
    // an otherwise funded task. Size the next window from observed save latency;
    // every renewal remains bounded by the original cumulative allowance.
    do {
      const value = this.ensure(), beforeSave = performance.now()
      const overdue = Math.max(0, Math.ceil(beforeSave - this.started!) - this.reserved)
      const remaining = value.limits!.activeMs - value.used.activeMs - overdue
      if (remaining <= 0) throw new CumulativeBudgetPause('任务累计活动时间额度已用完，已停止新动作；请核对现场或由用户调整总额度。')
      const amount = Math.min(this.reservationWindow, remaining), charge = overdue + amount
      this.update(next => { next.used.activeMs += charge; next.activeLease ??= { id: this.id, owner: ownerId, startedAt: new Date().toISOString(), reservedMs: 0 }; next.activeLease.reservedMs += charge })
      this.reserved += charge; this.deadline = this.started! + this.reserved
      this.reservationWindow = Math.max(1000, Math.ceil((performance.now() - beforeSave) * 2))
    } while (performance.now() >= this.deadline)
    this.timer = setTimeout(() => {
      try { this.reserveTime() } catch (error) { this.failure = error; this.controller.abort(error) }
    }, Math.max(1, this.deadline - performance.now()))
    this.timer.unref?.()
  }
  reserve(dimension: 'requests' | 'tools'): void {
    const value = this.ensure()
    this.assertTime()
    if (value.used[dimension] >= value.limits![dimension]) throw new CumulativeBudgetPause(`任务累计${dimension === 'requests' ? '模型请求' : '工具调用'}额度已用完；继续不会清零，请由用户调整额度。`)
    this.update(next => { next.used[dimension]++ })
    this.assertTime()
  }
  check(): void { this.ensure(); this.assertTime() }
  private assertTime(): void {
    if (this.started !== undefined && performance.now() >= this.deadline) {
      // Synchronous reliable saves may delay the timer beyond this reservation,
      // even when the task still has ample total time. Persist overdue time and
      // a fresh reservation before starting another action; never waive expiry.
      const value = this.ensure(), overdue = Math.max(0, Math.ceil(performance.now() - this.started) - this.reserved)
      if (value.limits!.activeMs > value.used.activeMs + overdue) { this.reserveTime(); return }
      const error = new CumulativeBudgetPause('活动时间预占已到期，已停止新动作。')
      this.failure = error; this.controller.abort(error); throw error
    }
  }
  finish(): void {
    if (this.finished) return
    this.finished = true
    liveLeases.delete(this.id)
    clearTimeout(this.timer)
    if (this.started === undefined) return
    // Only return this live lease's unused reservation; a crashed owner's reservation stays consumed.
    const elapsed = Math.ceil(performance.now() - this.started)
    if (this.host.read().activeLease?.id === this.id) { pendingSettlements.set(this.id, elapsed); settleKnownBudget(this.host) }
    if (this.failure) throw this.failure
    if (this.host.read().used.activeMs >= this.host.read().limits!.activeMs) throw new CumulativeBudgetPause('任务累计活动时间额度已用完，已停止新动作；实际收尾耗时已计入。')
  }
}
