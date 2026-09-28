import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readPage } from './context'
import type { EngineeringStore } from './store'

const artifactBytes = 16_000_000
const featureBytes = 128_000_000
export interface ExecutionArtifact {
  id: string
  label: string
  version: string
  totalCharacters: number
  complete: boolean
}
export interface CommandOutputArchive {
  append(text: string): void
  finish(): { artifact?: ExecutionArtifact; archiveError?: string }
}

/** Private, project/feature-scoped evidence; never a source-tree mutation. */
export class ExecutionArtifacts {
  private readonly directory: string
  constructor(private readonly store: EngineeringStore, projectId: string, featureId: string) {
    const scope = createHash('sha256').update(JSON.stringify([projectId, featureId])).digest('hex')
    this.directory = join(dirname(store.path), 'engineering-artifacts', scope)
  }
  write(content: string, label: string): string {
    if (Buffer.byteLength(content) > artifactBytes) throw new Error('执行记录归档超过单份 16 MB 上限；原始上下文未替换。')
    const stream = this.stream(label)
    stream.append(content)
    const result = stream.finish()
    if (!result.artifact?.complete) throw new Error(result.archiveError || '执行记录未完整归档；原始上下文未替换。')
    return result.artifact.id
  }
  read(args: { id?: string; offset?: number; limit?: number; version?: string }): string {
    if (!/^artifact:[a-f0-9-]{36}$/.test(args.id || '')) throw new Error('执行归档标识无效。')
    const id = args.id!.slice(9)
    if (!existsSync(join(this.directory, id + '.json'))) throw new Error('当前项目和功能中不存在此执行归档。')
    const meta: ExecutionArtifact = JSON.parse(readFileSync(join(this.directory, id + '.json'), 'utf8'))
    const content = readFileSync(join(this.directory, id + '.txt'), 'utf8')
    return JSON.stringify({ ...JSON.parse(readPage(content, args)), artifactId: meta.id, label: meta.label, complete: meta.complete })
  }
  stream(label: string): CommandOutputArchive {
    mkdirSync(this.directory, { recursive: true })
    const used = readdirSync(this.directory).reduce((sum, name) => sum + statSync(join(this.directory, name)).size, 0)
    let remaining = Math.min(artifactBytes, Math.max(0, featureBytes - used))
    const id = randomUUID(), file = join(this.directory, id + '.txt')
    const fd = openSync(file, 'wx', 0o600), hash = createHash('sha256')
    const keys = this.store.data.models.flatMap(model => { try { const key = this.store.key(model.id); return key ? [key] : [] } catch { return [] } })
    const guard = Math.max(128, ...keys.map(key => key.length + 1))
    let pending = '', characters = 0, complete = true, error = ''
    let result: ReturnType<CommandOutputArchive['finish']> | undefined
    const flush = (final = false) => {
      let cut = final ? pending.length : Math.max(0, pending.length - guard)
      // Delay boundary-crossing secrets and open-ended sk- tokens until redaction.
      if (!final) {
        let previous: number
        do {
          previous = cut
          for (const key of keys) {
            const at = pending.lastIndexOf(key, cut)
            if (at >= 0 && at < cut && at + key.length > cut) cut = at
          }
          for (const match of pending.matchAll(/\bsk-[a-zA-Z0-9_-]*/g)) {
            if (match.index! < cut && match.index! + match[0].length >= cut) cut = match.index!
          }
        } while (cut !== previous)
      }
      if (cut && /[\uD800-\uDBFF]/.test(pending[cut - 1])) cut--
      if (!cut) return
      let value = this.store.redact(pending.slice(0, cut))
      pending = pending.slice(cut)
      if (Buffer.byteLength(value) > remaining) {
        complete = false
        let low = 0, high = value.length
        while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(value.slice(0, mid)) <= remaining) low = mid; else high = mid - 1 }
        value = value.slice(0, low)
        if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1)
      }
      if (writeSync(fd, value) !== Buffer.byteLength(value)) throw new Error('执行归档写入不完整。')
      hash.update(value); characters += value.length; remaining -= Buffer.byteLength(value)
    }
    return {
      append: text => {
        if (result || error || !complete) return
        try {
          pending += text
          if (pending.length > artifactBytes) { pending = pending.slice(0, artifactBytes); flush(true); complete = false }
          else flush()
        } catch (failure) { complete = false; error = '执行输出归档失败：' + String(failure) }
      },
      finish: () => {
        if (result) return result
        try { if (!error) { flush(true); fsyncSync(fd) } }
        catch (failure) { error = '执行输出归档失败：' + String(failure) }
        finally { closeSync(fd) }
        if (error) return result = { archiveError: error }
        const artifact: ExecutionArtifact = { id: 'artifact:' + id, label: this.store.redact(label), version: hash.digest('hex'), totalCharacters: characters, complete }
        try { writeFileSync(join(this.directory, id + '.json'), JSON.stringify(artifact), { mode: 0o600 }) }
        catch (failure) { return result = { archiveError: '执行输出索引保存失败：' + String(failure) } }
        return result = { artifact, ...(!complete ? { archiveError: '输出达到归档配额，仅保留部分内容。' } : {}) }
      },
    }
  }
}
