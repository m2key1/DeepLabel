import { useSyncExternalStore } from 'react'
import { Button } from './ui/Button'
import { ThemeIcon } from './icons'

export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_KEY = 'deeplabel.theme'

function storedTheme(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function applyTheme(mode: ThemeMode) {
  const dark =
    mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

// One mode for the whole app, so the top bar's switch and the shortcut that cycles it agree.
let current: ThemeMode = 'system'
const listeners = new Set<() => void>()

export function initTheme() {
  current = storedTheme()
  applyTheme(current)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current === 'system') applyTheme('system')
  })
}

export function setTheme(mode: ThemeMode) {
  current = mode
  localStorage.setItem(THEME_KEY, mode)
  applyTheme(mode)
  for (const listener of listeners) listener()
}

const LABELS: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' }
const NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' }

export const cycleTheme = () => setTheme(NEXT[current])

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, () => current)
}

export function ThemeToggle() {
  const mode = useTheme()
  return (
    <Button variant="ghost" size="icon" onClick={cycleTheme} data-testid="theme-toggle" data-mode={mode}
            title={`Theme: ${LABELS[mode]} - click for ${LABELS[NEXT[mode]]}`} aria-label="Theme">
      <ThemeIcon mode={mode} />
    </Button>
  )
}
