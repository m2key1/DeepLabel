import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HOTKEY_ACTIONS, SCOPE_LABEL, scopeOf, type HotkeyScope } from '../../settings'
import { popoverChrome } from '../ui/Card'
import { useDismiss } from '../ui/menu'

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.'],
]
// Each key spans four columns, and each row starts a column further in than the one above,
// the stagger of a real keyboard; the grid stretches the whole of it to the panel's width.
const COLUMNS = Math.max(...ROWS.map((row, r) => r + 4 * row.length))

/** The shortcuts of one scope drawn on a keyboard, with or without Shift held: a taken key
 *  names its command, a free one is blank. Clicking a key offers the scope's commands to
 *  put on it; a key held by a command that is live beside this scope says so. */
export function KeyboardMap({ scopes, hotkeys, onBind }: {
  scopes: HotkeyScope[]
  hotkeys: Record<string, string>
  onBind: (id: string, combo: string) => void
}) {
  const [scope, setScope] = useState<HotkeyScope>(scopes.includes('editor') ? 'editor' : scopes[0])
  const [shift, setShift] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  useDismiss(picking !== null, () => setPicking(null))

  const comboOf = (key: string) => (shift ? `shift+${key}` : key)
  const holder = (key: string) => {
    const ids = HOTKEY_ACTIONS.filter((a) => hotkeys[a.id] === comboOf(key)).map((a) => a.id)
    return { here: ids.find((id) => scopeOf(id) === scope), elsewhere: ids.find((id) => scopeOf(id) !== scope) }
  }
  const label = (id: string) => HOTKEY_ACTIONS.find((a) => a.id === id)?.label ?? id
  const keyLabel = (id: string) => {
    const action = HOTKEY_ACTIONS.find((a) => a.id === id)
    return action?.short ?? action?.label ?? id
  }
  const commands = HOTKEY_ACTIONS.filter((a) => a.scope === scope)

  return (
    <div data-testid="keyboard-map" className="mb-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Where the keys apply" className="flex overflow-hidden rounded border border-line-strong text-xs">
          {scopes.map((s) => (
            <button key={s} type="button" aria-pressed={s === scope} onClick={() => setScope(s)}
                    className={`px-2 py-1 ${s === scope ? 'bg-accent-wash font-medium text-accent-ink' : 'text-ink-muted hover:bg-raised'}`}>
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        <button type="button" role="switch" aria-checked={shift} data-testid="keyboard-map-shift" onClick={() => setShift(!shift)}
                className={`rounded border px-2 py-1 text-xs ${shift ? 'border-accent bg-accent-wash text-accent-ink' : 'border-line-strong text-ink-muted'}`}>
          ⇧ Shift {shift ? 'held' : 'off'}
        </button>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[36rem] gap-y-1" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
          {ROWS.map((row, r) => row.map((key, k) => {
            const { here, elsewhere } = holder(key)
            const shown = here ?? elsewhere
            return (
              <button key={key} type="button" data-testid="keyboard-key" data-key={comboOf(key)} data-command={here}
                      aria-label={`${comboOf(key).toUpperCase()}: ${here ? label(here) : elsewhere ? `${label(elsewhere)} (${SCOPE_LABEL[scopeOf(elsewhere)]})` : 'free'}`}
                      title={here ? label(here) : elsewhere ? `${label(elsewhere)} - ${SCOPE_LABEL[scopeOf(elsewhere)]}` : 'Free - click to give it a command'}
                      aria-haspopup="menu" aria-expanded={picking === key}
                      onClick={(e) => { e.stopPropagation(); setPicking(picking === key ? null : key) }}
                      style={{ gridRow: r + 1, gridColumn: `${1 + r + 4 * k} / span 4` }}
                      className={`mx-0.5 flex h-14 min-w-0 flex-col rounded-md border border-b-[3px] px-1.5 pt-1 text-left ${
                        here ? 'border-accent bg-accent-wash text-accent-ink'
                          : elsewhere ? 'border-dashed border-line-strong text-ink-subtle'
                            : 'border-line-strong text-ink-subtle hover:border-accent'}`}>
                <span className="font-mono text-[11px] leading-none">{key.toUpperCase()}</span>
                {shown && (
                  <span className={`mt-auto mb-1 line-clamp-2 break-words text-[10px] font-semibold leading-[1.15] ${here ? 'text-ink' : 'text-ink-subtle'}`}>
                    {keyLabel(shown)}
                  </span>
                )}
              </button>
            )
          }))}
        </div>
      </div>
      {picking !== null && (
        <CommandList anchor={`[data-testid="keyboard-key"][data-key="${comboOf(picking)}"]`}
                     heading={`${comboOf(picking).toUpperCase()} in ${SCOPE_LABEL[scope]}`}
                     commands={commands} current={holder(picking).here}
                     onPick={(id) => { onBind(id, comboOf(picking)); setPicking(null) }} />
      )}
    </div>
  )
}

/** The commands a key can take, floating over the page beside the key: under it, or above
 *  it when the window has no room below, and scrolling inside itself when neither fits. */
function CommandList({ anchor, heading, commands, current, onPick }: {
  anchor: string
  heading: string
  commands: { id: string; label: string }[]
  current: string | undefined
  onPick: (id: string) => void
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null)

  useLayoutEffect(() => {
    const key = document.querySelector(anchor)
    if (!key || !panel.current) return
    const position = () => {
      const { left, top, bottom } = key.getBoundingClientRect()
      const height = panel.current?.scrollHeight ?? 0
      const below = window.innerHeight - bottom - MARGIN
      const above = top - MARGIN
      const x = Math.max(MARGIN, Math.min(left, window.innerWidth - PANEL_WIDTH - MARGIN))
      setPlace(height <= below || below >= above
        ? { left: x, top: bottom + 4, maxHeight: below - 4 }
        : { left: x, bottom: window.innerHeight - top + 4, maxHeight: above - 4 })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [anchor])

  return createPortal(
    <div ref={panel} role="menu" data-testid="keyboard-key-commands" onClick={(e) => e.stopPropagation()}
         style={{ ...place, width: PANEL_WIDTH, visibility: place ? 'visible' : 'hidden' }}
         className={`fixed z-50 overflow-auto py-1 ${popoverChrome}`}>
      <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-ink-subtle">{heading}</div>
      {commands.map((a) => (
        <button key={a.id} type="button" role="menuitem" data-testid="keyboard-key-command" data-command={a.id}
                onClick={() => onPick(a.id)}
                className={`block w-full px-2.5 py-1 text-left text-xs hover:bg-raised ${a.id === current ? 'font-semibold text-accent-ink' : 'text-ink'}`}>
          {a.label}
        </button>
      ))}
    </div>,
    document.body)
}

const PANEL_WIDTH = 240
const MARGIN = 8
