export interface ReadCoverage {
  sourceId: string
  scope: string
  version: string
  active: boolean
  ranges: [number, number][]
  reads: number
  reviewReason?: string
}
/** Coverage is evidence about reads, never permission to access a source. */
export class ReadRegistry {
  private records: ReadCoverage[]
  constructor(records: ReadCoverage[] = []) { this.records = structuredClone(records) }
  observe(name: string, args: Record<string, any>, output: string, scope: string): void {
    if (!['read_file', 'read_file_lines', 'search_files', 'read_context', 'read_skill'].includes(name)) return
    let page: any
    try { page = JSON.parse(output) } catch { return }
    const canonical = (path: string) => {
      const normalized = path.replace(/\\/g, '/').replace(/(^|\/)\.\//g, '$1')
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized
    }
    if (name === 'search_files') {
      for (const [path, version] of Object.entries(page.versions ?? {})) for (const record of this.records)
        if (record.scope === scope && record.sourceId === 'read_file::' + canonical(path)) record.active = record.version === version
      return
    }
    if (typeof page.version !== 'string' || typeof page.content !== 'string' || !Number.isSafeInteger(page.offset)) return
    const file = name === 'read_file' || name === 'read_file_lines'
    const sourceId = file ? 'read_file::' + canonical(page.path ?? args.path) : name + ':' + (args.id ?? '') + ':' + (args.path ?? '')
    for (const record of this.records) if (record.scope === scope && record.sourceId === sourceId) record.active = record.version === page.version
    let current = this.records.find(record => record.scope === scope && record.sourceId === sourceId && record.version === page.version)
    if (!current) { current = { sourceId, scope, version: page.version, active: true, ranges: [], reads: 0 }; this.records.push(current) }
    current.reads++; current.reviewReason = typeof args.reviewReason === 'string' ? args.reviewReason : current.reviewReason
    const ranges = [...current.ranges, [page.offset, page.offset + page.content.length] as [number, number]].sort((a, b) => a[0] - b[0])
    current.ranges = []
    for (const range of ranges) {
      const previous = current.ranges.at(-1)
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
      else current.ranges.push(range)
    }
    // This is a bounded working index; raw reads remain in messages/archives.
    if (this.records.length > 256) this.records.splice(0, this.records.length - 256)
  }
  snapshot(): ReadCoverage[] { return structuredClone(this.records) }
}
