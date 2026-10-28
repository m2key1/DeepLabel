import { useState } from 'react'
import { HOTKEY_ACTIONS, SCOPE_LABEL, scopeOf, type HotkeyScope } from '../../settings'
import { popoverChrome } from '../ui/Card'
import { useDismiss } from '../ui/menu'

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.'],
]
const INDENT = ['0', '0.6rem', '1.2rem', '2rem']

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
        <div className="inline-grid gap-1">
          {ROWS.map((row, r) => (
            <div key={r} className="flex gap-1" style={{ marginLeft: INDENT[r] }}>
              {row.map((key) => {
                const { here, elsewhere } = holder(key)
                const open = picking === key
                return (
                  <div key={key} className="relative">
                    <button type="button" data-testid="keyboard-key" data-key={comboOf(key)} data-command={here}
                            aria-label={`${comboOf(key).toUpperCase()}: ${here ? label(here) : elsewhere ? `${label(elsewhere)} (${SCOPE_LABEL[scopeOf(elsewhere)]})` : 'free'}`}
                            title={here ? label(here) : elsewhere ? `${label(elsewhere)} - ${SCOPE_LABEL[scopeOf(elsewhere)]}` : 'Free - click to give it a command'}
                            onClick={(e) => { e.stopPropagation(); setPicking(open ? null : key) }}
                            className={`relative h-11 w-12 rounded-md border border-b-[3px] px-1 pt-0.5 text-left font-mono text-[11px] ${
                              here ? 'border-accent bg-accent-wash text-accent-ink'
                                : elsewhere ? 'border-dashed border-line-strong text-ink-subtle'
                                  : 'border-line-strong text-ink-subtle hover:border-accent'}`}>
                      {key.toUpperCase()}
                      {(here ?? elsewhere) && (
                        <span className={`absolute inset-x-1 bottom-1 truncate font-sans text-[8.5px] font-semibold leading-tight ${here ? 'text-ink' : 'text-ink-subtle'}`}>
                          {label((here ?? elsewhere)!)}
                        </span>
                      )}
                    </button>
                    {open && (
                      <div onClick={(e) => e.stopPropagation()}
                           className={`absolute left-0 top-full z-30 mt-1 max-h-64 w-60 overflow-auto py-1 ${popoverChrome}`}>
                        <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-ink-subtle">
                          {comboOf(key).toUpperCase()} in {SCOPE_LABEL[scope]}
                        </div>
                        {commands.map((a) => (
                          <button key={a.id} type="button" data-testid="keyboard-key-command" data-command={a.id}
                                  onClick={() => { onBind(a.id, comboOf(key)); setPicking(null) }}
                                  className={`block w-full px-2.5 py-1 text-left text-xs hover:bg-raised ${a.id === here ? 'font-semibold text-accent-ink' : 'text-ink'}`}>
                            {a.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
