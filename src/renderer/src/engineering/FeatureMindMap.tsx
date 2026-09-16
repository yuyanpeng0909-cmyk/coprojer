import { useEffect, useRef, useState } from 'react'
import MindMap from 'simple-mind-map'
import Export from 'simple-mind-map/src/plugins/Export.js'
import { Download, Focus, Minus, Plus } from 'lucide-react'
import { scopeLabels, type Project, type Feature } from '../../../shared/engineering'
MindMap.usePlugin(Export)

export default function FeatureMindMap({
  project,
  onFeature,
}: {
  project: Project
  onFeature?(id: string): void
}) {
  const el = useRef<HTMLDivElement>(null),
    map = useRef<MindMap | null>(null),
    handler = useRef(onFeature)
  const needsFit = useRef(true)
  const pendingData = useRef<string | null>(null)
  const flushData = useRef<() => void>(() => {})
  const [format, setFormat] = useState('svg'),
    [notice, setNotice] = useState(''),
    [exporting, setExporting] = useState(false)
  handler.current = onFeature
  const modules = (features: Feature[], prefix = '') =>
    [...new Set(features.map((f) => f.module))].map((module) => ({
      data: { text: module, uid: `${prefix}module-${module}` },
      children: features
        .filter((f) => f.module === module)
        .map((f) => ({
          data: {
            text: `${f.title}\n${scopeLabels[f.scope]}`,
            uid: f.id,
            _featureId: f.id,
            expand: false,
          },
          children: f.criteria.map((c, i) => ({ data: { text: c, uid: `${f.id}-${i}` } })),
        })),
    }))
  const data = JSON.stringify({
    data: { text: project.name, uid: project.id },
    children: project.targets?.length
      ? [
          ...project.targets.map((t) => ({
            data: { text: t.name, uid: `target-${t.id}` },
            children: modules(
              project.features.filter((f) => f.targetId === t.id),
              t.id,
            ),
          })),
          ...(project.features.some((f) => !f.targetId)
            ? [
                {
                  data: { text: '尚未分配子项目', uid: 'unassigned' },
                  children: modules(
                    project.features.filter((f) => !f.targetId),
                    'unassigned',
                  ),
                },
              ]
            : []),
        ]
      : modules(project.features),
  })
  const currentData = useRef(data)
  currentData.current = data
  useEffect(() => {
    if (!el.current) return
    const value = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const fontFamily = 'Inter Variable, Noto Sans SC Variable, Microsoft YaHei UI, sans-serif'
    const theme = () => ({
      backgroundColor: value('--canvas'),
      lineColor: value('--border-strong'),
      lineStyle: 'curve',
      lineWidth: 1.5,
      paddingX: 13,
      paddingY: 8,
      root: {
        fontFamily,
        fillColor: value('--accent-solid'),
        color: value('--on-accent'),
        fontSize: 14,
        fontWeight: 'bold',
        borderRadius: 7,
      },
      second: {
        fontFamily,
        marginX: 35,
        marginY: 25,
        fillColor: value('--panel-tint'),
        color: value('--text'),
        borderColor: value('--border-strong'),
        borderWidth: 1,
        borderRadius: 6,
        fontSize: 12,
      },
      node: {
        fontFamily,
        marginX: 28,
        fillColor: value('--surface'),
        color: value('--text'),
        borderColor: value('--border-strong'),
        borderWidth: 1,
        borderRadius: 5,
        fontSize: 12,
      },
    })
    let instance: MindMap | null = null
    let rendering = true
    let appliedData = currentData.current
    flushData.current = () => {
      if (!instance || rendering || !pendingData.current) return
      const next = pendingData.current
      pendingData.current = null
      if (next === appliedData) return
      appliedData = next
      rendering = true
      instance.updateData(JSON.parse(next))
    }
    const layout = () => {
      if (!el.current || !el.current.clientWidth || !el.current.clientHeight) return
      if (instance) {
        needsFit.current = true
        instance.resize()
        return
      }
      instance = new MindMap({
        el: el.current,
        data: JSON.parse(currentData.current),
        layout: 'logicalStructure',
        readonly: true,
        themeConfig: theme(),
        fit: true,
        fitPadding: 18,
        isUseCustomNodeContent: false,
        mousewheelAction: 'zoom',
        enableAutoEnterTextEditWhenKeydown: false,
        enableShortcutOnlyWhenMouseInSvg: true,
      })
      map.current = instance
      appliedData = currentData.current
      needsFit.current = true
      instance.on('node_tree_render_start', () => {
        rendering = true
      })
      instance.on('node_tree_render_end', () => {
        rendering = false
        if (pendingData.current && pendingData.current !== appliedData) {
          queueMicrotask(() => flushData.current())
          return
        }
        if (needsFit.current && instance) {
          needsFit.current = false
          instance.view.fit()
        }
      })
      instance.on('node_click', (node: any) => {
        const id = node.getData('_featureId')
        if (id) handler.current?.(id)
      })
    }
    const resize = new ResizeObserver(layout)
    resize.observe(el.current)
    const observer = new MutationObserver(() => instance?.setThemeConfig(theme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    })
    return () => {
      resize.disconnect()
      observer.disconnect()
      instance?.destroy()
      instance = null
      map.current = null
      pendingData.current = null
      flushData.current = () => {}
    }
  }, [project.id])
  const previous = useRef(data)
  useEffect(() => {
    if (previous.current !== data) {
      if (!JSON.parse(previous.current).children.length) needsFit.current = true
      pendingData.current = data
      flushData.current()
      previous.current = data
    }
  }, [data])
  const exportMap = async () => {
    setExporting(true)
    setNotice('')
    try {
      const filename = project.name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) + '-功能图'
      let url: string
      if (format === 'md')
        url =
          'data:text/plain,' +
          encodeURIComponent(
            `# ${project.name}\n\n` +
              project.features
                .map(
                  (f) =>
                    `## ${f.module} / ${f.title}\n${f.description}\n${f.criteria.map((c) => '- ' + c).join('\n')}\n`,
                )
                .join('\n'),
          )
      else if (format === 'json') url = 'data:application/json,' + encodeURIComponent(data)
      else url = await map.current!.export(format, false, filename)
      const saved = await window.desktop.saveArtifact(`${filename}.${format}`, url)
      if (saved) setNotice('已导出')
    } catch (error) {
      setNotice(String(error))
    } finally {
      setExporting(false)
    }
  }
  return (
    <div className="research-mindmap">
      <div className="canvas-toolbar">
        <span>
          {project.features.length} 个功能 <i /> 拖动平移 · 滚轮缩放
        </span>
        <div>
          <button
            className="eng-icon"
            aria-label="缩小功能图"
            onClick={() => map.current?.view.narrow()}
          >
            <Minus size={14} />
          </button>
          <button
            className="eng-icon"
            aria-label="放大功能图"
            onClick={() => map.current?.view.enlarge()}
          >
            <Plus size={14} />
          </button>
          <button
            className="eng-icon"
            aria-label="适应画布"
            onClick={() => map.current?.view.fit()}
          >
            <Focus size={14} />
          </button>
          <select
            aria-label="功能图导出格式"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="svg">SVG</option>
            <option value="png">PNG</option>
            <option value="md">Markdown</option>
            <option value="json">JSON</option>
          </select>
          <button
            className="eng-icon"
            aria-label="导出功能图"
            disabled={exporting}
            onClick={() => void exportMap()}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
      <div className="mindmap-canvas" ref={el} aria-label="功能思维导图" />
      {!project.features.length && (
        <div className="mindmap-empty">从一个想法开始，模块与功能会在这里逐步生长。</div>
      )}
      <div className="canvas-footer">
        <span>{notice || '点击功能查看详情 · 展开节点查看验收标准'}</span>
        <small>SimpleMindMap</small>
      </div>
    </div>
  )
}
