import type { Connection, ModelMessage, ModelReply } from './model'
import type { DeltaListener } from './stream'
import { engineeringTools, executeReadOnly } from './files'
import { contextHash, readContext } from './context'
import type { Project, Feature } from '../../shared/engineering'
import type { EngineeringStore } from './store'
import { contextSession } from './context-session'
import { executeFileRead, fileReadTools } from './efficient-files'
import { compatibleSnapshot, continuityHash, newContinuity, portableMessages } from './context-continuity'

export interface PlanningHost { store: EngineeringStore; feature?: Feature; role?: 'planner' | 'designer'; agentId: string; operationId?: string }
export async function completeWithContext(connection: Connection, system: string, messages: ModelMessage[], project: Project, signal: AbortSignal,
  listener: DeltaListener | undefined, requiredContextIds: string[], readSkill: ((args: Record<string, any>) => string) | undefined, host: PlanningHost): Promise<ModelReply> {
  const allowed = () => host.store.data.agents.find(a => a.id === host.agentId && (!a.ownerProjectId || a.ownerProjectId === project.id))?.tools ?? []
  const tools = engineeringTools.filter(t => allowed().includes(t.name as any) && ['read_context', 'list_files', ...fileReadTools, ...(readSkill ? ['read_skill'] : [])].includes(t.name))
  const role = host.role ?? 'planner', owner = host.feature ?? project, revision = host.feature?.revision ?? 0
  const baseline = () => contextHash(JSON.stringify([project.brief, project.requirementsDocument, project.plannerId, project.designerId, project.teamAgentIds, host.feature?.revision, host.feature?.criteria,
    project.context.map(c => [c.id, c.content]), (project.prototypes ?? []).map(p => [p.id, p.html])]))
  const initial = baseline(), assertCurrent = () => { if (baseline() !== initial) throw new Error('规划资料或修订已变化，旧结果未提交；请重新读取当前版本。') }
  const session = contextSession(host.store, connection, owner, project.id, host.feature?.id ?? 'planning', revision, role,
    (kind, message) => host.store.event(project, kind, message, host.feature?.id), listener)
  const identity = JSON.stringify([project.id, host.feature?.id ?? 'planning', role, host.agentId])
  const contractHash = continuityHash([initial, system, messages, requiredContextIds, tools, host.operationId])
  const previous = session.previousSnapshot
  const compatible = compatibleSnapshot(previous, identity, contractHash) ? previous : undefined
  if (host.operationId && compatible?.continuity?.completedReply) {
    assertCurrent()
    return session.finish({ status: 'completed', reply: structuredClone(compatible.continuity.completedReply) })
  }
  const restored = compatible && !compatible.continuity?.completedReply ? compatible : undefined
  const continuity = restored?.continuity ?? newContinuity(identity, contractHash)
  const coverage = new Map(requiredContextIds.map(id => {
    const saved = continuity.requiredReads?.find(r => r.id === id)
    return [id, { read: saved?.read ?? 0, total: saved?.total ?? Infinity, version: saved?.version ?? '' }]
  }))
  const records = { ...session.records, save(snapshot: import('./runtime').RuntimeSnapshot) {
    const next = { ...(snapshot.continuity ?? continuity), requiredReads: [...coverage].map(([id, r]) => ({ id, ...r, total: Number.isFinite(r.total) ? r.total : null })) }
    session.records.save({ ...snapshot, continuity: next })
    Object.assign(continuity, next)
  } }
  if (restored) messages = portableMessages(restored.messages, connection)
  const outcome = await session.run({ instructions: system, messages, tools, continuity, stepLimit: 12, startStep: restored?.steps ?? 0, savedSteps: restored?.steps ?? 0,
    lastSequence: restored?.lastSequence, progress: restored?.progress, reads: restored?.reads,
    stepPrompt: () => coverage.size ? '\n必读资料进度：' + JSON.stringify([...coverage].map(([id, page]) => ({
      id, version: page.version || undefined, read: page.read, totalCharacters: Number.isFinite(page.total) ? page.total : null,
      complete: page.read >= page.total, nextOffset: page.read >= page.total ? null : page.read,
    }))) + '\n以上是本次实际工具读取的累计进度，不因历史压缩而清零。未读完的资料从 nextOffset 携带 version 继续；全部读完后整理本次要求的结果，不要从第 0 页重新遍历。若需要核对已归档的细节，按摘要中的归档引用定向读取。' : '',
    stepLabel: step => `规划读取资料 ${step + 1}/12`, conclusionLabel: '整理已读取的规划资料', replyKind: 'planning-result',
    contract: { inspect: text => text.trim() ? 'complete' : 'invalid', repairInstruction: '请仅根据已有资料输出本次要求的文本结果。',
      conclusionInstruction: '只整理已有资料，按当前要求返回结果。', canFinish: () => [...coverage.values()].every(c => c.read >= c.total), incompleteSourcesMessage: '未完整读取已确认原型，不能继续生成；请重试。' },
  }, { model: session.model, records, artifacts: { write: (content, label) => session.artifacts.write(content, label) },
    workspace: { assertCurrent, preparePrompt: prompt => { assertCurrent(); return prompt }, receivedReply: assertCurrent,
      readScope: JSON.stringify([project.id, host.feature?.id ?? 'planning', role]),
      provenance: reads => ({ taskRevision: revision, sources: ['project:' + project.id, 'planning:' + initial, ...reads.filter(r => r.active).map(r => r.sourceId + '@' + r.version)] }) },
    tools: { isFatal: () => false, redact: value => host.store.redact(value), visible: (_name, output) => output, received: () => {},
      execute: async (call, args) => {
        assertCurrent()
        if (!allowed().includes(call.name as any)) throw new Error('当前角色已无此工具权限。')
        session.reserveTool()
        // The portable runtime validates the offered schema before this read-only adapter.
        const output = call.name === 'read_skill' && readSkill ? readSkill(args) : fileReadTools.includes(call.name) ? await executeFileRead(project.root, call.name, args, signal) : executeReadOnly(project.root, call.name, args,
          { context: input => readContext(project, input), artifact: input => session.artifacts.read(input) })
        const tracked = call.name === 'read_context' ? coverage.get(args.id) : undefined
        if (tracked) {
          const page = JSON.parse(output)
          if (tracked.version && tracked.version !== page.version) tracked.read = 0
          tracked.version = page.version; tracked.total = page.totalCharacters
          if (page.offset <= tracked.read) tracked.read = Math.max(tracked.read, page.offset + page.content.length)
        }
        return { output }
      } },
  }, signal)
  return session.finish(outcome)
}
