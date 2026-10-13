import { createHash } from 'node:crypto'
import type { ContextRuntimeState } from '../../shared/model-profile'
import { modelProfile } from './model-profile'
import { complete, prepareModelRequest, verifyModelRequest, type Connection } from './model'
import { ExecutionArtifacts } from './execution-artifacts'
import { now, uid, type EngineeringStore } from './store'
import { runRuntime, type RuntimeInput, type RuntimePorts, type RuntimeSnapshot, type RunOutcome } from './runtime'
import { RuntimeBudgetLease, budgetHost, CumulativeBudgetPause } from './runtime-budget'
import type { DeltaListener } from './stream'
import { toolContractVersion } from './tool-contract'
import { continuationDocument } from './context-continuity'
import { responsesCompaction } from './responses-compaction'
import { contextConnection } from './context-policy'

export function contextView(snapshot: RuntimeSnapshot): NonNullable<ContextRuntimeState['view']> {
  const summaries = snapshot.messages.filter(m => m.role === 'user' && m.content.startsWith('[已完成工作摘要')).map(m => m.content)
  return { version: 2, lastSequence: snapshot.lastSequence,
    sources: [...new Set([...snapshot.reads.filter(r => r.active).map(r => r.scope + '/' + r.sourceId + '@' + r.version),
      ...summaries.flatMap(s => { try { return JSON.parse(s.split('\n摘要条目 v2：\n')[1]).sources ?? [] } catch { return [] } })])],
    archives: [...new Set([...summaries.flatMap(s => s.match(/artifact:[a-f0-9-]{36}/g) ?? []), ...[snapshot.continuity?.continuationArtifactId, snapshot.continuity?.indexArtifactId].filter((s): s is string => !!s)])], summaries }
}

/** Desktop persistence adapter for the same portable runtime; owns no business transitions. */
export function contextSession(store: EngineeringStore, original: Connection, owner: { contextRuntime?: ContextRuntimeState; runtimeBudget?: import('../../shared/runtime-budget').RuntimeBudget; contextPolicy?: import('../../shared/model-profile').ContextPolicy },
  projectId: string, scopeId: string, revision: number, role: string, event: (kind: string, message: string) => void, listener?: DeltaListener) {
  const effective = contextConnection(original, store.data.projects.find(p => p.id === projectId)?.contextPolicy, owner.contextPolicy)
  const connection: Connection = { ...effective, capabilities: effective.capabilities ? structuredClone(effective.capabilities) : undefined }
  const profile = modelProfile({ ...connection, checks: store.data.models.find(m => m.id === connection.id)?.checks })
  const manifest: ContextRuntimeState['manifest'] = { version: 1, id: uid(), at: now(), taskRevision: revision,
    model: profile.identity, credentialRef: connection.id, parameters: { reasoning: connection.reasoning }, profile,
    versions: { harness: 'runtime-v1', context: 'prepared-request-v2', tools: toolContractVersion, permissions: role + '-readonly-v1', result: role + '-text-v1', checkpoint: 'complete-round-v2' },
    environment: createHash('sha256').update(JSON.stringify([process.platform, process.arch, process.version, projectId, scopeId])).digest('hex'), upstreamVersion: null }
  const previous = owner.contextRuntime
  const state: ContextRuntimeState = { version: 2, manifest, status: 'running',
    requests: [...(previous?.requests ?? [])], manifests: [...(previous?.manifests ?? []), manifest].slice(-64),
    compactions: [...(previous?.compactions ?? [])], operations: [...(previous?.operations ?? [])] }
  owner.contextRuntime = state
  const key = JSON.stringify([projectId, scopeId, role]), artifacts = new ExecutionArtifacts(store.artifactHost(), projectId, scopeId)
  const previousSnapshot = structuredClone(store.data.contextSnapshots?.[key])
  const save = () => store.save()
  let budgetLease: RuntimeBudgetLease | undefined
  const withLease = async <T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (owner.runtimeBudget) budgetLease = new RuntimeBudgetLease(budgetHost(owner, save), signal)
    try { budgetLease?.start(); return await work(budgetLease?.signal ?? signal) }
    finally { budgetLease?.finish(); budgetLease = undefined }
  }
  const mergeUsage = (request: Parameters<NonNullable<RuntimePorts['records']['usage']>>[0], usage: Parameters<NonNullable<RuntimePorts['records']['usage']>>[1]) => {
    const record = state.requests.at(-1)
    if (record?.hash === request.hash && record.manifestId === manifest.id)
      record.usage = { ...record.usage, ...Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) }
  }
  const records: RuntimePorts['records'] = {
    save(snapshot) {
      const snapshots = store.data.contextSnapshots ??= {}, prior = snapshots[key], view = state.view
      const candidate = structuredClone(snapshot)
      if (candidate.continuity && (candidate.steps !== prior?.steps || candidate.continuity.growth?.epoch !== prior?.continuity?.growth?.epoch || !!candidate.continuity.completedReply !== !!prior?.continuity?.completedReply)) {
        candidate.continuity.indexArtifactId = artifacts.write(JSON.stringify({ version: 1, sequence: candidate.lastSequence, reads: candidate.reads, requiredReads: candidate.continuity.requiredReads ?? [] }), '来源与步骤索引.json')
        candidate.continuity.continuationArtifactId = artifacts.write(continuationDocument(candidate), 'CONTINUATION.md')
      } else if (candidate.continuity) {
        candidate.continuity.continuationArtifactId ??= prior?.continuity?.continuationArtifactId
        candidate.continuity.indexArtifactId ??= prior?.continuity?.indexArtifactId
      }
      snapshots[key] = JSON.parse(store.redact(JSON.stringify(candidate))); state.view = contextView(snapshots[key])
      try { save() } catch (error) { if (prior) snapshots[key] = prior; else delete snapshots[key]; state.view = view; throw error }
    },
    invalidate() { /* Read-only entries keep the last complete snapshot; no side effects can be replayed. */ },
    event(kind, message) {
      event(kind, message)
    },
    compaction(record) { state.compactions = [...(state.compactions ?? []), { ...record, manifestId: manifest.id, model: connection.model }].slice(-64); save() },
    budget(request) { state.latestBudget = request.budget; save() },
    request(request, status, reply) {
      state.latestBudget = request.budget
      if (status === 'prepared') { state.requests.push({ id: uid(), manifestId: manifest.id, hash: request.hash, at: now(), status, budget: request.budget }); state.requests = state.requests.slice(-200) }
      else {
        const record = state.requests.at(-1)
        if (record?.hash === request.hash && record.manifestId === manifest.id) { record.status = status; record.responseId = reply?.responseId }
        if (reply?.usage) mergeUsage(request, reply.usage)
      }
      save()
    },
    usage(request, usage) { mergeUsage(request, usage); save() },
  }
  const measuredConnection: Connection = { ...connection,
    onRequest: () => { budgetLease?.reserve('requests'); connection.onRequest?.() },
    onOperation: operation => { state.operations = [...(state.operations ?? []).filter(o => o.id !== operation.id), operation].slice(-100); save() },
  }
  return { artifacts, records, state, previousSnapshot, withLease,
    reserveTool: () => budgetLease?.reserve('tools'),
    async run(input: RuntimeInput, ports: RuntimePorts, signal: AbortSignal): Promise<RunOutcome> {
      let outcome: RunOutcome
      try { outcome = await withLease(signal, activeSignal => runRuntime(input, ports, activeSignal)) }
      catch (error) { outcome = { status: 'failed', error } }
      return outcome
    }, model: {
    prepare: (prompt, messages, tools) => prepareModelRequest(connection, prompt, messages, tools, true),
    verify: (prepared, signal) => verifyModelRequest({ ...connection,
      onRequest: () => { budgetLease?.reserve('requests'); connection.onRequest?.() },
      onOperation: operation => { state.operations = [...(state.operations ?? []).filter(o => o.id !== operation.id), operation].slice(-100); save() },
    }, prepared, signal),
    send: ({ prepared, prompt, messages, tools, onUsage }, signal) => complete({ ...connection,
      onRequest: () => { budgetLease?.reserve('requests'); connection.onRequest?.() },
      onResponse: update => { if (update.usage) onUsage(update.usage) } }, prompt, messages, tools, signal, listener ?? (() => {}), prepared),
    native: responsesCompaction(measuredConnection, artifacts),
  } satisfies RuntimePorts['model'], finish(outcome: RunOutcome) {
    state.status = outcome.status === 'failed' && outcome.error instanceof CumulativeBudgetPause ? 'paused' : outcome.status
    state.reason = outcome.status === 'paused' ? outcome.reason : outcome.status === 'failed' || outcome.status === 'cancelled' ? store.redact(String(outcome.error)) : undefined
    try { save() } catch (error) { state.status = 'failed'; state.reason = '运行结果尚未可靠保存：' + store.redact(String(error)); throw error }
    if (outcome.status === 'completed') return outcome.reply
    if (outcome.status === 'paused') throw new Error(outcome.reason)
    throw outcome.error
  } }
}
