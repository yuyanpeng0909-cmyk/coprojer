import { useEffect, useState } from 'react'
import { Layers2, Maximize2, Minus, X } from 'lucide-react'
import EngineeringPage from './engineering/EngineeringPage'
import { usePreferences } from './usePreferences'
import './workbench.css'
import { DetachedResearchPanel } from './engineering/RequirementsWorkspace'
import type { ResearchPanelContext } from '../../shared/desktop'
export default function App() {
  const [panel, setPanel] = useState<ResearchPanelContext | null | undefined>(undefined)
  const preferences = usePreferences()
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    window.desktop
      .researchPanel()
      .then(setPanel)
      .catch(() => setPanel(null))
    window.desktop
      .getAppInfo()
      .then(() => setConnected(true))
      .catch(() => setError('桌面服务连接失败，请重新启动应用。'))
  }, [])
  const control = (action: 'minimize' | 'maximize' | 'close') =>
    void window.desktop.windowControl(action).catch(() => setError('窗口操作失败，请重试。'))
  return (
    <div className="desktop-app">
      <header className="titlebar">
        <div className="brand">
          <Layers2 size={17} />
          <strong>Coprojer</strong>
          <span>工程工作空间</span>
        </div>
        <div className="window-controls">
          <button aria-label="最小化" onClick={() => control('minimize')}>
            <Minus size={14} />
          </button>
          <button aria-label="最大化或还原" onClick={() => control('maximize')}>
            <Maximize2 size={13} />
          </button>
          <button className="window-close" aria-label="关闭窗口" onClick={() => control('close')}>
            <X size={15} />
          </button>
        </div>
      </header>
      {(error || preferences.error) && (
        <div className="application-error" role="alert">
          {error || preferences.error}
        </div>
      )}
      {panel === undefined ? null : panel ? (
        <DetachedResearchPanel context={panel} />
      ) : (
        <EngineeringPage preferences={preferences} connected={connected} />
      )}
    </div>
  )
}
