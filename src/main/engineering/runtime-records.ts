import type { ContextRuntimeState } from '../../shared/model-profile'
import type { RunRecordRef } from '../../shared/run-ref'
import type { RuntimePorts } from './runtime'
import { now, uid } from './store'

type RuntimeRecordsHost = {
  save(): void
  manifestId(): string
  model(): string
} & ({ mode: 'execution'; role(): string; ref(): RunRecordRef; requestPrepared(id: string): void } | { mode: 'readonly' })

/** Snapshot persistence and business events remain with each entry's adapter. */
export function runtimeRecords(state: ContextRuntimeState, host: RuntimeRecordsHost): Pick<RuntimePorts['records'], 'compaction' | 'budget' | 'request' | 'usage'> {
  return {
    compaction(record) {
      state.compactions = [...(state.compactions ?? []), { ...record, manifestId: host.manifestId(),
        ...(host.mode === 'execution' ? { role: host.role(), ...host.ref() } : {}), model: host.model() }].slice(-64)
      host.save()
    },
    budget(request) { state.latestBudget = request.budget; host.save() },
    request(request, status, reply) {
      state.latestBudget = request.budget
      if (status === 'prepared') {
        const record: ContextRuntimeState['requests'][number] = { id: uid(), manifestId: host.manifestId(), hash: request.hash, at: now(), status, budget: request.budget,
          ...(host.mode === 'execution' ? host.ref() : {}) }
        if (host.mode === 'execution') host.requestPrepared(record.id)
        state.requests.push(record); state.requests = state.requests.slice(-200)
      }
      else {
        const record = state.requests.at(-1)
        if (record?.hash === request.hash && record.manifestId === host.manifestId()) {
          record.status = status
          // Read-only entries clear a missing response ID; execution retains it.
          if (host.mode === 'readonly') record.responseId = reply?.responseId
          if (reply?.usage) record.usage = { ...record.usage, ...Object.fromEntries(Object.entries(reply.usage).filter(([, value]) => value !== undefined)) }
          if (host.mode === 'execution' && reply?.responseId) record.responseId = reply.responseId
        }
      }
      host.save()
    },
    usage(request, usage) {
      const record = state.requests.at(-1)
      if (record?.hash === request.hash && record.manifestId === host.manifestId()) {
        record.usage = { ...record.usage, ...Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) }
        if (host.mode === 'execution') host.save()
      }
      // Read-only entries also save unmatched usage; keep the original boundary.
      if (host.mode === 'readonly') host.save()
    },
  }
}
