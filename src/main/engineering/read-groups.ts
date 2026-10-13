import { lstatSync, readdirSync } from 'node:fs'
import { relative, sep, join } from 'node:path'
import type { ToolCall } from './model'
import type { ReadGroupPlan } from './runtime'
import { safePath, engineeringTools } from './files'
import { canonicalFile, fileIdentity, fileReadTools, textVersion } from './efficient-files'
import { parseToolArguments } from './tool-contract'
import { RecoveryRequired } from './reliability'

function resource(root: string, call: ToolCall, signal: AbortSignal): ReadGroupPlan['resources'][number] {
  const args = parseToolArguments(engineeringTools.find(t => t.name === call.name)!, call.arguments)
  const path = call.name === 'search_files' ? args.scope : args.path
  const target = path === '.' && call.name === 'search_files' ? root : safePath(root, path)
  const info = lstatSync(target), kind = info.isDirectory() ? 'tree' : 'file'
  if (kind === 'tree' && call.name !== 'search_files') throw new Error('读取目标不是文件。')
  let count = 0, bytes = 0
  const entries: [string, string][] = []
  const walk = (file: string, depth: number): void => {
    signal.throwIfAborted()
    if (++count > 1200 || depth > 8) throw new Error('资源快照超过并发范围，改用串行。')
    const name = relative(root, file).split(sep).join('/') || '.'
    if (name !== '.') safePath(root, name)
    const stat = lstatSync(file, { bigint: true })
    if (stat.isSymbolicLink()) throw new Error('并发资源不能包含符号链接。')
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
    if (stat.isDirectory()) { entries.push([fileIdentity(name), 'directory:' + stamp]); for (const child of readdirSync(file).sort()) walk(join(file, child), depth + 1) }
    else {
      if (!stat.isFile() || stat.nlink > 1n || stat.size > 400000n || (bytes += Number(stat.size)) > 8000000) throw new Error('资源不独立或快照超过并发范围，改用串行。')
      entries.push([fileIdentity(name), stamp])
    }
  }
  walk(target, 0)
  return { path: path === '.' ? '.' : canonicalFile(root, path), kind, version: textVersion(JSON.stringify(entries.sort((a,b) => a[0].localeCompare(b[0])))) }
}
function independent(resources: ReadGroupPlan['resources']): boolean {
  return resources.every((a, i) => resources.every((b, j) => {
    if (i === j) return true
    const ap = fileIdentity(a.path), bp = fileIdentity(b.path)
    return ap !== bp && !(a.kind === 'tree' && (ap === '.' || bp.startsWith(ap + '/'))) && !(b.kind === 'tree' && (bp === '.' || ap.startsWith(bp + '/')))
  }))
}
export async function planReadGroup(root: string, calls: ToolCall[], concurrency: 1 | 2 | 4, signal: AbortSignal): Promise<ReadGroupPlan | undefined> {
  if (concurrency === 1 || calls.length < 2 || calls.length > 24 || !calls.every(call => fileReadTools.includes(call.name))) return undefined
  try {
    const resources = []
    for (const call of calls) resources.push(resource(root, call, signal))
    if (!independent(resources)) return undefined
    return { version: 1, concurrency, resources, outputLimits: calls.map(() => Math.floor(24000 / calls.length)) }
  } catch { signal.throwIfAborted(); return undefined }
}
export async function checkReadGroup(root: string, calls: ToolCall[], plan: ReadGroupPlan, signal: AbortSignal): Promise<void> {
  if (!calls.every(call => fileReadTools.includes(call.name)) || !independent(plan.resources)) throw new RecoveryRequired('待恢复组不是独立只读资源。')
  // Two bounded synchronous metadata observations catch changes during traversal,
  // without extra content reads. This is not an OS-atomic filesystem snapshot;
  // each tool result retains its independently verified content version.
  for (let pass = 0; pass < 2; pass++) for (const [i, call] of calls.entries()) {
    let actual
    try { actual = resource(root, call, signal) } catch (cause) { signal.throwIfAborted(); throw new RecoveryRequired('读取资源无法核对；保留已有回执，停止排队读取：' + String(cause)) }
    if (JSON.stringify(actual) !== JSON.stringify(plan.resources[i])) throw new RecoveryRequired('读取组资源版本已变化；保留已有回执，不拼接旧结果或自动重读。')
  }
}
