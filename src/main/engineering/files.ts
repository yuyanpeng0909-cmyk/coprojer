import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { Project } from '../../shared/engineering'
import type { EngineeringStore } from './store'
import type { ToolDefinition } from './model'

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const string = { type: 'string' }
export const engineeringTools: ToolDefinition[] = [
  {
    name: 'read_context',
    description:
      '按上下文 ID 读取完整原文与来源，包括已确认基线、讨论分页和原型。讨论是参考材料，已确认基线才是交付依据。不填 ID 时列出索引。',
    parameters: object({ id: string }, []),
  },
  {
    name: 'list_files',
    description: '列出项目中的源文件（忽略依赖和构建目录）。',
    parameters: object({}, []),
  },
  {
    name: 'read_file',
    description: '读取项目中的 UTF-8 文本文件。',
    parameters: object({ path: string }, ['path']),
  },
  {
    name: 'write_file',
    description: '创建或替换项目中的 UTF-8 文本文件；内容必须完整。不能修改 .coprojer。',
    parameters: object({ path: string, content: string }, ['path', 'content']),
  },
  {
    name: 'run_command',
    description:
      '在项目根目录执行 npm 或 node。每次一个命令，不使用 shell 拼接。使用 npm run build/test 验证；不要启动常驻开发服务。',
    parameters: object(
      {
        program: { type: 'string', enum: ['npm', 'node'] },
        args: { type: 'array', items: string },
        timeoutSeconds: { type: 'number' },
      },
      ['program', 'args'],
    ),
  },
]
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
        /[. ]$/.test(p),
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
export function listFiles(root: string): string[] {
  const result: string[] = []
  function walk(directory: string, depth: number): void {
    if (depth > 8 || result.length >= 600) return
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (
        item.isSymbolicLink() ||
        ['node_modules', '.git', '.coprojer', 'dist', 'out', 'coverage'].includes(item.name)
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
export async function runCommand(
  root: string,
  program: string,
  args: string[],
  seconds: number,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<{ code: number; output: string }> {
  signal.throwIfAborted()
  const command = nodeCommand(program, args)
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: root,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '',
      tail = '',
      reason = ''
    const flush = () => {
      if (tail) {
        progress(tail.slice(-10000))
        tail = ''
      }
    }
    const append = (chunk: Buffer) => {
      const value = chunk.toString()
      output = (output + value).slice(-24000)
      tail += value
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const interval = setInterval(flush, 900)
    const stop = (why: string) => {
      reason = why
      if (child.pid) killTree(child.pid)
    }
    const abort = () => stop('执行已停止')
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => stop('命令运行超时'),
      Math.max(5, Math.min(seconds || 120, 300)) * 1000,
    )
    const cleanup = () => {
      clearTimeout(timer)
      clearInterval(interval)
      signal.removeEventListener('abort', abort)
      flush()
    }
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      resolveCommand({
        code: reason ? -1 : (code ?? -1),
        output: `${output}${reason ? `\n${reason}` : ''}`,
      })
    })
  })
}
export async function executeTool(
  store: EngineeringStore,
  project: Project,
  featureId: string,
  role: 'developer' | 'reviewer',
  name: string,
  args: any,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  if (name === 'read_context') {
    if (!args.id)
      return JSON.stringify([
        ...project.context.map(({ id, title, source }) => ({ id, title, source })),
        ...Array.from({ length: Math.ceil(project.chat.length / 10) }, (_, i) => ({
          id: `discussion:${i}`,
          title: `原始讨论 ${i * 10 + 1}–${Math.min((i + 1) * 10, project.chat.length)}`,
          source: '完整讨论记录，仅作追溯参考',
        })),
        ...(project.prototypes ?? []).map((p) => ({
          id: `prototype:${p.id}`,
          title: p.title,
          source: '设计原型，仅作界面参考',
        })),
      ])
    if (/^discussion:\d+$/.test(args.id)) {
      const start = Number(args.id.split(':')[1]) * 10
      return JSON.stringify(
        project.chat
          .slice(start, start + 10)
          .map(({ id, role, text, at, modelName, status }) => ({
            id,
            role,
            text,
            at,
            modelName,
            status,
          })),
      )
    }
    if (typeof args.id === 'string' && args.id.startsWith('prototype:')) {
      const prototype = project.prototypes?.find((p) => p.id === args.id.slice(10))
      if (!prototype) throw new Error('原型记录不存在。')
      return JSON.stringify(prototype)
    }
    const context = project.context.find((c) => c.id === args.id)
    if (!context) throw new Error('上下文记录不存在，请先读取索引。')
    return JSON.stringify(context)
  }
  if (name === 'list_files') return JSON.stringify(listFiles(project.root))
  if (name === 'read_file') {
    const file = safePath(project.root, args.path)
    if (lstatSync(file).size > 400_000) throw new Error('文件过大，请拆分文件。')
    return readFileSync(file, 'utf8')
  }
  if (name === 'write_file') {
    if (role !== 'developer') throw new Error('验证角色不能修改工程文件。')
    if (typeof args.content !== 'string' || args.content.length > 300_000)
      throw new Error('文件内容为空类型或超过大小上限。')
    const file = safePath(project.root, args.path)
    const canonical = relative(project.root, file).split(sep).join('/')
    let change = project.changes.find((c) => c.path === canonical && c.featureId === featureId)
    const before = change ? change.before : existsSync(file) ? readFileSync(file, 'utf8') : null
    mkdirSync(dirname(file), { recursive: true })
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
    if (role === 'reviewer') {
      const first = args.args?.[0]
      if (args.program === 'npm' && !['test', 'run'].includes(first))
        throw new Error('验证角色仅可执行 npm test 或 npm run 检查脚本。')
      if (
        args.program === 'npm' &&
        first === 'run' &&
        !/^(test(?::[\w-]+)?|build|typecheck|lint|check)$/.test(args.args?.[1] ?? '')
      )
        throw new Error('请运行 test/build/typecheck/lint/check 检查脚本。')
      if (args.program === 'node' && (!args.args?.[0] || args.args[0].startsWith('-')))
        throw new Error('验证角色请执行项目中的测试脚本。')
      if (args.program === 'node') safePath(project.root, args.args[0])
    }
    const before = snapshotTextFiles(project.root)
    try {
      const result = await runCommand(
        project.root,
        args.program,
        args.args,
        args.timeoutSeconds,
        signal,
        (text) => store.event(project, 'output', text, featureId),
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
