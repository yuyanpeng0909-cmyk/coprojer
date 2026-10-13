import type { EngineeringStore } from './store'
import type { Project, Feature } from '../../shared/engineering'
import { ReceiptLedger, sealReceipt, type ToolReceipt } from './receipt-ledger'
import { executionKey } from './execution'
import { readFileVersion, fileContentVersion, fileEffectOutput } from './file-effects'
import { patchedText } from './efficient-files'
import { RecoveryRequired } from './reliability'
import { sourceVersions, safePath } from './files'
import type { ExecutionCheckpoint } from './execution'
import type { PendingToolGroup } from './runtime'
import { assertCommandReceipt, reconcileCommandReceipt } from './command-effects'

const resourceKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
export function pendingSources(root: string, group: PendingToolGroup): Record<string, string> {
  const result = Object.fromEntries(Object.entries(sourceVersions(root)).map(([path, version]) => [resourceKey(path), version]))
  for (const call of group.assistant.calls ?? []) {
    if (!['write_file', 'patch_file'].includes(call.name)) continue
    try { const args = JSON.parse(call.arguments); const path = args.path.replace(/\\/g, '/'); result[resourceKey(path)] = readFileVersion(root, path) }
    catch { /* Invalid tool parameters still go through the normal contract error path. */ }
  }
  return result
}

export function featureReceiptLedger(store: EngineeringStore, project: Project, feature: Feature): ReceiptLedger {
  const key = executionKey(project.id, feature.id)
  return new ReceiptLedger({ load: () => store.data.receiptJournals?.[key], save: journal => {
    const journals = store.data.receiptJournals ??= {}, previous = journals[key], state = feature.contextRuntime, oldView = state?.receipts
    journals[key] = journal
    if (state) state.receipts = Object.values(journal.receipts).map(({ logicalId, tool, taskRevision, status, at, updatedAt, attempts, reason, effects, nextStep, applied, partialCommand }) =>
      ({ logicalId, tool, taskRevision, status, at, updatedAt, attempts, reason, effects, nextStep, applied, partialCommand }))
    try { store.save() } catch (error) { if (previous) journals[key] = previous; else delete journals[key]; if (state) state.receipts = oldView; throw error }
  } })
}
export function assertFileReceipt(record: ToolReceipt): void {
  const effect = record.file
  if (record.version !== 1 || record.strategy !== 'file-v1' || !['write_file', 'patch_file'].includes(record.tool) || !effect || typeof effect.path !== 'string' ||
    typeof effect.beforeVersion !== 'string' || !(effect.beforeVersion === 'absent' || /^[a-f0-9]{64}$/.test(effect.beforeVersion)) || effect.before !== null && typeof effect.before !== 'string' ||
    typeof effect.after !== 'string' || effect.expectedVersion !== fileContentVersion(effect.after))
    throw new RecoveryRequired('文件意图不完整或版本未知，不能推定成功或重写。')
  try {
    const expected = record.tool === 'patch_file' ? patchedText(effect.before!, record.args as any) : record.args.content
    if (effect.after !== expected) throw new Error('after mismatch')
  } catch { throw new RecoveryRequired('文件意图与原参数或补丁范围不一致，禁止补登记或重写。') }
}
export function reconcileFileReceipt(project: Project, record: ToolReceipt): ToolReceipt {
  assertFileReceipt(record)
  if (safePath(project.root, record.file!.path) !== safePath(project.root, record.args.path as string)) throw new RecoveryRequired('文件回执路径与保存参数不一致。')
  let actual: string
  try { actual = readFileVersion(project.root, record.file!.path) }
  catch (error) { return { ...record, status: 'uncertain', reason: '文件范围或版本无法核对：' + String(error), nextStep: '恢复正确项目路径与读取权限后重新核对。', updatedAt: new Date().toISOString() } }
  if (actual !== record.file!.expectedVersion) return { ...record, status: 'uncertain',
    reason: '当前文件与预期写入版本不一致；未默认重写。', effects: ['已核对 ' + record.file!.path + '，当前版本 ' + actual],
    nextStep: '人工核对文件内容与已保存意图；保留冲突后显式决定新的操作。', updatedAt: new Date().toISOString() }
  const effects = ['已确认 ' + record.file!.path + ' 与预期写入版本一致：' + actual]
  return sealReceipt({ ...record, status: 'completed', reason: '通过实际文件版本核对补齐完成回执，未重新写入。', effects, nextStep: undefined, updatedAt: new Date().toISOString(),
    result: { output: fileEffectOutput(record.file!, record.tool === 'patch_file'),
      changed: record.file!.beforeVersion !== actual, effects } })
}
export function applyReceiptProjection(store: EngineeringStore, project: Project, feature: Feature, ledger: ReceiptLedger, receipt: ToolReceipt): void {
  if (receipt.applied || !receipt.result || !['completed', 'failed', 'cancelled'].includes(receipt.status)) return
  const checkpoint = store.data.executionCheckpoints?.[executionKey(project.id, feature.id)], oldCommands = checkpoint?.commands.slice()
  const previous = structuredClone(project.changes), attempt = feature.verificationPreparation?.attempts.find(a => a.id === receipt.preparationAttemptId), actions = attempt?.actions.slice()
  try {
    if (receipt.taskRevision === feature.revision && receipt.result.command) {
      assertCommandReceipt(project, receipt)
      for (const change of receipt.result.command.changes) {
        safePath(project.root, change.path)
        const existing = project.changes.find(c => c.featureId === feature.id && c.path === change.path)
        if (existing) existing.after = change.after
        else project.changes.push({ ...change, featureId: feature.id })
      }
      if (checkpoint?.manifest?.id === receipt.manifestId && !checkpoint.commands.some(c => c.logicalCallId === receipt.logicalId)) checkpoint.commands.push(receipt.result.command.evidence)
    }
    if (receipt.taskRevision === feature.revision && receipt.file && receipt.status === 'completed') {
      assertFileReceipt(receipt)
      const effect = receipt.file, existing = project.changes.find(c => c.featureId === feature.id && c.path === effect.path)
      if (existing) existing.after = effect.after
      else project.changes.push({ featureId: feature.id, path: effect.path, before: effect.before, after: effect.after })
      if (receipt.role === 'preparer' && effect.before === null && attempt && !attempt.actions.includes('created:' + effect.path)) attempt.actions.push('created:' + effect.path)
    }
    if (receipt.taskRevision === feature.revision && receipt.role === 'preparer' && attempt) attempt.actions.push(receipt.tool + ': ' + receipt.result.output.slice(0, 1500))
    ledger.put({ ...receipt, applied: true, ...(receipt.taskRevision !== feature.revision ? { reason: '旧修订效果已保留历史，未修改当前业务登记或阶段。' } : {}) })
  } catch (error) { project.changes = previous; if (attempt && actions) attempt.actions = actions; if (checkpoint && oldCommands) checkpoint.commands = oldCommands; throw error }
}
/** Read and reconcile durable effects before any model request; consumes no execution allowance. */
export function reconcileFeatureReceipts(store: EngineeringStore, project: Project, feature: Feature): void {
  const ledger = featureReceiptLedger(store, project, feature)
  const checkpoint = store.data.executionCheckpoints?.[executionKey(project.id, feature.id)]
  for (let receipt of ledger.all()) {
    if (receipt.version !== 1 || receipt.projectId !== project.id || receipt.scopeId !== feature.id) throw new RecoveryRequired('调用回执范围或版本不符，请保留原件核对。')
    const index = checkpoint?.pending?.logicalIds.indexOf(receipt.logicalId) ?? -1
    if (index >= 0) {
      const group = checkpoint!.pending!, call = group.assistant.calls![index]
      if (receipt.groupId !== group.id || receipt.manifestId !== checkpoint!.manifest!.id || receipt.providerCallId !== call.id || receipt.tool !== call.name ||
        receipt.role !== checkpoint!.role || (receipt.strategy === 'not-started-v1' ? receipt.skippedArguments !== call.arguments : JSON.stringify(receipt.args) !== JSON.stringify(JSON.parse(call.arguments)))) throw new RecoveryRequired('回执与待恢复工具组身份不一致。')
    }
    if (receipt.file) {
      assertFileReceipt(receipt)
      if (safePath(project.root, receipt.file.path) !== safePath(project.root, receipt.args.path as string)) throw new RecoveryRequired('文件回执路径与保存参数不一致。')
    }
    if (receipt.strategy === 'file-v1' && ['running', 'uncertain'].includes(receipt.status)) { receipt = reconcileFileReceipt(project, receipt); ledger.put(receipt) }
    if (receipt.command) assertCommandReceipt(project, receipt)
    if (receipt.strategy === 'command-v1' && ['running', 'uncertain'].includes(receipt.status)) { receipt = reconcileCommandReceipt(store, project, feature, receipt); ledger.put(receipt) }
    applyReceiptProjection(store, project, feature, ledger, receipt)
    if (receipt.status === 'uncertain') throw new RecoveryRequired(receipt.reason ?? '仍有操作效果待核对。')
  }
}
export function assertPendingSources(store: EngineeringStore, project: Project, feature: Feature, checkpoint: ExecutionCheckpoint): void {
  if (!checkpoint.pending) return
  if (!checkpoint.pendingSources) throw new RecoveryRequired('待处理工具组缺少资源版本，不能推定外部修改已获授权。')
  const expected = { ...checkpoint.pendingSources }, ledger = featureReceiptLedger(store, project, feature)
  for (const id of checkpoint.pending.logicalIds) {
    const receipt = ledger.get(id)
    if (receipt?.file && receipt.status === 'completed') expected[resourceKey(receipt.file.path)] = receipt.file.expectedVersion
    if (receipt?.result?.command) {
      const before = receipt.command!.before.versions, after = receipt.result.command.after.versions
      for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[path] === after[path]) continue
        if (after[path]) expected[resourceKey(path)] = after[path]; else delete expected[resourceKey(path)]
      }
    }
  }
  const actual = pendingSources(project.root, checkpoint.pending), paths = new Set([...Object.keys(expected), ...Object.keys(actual)])
  if ([...paths].some(path => actual[path] !== expected[path])) throw new RecoveryRequired('工程包含本组已记录效果之外的修改；保留外部内容，停止排队动作，需重新读取并显式接续。')
}
