import type { ReactNode } from 'react'
import { EyeIcon } from '../components/icons'
import type { Pen } from './types'

export interface PenRow extends Pen {
  /** Hidden on the canvas; the eye brings it back. */
  hidden?: boolean
}

/** What the next shape will be: one row per class, the active one highlighted, a digit
 *  on the first nine. Which class the selected shape has is a second question, answered
 *  beside the first: that row carries a stripe, whatever pen is loaded. A map dataset
 *  owns its classes and may recolour, add and remove them here; a scan's layout classes
 *  are fixed, and get an eye to hide them instead. */
export function PenPanel({
  heading = 'Classes', pens, active, selected = null, onPick, onToggleHidden, editable, extra, ranking,
}: {
  heading?: ReactNode
  pens: PenRow[]
  active: Pen['key'] | null
  /** The class of what is selected on the page, if anything is. */
  selected?: Pen['key'] | null
  onPick: (key: Pen['key']) => void
  onToggleHidden?: (key: Pen['key']) => void
  editable?: {
    onRecolor: (key: Pen['key'], hex: string) => void
    onRemove: (pen: PenRow) => void
    onAdd: () => void
  }
  /** Controls of a row's own, after its name - the Line pen's two shapes. */
  extra?: (pen: PenRow) => ReactNode
  /** Overlap priority, 1 the highest: shown on every row, and moved a step by onMove. */
  ranking?: {
    rankOf: (key: Pen['key']) => number
    onMove?: (key: Pen['key'], step: -1 | 1) => void
  }
}) {
  return (
    // However many classes there are - there is no limit - they take the room they need
    // up to a share of the rail and scroll beyond it, so the list and the panels below
    // stay within reach.
    <div className="flex min-h-0 flex-col" style={{ maxHeight: '40%' }}>
      <p className="mb-1 shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-subtle">{heading}</p>
      <div data-testid="class-list" className="min-h-0 space-y-1 overflow-y-auto">
        {pens.map((pen) => {
          const on = pen.key === active
          const marked = pen.key === selected
          return (
            <div
              key={pen.key}
              data-testid="pen-row"
              data-class={pen.label}
              data-active={on}
              data-selected={marked}
              title={marked ? `The selected shape is a ${pen.label}` : undefined}
              className={`flex items-center gap-1.5 rounded border px-1.5 py-1 text-xs ${
                on ? 'border-accent bg-accent-wash' : 'border-transparent hover:bg-raised'
              } ${marked ? 'border-l-2 border-l-accent' : ''} ${pen.hidden ? 'opacity-40' : ''}`}
            >
              <label className="relative inline-flex h-3 w-3 shrink-0" title={editable ? 'Change colour' : undefined}>
                <span data-testid="pen-swatch" className="h-3 w-3 rounded-full" style={{ backgroundColor: pen.color }} />
                {editable && (
                  <input
                    type="color"
                    aria-label={`Colour of ${pen.label}`}
                    value={pen.color}
                    onChange={(e) => editable.onRecolor(pen.key, e.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                )}
              </label>
              <button
                onClick={() => onPick(pen.key)}
                aria-pressed={on}
                data-testid="pen-pill"
                data-class={pen.label}
                title={pen.digit !== null ? `${pen.digit}` : undefined}
                className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${on ? 'font-medium text-accent-ink' : 'text-ink'}`}
              >
                <span className="truncate">{pen.label}</span>
                {pen.digit !== null && (
                  <span aria-hidden="true" className="ml-auto tabular-nums text-ink-subtle">{pen.digit}</span>
                )}
              </button>
              {extra?.(pen)}
              {ranking && (
                <RankControl
                  label={pen.label}
                  rank={ranking.rankOf(pen.key)}
                  last={pens.length}
                  onMove={ranking.onMove && ((step) => ranking.onMove!(pen.key, step))}
                />
              )}
              {onToggleHidden && (
                <button
                  onClick={() => onToggleHidden(pen.key)}
                  title={pen.hidden ? 'show' : 'hide'}
                  aria-label={`${pen.hidden ? 'Show' : 'Hide'} ${pen.label}`}
                  className="shrink-0 text-ink-subtle hover:text-ink"
                >
                  <EyeIcon off={!!pen.hidden} />
                </button>
              )}
              {editable && (
                <button
                  onClick={() => editable.onRemove(pen)}
                  title="Remove class"
                  aria-label={`Remove ${pen.label}`}
                  className="shrink-0 px-0.5 text-ink-subtle hover:text-danger"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
      {editable && (
        <button
          onClick={editable.onAdd}
          className="mt-1.5 w-full shrink-0 rounded border border-dashed border-line-strong px-2 py-1 text-xs text-ink-muted hover:border-accent hover:text-accent-ink"
        >
          + Add class
        </button>
      )}
    </div>
  )
}

function RankControl({ label, rank, last, onMove }: {
  label: string
  rank: number
  last: number
  onMove?: (step: -1 | 1) => void
}) {
  const step = (dir: -1 | 1, testId: string, glyph: string, disabled: boolean) => (
    <button
      data-testid={testId}
      onClick={() => onMove?.(dir)}
      disabled={disabled}
      aria-label={`${dir < 0 ? 'Raise' : 'Lower'} the priority of ${label}`}
      className="px-0.5 leading-none text-ink-subtle hover:text-ink disabled:opacity-30 disabled:hover:text-ink-subtle"
    >
      {glyph}
    </button>
  )
  return (
    <span className="flex shrink-0 items-center" title={`Priority ${rank} of ${last}: it wins overlaps against every lower rank`}>
      {onMove && step(-1, 'class-priority-up', '\u25B2', rank <= 1)}
      <span data-testid="class-priority" className="w-4 text-center text-[10px] tabular-nums text-ink-muted">{rank}</span>
      {onMove && step(1, 'class-priority-down', '\u25BC', rank >= last)}
    </span>
  )
}
