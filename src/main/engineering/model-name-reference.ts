// Name similarity is a discovery aid only, never proof of model identity.
const normalized = (value: string) => value.toLowerCase().split('/').at(-1)!.replace(/[^a-z0-9]/g, '')
export function modelNameSimilarity(requested: string, actual: string): number {
  const a = normalized(requested), b = normalized(actual)
  if (!a || !b || a.length > 240 || b.length > 240 || a.match(/^[a-z]+/)?.[0] !== b.match(/^[a-z]+/)?.[0]) return 0
  if (a === b) return 1
  // An explicitly appended reasoning label is close by name, not an exact match.
  const suffix = /^(low|medium|high|xhigh|max|thinking|reasoning|nonthinking|nonreasoning)$/
  if (b.startsWith(a) && suffix.test(b.slice(a.length)) || a.startsWith(b) && suffix.test(a.slice(b.length))) return .97
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = next
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length)
}
export function nearbyModelRows<T>(requested: string, rows: T[], name: (row: T) => string, limit = 3): T[] {
  return rows.map(row => ({ row, similarity: modelNameSimilarity(requested, name(row)) }))
    .filter(item => item.similarity >= .72)
    .sort((a, b) => b.similarity - a.similarity || name(a.row).localeCompare(name(b.row)))
    .slice(0, limit).map(item => item.row)
}
export function modelNameDifference(requested: string, actual: string): string {
  const a = requested.split('/').at(-1)!, b = actual.split('/').at(-1)!
  if (a.toLowerCase() === b.toLowerCase()) return requested.includes('/') ? '名称含供应商前缀，尚未核实为同一型号。' : '名称相同，推理设置尚未核实一致。'
  if ((a.match(/\d+/g) || []).join('.') !== (b.match(/\d+/g) || []).join('.')) return '型号版本或规格数字不同，不代表当前版本的成绩。'
  return '名称格式或后缀近似，尚未核实为同一型号与推理设置。'
}
