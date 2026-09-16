import { accentOptions, type Appearance } from '../appearance'
import type { Preferences } from '../usePreferences'
export default function WorkspaceSettings({ preferences }: { preferences: Preferences }) {
  const { appearance, setAppearance, theme, setTheme } = preferences
  return (
    <div className="workspace-preferences">
      <section>
        <header>
          <h2>界面外观</h2>
          <p>保持熟悉的工作环境，偏好自动保存在本机。</p>
        </header>
        <div className="preference-row">
          <div>
            <strong>显示主题</strong>
            <small>切换工作空间的明暗表面</small>
          </div>
          <div className="theme-options">
            <button aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
              亮色
            </button>
            <button aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
              暗色
            </button>
          </div>
        </div>
        <div className="preference-row">
          <div>
            <strong>强调色</strong>
            <small>用于主要操作与选中状态</small>
          </div>
          <div className="accent-options">
            {accentOptions.map((a) => (
              <button
                key={a.id}
                aria-label={`强调色：${a.name}`}
                title={a.name}
                aria-pressed={appearance.accent === a.id}
                onClick={() => setAppearance({ ...appearance, accent: a.id })}
              >
                <i style={{ background: a.color }} />
              </button>
            ))}
          </div>
        </div>
        <label className="preference-row">
          <span>
            <strong>界面密度</strong>
            <small>调整工作列表的行间距</small>
          </span>
          <select
            aria-label="界面密度"
            value={appearance.density}
            onChange={(e) =>
              setAppearance({ ...appearance, density: e.target.value as Appearance['density'] })
            }
          >
            <option value="compact">紧凑</option>
            <option value="comfortable">舒适</option>
          </select>
        </label>
        <label className="preference-row">
          <span>
            <strong>圆角</strong>
            <small>控件采用不超过 6px 的紧凑圆角</small>
          </span>
          <span className="radius-control">
            <input
              aria-label="圆角"
              type="range"
              min="0"
              max="20"
              value={appearance.radius}
              onChange={(e) => setAppearance({ ...appearance, radius: Number(e.target.value) })}
            />
            <output>{appearance.radius}px</output>
          </span>
        </label>
      </section>
      <section>
        <header>
          <h2>工作空间</h2>
          <p>工程在本机目录执行，关键决策和开发记录持续保存。</p>
        </header>
        <div className="preference-row">
          <div>
            <strong>工作方式</strong>
            <small>需求确认 → 方案确认 → 开发与验证 → 最终验收</small>
          </div>
          <span className="eng-tag">按功能串行</span>
        </div>
        <div className="preference-row">
          <div>
            <strong>键盘快捷键</strong>
            <small>新建项目 / 查找功能与页面</small>
          </div>
          <span className="shortcut-pair">
            <kbd>Ctrl N</kbd>
            <kbd>Ctrl K</kbd>
          </span>
        </div>
      </section>
    </div>
  )
}
