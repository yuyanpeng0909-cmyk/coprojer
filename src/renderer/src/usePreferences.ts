import { useEffect, useState } from 'react'
import { accentOptions, appearanceDefaults, type Appearance } from './appearance'
const workspaceKey = 'coprojer.workspace.v1'
const appearanceKey = 'coprojer.demo.appearance.v3.desktop'
function read(key: string): Record<string, any> {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}
export function usePreferences() {
  const [theme, setThemeState] = useState<'light' | 'dark'>(() =>
    read(workspaceKey).theme === 'dark' ? 'dark' : 'light',
  )
  const [appearance, setAppearanceState] = useState<Appearance>(() => {
    const value = read(appearanceKey)
    return {
      accent: accentOptions.some((a) => a.id === value.accent)
        ? value.accent
        : appearanceDefaults.accent,
      density: value.density === 'comfortable' ? 'comfortable' : 'compact',
      radius:
        typeof value.radius === 'number' && Number.isFinite(value.radius)
          ? Math.max(0, Math.min(20, value.radius))
          : 6,
    }
  })
  const [error, setError] = useState('')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    const element = document.documentElement
    element.dataset.accent = appearance.accent
    element.dataset.density = appearance.density
    element.style.setProperty('--demo-radius', `${appearance.radius}px`)
  }, [appearance])
  const setTheme = (value: 'light' | 'dark') => {
    setThemeState(value)
    try {
      const saved = localStorage.getItem(workspaceKey)
      const previous = saved ? JSON.parse(saved) : {}
      localStorage.setItem(workspaceKey, JSON.stringify({ ...previous, theme: value }))
      setError('')
    } catch {
      setError('外观未能保存，原有本地资料未覆盖。')
    }
  }
  const setAppearance = (value: Appearance) => {
    setAppearanceState(value)
    try {
      localStorage.setItem(appearanceKey, JSON.stringify(value))
      setError('')
    } catch {
      setError('外观未能保存，请检查本地存储。')
    }
  }
  return {
    theme,
    appearance,
    setTheme,
    setAppearance,
    error,
    toggleTheme: () => setTheme(theme === 'light' ? 'dark' : 'light'),
  }
}
export type Preferences = ReturnType<typeof usePreferences>
