import { useRef, useState } from 'react'
import { lineCropUrl } from '../../api'
import type { Line } from '../../api'
import { profileStops } from '../../lib/confidence'
import type { CropPlan } from '../../lib/geometry/quad'
import { useAuth } from '../../auth'
import { comboLabel, useSettings } from '../../settings'
import { LOUPE_HEIGHT, clampLoupeHeight } from '../../util'
import { boxChrome } from '../chrome'
import { Splitter } from '../ui/Splitter'

interface LineLoupeProps {
  line: Line | null
  editing: boolean
  showConfidence: boolean
  orientation: number
  onRotate: (dir: 1 | -1) => void
  /** How tall the crop is drawn, in pixels. */
  height: number
  onResize: (e: React.PointerEvent) => void
  onHeight: (px: number) => void
  /** What the crop is cut from, so the loupe can say when it is not what a reader expects. */
  plan: CropPlan | null
  /** What the OCR model resizes a line to. Null until a run has loaded the checkpoint. */
  targetHeight: number | null
  maxWidth: number | null
}

/** What is worth saying about this crop, and nothing when there is nothing to say.
 *
 *  A caption that is always there stops being read; these appear only when the crop is not
 *  what someone would assume from looking at the page, which is rare and always actionable:
 *  rescan a line too small to have detail, split one too long, redraw one lying at an angle
 *  the backend will not straighten. */
function complaints(plan: CropPlan | null, targetHeight: number | null,
                    maxWidth: number | null): string[] {
  if (!plan) return []
  const out: string[] = []
  if (!plan.deskewed && plan.tilt > 2) out.push(`not straightened - ${Math.round(plan.tilt)}° tilt`)
  const [wide, tall] = plan.size
  if (targetHeight && tall > 0) {
    const scale = targetHeight / tall
    if (scale >= 1.5) out.push(`upscaled ${scale.toFixed(1)}x`)
    if (maxWidth && wide * scale > maxWidth) {
      out.push(`squashed ${(wide * scale / maxWidth).toFixed(1)}x to fit ${maxWidth}px`)
    }
  }
  return out
}

export function LineLoupe({ line, editing, showConfidence, orientation, onRotate,
                           height, onResize, onHeight,
                           plan, targetHeight, maxWidth }: LineLoupeProps) {
  const { canEdit } = useAuth()
  // Off by default: fitted is the useful view, and true scale is for answering "why is this
  // line read so badly" rather than for reading along.
  const [trueScale, setTrueScale] = useState(false)
  const { hotkeys: hk } = useSettings()
  // A second press, counted here rather than left to onDoubleClick: the drag has to
  // preventDefault on pointerdown to stop the press selecting the text around it, and that
  // suppresses the click events the browser would otherwise synthesise from it.
  const pressed = useRef(-Infinity)

  // The loupe shows the aligned base crop OCR reads, spun by the manual orientation with CSS.
  const heat =
    line && showConfidence && line.conf_profile
      ? `linear-gradient(to right, ${profileStops(line.conf_profile)
          .map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`)
          .join(', ')})`
      : null
  const said = complaints(plan, targetHeight, maxWidth)
  const quarter = orientation % 180 === 90 // rotated to portrait: fit its width to the box height
  const rotBtn =
    'flex h-8 w-8 items-center justify-center rounded-md border border-line-strong bg-surface/90 text-xl leading-none text-ink shadow-sm hover:border-accent hover:text-accent-ink'

  return (
    <div className="mb-3 shrink-0">
      <div id="line-loupe" data-testid="line-loupe" style={{ height }}
           className={`relative overflow-hidden ${boxChrome}`}>
        {line ? (
          <>
            <div className={`flex h-full items-center ${
              trueScale ? 'justify-start overflow-auto' : 'justify-center overflow-hidden'}`}>
              <div className="relative flex h-full max-w-full items-center">
                <img
                  src={lineCropUrl(line)}
                  alt=""
                  // Scale the crop's height to the loupe, upscaling short crops too - unless
                  // that would run it off the side, in which case it is fitted to the width
                  // instead and padded above and below. Either way the whole line is on
                  // screen at once. Turned on its side it is the loupe's height that has to
                  // become its width, or a portrait crop grows past the box it sits in.
                  data-testid="loupe-crop"
                  data-true-scale={trueScale}
                  className={trueScale ? 'max-w-none' : 'max-h-full max-w-full object-contain'}
                  style={trueScale && targetHeight
                    ? { transform: `rotate(${orientation}deg)`, height: targetHeight }
                    : { transform: `rotate(${orientation}deg)`,
                        ...(quarter ? { width: height } : { height: '100%' }) }}
                />
                {heat && (
                  <div className="pointer-events-none absolute inset-0"
                       style={{ background: heat, opacity: 0.4 }} />
                )}
              </div>
            </div>
            {said.length > 0 && (
              <div data-testid="loupe-complaints"
                   className="pointer-events-none absolute bottom-1 left-1.5 flex flex-wrap gap-1">
                {said.map((what) => (
                  <span key={what}
                        className="rounded bg-warn/20 px-1.5 py-0.5 text-[11px] font-medium text-warn shadow-sm">
                    {what}
                  </span>
                ))}
              </div>
            )}
            {targetHeight !== null && (
              <button
                type="button"
                data-testid="loupe-true-scale"
                aria-pressed={trueScale}
                title={`Show it at the ${targetHeight}px the model resizes it to, rather than fitted to this box`}
                onClick={() => setTrueScale((was) => !was)}
                className={`absolute bottom-1 right-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium shadow-sm ${
                  trueScale
                    ? 'bg-accent text-on-accent'
                    : 'bg-surface/90 text-ink-muted'
                }`}
              >
                1:1
              </button>
            )}
            {canEdit && (
              <div className="absolute right-1.5 top-1.5 flex gap-1">
                <button
                  type="button"
                  onClick={() => onRotate(-1)}
                  aria-label="Rotate counter-clockwise"
                  data-testid="line-rotate-ccw"
                  title={`Rotate counter-clockwise (${comboLabel(hk.rotateCcw)})`}
                  className={rotBtn}
                >
                  ⟲
                </button>
                <button
                  type="button"
                  onClick={() => onRotate(1)}
                  aria-label="Rotate clockwise"
                  data-testid="line-rotate-cw"
                  title={`Rotate clockwise (${comboLabel(hk.rotateCw)})`}
                  className={rotBtn}
                >
                  ⟳
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <span className="text-xs text-ink-subtle">
              {editing ? 'Select a line to magnify it' : 'Hover a line to magnify it'}
            </span>
          </div>
        )}
      </div>
      {/* On the shell rather than inside the box, so it is there for an empty loupe too:
          how tall to leave the crop is worth settling before a line is picked. */}
      <Splitter
        orientation="horizontal"
        aria-label="Height of the loupe"
        aria-valuemin={LOUPE_HEIGHT.least}
        aria-valuemax={LOUPE_HEIGHT.most}
        aria-valuenow={height}
        aria-controls="line-loupe"
        data-testid="loupe-divider"
        title="Drag to resize, double-click to reset"
        onPointerDown={(e) => {
          // A clock of our own: a synthesised event can carry a timeStamp of nearly zero,
          // which would read as a second press before there has been a first.
          const now = performance.now()
          const again = now - pressed.current < 400
          pressed.current = again ? -Infinity : now
          if (again) onHeight(LOUPE_HEIGHT.fallback)
          else onResize(e)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          e.preventDefault()
          onHeight(clampLoupeHeight(height + (e.key === 'ArrowUp' ? -16 : 16)))
        }}
        className="mt-0.5"
      />
    </div>
  )
}
