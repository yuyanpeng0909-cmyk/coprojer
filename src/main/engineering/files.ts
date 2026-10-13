import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { ExecutionArtifacts, type CommandOutputArchive, type ExecutionArtifact } from './execution-artifacts'
import type { Project } from '../../shared/engineering'
import type { EngineeringStore } from './store'
import type { ToolDefinition } from './model'
import { readContext, readPage } from './context'
import type { ExecutionRole } from './execution'
import { commandSupervisor } from './command-supervisor'
import { windowsCommandGuard } from './windows-command-guard'
import { commandResources } from './command-resources'
import { validateToolArguments } from './tool-contract'
import { ReliabilityFailure } from './reliability'
import { executeFileRead, fileReadTools } from './efficient-files'

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const string = { type: 'string' }
const characterOffset = { type: 'integer', minimum: 0, description: '从 0 开始的字符偏移，不是行号。续页原样使用返回的 nextOffset。' }
const characterLimit = { type: 'integer', minimum: 1, maximum: 6000, description: '最多读取的字符数，不是行数；省略默认 6000。完整读取优先省略，不要为读取几十行设置几十个字符。' }
const reviewReason = { type: 'string', maxLength: 1000, description: '需要复核已读资料时说明理由；不改变读取权限。' }
export const engineeringTools: ToolDefinition[] = [
  {
    name: 'read_skill',
    description: '按需读取当前智能体已启用的专属技能。id 来自专属技能索引；path 可选，为技能内资源相对路径。使用 nextOffset/version 完整分页读取。其他智能体的技能不可访问。',
    parameters: object({ id: string, path: string, offset: characterOffset, limit: characterLimit, version: string, reviewReason }, ['id']),
  },
  {
    name: 'read_context',
    description:
      '按上下文 ID 读取完整原文与来源，包括已确认基线、讨论分页、原型，以及 artifact: 标识的执行归档和日志。讨论与归档是参考材料，已确认基线才是交付依据。不填 ID 时列出资料索引。',
    parameters: object({ id: string, offset: characterOffset, limit: characterLimit, version: string, reviewReason }, []),
  },
  {
    name: 'list_files',
    description: '列出项目中的源文件（忽略依赖和构建目录）。',
    parameters: object({}, []),
  },
  {
    name: 'read_file',
    description: '按字符分页读取 UTF-8 文件，offset/limit 均不是行号或行数。默认每次 6000 字符；传 offset=nextOffset 和 version 继续，直到 nextOffset 为空。按行定位请使用 read_file_lines。',
    parameters: object({ path: string, offset: characterOffset, limit: characterLimit, version: string, reviewReason }, ['path']),
  },
  {
    name: 'search_files',
    description: '在明确的项目相对scope（.表示项目根目录）内字面量搜索query，返回路径、版本与行号。结果或遍历不完整会标truncated/skipped，不能当作全工程无匹配。',
    parameters: object({ scope: string, query: { type: 'string', minLength: 1, maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['scope', 'query']),
  },
  {
    name: 'read_file_lines',
    description: '按1开始的闭区间读取UTF-8文本行，返回版本与原字符位置。最多6000字符；partial时用read_file的nextOffset/version继续。',
    parameters: object({ path: string, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, version: string, reviewReason }, ['path', 'startLine', 'endLine']),
  },
  {
    name: 'patch_file',
    description: '读取后以expectedVersion、明确行范围及唯一匹配的oldText替换局部内容。版本、范围或匹配冲突时无修改；不自动退回整文件覆盖。',
    parameters: object({ path: string, expectedVersion: string, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, oldText: { type: 'string', minLength: 1, maxLength: 300000 }, newText: { type: 'string', maxLength: 300000 } }, ['path', 'expectedVersion', 'startLine', 'endLine', 'oldText', 'newText']),
  },
  {
    name: 'write_file',
    description: '创建或替换项目中的 UTF-8 文本文件；内容必须完整。不能修改 .coprojer。',
    parameters: object({ path: string, content: { type: 'string', maxLength: 300000 } }, ['path', 'content']),
  },
  {
    name: 'run_command',
    description:
      '在项目根目录执行 npm 或 node。每次一个命令，不使用 shell 拼接。使用 npm run build/test 验证；不要启动常驻开发服务。',
    parameters: object(
      {
        program: { type: 'string', enum: ['npm', 'node'] },
        args: { type: 'array', items: string, maxItems: 40 },
        timeoutSeconds: { type: 'number', minimum: 5, maximum: 300, description: '超时秒数；默认 120 秒，允许 5—300 秒。不接受 timeoutMs。' },
        evidenceKind: { type: 'string', enum: ['unit', 'mock', 'application', 'desktop', 'duration', 'history', 'inspection'] },
        evidenceKinds: { type: 'array', description: '本命令实际覆盖的证据类型；例如真实应用短时测量同时为 application 和 duration。不得把历史核对、mock 或 API 回调标为桌面输入。', items: { type: 'string', enum: ['unit', 'mock', 'application', 'desktop', 'duration', 'history', 'inspection'] } },
      },
      ['program', 'args'],
    ),
  },
]
/** Shared read path; callers supply only scoped content readers, never a store. */
export function executeReadOnly(root: string, name: string, args: Record<string, any>, readers: {
  context(args: Record<string, any>): string
  artifact(args: Record<string, any>): string
}): string {
  if (!['read_context', 'list_files', 'read_file'].includes(name)) throw new Error('当前端口只允许读取工具。')
  validateToolArguments(engineeringTools.find(t => t.name === name)!, args)
  if (name === 'read_context') return typeof args.id === 'string' && args.id.startsWith('artifact:') ? readers.artifact(args) : readers.context(args)
  if (name === 'list_files') return JSON.stringify(listFiles(root))
  const file = safePath(root, args.path)
  if (lstatSync(file).size > 400_000) throw new Error('文件过大，请拆分文件。')
  return readPage(readFileSync(file, 'utf8'), args)
}
export function safePath(root: string, name: string): string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\0') ||
    name.includes(':') ||
    isAbsolute(name)
  )
    throw new Error('必须提供项目内的相对路径。')
  const parts = name.split(/[\\/]/)
  if (
    parts.some(
      (p) =>
        p === '..' ||
        ['.git', '.coprojer', 'node_modules'].includes(p.toLowerCase()) ||
        (p !== '.' && /[. ]$/.test(p)),
    )
  )
    throw new Error('此路径不可由工程文件工具访问。')
  const target = resolve(root, name)
  const rel = relative(realpathSync(root), target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel))
    throw new Error('路径越过项目目录。')
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('不能通过符号链接访问工程文件。')
  }
  return target
}
/** In-place writes must not also modify aliases outside the authorized project. */
export function assertExclusiveWriteTarget(file: string): void {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat?.isFile() && stat.nlink > 1) throw new Error('不能修改存在硬链接的工程文件；其他路径可能指向项目外，文件未改动。')
}
export function listFiles(root: string): string[] {
  const result: string[] = []
  function walk(directory: string, depth: number): void {
    if (depth > 8 || result.length >= 600) return
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (
        item.isSymbolicLink() ||
        ['node_modules', '.git', '.coprojer', 'dist', 'out', 'coverage', '.runtime', '.scratch', '.cache', '.vite'].includes(item.name.toLowerCase())
      )
        continue
      const full = join(directory, item.name)
      if (item.isDirectory()) walk(full, depth + 1)
      else if (result.length < 600) result.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root, 0)
  return result
}
// Unlike the UI file listing this traverses the entire source tree. Lockfiles
// and binary sources participate; generated evidence belongs in .runtime.
// Existing projects may already write runtime artifacts to conventional report
// directories. Only images and self-describing execution records are outputs;
// scope documents, config JSON, fixtures and executable checks remain inputs.
function generatedVerificationArtifact(root: string, full: string): boolean {
  const name = relative(root, full).split(sep).join('/')
  if (!/^(verification|test-results|playwright-report)\/.+\//.test(name)) return false
  if (/\.(png|jpe?g|webp|webm|mp4)$/i.test(name)) return true
  if (!name.endsWith('.json') || lstatSync(full).size > 2_000_000) return false
  try {
    const record = JSON.parse(readFileSync(full, 'utf8'))
    const manifest = record?.sourceAndBuild
    return typeof record.startedAt === 'string' && Number.isFinite(Date.parse(record.startedAt)) &&
      ['running', 'passed', 'failed', 'cancelled'].includes(record.status) &&
      manifest && typeof manifest === 'object' && !Array.isArray(manifest) && Object.keys(manifest).length > 0 &&
      Object.values(manifest).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
  } catch { return false }
}
export function sourceFingerprint(root: string): string {
  const hash = createHash('sha256')
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git', '.coprojer', 'dist', 'out', 'coverage', '.runtime', '.scratch', '.cache', '.vite'].includes(entry.name.toLowerCase())) continue
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) { hash.update(relative(root, full) + ':symlink:' + lstatSync(full).mtimeMs); continue }
      if (entry.isDirectory()) walk(full)
      else if (!/\.(log|tsbuildinfo)$/.test(entry.name) && !generatedVerificationArtifact(root, full)) hash.update(relative(root, full) + '\0').update(readFileSync(full)).update('\0')
    }
  }
  walk(root)
  return hash.digest('hex')
}
/** Per-resource counterpart used only to explain changes during a pending group. */
export function sourceVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = {}
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.coprojer', 'dist', 'out', 'coverage', '.runtime', '.scratch', '.cache', '.vite'].includes(entry.name.toLowerCase())) continue
      const full = join(directory, entry.name), name = relative(root, full).split(sep).join('/')
      if (entry.isSymbolicLink()) versions[name] = 'symlink:' + lstatSync(full).mtimeMs
      else if (entry.isDirectory()) walk(full)
      else if (!/\.(log|tsbuildinfo)$/.test(entry.name) && !generatedVerificationArtifact(root, full)) versions[name] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root); return versions
}
const testPath = (path: string) => /^(tests?|__tests__|scripts|fixtures)[/]/.test(path) || /^(vitest|playwright)\.config\.[cm]?[jt]s$/.test(path)
export class PreparationBoundaryError extends Error {}
function preparationSnapshot(root: string): Map<string, string> {
  const result = new Map<string, string>()
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.coprojer', 'dist', 'out', 'coverage', '.runtime', '.scratch', '.cache', '.vite'].includes(entry.name.toLowerCase())) continue
      const full = join(directory, entry.name), name = relative(root, full).split(sep).join('/')
      if (entry.isSymbolicLink()) result.set(name, 'symlink:' + lstatSync(full).mtimeMs)
      else if (entry.isDirectory()) walk(full)
      else if (!generatedVerificationArtifact(root, full)) result.set(name, name === 'package.json' ? readFileSync(full, 'utf8') : createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(root); return result
}
export function assertPreparationChanges(before: Map<string, string>, after: Map<string, string>): void {
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name) === after.get(name) || name === 'package-lock.json') continue
    if (name === 'package.json' && before.has(name) && after.has(name)) {
      const old = JSON.parse(before.get(name)!), next = JSON.parse(after.get(name)!)
      if (JSON.stringify({ ...old, devDependencies: null }) === JSON.stringify({ ...next, devDependencies: null }) &&
        Object.entries(old.devDependencies ?? {}).every(([key, value]) => next.devDependencies?.[key] === value)) continue
    }
    throw new PreparationBoundaryError('准备命令改变了受保护工程文件：' + name + '。已停止并保留现场；需要检查实际差异，不能据此通过或自动覆盖恢复。')
  }
}
export function preparationWrite(project: Project, featureId: string, path: string, content: string): void {
  const file = safePath(project.root, path)
  const canonical = relative(project.root, file).split(sep).join('/')
  if (canonical === 'package.json') {
    const before = JSON.parse(readFileSync(file, 'utf8')), after = JSON.parse(content)
    const previous = before.scripts ?? {}, next = after.scripts ?? {}
    if (JSON.stringify({ ...before, scripts: null }) !== JSON.stringify({ ...after, scripts: null }) ||
      Object.entries(previous).some(([key, value]) => next[key] !== value) ||
      Object.keys(next).some(key => !(key in previous) && !/^test(?::[\w-]+)+$/.test(key)))
      throw new Error('准备阶段只可新增 test:* 命令；保留原有命令、依赖和其余项目配置。依赖通过受限 npm install 安装。')
    return
  }
  if (!testPath(canonical)) throw new Error('准备阶段只能写入 tests/test/__tests__/scripts/fixtures 测试资料，不能修改业务源码。')
  const owned = project.features.find(f => f.id === featureId)?.verificationPreparation?.attempts
    .some(attempt => attempt.actions.includes('created:' + canonical))
  if (existsSync(file) && !owned && readFileSync(file, 'utf8') !== content)
    throw new Error('准备阶段保留原有脚本和断言；请添加补充检查脚本，不能覆盖已有测试或降低标准。')
  const previous = project.changes.find(c => c.featureId === featureId && c.path === canonical)
  if (owned && existsSync(file) && previous?.after !== readFileSync(file, 'utf8'))
    throw new Error('此测试资料已被外部修改，准备阶段不能覆盖；请新增补充检查。')
}
function preparationCommand(project: Project, args: any): void {
  const argv = args.args as string[]
  if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new Error('命令参数必须是字符串数组。')
  if (args.program === 'npm' && ['install', 'add', 'i'].includes(argv[0])) {
    const flags = new Set(['--save-dev', '-D', '--ignore-scripts', '--no-audit', '--no-fund'])
    const specs = argv.slice(1).filter(a => !flags.has(a))
    if (!argv.includes('--ignore-scripts') || !(argv.includes('--save-dev') || argv.includes('-D')) || specs.length !== 1)
      throw new Error('准备只允许 npm install --save-dev --ignore-scripts <一个明确缺失的开发依赖>，不运行安装生命周期脚本。')
    const spec = specs[0]
    let name: string
    if (spec.startsWith('file:')) {
      const path = spec.slice(5)
      if (!/^tests?[/]fixtures[/]/.test(path)) throw new Error('离线依赖只允许项目 tests/fixtures 内的包。')
      name = JSON.parse(readFileSync(safePath(project.root, path + '/package.json'), 'utf8')).name
    } else {
      const match = /^((?:@[a-z0-9._-]+[/])?[a-z0-9][a-z0-9._-]*)(?:@([\w.^~*-]+))?$/.exec(spec)
      if (!match) throw new Error('只允许明确的 npm 包及版本；不允许全局安装、URL、外部路径或安装参数。')
      name = match[1]
    }
    if (!/^(@[a-z0-9._-]+[/])?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('依赖名称无效。')
    const manifest = JSON.parse(readFileSync(safePath(project.root, 'package.json'), 'utf8'))
    if (manifest.dependencies?.[name]) throw new Error('准备阶段不能变更生产依赖。')
    if (existsSync(join(project.root, 'node_modules', name, 'package.json'))) throw new Error('依赖已存在，不重复安装或升级。')
    if (manifest.devDependencies?.[name] && spec !== name && spec !== `${name}@${manifest.devDependencies[name]}`)
      throw new Error('已声明的开发依赖必须保留其版本。')
    return
  }
  if (args.program === 'npm' && ((argv.length === 1 && argv[0] === 'test') ||
    (argv.length === 2 && argv[0] === 'run' && /^(test(?::[\w-]+)*|build|typecheck|lint|check)$/.test(argv[1])))) return
  if (args.program === 'node' && argv.length === 1 && testPath(argv[0].replace(/\\/g, '/'))) { safePath(project.root, argv[0]); return }
  throw new Error('准备阶段只能执行项目检查/构建脚本或安装缺失的开发依赖；不允许内联代码、系统安装、常驻进程或外部命令。')
}
async function commandGuard(directory: string): Promise<string> {
  const source = windowsCommandGuard(), version = createHash('sha256').update(source).digest('hex')
  const folder = join(dirname(dirname(directory)), 'native-guard', version)
  const executable = join(folder, 'guard.exe'), digest = executable + '.sha256'
  if (existsSync(executable) && existsSync(digest) && createHash('sha256').update(readFileSync(executable)).digest('hex') === readFileSync(digest, 'utf8')) return executable
  const compiler = ['Framework64', 'Framework'].map(name => join(process.env.SystemRoot!, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')).find(existsSync)
  if (!compiler) throw new ReliabilityFailure('缺少 Windows 命令守护编译器；未启动命令。')
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'guard.cs'), source)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(compiler, ['/nologo', '/target:exe', '/out:' + executable, join(folder, 'guard.cs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let diagnostic = ''; child.stdout.on('data', c => { diagnostic += c }); child.stderr.on('data', c => { diagnostic += c })
    const timer = setTimeout(() => { child.kill(); reject(new ReliabilityFailure('Windows 命令守护准备超时，未启动命令。')) }, 30000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); if (code) reject(new ReliabilityFailure('Windows 命令守护准备失败：' + diagnostic)); else resolve() })
  })
  writeFileSync(digest, createHash('sha256').update(readFileSync(executable)).digest('hex'))
  return executable
}
export function nodeCommand(
  program: string,
  args: string[],
): { executable: string; args: string[] } {
  if (
    !['node', 'npm'].includes(program) ||
    !Array.isArray(args) ||
    args.some((a) => typeof a !== 'string' || a.includes('\0')) ||
    args.length > 40
  )
    throw new Error('仅支持 npm/Node 工程命令及字符串参数。')
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const node = lookup.stdout?.trim().split(/\r?\n/)[0]
  if (!node || !existsSync(node))
    throw new Error('未找到 Node.js，请安装 Node.js 后重新启动 Coprojer。')
  if (program === 'node') return { executable: node, args }
  const candidates = [
    join(dirname(node), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  const npm = candidates.find(existsSync)
  if (!npm) throw new Error('未找到 npm，请检查 Node.js 安装。')
  return { executable: node, args: [npm, ...args] }
}
export function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed =
    /^(path|systemroot|windir|temp|tmp|appdata|localappdata|programfiles(?:\(x86\))?|programdata|comspec|pathext|userprofile|home|lang|lc_all|systemdrive|number_of_processors)$/i
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)))
}
export function killTree(pid: number): void {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* Already exited. */
      }
    }
  }
}
export function cleanupVerificationRuns(root: string): void {
  if (!existsSync(root)) return
  let directory: string
  try { directory = safePath(root, '.runtime/coprojer-checks') } catch { return }
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
    try {
      const run = safePath(root, '.runtime/coprojer-checks/' + entry.name)
      const lease = JSON.parse(readFileSync(join(run, 'lease.json'), 'utf8'))
      if (lease.kind !== 'coprojer-verification-run' || lease.id !== entry.name || lease.root !== realpathSync(root) || !Number.isInteger(lease.pid)) continue
      let active = true
      try { process.kill(lease.pid, 0) } catch (error) { active = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      // Never kill a saved PID: it might have been reused by an unrelated app.
      if (!active) rmSync(run, { recursive: true, force: true, maxRetries: 3 })
    } catch { /* Retain unknown or busy files; do not widen cleanup scope. */ }
  }
}
export async function runCommand(
  root: string,
  program: string,
  args: string[],
  seconds: number,
  signal: AbortSignal,
  progress: (text: string) => void,
  isolated = false,
  createArchive?: (runId: string) => CommandOutputArchive,
  durable?: { runId: string; nonce: string; directory: string; maxOutputBytes: number; secrets: string[] },
): Promise<{ code: number; output: string; runId: string; artifact?: ExecutionArtifact; archiveError?: string }> {
  signal.throwIfAborted()
  if (isolated) cleanupVerificationRuns(root)
  const command = nodeCommand(program, args)
  const runId = durable?.runId ?? randomUUID()
  const runtime = isolated ? safePath(root, '.runtime/coprojer-checks/' + runId) : undefined
  if (runtime) mkdirSync(join(runtime, 'user-data'), { recursive: true })
  const env = commandEnvironment()
  // Windows PowerShell may fall back to cwd/Microsoft when a child host cannot
  // resolve its profile. Generated module discovery data must not change the
  // source snapshot and invalidate otherwise successful independent checks.
  const moduleCache = runtime ? join(runtime, 'powershell', 'ModuleAnalysisCache')
    : safePath(root, '.runtime/powershell/ModuleAnalysisCache')
  mkdirSync(dirname(moduleCache), { recursive: true })
  env.PSModuleAnalysisCachePath = moduleCache
  if (runtime) Object.assign(env, { COPROJER_TEST_USER_DATA: join(runtime, 'user-data'), COPROJER_TEST_RUN_ID: runId,
    COPROJER_EVIDENCE_DIR: join(root, '.runtime', 'verification-evidence', runId),
    HOME: join(runtime, 'user-data'), USERPROFILE: join(runtime, 'user-data'), APPDATA: join(runtime, 'user-data'),
    LOCALAPPDATA: join(runtime, 'user-data'), npm_config_cache: join(runtime, 'npm-cache') })
  const timeoutMs = Math.max(5, Math.min(seconds || 120, 300)) * 1000
  if (runtime || durable) {
    if (durable) mkdirSync(durable.directory, { recursive: true, mode: 0o700 })
    const guard = durable && process.platform === 'win32' ? await commandGuard(durable.directory) : undefined
    signal.throwIfAborted()
    const helper = join(durable?.directory ?? runtime!, 'supervisor.cjs')
    writeFileSync(helper, 'const commandResources = ' + commandResources.toString() + ';(' + commandSupervisor.toString() + ')()')
    command.args = [helper, JSON.stringify({ ...command, root, runtime, timeoutMs, guard, durable: durable ? { ...durable, secrets: undefined } : undefined, result: join(durable?.directory ?? runtime!, 'result.json') })]
  }
  const archive = createArchive?.(runId)
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: root,
      windowsHide: true,
      // libuv kills non-detached Windows children when the owning process exits.
      // The durable supervisor must survive long enough to stop its job and save proof;
      // its stdin pipe still binds its lifetime to this owner.
      detached: !!durable || process.platform !== 'win32',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = '',
      tail = '',
      reason = ''
    let recordingError: unknown
    const flush = () => {
      if (tail) {
        try { progress(tail.slice(-10000)) } catch (error) { recordingError = error; stop('运行记录保存失败') }
        tail = ''
      }
    }
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
    const append = (value: string) => {
      archive?.append(value)
      output = (output + value).slice(-24000)
      tail += value
    }
    child.stdout.on('data', chunk => append(stdoutDecoder.write(chunk)))
    child.stderr.on('data', chunk => append(stderrDecoder.write(chunk)))
    child.stdin.on('error', () => { /* A process may already have closed its lifetime pipe. */ })
    const interval = setInterval(flush, 900)
    const stop = (why: string) => {
      reason = why
      if (runtime || durable) child.stdin.end()
      else if (child.pid) killTree(child.pid)
    }
    const abort = () => stop('执行已停止')
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => stop('命令运行超时'),
      timeoutMs,
    )
    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(interval)
      signal.removeEventListener('abort', abort)
      flush()
    }
    const cleanupRuntime = () => {
      if (!runtime) return ''
      try { rmSync(runtime, { recursive: true, force: true, maxRetries: 3 }); return '' }
      catch { return '临时目录清理失败，文件可能仍被占用；保留登记记录，重启后再清理。' }
    }
    child.on('error', (error) => {
      cleanup()
      archive?.finish()
      const cleanupError = cleanupRuntime()
      if (cleanupError) progress(cleanupError)
      reject(error)
    })
    child.on('close', (code) => {
      append(stdoutDecoder.end()); append(stderrDecoder.end())
      cleanup()
      reason ||= cleanupRuntime()
      if (recordingError) { reject(recordingError); return }
      resolveCommand({
        runId,
        ...archive?.finish(),
        code: reason ? -1 : (code ?? -1),
        output: `${output}${reason ? `\n${reason}` : ''}`,
      })
    })
    try {
      if (runtime && child.pid) writeFileSync(join(runtime, 'lease.json'), JSON.stringify({ kind: 'coprojer-verification-run', id: runId, root: realpathSync(root), pid: child.pid }))
      // The durable helper cannot launch the command before this input arrives.
      if (durable) child.stdin.write(JSON.stringify({ secrets: durable.secrets }) + '\n')
    } catch (cause) { recordingError = new ReliabilityFailure('命令运行标识保存失败，已停止启动。', { cause }); stop('命令运行标识保存失败') }
  })
}
export function authorizeCommand(project: Project, role: ExecutionRole, args: any): void {
  if (!['developer', 'reviewer', 'preparer'].includes(role)) throw new Error('当前角色不能执行命令。')
    if (role === 'preparer') preparationCommand(project, args)
    if (role === 'reviewer') {
      const first = args.args?.[0]
      if (args.program === 'npm' && !['test', 'run'].includes(first))
        throw new Error('验证角色仅可执行 npm test 或 npm run 检查脚本。')
      if (
        args.program === 'npm' &&
        first === 'run' &&
        !/^(test(?::[\w-]+)*|build|typecheck|lint|check)$/.test(args.args?.[1] ?? '')
      )
        throw new Error('请运行 test/build/typecheck/lint/check 检查脚本。')
      if (args.program === 'npm' && args.args.length !== (first === 'test' ? 1 : 2))
        throw new Error('验证命令不能通过额外参数改变项目路径或检查范围。')
      if (args.program === 'node' && (!args.args?.[0] || args.args[0].startsWith('-')))
        throw new Error('验证角色请执行项目中的测试脚本。')
      if (args.program === 'node') safePath(project.root, args.args[0])
    }
}

export async function executeTool(
  store: EngineeringStore,
  project: Project,
  featureId: string,
  role: ExecutionRole,
  name: string,
  args: any,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  const definition = engineeringTools.find(tool => tool.name === name)
  if (!definition) throw new Error(`未知工程工具：${name}`)
  args = validateToolArguments(definition, args)
  if (role === 'diagnoser' && !['read_context', 'list_files', ...fileReadTools].includes(name))
    throw new Error('缺口诊断只允许读取，不能执行命令或修改工程。')
  if (fileReadTools.includes(name)) return executeFileRead(project.root, name, args, signal)
  if (name === 'patch_file') throw new Error('局部补丁需要可靠文件效果策略；请先显式迁移旧任务。')
  if (['read_context', 'list_files', 'read_file'].includes(name)) return executeReadOnly(project.root, name, args, {
    context: input => readContext(project, input), artifact: input => new ExecutionArtifacts(store.artifactHost(), project.id, featureId).read(input),
  })
  if (name === 'write_file') {
    if (!['developer', 'preparer'].includes(role)) throw new Error('验证角色不能修改工程文件。')
    if (typeof args.content !== 'string' || args.content.length > 300_000)
      throw new Error('文件内容为空类型或超过大小上限。')
    const file = safePath(project.root, args.path)
    if (role === 'preparer') preparationWrite(project, featureId, args.path, args.content)
    const canonical = relative(project.root, file).split(sep).join('/')
    let change = project.changes.find((c) => c.path === canonical && c.featureId === featureId)
    const before = change ? change.before : existsSync(file) ? readFileSync(file, 'utf8') : null
    if (role === 'preparer' && !existsSync(file)) project.features.find(f => f.id === featureId)?.verificationPreparation?.attempts.at(-1)?.actions.push('created:' + canonical)
    mkdirSync(dirname(file), { recursive: true })
    assertExclusiveWriteTarget(file)
    writeFileSync(file, args.content)
    if (!change) {
      change = { path: canonical, before, after: args.content, featureId }
      project.changes.push(change)
    }
    change.after = args.content
    store.save()
    return `已写入 ${canonical}（${Buffer.byteLength(args.content)} 字节）`
  }
  if (name === 'run_command') {
    authorizeCommand(project, role, args)
    const before = snapshotTextFiles(project.root)
    const protectedBefore = role === 'preparer' ? preparationSnapshot(project.root) : undefined
    try {
      const result = await runCommand(
        project.root,
        args.program,
        args.args,
        args.timeoutSeconds,
        signal,
        (text) => store.event(project, 'output', text, featureId),
        role !== 'developer',
        runId => new ExecutionArtifacts(store.artifactHost(), project.id, featureId).stream('命令 ' + runId + ': ' + args.program + ' ' + args.args.join(' ')),
      )
      return JSON.stringify(result)
    } finally {
      const after = snapshotTextFiles(project.root)
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(path) === after.get(path)) continue
        const change = project.changes.find((c) => c.featureId === featureId && c.path === path)
        if (change) change.after = after.get(path) ?? null
        else
          project.changes.push({
            path,
            before: before.get(path) ?? null,
            after: after.get(path) ?? null,
            featureId,
          })
      }
      store.save()
      if (protectedBefore) assertPreparationChanges(protectedBefore, preparationSnapshot(project.root))
    }
  }
  throw new Error(`未知工程工具：${name}`)
}

// Capture script-created/modified/deleted text sources as well as write_file changes.
// Generated output, dependencies and binary/oversized files are represented in command logs.
function snapshotTextFiles(root: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const path of listFiles(root)) {
    if (/^(package-lock\.json)$|\.log$|\.tsbuildinfo$/.test(path)) continue
    const target = safePath(root, path)
    if (lstatSync(target).size > 400_000) continue
    const content = readFileSync(target, 'utf8')
    if (!content.includes('\0')) files.set(path, content)
  }
  return files
}
