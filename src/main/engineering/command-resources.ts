export interface CommandResources {
  versions: Record<string, string>
  texts: Record<string, string>
  protected: Record<string, string>
}
// Serialized into the independent command supervisor; capture no module state.
export function commandResources(root: string): CommandResources {
  const fs = require('node:fs') as typeof import('node:fs'), path = require('node:path') as typeof import('node:path')
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const result: CommandResources = { versions: {}, texts: {}, protected: {} }
  let bytes = 0
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.coprojer', 'dist', 'out', 'coverage', '.runtime', '.scratch', '.cache', '.vite'].includes(entry.name.toLowerCase())) continue
      const full = path.join(directory, entry.name), name = path.relative(root, full).split(path.sep).join('/')
      if (entry.isSymbolicLink()) { result.versions[name] = result.protected[name] = 'symlink:' + fs.lstatSync(full).mtimeMs; continue }
      if (entry.isDirectory()) { walk(full); continue }
      const buffer = fs.readFileSync(full), content = buffer.toString('utf8')
      if (/^(verification|test-results|playwright-report)\/.+\//.test(name)) {
        if (/\.(png|jpe?g|webp|webm|mp4)$/i.test(name)) continue
        if (name.endsWith('.json') && buffer.length <= 2_000_000) {
          try {
            const record = JSON.parse(content), manifest = record?.sourceAndBuild
            if (typeof record.startedAt === 'string' && Number.isFinite(Date.parse(record.startedAt)) && ['running', 'passed', 'failed', 'cancelled'].includes(record.status) &&
              manifest && typeof manifest === 'object' && !Array.isArray(manifest) && Object.keys(manifest).length > 0 && Object.values(manifest).every(v => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v))) continue
          } catch { /* A normal source file. */ }
        }
      }
      const hash = createHash('sha256').update(buffer).digest('hex')
      result.protected[name] = name === 'package.json' ? content : hash
      if (/\.(log|tsbuildinfo)$/.test(name)) continue
      result.versions[name] = hash
      if (buffer.length <= 400_000 && !content.includes('\0') && Buffer.from(content).equals(buffer)) { result.texts[name] = content; bytes += buffer.length }
      if (bytes > 8_000_000 || Object.keys(result.versions).length > 50_000) throw new Error('命令资源快照超过可靠保存范围，请缩小工程后重新运行。')
    }
  }
  walk(root); return result
}
