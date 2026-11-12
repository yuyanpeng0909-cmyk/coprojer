import type { AgentConfig, Project, toolLabels } from '../../shared/engineering'
import type { RuntimePorts } from './runtime'
import type { ExecutionRun } from './service'
import type { ToolHook } from './tool-pipeline'
import type { ReceiptResult } from './receipt-ledger'
import { now, uid, type EngineeringStore } from './store'
import { PreparationBoundaryError } from './files'
import { applyReceiptProjection } from './execution-recovery'
import { commandEvidenceKinds } from './execution'
import { commandFailure, runtimeMeasurements } from './verification'

export interface ExecutionHookInvocation {
  call: Parameters<RuntimePorts['tools']['execute']>[0]
  args: Parameters<RuntimePorts['tools']['execute']>[1]
  step: number
  identity: Parameters<RuntimePorts['tools']['execute']>[4]
  liveAgent?: AgentConfig
  started: number
  commandFingerprint: string
  progressSource: string
  hasEffect: boolean
}

type ExecutionToolResult = ReceiptResult & { stopGroup?: string }
type ExecutionToolHook = ToolHook<ExecutionRun, ExecutionHookInvocation, ExecutionToolResult>
interface ExecutionHooksHost {
  store: EngineeringStore
  sourceFingerprint(project: Project): string
}

export function createExecutionHooks(host: ExecutionHooksHost) {
  const parameterSecrets: ExecutionToolHook = {
    name: 'parameter-secrets',
    beforeIntent: (_run, { call, args }) => {
          if (['write_file', 'patch_file'].includes(call.name)) {
            if (host.store.redact(JSON.stringify(args)) !== JSON.stringify(args)) throw new Error('工具内容包含受保护连接密钥，不能写入或保存该意图。')
          }
          if (call.name === 'run_command') {
            if (host.store.redact(JSON.stringify(args)) !== JSON.stringify(args)) throw new Error('命令参数含受保护密钥，不能保存或执行。')
          }
    },
  }
  const liveAgent: ExecutionToolHook = {
    name: 'live-agent',
    beforeExecute: (run, invocation) => {
      const { p, agent } = run
      const { call } = invocation
            invocation.liveAgent = host.store.data.agents.find(a => a.id === agent.id && a.role === agent.role && (!a.ownerProjectId || a.ownerProjectId === p.id))
            if (!run.offered.some((t) => t.name === call.name) || !invocation.liveAgent?.tools.includes(call.name as keyof typeof toolLabels))
              throw new Error('当前角色不可使用此工具。')
    },
  }
  const requiredPrototype: ExecutionToolHook = {
    name: 'required-prototype',
    beforeExecute: (run, { call }) => {
            if (['write_file', 'patch_file', 'run_command'].includes(call.name) && run.prototypeReadUntil < run.prototypeLength)
              throw new Error('请先完整分页读取已验收原型 prototype:' + run.prototype!.id + '；当前已连续读取到 ' + run.prototypeReadUntil + ' 字符。')
    },
  }
  const activity: ExecutionToolHook = {
    name: 'activity',
    beforeExecute: (run, invocation) => {
      const { p, f } = run
      const { call, args } = invocation
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
            invocation.started = Date.now()
            invocation.commandFingerprint = call.name === 'run_command' ? host.sourceFingerprint(p) : ''
            invocation.progressSource = invocation.commandFingerprint
    },
  }
  const budget: ExecutionToolHook = {
    name: 'budget',
    beforeExecute: run => { run.budgetLease?.check() },
  }
  const receiptProjection: ExecutionToolHook = {
    name: 'receipt-projection',
    afterSettle: (run, invocation, result) => {
      const { p, f } = run
      const identity = invocation.identity!
          if (invocation.hasEffect) applyReceiptProjection(host.store, p, f, run.ledger, run.ledger.get(identity.logicalId)!)
          if (result.command && !run.commands.some(c => c.logicalCallId === identity.logicalId)) run.commands.push(result.command.evidence)
          if (result.command?.boundaryError) throw new PreparationBoundaryError(result.command.boundaryError)
    },
  }
  const prototypeProgress: ExecutionToolHook = {
    name: 'prototype-progress',
    afterExecute: (run, { call, args }, output) => {
            if (run.prototype && call.name === 'read_context' && args.id === 'prototype:' + run.prototype.id) {
              const page = JSON.parse(output)
              if (page.offset <= run.prototypeReadUntil) run.prototypeReadUntil = Math.max(run.prototypeReadUntil, page.offset + page.content.length)
            }
    },
    afterSettle: (run, { call, args }, result) => {
          if (run.prototype && call.name === 'read_context' && args.id === 'prototype:' + run.prototype.id && !result.output.startsWith('工具错误：')) {
            const page = JSON.parse(result.output)
            if (page.offset <= run.prototypeReadUntil) run.prototypeReadUntil = Math.max(run.prototypeReadUntil, page.offset + page.content.length)
          }
    },
  }
  const legacyCommandEvidence: ExecutionToolHook = {
    name: 'legacy-command-evidence',
    afterExecute: (run, invocation, output) => {
      const { call, args, step, started, commandFingerprint } = invocation
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
      return output
    },
  }
  const commandStopGroup: ExecutionToolHook = {
    name: 'command-stop-group',
    afterSettle: (_run, _invocation, result) => {
          return { ...result, ...(result.command && result.status === 'cancelled' ? { stopGroup: '命令已停止，已保留输出和文件变化；本组排队动作未启动，显式继续将开始新的模型回合。' } : {}) }
    },
  }
  return { parameterSecrets, liveAgent, requiredPrototype, activity, budget, receiptProjection, prototypeProgress, legacyCommandEvidence, commandStopGroup }
}
