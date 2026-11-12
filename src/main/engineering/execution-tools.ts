import type { RuntimePorts } from './runtime'
import type { ExecutionRun } from './service'
import type { AgentConfig, AgentRole, Project, toolLabels } from '../../shared/engineering'
import type { skillReader } from './skills'
import { now, uid, type EngineeringStore } from './store'
import { planReadGroup, checkReadGroup } from './read-groups'
import { receiptIntentHash, sealReceipt, type ToolReceipt } from './receipt-ledger'
import { applyReceiptProjection, reconcileFileReceipt, assertFileReceipt } from './execution-recovery'
import { prepareFileEffect, preparePatchEffect, applyFileEffect, fileEffectOutput, type FileEffect } from './file-effects'
import { prepareCommandEffect, executeCommandEffect, reconcileCommandReceipt, assertCommandReceipt, type CommandEffect } from './command-effects'
import { ReliabilityFailure, RecoveryRequired, EffectUncertain } from './reliability'
import { executeTool, PreparationBoundaryError } from './files'
import { TaskRevisionChanged } from './task-projection'
import { commandEvidenceKinds } from './execution'
import { commandFailure, verificationContract, runtimeMeasurements } from './verification'
import { toolContractVersion } from './tool-contract'

interface ExecutionToolsHost {
  store: EngineeringStore
  sourceFingerprint(project: Project): string
  agentSkillReader(project: Project, role: AgentRole, agent?: AgentConfig): ReturnType<typeof skillReader>
}
// Reads are losslessly paged. Other tool output is bounded and may be truncated.
function agentToolMessage(name: string, output: string): string {
  if (['read_context', 'read_file', 'read_file_lines', 'search_files'].includes(name)) return output
  const limit = 12_000
  if (output.length <= limit) return output
  const head = Math.max(1, limit - 1_200)
  return `${output.slice(0, head)}\n\n[工具输出已截断，仅保留前 ${head} 个字符与末尾 1000 字符；活动记录也可能截断。不要仅为找回输出而重复执行有副作用的命令；需完整证据时让检查程序写入项目文件，再用 read_file 分页读取。]\n\n${output.slice(-1_000)}`
}

export function executionTools(run: ExecutionRun, host: ExecutionToolsHost): RuntimePorts['tools'] {
  const { p, f, agent } = run
  return {
        planGroup: async (calls, toolSignal) => {
          if (!run.reliable || !calls.every(call => run.offered.some(t => t.name === call.name))) return undefined
          run.assertRevision()
          const plan = await planReadGroup(p.root, calls, agent.readConcurrency ?? 1, toolSignal)
          run.assertRevision(); return plan
        },
        checkGroup: async (calls, plan, toolSignal) => { run.assertRevision(); await checkReadGroup(p.root, calls, plan, toolSignal); run.assertRevision() },
        isFatal: error => error instanceof PreparationBoundaryError || error instanceof TaskRevisionChanged || error instanceof ReliabilityFailure,
        redact: value => host.store.redact(value),
        visible: agentToolMessage,
        execute: async (call, args, step, toolSignal, identity) => {
          let fileEffect: FileEffect | undefined
          let commandEffect: CommandEffect | undefined, commandIntent: ToolReceipt | undefined
          const authorize = () => {
            toolSignal.throwIfAborted(); run.assertRevision()
            const live = host.store.data.agents.find(a => a.id === agent.id && a.role === agent.role && (!a.ownerProjectId || a.ownerProjectId === p.id))
            if (!run.offered.some(t => t.name === call.name) || !live?.tools.includes(call.name as keyof typeof toolLabels)) throw new Error('当前角色不可使用此工具。')
          }
          const work = async () => {
          const beforeWrite = ['write_file', 'patch_file'].includes(call.name) ? host.sourceFingerprint(p) : ''
          let output = '', progressSource = ''
          try {
            const liveAgent = host.store.data.agents.find(a => a.id === agent.id && a.role === agent.role && (!a.ownerProjectId || a.ownerProjectId === p.id))
            if (!run.offered.some((t) => t.name === call.name) || !liveAgent?.tools.includes(call.name as keyof typeof toolLabels))
              throw new Error('当前角色不可使用此工具。')
            if (['write_file', 'patch_file', 'run_command'].includes(call.name) && run.prototypeReadUntil < run.prototypeLength)
              throw new Error('请先完整分页读取已验收原型 prototype:' + run.prototype!.id + '；当前已连续读取到 ' + run.prototypeReadUntil + ' 字符。')
            if (run.preparing) {
              p.activity = run.phaseLabel + (call.name === 'run_command' ? ' · 正在执行检查：' : ' · 执行工具：') + call.name + '「' + f.title + '」'
              host.store.save()
            }
            host.store.event(
              p,
              'tool',
              `${call.name} ${['write_file', 'patch_file', 'read_file', 'read_file_lines'].includes(call.name) ? args.path : call.name === 'search_files' ? args.scope : call.name === 'run_command' ? `${args.program} ${(args.args ?? []).join(' ')}` : ''}`,
              f.id,
            )
            const started = Date.now()
            const commandFingerprint = call.name === 'run_command' ? host.sourceFingerprint(p) : ''
            progressSource = commandFingerprint
            run.budgetLease?.check()
            if (commandIntent) return executeCommandEffect(host.store, p, f, commandIntent, toolSignal)
            if (fileEffect) { applyFileEffect(p.root, fileEffect, toolSignal); output = fileEffectOutput(fileEffect, call.name === 'patch_file') }
            else output = call.name === 'read_skill' ? host.agentSkillReader(p, agent.role, liveAgent)(args) : await executeTool(host.store, p, f.id, run.role, call.name, args, toolSignal)
            if (run.prototype && call.name === 'read_context' && args.id === 'prototype:' + run.prototype.id) {
              const page = JSON.parse(output)
              if (page.offset <= run.prototypeReadUntil) run.prototypeReadUntil = Math.max(run.prototypeReadUntil, page.offset + page.content.length)
            }
            if (call.name === 'run_command') {
              const result = JSON.parse(output)
              result.output = host.store.redact(result.output)
              const evidenceId = 'check-' + (run.commands.length + 1)
              const evidenceKinds = commandEvidenceKinds(args)
              run.commands.push({
                taskRevision: run.taskRevision, contractFingerprint: run.contractFingerprint, environmentFingerprint: run.environmentFingerprint, executionRunId: run.executionRunId, stepId: String(step), logicalCallId: uid(), providerCallId: call.id,
                ...result, id: evidenceId, at: now(), sourceFingerprint: commandFingerprint, durationMs: Date.now() - started,
                evidenceKind: evidenceKinds[0], evidenceKinds,
                failureKind: commandFailure(result.output, result.code),
                measurements: runtimeMeasurements(result.output),
                command: `${args.program} ${args.args.join(' ')}`,
                isTest:
                  args.program === 'npm'
                    ? args.args[0] === 'test' ||
                      (args.args[0] === 'run' && /^test(?::|$)/.test(args.args[1] ?? ''))
                    : /(^|[/.\\_-])tests?([/.\\_-]|$)/i.test(args.args[0] ?? ''),
              })
              if (args.program === 'node' && /(^|[./_-])(smoke|check|verify|verification)([./_-]|$)/i.test(args.args[0] ?? '')) run.commands[run.commands.length - 1].isTest = true
              output = JSON.stringify({ ...result, evidenceId, evidenceKinds, measurements: run.commands.at(-1)?.measurements, sourceFingerprint: commandFingerprint, durationMs: Date.now() - started })
            }
          } catch (error) {
            if (error instanceof PreparationBoundaryError || error instanceof TaskRevisionChanged || error instanceof ReliabilityFailure || error instanceof EffectUncertain) throw error
            if (toolSignal.aborted && ['read_file', 'read_file_lines', 'search_files'].includes(call.name)) return { output: '读取已取消；已保存调用状态，未完成内容不作为当前依据。', status: 'cancelled' as const }
            if (run.reliable) throw new Error(host.store.redact(error instanceof Error ? error.message : String(error)))
            output = '工具错误：' + (error instanceof Error ? error.message : String(error))
          }
          return { output, sourceVersion: progressSource, changed: ['write_file', 'patch_file'].includes(call.name) && beforeWrite !== host.sourceFingerprint(p),
            ...(fileEffect ? { effects: ['已写入 ' + fileEffect.path + '，版本 ' + fileEffect.expectedVersion] } : {}) }
          }
          if (!run.reliable) { authorize(); run.budgetLease?.reserve('tools'); return work() }
          if (!identity) throw new ReliabilityFailure('缺少已保存的逻辑调用身份。')
          const supported = ['read_skill', 'read_context', 'read_file', 'read_file_lines', 'search_files', 'list_files', ...(f.runtimePolicy === 'receipts-effects-v1' ? ['write_file', 'patch_file', 'run_command'] : [])]
          if (!supported.includes(call.name)) throw new RecoveryRequired('此运行版本尚未启用该副作用工具的恢复策略：' + call.name)
          if (['write_file', 'patch_file'].includes(call.name)) {
            authorize()
            if (host.store.redact(JSON.stringify(args)) !== JSON.stringify(args)) throw new Error('工具内容包含受保护连接密钥，不能写入或保存该意图。')
            const prior = run.ledger.get(identity.logicalId)
            if (prior) { assertFileReceipt(prior); fileEffect = prior.file }
            else {
              fileEffect = call.name === 'patch_file' ? preparePatchEffect(p, f.id, run.role, args) : prepareFileEffect(p, f.id, run.role, args as { path: string; content: string })
              if (call.name === 'patch_file' && (host.store.redact(fileEffect.before!) !== fileEffect.before || host.store.redact(fileEffect.after) !== fileEffect.after))
                throw new Error('补丁原文包含受保护连接密钥，无法可靠保存完整意图；未修改文件。')
              fileEffect.before = fileEffect.before === null ? null : host.store.redact(fileEffect.before)
            }
          }
          if (call.name === 'run_command') {
            authorize()
            if (host.store.redact(JSON.stringify(args)) !== JSON.stringify(args)) throw new Error('命令参数含受保护密钥，不能保存或执行。')
            const prior = run.ledger.get(identity.logicalId)
            if (prior) { assertCommandReceipt(p, prior); commandEffect = prior.command }
            else commandEffect = prepareCommandEffect(host.store, p, f, run.role, args, { id: 'check-' + (run.commands.length + 1), taskRevision: run.taskRevision, contractFingerprint: run.contractFingerprint, environmentFingerprint: run.environmentFingerprint,
              executionRunId: run.executionRunId, stepId: String(step), logicalCallId: identity.logicalId, providerCallId: call.id, sourceFingerprint: host.sourceFingerprint(p) })
          }
          const intent: ToolReceipt = { version: 1, logicalId: identity.logicalId, providerCallId: call.id, groupId: identity.groupId, manifestId: run.manifest.id,
            projectId: p.id, scopeId: f.id, agentId: agent.id, role: run.role, schemaVersion: run.ledger.get(identity.logicalId)?.schemaVersion ?? toolContractVersion, permissions: [...agent.tools],
            args: JSON.parse(host.store.redact(JSON.stringify(args))), taskRevision: run.taskRevision, resourceVersion: host.sourceFingerprint(p), strategy: commandEffect ? 'command-v1' : fileEffect ? 'file-v1' : 'readonly-v1', file: fileEffect, command: commandEffect, tool: call.name,
            preparationAttemptId: run.role === 'preparer' ? f.verificationPreparation?.attempts.at(-1)?.id : undefined,
            status: 'prepared', at: now(), updatedAt: now(), attempts: 0, effects: [], applied: false, intentHash: '' }
          intent.intentHash = receiptIntentHash(intent)
          if (commandEffect) commandIntent = intent
          const result = await run.ledger.execute(intent, () => { authorize(); run.budgetLease?.reserve('tools') }, async () => { const result = await work(); return { ...result, output: host.store.redact(result.output) } },
            async receipt => receipt.command ? reconcileCommandReceipt(host.store, p, f, receipt) : reconcileFileReceipt(p, receipt))
          if (fileEffect || commandEffect) applyReceiptProjection(host.store, p, f, run.ledger, run.ledger.get(identity.logicalId)!)
          if (result.command && !run.commands.some(c => c.logicalCallId === identity.logicalId)) run.commands.push(result.command.evidence)
          if (result.command?.boundaryError) throw new PreparationBoundaryError(result.command.boundaryError)
          if (run.prototype && call.name === 'read_context' && args.id === 'prototype:' + run.prototype.id && !result.output.startsWith('工具错误：')) {
            const page = JSON.parse(result.output)
            if (page.offset <= run.prototypeReadUntil) run.prototypeReadUntil = Math.max(run.prototypeReadUntil, page.offset + page.content.length)
          }
          return { ...result, ...(result.command && result.status === 'cancelled' ? { stopGroup: '命令已停止，已保留输出和文件变化；本组排队动作未启动，显式继续将开始新的模型回合。' } : {}) }
        },
        skip: (call, reason, identity) => {
          const previous = run.ledger.get(identity.logicalId)
          if (previous) {
            if (previous.strategy !== 'not-started-v1' || previous.groupId !== identity.groupId || previous.providerCallId !== call.id) throw new RecoveryRequired('取消组存在不一致的排队调用记录。')
            return previous.result!
          }
          const record: ToolReceipt = { version: 1, logicalId: identity.logicalId, providerCallId: call.id, groupId: identity.groupId, manifestId: run.manifest.id,
            projectId: p.id, scopeId: f.id, agentId: agent.id, role: run.role, schemaVersion: toolContractVersion, permissions: [...agent.tools],
            args: {}, skippedArguments: host.store.redact(call.arguments), taskRevision: run.taskRevision, resourceVersion: host.sourceFingerprint(p), strategy: 'not-started-v1', tool: call.name,
            status: 'cancelled', at: now(), updatedAt: now(), attempts: 0, effects: [], applied: true, intentHash: '', reason,
            result: { status: 'cancelled', output: '未启动：原工具组已取消；本调用没有执行。', changed: false } }
          record.intentHash = receiptIntentHash(record); run.ledger.put(sealReceipt(record)); return record.result!
        },
        received: (_call, output, identity) => {
          if (f.revision !== run.taskRevision || verificationContract(p, f) !== run.contractFingerprint) {
            host.store.event(p, 'historical-result', JSON.stringify({ taskRevision: run.taskRevision, executionRunId: run.executionRunId, commands: run.commands, output }), f.id)
            throw new TaskRevisionChanged()
          }
          const receipt = run.reliable && identity ? run.ledger.get(identity.logicalId) : undefined
          if (receipt) applyReceiptProjection(host.store, p, f, run.ledger, receipt)
          else if (run.role === 'preparer') {
            const attempt = f.verificationPreparation?.attempts.at(-1)
            const prior = attempt?.actions.slice()
            if (attempt) attempt.actions.push(_call.name + ': ' + output.slice(0, 1500))
            try { host.store.save() }
            catch (error) { if (attempt && prior) attempt.actions = prior; throw error }
          }
        },
      }
}
