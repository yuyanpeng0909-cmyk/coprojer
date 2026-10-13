import { promises as fs } from 'node:fs'
import { relative, sep, join } from 'node:path'
import { createHash } from 'node:crypto'
import { safePath } from './files'
import { readPage } from './context'

export const textVersion = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
export const canonicalFile = (root: string, path: string) => relative(root, safePath(root, path)).split(sep).join('/')
export const fileIdentity = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
export const fileReadTools = ['read_file', 'read_file_lines', 'search_files']
const excluded = new Set(['node_modules', '.git', '.coprojer', 'dist', 'out', 'coverage', '.runtime', '.scratch', '.cache', '.vite'])

/** Actual asynchronous I/O; callers own authorization, accounting and receipts. */
export async function readText(root: string, path: string, signal?: AbortSignal): Promise<{ path: string; content: string; version: string }> {
  signal?.throwIfAborted()
  const target = safePath(root, path), info = await fs.lstat(target)
  if (!info.isFile() || info.size > 400000) throw new Error('只支持不超过400000字节的UTF-8文本文件。')
  const bytes = await fs.readFile(target, { signal }), content = bytes.toString('utf8')
  if (bytes.length > 400000 || content.includes('\0') || !Buffer.from(content).equals(bytes)) throw new Error('文件不是可完整读取的UTF-8文本，或超过大小上限。')
  safePath(root, path)
  const after = await fs.lstat(target)
  if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || info.ino !== after.ino)
    throw new Error('读取期间资源版本已变化，请重新读取。')
  return { path: canonicalFile(root, path), content, version: textVersion(bytes) }
}

export function lineRange(content: string, startLine: number, endLine: number): { start: number; end: number; totalLines: number } {
  const starts = [0]
  for (let i = 0; i < content.length; i++) if (content[i] === '\n' && i + 1 < content.length) starts.push(i + 1)
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > starts.length)
    throw new Error('行范围越界：使用1开始的闭区间，文件共' + starts.length + '行。')
  return { start: starts[startLine - 1], end: starts[endLine] ?? content.length, totalLines: starts.length }
}

export function patchedText(before: string, args: { expectedVersion: string; startLine: number; endLine: number; oldText: string; newText: string }): string {
  if (textVersion(before) !== args.expectedVersion) throw new Error('补丁预期版本不一致，请重新读取当前文件。')
  if (typeof args.oldText !== 'string' || !args.oldText) throw new Error('补丁oldText必须是非空文本。')
  const { start, end } = lineRange(before, args.startLine, args.endLine), range = before.slice(start, end)
  const match = range.indexOf(args.oldText)
  if (match < 0 || range.indexOf(args.oldText, match + 1) >= 0) throw new Error('补丁在指定行范围内必须恰好唯一匹配。')
  const after = before.slice(0, start + match) + args.newText + before.slice(start + match + args.oldText.length)
  if (after.length > 300000) throw new Error('补丁结果超过文本写入上限。')
  return after
}

export async function searchFiles(root: string, args: { scope: string; query: string; limit?: number }, signal?: AbortSignal): Promise<string> {
  if (!args.query.trim()) throw new Error('搜索query必须是非空字面量。')
  const scope = args.scope === '.' ? root : safePath(root, args.scope), limit = args.limit ?? 30
  const matches: { path: string; version: string; line: number; text: string; lineTruncated: boolean }[] = []
  const skipped: { path: string; reason: string }[] = [], versions: Record<string, string> = {}, directories = new Map<string, string>()
  let scanned = 0, visited = 0, truncated = false
  const skip = (path: string, reason: string) => { truncated = true; if (skipped.length < 100) skipped.push({ path, reason }) }
  const walk = async (target: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    const path = relative(root, target).split(sep).join('/') || '.'
    if (++visited > 1200 || depth > 8 || scanned >= 600) { skip(path, '遍历上限'); return }
    const info = await fs.lstat(target)
    if (info.isSymbolicLink()) { skip(path, '符号链接不可访问'); return }
    if (info.isDirectory()) {
      if (path !== '.' && excluded.has(target.split(sep).at(-1)!.toLowerCase())) { skip(path, '排除目录'); return }
      const entries = await fs.readdir(target)
      directories.set(target, JSON.stringify(entries.sort()))
      for (const entry of entries.sort()) {
        if (matches.length >= limit || visited >= 1200 || scanned >= 600) { skip(path, '结果或遍历上限'); break }
        await walk(join(target, entry), depth + 1)
      }
      return
    }
    if (!info.isFile()) { skip(path, '不是普通文件'); return }
    try {
      const file = await readText(root, path, signal); scanned++; versions[file.path] = file.version
      const lines = file.content.split('\n')
      for (let i = 0; i < lines.length; i++) if (lines[i].includes(args.query)) {
        if (matches.length >= limit) { skip(path, '结果上限'); break }
        const at = lines[i].indexOf(args.query), start = Math.max(0, at - 120)
        matches.push({ path: file.path, version: file.version, line: i + 1, text: lines[i].slice(start, start + 400), lineTruncated: lines[i].length > 400 })
      }
    } catch (error) { signal?.throwIfAborted(); skip(path, String(error)) }
  }
  await walk(scope, 0)
  // Search results are versioned references, never coverage of unread file bodies.
  for (const [path, version] of Object.entries(versions)) if ((await readText(root, path, signal)).version !== version) throw new Error('搜索期间资源版本已变化，请重新搜索。')
  for (const [directory, entries] of directories) if (JSON.stringify((await fs.readdir(directory)).sort()) !== entries) throw new Error('搜索期间目录内容已变化，请重新搜索。')
  return JSON.stringify({ scope: args.scope, query: args.query, limit, matches, versions, scanned, skipped, complete: !truncated, truncated })
}

export async function executeFileRead(root: string, name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
  if (name === 'search_files') return searchFiles(root, args as any, signal)
  const file = await readText(root, args.path, signal)
  if (args.version && args.version !== file.version) throw new Error('原文版本已变化，请重新读取。')
  if (name === 'read_file') return JSON.stringify({ ...JSON.parse(readPage(file.content, args)), path: file.path })
  const range = lineRange(file.content, args.startLine, args.endLine), end = Math.min(range.end, range.start + 6000)
  return JSON.stringify({ path: file.path, version: file.version, startLine: args.startLine, endLine: args.endLine,
    totalLines: range.totalLines, offset: range.start, rangeEndOffset: range.end, totalCharacters: file.content.length,
    partial: end < range.end, nextOffset: end < range.end ? end : null, content: file.content.slice(range.start, end) })
}
