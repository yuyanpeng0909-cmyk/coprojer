export interface Appearance {
  accent: 'neutral' | 'sage' | 'blue' | 'violet' | 'terracotta'
  density: 'comfortable' | 'compact'
  radius: number
}

export const appearanceDefaults: Appearance = {
  accent: 'neutral',
  density: 'compact',
  radius: 6,
}

export const accentOptions = [
  { id: 'neutral', name: '黑白', color: '#1a1c1f' },
  { id: 'blue', name: '雾蓝', color: '#4b5bc4' },
  { id: 'violet', name: '鸢尾', color: '#6d28d9' },
  { id: 'sage', name: '鼠尾草', color: '#166534' },
  { id: 'terracotta', name: '陶土', color: '#9a3412' },
] as const
