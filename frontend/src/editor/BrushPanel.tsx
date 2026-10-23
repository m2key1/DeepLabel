import { useState } from 'react'
import { Input } from '../components/ui/Field'

export const BRUSH_MIN_PX = 4
export const BRUSH_MAX_PX = 120
// What one notch of the wheel is worth: a step the hand can count, from floor to ceiling.
export const BRUSH_STEP_PX = 4

export const clampBrush = (px: number) =>
  Math.min(BRUSH_MAX_PX, Math.max(BRUSH_MIN_PX, Math.round(px) || BRUSH_MIN_PX))

/** The brush some notches on: up grows it, down shrinks it, neither past the bounds. */
export const stepBrush = (px: number, notches: number) => clampBrush(px + notches * BRUSH_STEP_PX)

/** The brush on the glass, for the circle and the reach alike. The setting is pixels of
 *  the page as it fits the pane, so both grow and shrink with the zoom. Rounded to a
 *  hundredth of a pixel, finer than a screen draws, so float noise never reaches the DOM. */
export const brushOnGlass = (px: number, zoom: number) => Math.round(px * zoom * 100) / 100

/** The eraser's brush, in pixels of the page as it fits the pane: a slider for sweeping
 *  through sizes and a number for coming back to one. Both editors sweep with the same
 *  brush, so both show this. */
export function BrushPanel({ radius, onRadius }: { radius: number; onRadius: (px: number) => void }) {
  // What is being typed stays as typed: clamping every keystroke would turn the 3 of 30
  // into the 4 px floor before the 0 arrived. A size inside the bounds takes at once, and
  // whatever is left is settled on Enter or on leaving the box. An emptied box keeps the
  // size it had.
  const [typed, setTyped] = useState<string | null>(null)
  const type = (text: string) => {
    setTyped(text)
    const px = Number(text)
    if (text !== '' && Number.isInteger(px) && px >= BRUSH_MIN_PX && px <= BRUSH_MAX_PX) onRadius(px)
  }
  const settle = () => {
    if (typed === null) return
    const px = Number(typed)
    if (typed.trim() !== '' && Number.isFinite(px)) onRadius(clampBrush(px))
    setTyped(null)
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">Brush</p>
      <label
        className="mb-1 block text-xs text-ink-muted"
        title="Pixels of the page as it fits the pane: the circle and its reach grow and shrink with the zoom"
      >
        Size {radius}px
        <input
          type="range" min={BRUSH_MIN_PX} max={BRUSH_MAX_PX} step={1} value={radius}
          onChange={(e) => onRadius(Number(e.target.value))}
          // The slider keeps focus after a drag and then eats Ctrl+Z and every other
          // hotkey, which the key handler ignores while an input has it.
          onMouseUp={(e) => e.currentTarget.blur()}
          className="w-full accent-accent"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        Radius
        <Input
          data-testid="brush-radius"
          type="number" min={BRUSH_MIN_PX} max={BRUSH_MAX_PX} step={1} value={typed ?? radius}
          onChange={(e) => type(e.target.value)}
          onBlur={settle}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          size="xs"
          className="w-16 text-right"
        />
        px
      </label>
    </div>
  )
}
