import { targetKinds, type Project, type ProjectTarget } from '../../shared/engineering'

export function mergeTargets(project: Project, input: unknown): void {
  if (!Array.isArray(input) || !input.length || input.length > 24)
    throw new Error('子项目数量应为 1–24 个。')
  const seen = new Set<string>()
  const targets: ProjectTarget[] = input.map((value) => {
    const field = (key: string, max: number, required = true) => {
      const v = value?.[key]
      if (typeof v !== 'string' || v.length > max || (required && !v.trim()))
        throw new Error(`子项目 ${key} 无效。`)
      return v.trim()
    }
    const id = field('id', 64)
    if (!/^[a-z][a-z0-9-]*$/.test(id) || seen.has(id))
      throw new Error('子项目标识须为唯一的小写英文、数字和短横线。')
    seen.add(id)
    const kind = field('kind', 30) as ProjectTarget['kind']
    if (!Object.hasOwn(targetKinds, kind)) throw new Error('未知的子项目类型。')
    const directory = field('directory', 160)
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(directory))
      throw new Error('子项目目录须为工作区内的相对目录，例如 apps/web。')
    const next = {
      id,
      kind,
      directory,
      name: field('name', 80),
      responsibility: field('responsibility', 6000),
      contracts: field('contracts', 12000, false),
    }
    const previous = project.targets?.find((t) => t.id === id)
    if (
      previous &&
      JSON.stringify(previous) !== JSON.stringify(next) &&
      project.features.some((f) => f.targetId === id && f.stage !== 'requirements')
    )
      throw new Error(`「${previous.name}」已有确认的功能，请先重新打开需求再修改子项目。`)
    return next
  })
  const merged = [...(project.targets || []).filter((t) => !seen.has(t.id)), ...targets]
  if (
    merged.length > 24 ||
    new Set(merged.map((t) => t.directory.toLowerCase())).size !== merged.length
  )
    throw new Error('子项目目录必须唯一，最多 24 个子项目。')
  project.targets = merged
}
