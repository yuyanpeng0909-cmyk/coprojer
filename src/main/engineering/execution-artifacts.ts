import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readPage } from './context'

const artifactBytes = 16_000_000
const featureBytes = 128_000_000
export interface ExecutionArtifact {
  formatVersion?: 1
  scope?: string
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
export interface ArtifactHost {
  path: string
  redact(value: string): string
  secrets(): string[]
}

/** Private, project/feature-scoped evidence; never a source-tree mutation. */
export class ExecutionArtifacts {
  private readonly directory: string
  private readonly scope: string
  constructor(private readonly host: ArtifactHost, projectId: string, featureId: string) {
    const scope = createHash('sha256').update(JSON.stringify([projectId, featureId])).digest('hex')
    this.scope = scope
    this.directory = join(dirname(host.path), 'engineering-artifacts', scope)
  }
  write(content: string, label: string): string {
    if (Buffer.byteLength(content) > artifactBytes) throw new Error('执行记录归档超过单份 16 MB 上限；原始上下文未替换。')
    const stream = this.stream(label)
    stream.append(content)
    const result = stream.finish()
    if (!result.artifact?.complete) throw new Error(result.archiveError || '执行记录未完整归档；原始上下文未替换。')
    return result.artifact.id
  }
  writeOpaque(output: Record<string, unknown>[], identity: string): string {
    const body = JSON.stringify({ version: 1, scope: this.scope, identity, output })
    mkdirSync(this.directory, { recursive: true })
    const used = readdirSync(this.directory).reduce((sum, name) => sum + statSync(join(this.directory, name)).size, 0)
    if (Buffer.byteLength(body) > artifactBytes || used + Buffer.byteLength(body) > featureBytes) throw new Error('原生窗口超过私有归档配额，原视图保留。')
    const id = randomUUID(), file = join(this.directory, id + '.opaque'), fd = openSync(file + '.tmp', 'wx', 0o600)
    try { if (writeSync(fd, body) !== Buffer.byteLength(body)) throw new Error('原生窗口写入不完整。'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(file + '.tmp', file)
    return 'opaque:' + id + ':' + createHash('sha256').update(body).digest('hex')
  }
  readOpaque(reference: string, identity: string): Record<string, unknown>[] {
    const match = /^opaque:([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(reference)
    if (!match) throw new Error('原生窗口引用格式未知。')
    const body = readFileSync(join(this.directory, match[1] + '.opaque'), 'utf8')
    if (createHash('sha256').update(body).digest('hex') !== match[2]) throw new Error('原生窗口校验失败，原件保留。')
    const data = JSON.parse(body)
    if (data.version !== 1 || data.scope !== this.scope || data.identity !== identity || !Array.isArray(data.output)) throw new Error('原生窗口版本或身份不兼容。')
    return data.output
  }
  read(args: { id?: string; offset?: number; limit?: number; version?: string }): string {
    if (!/^artifact:[a-f0-9-]{36}$/.test(args.id || '')) throw new Error('执行归档标识无效。')
    const id = args.id!.slice(9)
    if (!existsSync(join(this.directory, id + '.json'))) throw new Error('当前项目和功能中不存在此执行归档。')
    const meta: ExecutionArtifact = JSON.parse(readFileSync(join(this.directory, id + '.json'), 'utf8'))
    const content = readFileSync(join(this.directory, id + '.txt'), 'utf8')
    if (meta.formatVersion !== undefined && meta.formatVersion !== 1 || meta.scope !== undefined && meta.scope !== this.scope ||
      meta.id !== args.id || typeof meta.complete !== 'boolean' || meta.totalCharacters !== content.length ||
      meta.version !== createHash('sha256').update(content).digest('hex')) throw new Error('执行归档版本、范围或内容校验失败；原件保留，不能宣称全文完整。')
    return JSON.stringify({ ...JSON.parse(readPage(content, args)), artifactId: meta.id, label: meta.label, complete: meta.complete })
  }
  stream(label: string, partial = false): CommandOutputArchive {
    mkdirSync(this.directory, { recursive: true })
    const used = readdirSync(this.directory).reduce((sum, name) => sum + statSync(join(this.directory, name)).size, 0)
    let remaining = Math.min(artifactBytes, Math.max(0, featureBytes - used))
    const id = randomUUID(), file = join(this.directory, id + '.txt')
    const fd = openSync(file, 'wx', 0o600), hash = createHash('sha256')
    const keys = this.host.secrets()
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
      let value = this.host.redact(pending.slice(0, cut))
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
        const artifact: ExecutionArtifact = { formatVersion: 1, scope: this.scope, id: 'artifact:' + id, label: this.host.redact(label), version: hash.digest('hex'), totalCharacters: characters, complete: complete && !partial }
        try {
          const index = join(this.directory, id + '.json'), temporary = index + '.tmp', indexFd = openSync(temporary, 'wx', 0o600)
          try {
            const value = JSON.stringify(artifact)
            if (writeSync(indexFd, value) !== Buffer.byteLength(value)) throw new Error('归档索引写入不完整。')
            fsyncSync(indexFd)
          } finally { closeSync(indexFd) }
          renameSync(temporary, index)
        }
        catch (failure) { return result = { archiveError: '执行输出索引保存失败：' + String(failure) } }
        return result = { artifact, ...(!complete ? { archiveError: '输出达到归档配额，仅保留部分内容。' } : {}) }
      },
    }
  }
}
