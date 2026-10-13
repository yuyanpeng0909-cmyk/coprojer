import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { safePath, preparationWrite, assertExclusiveWriteTarget } from './files'
import type { Project } from '../../shared/engineering'
import type { ExecutionRole } from './execution'
import { EffectUncertain } from './reliability'
import { patchedText } from './efficient-files'

export interface FileEffect {
  path: string
  before: string | null
  beforeVersion: string
  expectedVersion: string
  after: string
}
export const fileContentVersion = (content: string | Buffer | null) => content === null ? 'absent' : createHash('sha256').update(content).digest('hex')
export function readFileVersion(root: string, path: string): string {
  const file = safePath(root, path)
  return existsSync(file) ? fileContentVersion(readFileSync(file)) : 'absent'
}
export function prepareFileEffect(project: Project, featureId: string, role: ExecutionRole, args: { path: string; content: string }): FileEffect {
  if (!['developer', 'preparer'].includes(role)) throw new Error('验证角色不能修改工程文件。')
  const file = safePath(project.root, args.path)
  assertExclusiveWriteTarget(file)
  if (role === 'preparer') preparationWrite(project, featureId, args.path, args.content)
  if (existsSync(file) && lstatSync(file).size > 400000) throw new Error('原文件超过可可靠登记的文本大小上限。')
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (before?.includes('\0') || before !== null && !Buffer.from(before).equals(readFileSync(file))) throw new Error('整文件工具只能替换可完整登记的UTF-8文本。')
  return { path: relative(project.root, file).split(sep).join('/'), before, beforeVersion: fileContentVersion(before), after: args.content, expectedVersion: fileContentVersion(args.content) }
}
export function preparePatchEffect(project: Project, featureId: string, role: ExecutionRole, args: Record<string, any>): FileEffect {
  const file = safePath(project.root, args.path)
  if (lstatSync(file).size > 400000) throw new Error('原文件超过可靠文本大小上限。')
  const before = readFileSync(file, 'utf8')
  const content = patchedText(before, args as any)
  const effect = prepareFileEffect(project, featureId, role, { path: args.path, content })
  if (effect.beforeVersion !== args.expectedVersion) throw new Error('补丁准备期间资源版本已变化；未修改文件。')
  return effect
}
export function fileEffectOutput(effect: FileEffect, patch: boolean): string {
  return patch ? JSON.stringify({ path: effect.path, beforeVersion: effect.beforeVersion, version: effect.expectedVersion,
    changed: effect.beforeVersion !== effect.expectedVersion, beforeCharacters: effect.before?.length ?? 0, afterCharacters: effect.after.length })
    : `已写入 ${effect.path}（${Buffer.byteLength(effect.after)} 字节）`
}
export function applyFileEffect(root: string, effect: FileEffect, signal: AbortSignal): void {
  signal.throwIfAborted()
  const file = safePath(root, effect.path)
  if (readFileVersion(root, effect.path) !== effect.beforeVersion) throw new EffectUncertain('写入前资源版本已变化；没有覆盖文件，需核对当前内容。')
  try { assertExclusiveWriteTarget(file) }
  catch (cause) { throw new EffectUncertain('写入前目标不再能确认独占，未覆盖文件；请核对：' + String(cause)) }
  try {
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, effect.after)
    const descriptor = openSync(file, 'r+'); try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch (cause) { throw new EffectUncertain('写入未获得可靠完成结果，可能已有部分修改：' + String(cause)) }
}
