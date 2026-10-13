import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { EngineeringStore } from './store'
import type { Project, Feature } from '../../shared/engineering'
import { commandResources, type CommandResources } from './command-resources'
import { authorizeCommand, assertPreparationChanges, runCommand, safePath } from './files'
import { ExecutionArtifacts } from './execution-artifacts'
import { commandEvidenceKinds, type CommandEvidence, type ExecutionRole } from './execution'
import { commandFailure, runtimeMeasurements } from './verification'
import { RecoveryRequired, EffectUncertain, ReliabilityFailure } from './reliability'
import { sealReceipt, type ReceiptResult, type ToolReceipt } from './receipt-ledger'

export interface CommandEffect {
  version: 1
  runId: string
  nonce: string
  root: string
  before: CommandResources
  evidence: Pick<CommandEvidence, 'id' | 'taskRevision' | 'contractFingerprint' | 'environmentFingerprint' | 'executionRunId' | 'stepId' | 'logicalCallId' | 'providerCallId' | 'sourceFingerprint'>
}
export interface CommandOutcome {
  evidence: CommandEvidence
  after: CommandResources
  changes: { path: string; before: string | null; after: string | null }[]
  boundaryError?: string
  stoppedConfirmed: boolean
  rawOutput: { bytes: number; totalBytes: number; complete: boolean; sha256: string }
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function intact(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { integrity, ...body } = value; return integrity === hash(JSON.stringify(body))
}
function resourcesValid(root: string, value: any): value is CommandResources {
  if (!value || typeof value !== 'object') return false
  for (const name of ['versions', 'texts', 'protected']) {
    const map = value[name]; if (!map || typeof map !== 'object' || Array.isArray(map)) return false
    for (const [path, content] of Object.entries(map)) {
      if (!path || typeof content !== 'string' || name === 'versions' && !/^[a-f0-9]{64}$/.test(content)) return false
      try { safePath(root, path) } catch { return false }
    }
  }
  return true
}
export function assertCommandResult(record: ToolReceipt): void {
  const outcome = record.result?.command, effect = record.command, evidence = outcome?.evidence
  if (!effect || !outcome || !evidence || outcome.stoppedConfirmed !== true || !resourcesValid(effect.root, outcome.after) ||
    Object.entries(effect.evidence).some(([key, value]) => (evidence as any)[key] !== value) || evidence.runId !== effect.runId ||
    typeof evidence.output !== 'string' || typeof evidence.at !== 'string' || typeof evidence.durationMs !== 'number' || !Number.isSafeInteger(evidence.durationMs) || evidence.durationMs < 0 ||
    !Number.isInteger(evidence.code) || record.status === 'completed' && evidence.code !== 0 || record.status !== 'completed' && evidence.code === 0 ||
    record.result?.status !== record.status || !Array.isArray(outcome.changes) || !Number.isSafeInteger(outcome.rawOutput?.bytes) ||
    outcome.rawOutput.bytes < 0 || typeof outcome.rawOutput.complete !== 'boolean' || !/^[a-f0-9]{64}$/.test(outcome.rawOutput.sha256))
    throw new RecoveryRequired('命令结果的身份、状态或资源不完整，禁止投影。')
  const seen = new Set<string>()
  for (const change of outcome.changes) {
    if (!change || typeof change.path !== 'string' || seen.has(change.path) || change.before !== (effect.before.texts[change.path] ?? null) ||
      change.after !== (outcome.after.texts[change.path] ?? null) || effect.before.versions[change.path] === outcome.after.versions[change.path])
      throw new RecoveryRequired('命令变更与保存资源不一致，禁止投影。')
    safePath(effect.root, change.path); seen.add(change.path)
  }
}
const scopeDirectory = (store: EngineeringStore, project: Project, feature: Feature) => join(dirname(store.path), 'engineering-commands', createHash('sha256').update(JSON.stringify([project.id, feature.id])).digest('hex'))
const directory = (store: EngineeringStore, project: Project, feature: Feature, effect: CommandEffect) => {
  if (!/^[a-f0-9-]{36}$/.test(effect.runId) || !/^[a-f0-9-]{36}$/.test(effect.nonce) || effect.version !== 1 || effect.root !== project.root) throw new RecoveryRequired('命令运行身份或项目范围不一致。')
  return join(scopeDirectory(store, project, feature), effect.runId)
}
export function prepareCommandEffect(store: EngineeringStore, project: Project, feature: Feature, role: ExecutionRole, args: any, evidence: CommandEffect['evidence']): CommandEffect {
  authorizeCommand(project, role, args)
  const used = (path: string): number => !existsSync(path) ? 0 : readdirSync(path, { withFileTypes: true }).reduce((sum, item) => {
    if (item.isSymbolicLink()) throw new RecoveryRequired('命令制品目录存在未知链接，请核对。')
    const child = join(path, item.name); return sum + (item.isDirectory() ? used(child) : statSync(child).size)
  }, 0)
  if (used(scopeDirectory(store, project, feature)) > 96_000_000) throw new RecoveryRequired('命令持久记录达到每功能128MB保护上限，保留原件，未启动新命令。')
  const before = commandResources(project.root)
  for (const path of Object.keys(before.texts)) before.texts[path] = store.redact(before.texts[path])
  for (const path of Object.keys(before.protected)) before.protected[path] = store.redact(before.protected[path])
  if (Buffer.byteLength(JSON.stringify(before)) > 8_000_000) throw new RecoveryRequired('命令前资源记录超过8MB上限，未启动命令。')
  return { version: 1, runId: randomUUID(), nonce: randomUUID(), root: project.root, before, evidence }
}
export function assertCommandReceipt(project: Project, record: ToolReceipt): void {
  const effect = record.command
  if (!effect || effect.version !== 1 || effect.root !== project.root || !effect.before?.versions || !effect.before?.texts || !effect.before?.protected ||
    effect.evidence?.logicalCallId !== record.logicalId || effect.evidence?.providerCallId !== record.providerCallId || effect.evidence?.taskRevision !== record.taskRevision ||
    !['developer', 'reviewer', 'preparer'].includes(record.role)) throw new RecoveryRequired('命令意图、权限或资源记录无效；禁止重跑。')
}
export async function executeCommandEffect(store: EngineeringStore, project: Project, feature: Feature, record: ToolReceipt, signal: AbortSignal): Promise<ReceiptResult> {
  assertCommandReceipt(project, record); authorizeCommand(project, record.role as ExecutionRole, record.args)
  const effect = record.command!, args = record.args as any
  if (JSON.stringify(commandResources(project.root).versions) !== JSON.stringify(effect.before.versions)) throw new EffectUncertain('命令启动前源码已变化，未运行；请核对原意图。')
  try { await runCommand(project.root, args.program, args.args, args.timeoutSeconds, signal, text => store.event(project, 'output', text, feature.id), record.role !== 'developer', undefined,
    { runId: effect.runId, nonce: effect.nonce, directory: directory(store, project, feature, effect), maxOutputBytes: 16_000_000, secrets: store.artifactHost().secrets() }) }
  catch (error) { if (error instanceof ReliabilityFailure) throw error; throw new EffectUncertain('命令宿主未获得完整结果：' + String(error)) }
  const completed = reconcileCommandReceipt(store, project, feature, record)
  if (!completed.result || completed.status === 'uncertain') throw new EffectUncertain(completed.reason ?? '命令效果未知。')
  return completed.result
}
export function reconcileCommandReceipt(store: EngineeringStore, project: Project, feature: Feature, record: ToolReceipt): ToolReceipt {
  assertCommandReceipt(project, record)
  const effect = record.command!, folder = directory(store, project, feature, effect)
  const uncertain = (reason: string): ToolReceipt => {
    const effects: string[] = [], partial = { runId: effect.runId, stoppedConfirmed: false as const, artifact: record.partialCommand?.artifact, observedAt: new Date().toISOString() }
    try {
      const output = readFileSync(join(folder, 'output.log')); if (output.length > 16_000_000) throw new Error('输出超过上限')
      const stream = new ExecutionArtifacts(store.artifactHost(), project.id, feature.id).stream('待核对命令部分输出 ' + effect.runId, true)
      stream.append(store.redact(output.toString('utf8'))); partial.artifact = stream.finish().artifact
      if (partial.artifact) partial.artifact.complete = false
      effects.push('已保存部分输出；结束凭证未通过核对，不作为成功证据。')
    } catch { effects.push('部分输出暂不可读取。') }
    try { const actual = commandResources(project.root); effects.push(...[...new Set([...Object.keys(effect.before.versions), ...Object.keys(actual.versions)])]
      .filter(path => effect.before.versions[path] !== actual.versions[path]).map(path => '当前观察到文件变化（来源与最终效果待核对）：' + path)) }
    catch { effects.push('当前文件范围或版本暂不可核对。') }
    return { ...record, result: undefined, resultHash: undefined, status: 'uncertain', effects, partialCommand: partial, reason, updatedAt: new Date().toISOString(), nextStep: '核对受控进程停止凭证、部分输出及当前文件；保留原件，不能默认重新运行。' }
  }
  if (!existsSync(join(folder, 'result.json'))) return uncertain('尚无监督进程的持久结束凭证；停止与部分效果均待核对。')
  let raw: any, launch: any
  try { raw = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')); launch = JSON.parse(readFileSync(join(folder, 'launch.json'), 'utf8')) }
  catch { return uncertain('命令结束或启动凭证无法读取。') }
  if (!intact(raw) || !intact(launch) || raw.version !== 1 || raw.runId !== effect.runId || raw.nonce !== effect.nonce || raw.root !== project.root || launch.runId !== effect.runId || launch.nonce !== effect.nonce ||
    launch.supervisorPid !== raw.supervisorPid || launch.childPid !== raw.childPid || !raw.stoppedConfirmed || !['completed', 'failed', 'cancelled'].includes(raw.status) ||
    !Number.isSafeInteger(raw.durationMs) || raw.durationMs < 0 || !Number.isInteger(raw.code) || typeof raw.output !== 'string' || !resourcesValid(project.root, raw.resources) ||
    raw.rawOutput?.file !== 'output.log' || !Number.isSafeInteger(raw.rawOutput?.bytes) || raw.rawOutput.bytes < 0 || raw.rawOutput.bytes > 16_000_000 || typeof raw.rawOutput.complete !== 'boolean') return uncertain('命令凭证不完整或无法确认受控进程停止；未推定无修改。')
  const after: CommandResources = raw.resources, changes: CommandOutcome['changes'] = []
  for (const path of new Set([...Object.keys(effect.before.texts), ...Object.keys(after.texts)])) {
    if (effect.before.versions[path] === after.versions[path]) continue
    // Binary/oversized replacements are still visible in effects, never projected as a deletion.
    if (after.versions[path] && after.texts[path] === undefined || effect.before.versions[path] && effect.before.texts[path] === undefined) continue
    changes.push({ path, before: effect.before.texts[path] ?? null, after: store.redact(after.texts[path] ?? '') || (after.texts[path] === undefined ? null : '') })
  }
  const changedPaths = [...new Set([...Object.keys(effect.before.versions), ...Object.keys(after.versions)])].filter(path => effect.before.versions[path] !== after.versions[path])
  let boundaryError: string | undefined
  if (record.role === 'preparer') { try { assertPreparationChanges(new Map(Object.entries(effect.before.protected)), new Map(Object.entries(after.protected))) } catch (error) { boundaryError = String(error) } }
  let rawText: string
  try { const bytes = readFileSync(join(folder, 'output.log')); if (bytes.length !== raw.rawOutput.bytes || hash(bytes) !== raw.rawOutput.sha256) return uncertain('命令输出摘要或长度与持久凭证不一致。'); rawText = bytes.toString('utf8') }
  catch { return uncertain('命令原始输出无法读取。') }
  const stream = new ExecutionArtifacts(store.artifactHost(), project.id, feature.id).stream('命令 ' + effect.runId + '：恢复可追溯输出'); stream.append(rawText)
  const archive = stream.finish(), args = record.args as any, evidenceKinds = commandEvidenceKinds(args)
  const evidence: CommandEvidence = { ...effect.evidence, runId: effect.runId, at: raw.finishedAt, code: boundaryError ? -1 : raw.code,
    output: store.redact(raw.output + (raw.reason ? '\n' + raw.reason : '') + (boundaryError ? '\n' + boundaryError : '')), durationMs: raw.durationMs,
    artifact: archive.artifact, command: `${args.program} ${args.args.join(' ')}`, evidenceKind: evidenceKinds[0], evidenceKinds,
    isTest: args.program === 'npm' ? args.args[0] === 'test' || args.args[0] === 'run' && /^test(?::|$)/.test(args.args[1] ?? '') : /(^|[/.\\_-])(tests?|smoke|check|verify|verification)([/.\\_-]|$)/i.test(args.args[0] ?? '') }
  evidence.failureKind = commandFailure(evidence.output, evidence.code); evidence.measurements = runtimeMeasurements(evidence.output)
  const effects = ['受控进程已结束；' + (raw.rawOutput.complete ? '原始输出已完整保存' : '原始输出达到上限，仅保存部分'), ...changedPaths.map(path => '已观察文件变化：' + path)]
  const result: ReceiptResult = { status: boundaryError ? 'failed' : raw.status, output: JSON.stringify({ ...evidence, evidenceId: evidence.id, artifact: archive.artifact, archiveError: archive.archiveError, rawOutput: raw.rawOutput }),
    sourceVersion: effect.evidence.sourceFingerprint, changed: changedPaths.length > 0, effects, command: { evidence, after, changes, boundaryError, stoppedConfirmed: true, rawOutput: raw.rawOutput } }
  return sealReceipt({ ...record, result, partialCommand: undefined, status: result.status!, effects, reason: boundaryError ?? (raw.reason || undefined), nextStep: undefined, updatedAt: new Date().toISOString() })
}
