declare module 'simple-mind-map' {
  export default class MindMap {
    static usePlugin(plugin: unknown): typeof MindMap
    constructor(options: Record<string, unknown>)
    on(event: string, listener: (...args: any[]) => void): void
    setData(data: unknown): void
    updateData(data: unknown): void
    setThemeConfig(theme: Record<string, unknown>): void
    resize(): void
    destroy(): void
    export(type: string, download: boolean, name: string): Promise<string>
    view: { fit(): void; enlarge(): void; narrow(): void }
  }
}
declare module 'simple-mind-map/src/plugins/Export.js' {
  const plugin: unknown
  export default plugin
}
