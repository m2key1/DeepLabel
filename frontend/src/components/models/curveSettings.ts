import { useCallback, useState } from 'react'

import type { XAxis } from './metrics'

export interface CurveSettings {
  axis: XAxis
  scale: 'linear' | 'log'
  /** The EMA weight, 0 for the readings themselves. */
  smoothing: number
  /** Fit the y range to the 5th-95th percentile rather than the extremes. */
  outliers: boolean
  /** What a drag on a chart does: box-zoom, or move the view like a hand. */
  tool: 'zoom' | 'move'
}

export const MAX_SMOOTHING = 0.99

const STORAGE_KEY = 'deeplabel:run-curves'

const DEFAULTS: CurveSettings = { axis: 'step', scale: 'linear', smoothing: 0, outliers: false, tool: 'zoom' }

function load(): CurveSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<CurveSettings>
    return {
      axis: saved.axis === 'epoch' || saved.axis === 'time' || saved.axis === 'step' ? saved.axis : DEFAULTS.axis,
      scale: saved.scale === 'log' ? 'log' : 'linear',
      smoothing: typeof saved.smoothing === 'number' && saved.smoothing >= 0 && saved.smoothing <= MAX_SMOOTHING
        ? saved.smoothing : DEFAULTS.smoothing,
      outliers: saved.outliers === true,
      tool: saved.tool === 'move' ? 'move' : 'zoom',
    }
  } catch {
    return DEFAULTS
  }
}

/** The curve toolbar's choices, remembered per browser the way TensorBoard keeps them. */
export function useCurveSettings(): [CurveSettings, (change: Partial<CurveSettings>) => void] {
  const [settings, setSettings] = useState(load)
  const update = useCallback((change: Partial<CurveSettings>) => {
    setSettings((old) => {
      const next = { ...old, ...change }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // A browser that refuses storage still gets the choice for this visit.
      }
      return next
    })
  }, [])
  return [settings, update]
}
