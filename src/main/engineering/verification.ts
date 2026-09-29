import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Feature, Project, VerificationGap, RuntimeMeasurement } from '../../shared/engineering'
import { commandEvidenceKinds, type CommandEvidence } from './execution'
import { nodeCommand } from './files'

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Normalize a model's decimal representation, never infer or expand evidence.
export function measuredDuration(value: unknown): number | undefined {
  const seconds = typeof value === 'number' ? value
    : typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}
// Keep the audit ledger intact. Only an actual later success of the same
// command, source and evidence scope resolves a prior failed attempt.
export function currentCommandEvidence(commands: CommandEvidence[]): CommandEvidence[] {
  return commands.filter((command, index) => command.code === 0 || !command.sourceFingerprint ||
    !commands.slice(index + 1).some(later => later.code === 0 && later.command === command.command &&
      later.sourceFingerprint === command.sourceFingerprint && !commandEvidenceKinds(later).includes('history') &&
      commandEvidenceKinds(command).every(kind => commandEvidenceKinds(later).includes(kind))))
}
// Optional JSONL runner protocol, parsed from this command's actual stdout.
// Pair starts/completions by mode; never sum parallel instance durations.
export function runtimeMeasurements(output: string): RuntimeMeasurement[] {
  const starts = new Map<string, number>(), results = new Map<string, RuntimeMeasurement>()
  for (const line of output.split(/\r?\n/)) {
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row.mode !== 'string' || !row.mode || row.mode.length > 100) continue
    if (row.event === 'started' && Number.isFinite(row.durationMs) && row.durationMs > 0) {
      starts.set(row.mode, row.durationMs); results.delete(row.mode)
    }
    if (row.event === 'passed' && starts.has(row.mode) && Number.isFinite(row.delayMs) && Number.isFinite(row.observedDelayMs)) {
      results.set(row.mode, { mode: row.mode, durationSeconds: starts.get(row.mode)! / 1000,
        persistedTransitionDelayMs: row.delayMs, observedTransitionDelayMs: row.observedDelayMs })
    }
  }
  return [...results.values()]
}
export function measurementSummary(rows: RuntimeMeasurement[]): string {
  return rows.map(r => r.mode + '：单实例 ' + r.durationSeconds + ' 秒；持久化延迟 ' + r.persistedTransitionDelayMs +
    ' ms；外部观察延迟 ' + r.observedTransitionDelayMs + ' ms').join('；')
}
export const interactionEvidenceBoundary = '证据边界：真实应用进程中的属性断言、原生 API 调用、直接触发菜单回调只能证明 application，不能证明 desktop。验收条件涉及系统可见图标、鼠标悬停、点击菜单等用户实际操作时，必须覆盖对应真实输入和观察；不能把缺失步骤解释为本轮无需，也不能用待用户最终验收替代独立验证。没有真实输入/观察证据就保留对应部分 unverified，并核对是否可自动准备。不要增加验收文本和最新确认范围之外的平台、时长或操作要求。'
// Only explicit native interaction in the existing criterion triggers this
// conservative guard. It does not invent platforms, durations or new criteria.
export function nativeInteractionRequired(criterion: string): boolean {
  return /托盘|任务栏|桌面|原生菜单|系统菜单|system tray|taskbar|native menu|desktop/i.test(criterion) &&
    /悬停|鼠标|点击|单击|双击|菜单|拖拽|hover|mouse|click|menu|drag/i.test(criterion)
}
export function nativeEvidenceSupported(criterion: string, item: { evidenceKind?: string; evidence?: string } | undefined): boolean {
  if (!nativeInteractionRequired(criterion)) return true
  if (item?.evidenceKind !== 'desktop') return false
  const evidence = item.evidence || ''
  if (/API_CALLBACK_ONLY|callback.only|(?:仅|只有|只做)[^。\n]{0,30}(?:API|回调)|(?:直接调用|直接触发)[^。\n]{0,20}回调|(?:only|directly)[^.\n]{0,30}callback/i.test(evidence)) return false
  // Explicitly admitted missing native input cannot become a pass by relabeling.
  return !/(?:无法|未能|未做|未实测|未验证|缺少|没有)[^。\n]{0,60}(?:鼠标|悬停|桌面交互|原生输入)|(?:鼠标|悬停|桌面交互|原生输入)[^。\n]{0,40}(?:未验证|未实测|不可用)|(?:mouse|hover|desktop interaction|native input)[^.\n]{0,60}(?:not tested|not verified|unavailable|requires separate)/i.test(evidence)
}
export function preparationPrompt(role: 'diagnoser' | 'preparer'): string {
  if (role === 'diagnoser') return `VERIFICATION_DIAGNOSIS：只读诊断验证缺口。核对已有文件、脚本、依赖、主机事实和最新确认范围。没有脚本/缺开发依赖通常可自动补齐，不能直接推给用户。未知能力先检查；只有具体平台、设备、凭据、授权或确实不可提供的观察能力缺失才 external。混合缺口分别分类。不能运行命令或修改文件。输出 JSON {"gaps":[{"id":"原缺口ID","disposition":"automatic 或 external 或 unknown","reason":"核对过的文件/主机事实和判断依据","nextStep":"具体准备动作或最小外部输入"}],"summary":"结论"}。缺证据不等于业务缺陷；未知保留技术阻塞。`
  return `VERIFICATION_PREPARATION：承担单独可审计的验证准备，不负责实现业务或独立判定通过。只补齐 automatic 缺口。可添加 tests/test/__tests__/scripts/fixtures 测试脚本、冒烟脚本和夹具，添加 test:* 命令，安装明确缺失的项目开发依赖。npm install 必须 --save-dev --ignore-scripts（可加 --no-audit --no-fund）；安装生命周期需额外诊断，不自行解除限制。不能修改业务源码、生产依赖、原有脚本/断言或验收标准；不能用 mock 替换真实测试。已有脚本需修复时添加保留标准的补充检查脚本。必须用隔离目录：每次 run_command 提供 COPROJER_TEST_USER_DATA 和 COPROJER_EVIDENCE_DIR，截图/日志放后者。脚本必须在 finally 关闭自己创建的测试进程，不能操作无关进程或真实工作数据。只运行有界测试，不启动常驻服务。禁止系统安装、提权、付费和外部账号授权。若发现业务缺陷停止准备，输出 defect 并提供文件、复现和交接；不能擅自修复。最终只输出 JSON {"status":"ready 或 blocked 或 defect","summary":"已执行动作及实际结果","nextStep":"复验命令或具体技术阻塞与最小处理步骤"}。ready 只代表准备，必须独立验证重新执行，不能宣称功能通过。`
}
const brief = (value: unknown, fallback = ''): string => typeof value === 'string' ? value.trim().slice(0, 3000) : fallback
export function desktopCapability(): Record<string, unknown> {
  if (process.platform !== 'win32') return { platform: process.platform, checked: false, reason: '当前未提供此平台的原生桌面能力探测，先核对目标平台及项目驱动。' }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; Add-Type -AssemblyName System.Windows.Forms; [pscustomobject]@{interactive=[Environment]::UserInteractive; screens=[System.Windows.Forms.Screen]::AllScreens.Count; desktop=[System.Windows.Automation.AutomationElement]::RootElement.Current.BoundingRectangle.ToString()} | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  try {
    const facts = JSON.parse(result.stdout.trim())
    if (result.status !== 0 || typeof facts.interactive !== 'boolean') throw new Error('incomplete probe')
    return { platform: 'win32', checked: true, ...facts,
      available: facts.interactive && facts.screens > 0,
      ...(!facts.interactive || facts.screens < 1 ? { reason: '探测未发现可交互桌面或可用屏幕。' } : {}),
      meaning: '仅证明本机有可探测的交互桌面和 Windows UIAutomation/Forms；尚未证明目标应用的点击、悬停或截图通过。',
      nextStep: '需要原生鼠标证据时，可由验证准备添加有界 Node 检查，调用本机 PowerShell/.NET UIAutomation 与 Win32 输入，并隔离目标应用。仅操作本次启动的应用及已定位的对应托盘图标；必须记录真实输入结果，不能直接调用菜单回调替代。历史外部工具的截图/坐标错误不证明当前本机能力不可用。' }
  } catch {
    return { platform: 'win32', checked: true, available: false, reason: result.error?.message || result.stderr.trim().slice(0, 600) || '桌面能力探测未返回有效结果；保留技术阻塞，不假定需要人工。' }
  }
}
export function verificationContract(p: Project, f: Feature): string {
  return digest({ root: p.root, revision: f.revision, criteria: f.criteria, description: f.description, plan: f.plan,
    prototypeId: f.prototypeId, prototype: p.prototypes?.find(v => v.id === f.prototypeId), baseline: p.requirementsBaseline,
    targets: p.targets, dependencies: f.dependencies })
}
export function verificationEnvironment(p: Project): Record<string, unknown> {
  let runtime: Record<string, unknown>
  try { runtime = { node: nodeCommand('node', []).executable, npm: nodeCommand('npm', []).args[0], available: true } }
  catch (error) { runtime = { available: false, reason: error instanceof Error ? error.message : String(error) } }
  let manifest: any = {}
  try { manifest = JSON.parse(readFileSync(join(p.root, 'package.json'), 'utf8')) } catch { /* Missing manifest is diagnostic evidence. */ }
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).sort().map(name => {
    if (!/^(@[a-z0-9._-]+[/])?[a-z0-9._-]+$/i.test(name)) return [name, 'invalid-name']
    const file = join(p.root, 'node_modules', name, 'package.json')
    try { return [name, JSON.parse(readFileSync(file, 'utf8')).version] } catch { return [name, 'missing'] }
  })
  return { platform: process.platform, arch: process.arch, runtime, scripts: manifest.scripts ?? {}, dependencies,
    hasPackage: existsSync(join(p.root, 'package.json')),
    tools: '诊断可读取项目文件和确认基线；准备可写测试资料、添加 test:*、安装项目开发依赖；独立验证只能运行已有检查。',
    desktop: desktopCapability(),
    scope: '平台、时长、验收范围只取本项目最新确认基线；不要自动扩大。' }
}
export function commandFailure(output: string, code: number): CommandEvidence['failureKind'] {
  if (code === 0) return undefined
  // A nonzero check remains a defect unless the runner itself could not start.
  if (/ERR_ASSERTION|AssertionError|Tests?\s+\d+ failed|FAIL\s|error TS\d+/i.test(output)) return 'check'
  if (output.includes('DESKTOP_TECHNICAL_BLOCK:')) return 'condition'
  if (output.includes('临时目录清理失败')) return 'condition'
  return /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package|Missing script:|ENOENT|EACCES|EPERM|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|not recognized|command not found|命令运行超时|执行已停止|Executable doesn't exist/i.test(output) ? 'condition' : 'check'
}
export function pendingGaps(f: Feature): VerificationGap[] {
  const checks = [...f.criteria.map(criterion => f.results.find(r => r.criterion === criterion) ?? {
    criterion, status: 'unverified' as const, evidence: '缺少当前验收项的有效独立验证结果，需要重新执行检查。',
  }), ...(f.prototypeId && f.prototypeResult ? [{ ...f.prototypeResult, criterion: '已验收原型对照' }] : [])]
  return checks.filter(r => r.status === 'unverified').map(r => ({ id: digest(r.criterion).slice(0, 16), criterion: r.criterion,
    description: r.evidence, disposition: 'unknown', reason: '尚需核对当前工程和运行环境。', nextStep: '有界只读诊断。' }))
}
export function diagnosedGaps(gaps: VerificationGap[], raw: unknown,
  environment?: Record<string, unknown>, attemptedCurrentEnvironment = false): VerificationGap[] {
  const rows = Array.isArray(raw) ? raw : []
  return gaps.map(gap => {
    const item = rows.find(r => r?.id === gap.id || r?.criterion === gap.criterion)
    const reason = brief(item?.reason)
    const nextStep = brief(item?.nextStep)
    const disposition = reason && nextStep && ['automatic', 'external'].includes(item?.disposition) ? item.disposition : 'unknown'
    const desktop = environment?.desktop as ReturnType<typeof desktopCapability> | undefined
    // A model's lack of a ready-made driver is not a machine capability probe.
    // Prepare once using the observed local capabilities, then use the actual
    // attempt outcome. This never upgrades callback evidence to desktop input.
    if (nativeInteractionRequired(gap.criterion) && disposition !== 'automatic' && !attemptedCurrentEnvironment && desktop?.checked) {
      if (desktop.available) return { ...gap, disposition: 'automatic',
        reason: '当前本机探测支持有界准备；诊断文字尚不能证明真实输入不可用。' + brief(desktop.meaning) + ' 原诊断：' + reason,
        nextStep: brief(desktop.nextStep) || '创建隔离目标的有界桌面能力检查，记录定位、输入和观察；不能定位就保留具体技术阻塞。' }
      return { ...gap, disposition: 'unknown', reason: '当前桌面探测未能确认可用能力：' + brief(desktop.reason),
        nextStep: '核对本次探测失败和本地已有驱动；这是技术阻塞，不自动要求人工授权。' }
    }
    return { ...gap, disposition, reason: reason || '诊断未提供可核查依据；尚不能判为需要人工。', nextStep: nextStep || '检查执行记录，补充技术诊断后继续验证。' }
  })
}
