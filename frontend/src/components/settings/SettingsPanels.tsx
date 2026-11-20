import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  HOTKEY_ACTIONS, HOTKEY_SCOPES, PAGE_OVERLAYS, SCOPE_LABEL, comboLabel, commandsFor, eventCombo, evictedBy, scopeOf, useSettings,
} from '../../settings'
import { ApiTokens } from '../ApiTokens'
import { CharacterKeyboard } from './CharacterKeyboard'
import { KeyboardMap } from './KeyboardMap'
import { LlmConnections } from '../llm/LlmConnections'
import { CheckField } from '../ui/Field'
import { Section, SubHeading } from '../ui/Section'

export interface SettingsPanel {
  id: string
  label: string
  node: ReactNode
}

/** Your own settings, one panel each, shown as tabs on your profile. */
export function useSettingsPanels(): SettingsPanel[] {
  const { hotkeys, pageOverlays, shareActivity, showActivity, save } = useSettings()
  const [capturing, setCapturing] = useState<string | null>(null)
  // A combo runs one command wherever the two could both be on screen, so binding it
  // here takes it off whatever held it there - otherwise the same key would fire two
  // things and the loser would look broken. The page viewer and the map editor never
  // share a screen, so a letter may mean one thing in each.
  const rebind = (id: string, combo: string) => {
    const next = { ...hotkeys, [id]: combo }
    for (const taken of evictedBy(hotkeys, id, combo)) next[taken] = ''
    save({ hotkeys: next })
    setCapturing(null)
  }
  const label = (id: string) => HOTKEY_ACTIONS.find((a) => a.id === id)?.label ?? id
  const sharedWith = (id: string) =>
    commandsFor(hotkeys, hotkeys[id]).filter((other) => other !== id)
  const unbind = (id: string) => save({ hotkeys: { ...hotkeys, [id]: '' } })
  const keyBtn =
    'min-w-20 rounded border border-line-strong px-2 py-1 text-center text-sm font-medium text-ink hover:border-accent'

  return [
    { id: 'together', label: 'Working together', node: (
      <Section title="Working together">
        <div className="space-y-2 text-sm">
          <CheckField
            data-testid="share-activity"
            checked={shareActivity}
            onChange={(on) => save({ share_activity: on })}
            label="Share what I am working on"
            help="Others see which dataset and page you have open. Off keeps that to yourself: you still count as online, and you still see them."
          />
          <CheckField
            data-testid="show-activity"
            checked={showActivity}
            onChange={(on) => save({ show_activity: on })}
            label="Show where others are"
            help="Who is online in the nav bar, avatars on datasets and pages, and a notice when someone
                  else has the page you open."
          />
        </div>
      </Section>
    ) },
    { id: 'visibility', label: 'Default visibility', node: (
      <Section title="Default visibility">
        <p className="mb-2 text-xs text-ink-muted">
          What a page shows when you open it. An overlay you toggle in the viewer stays that way on the
          pages you go on to, until you leave the viewer.
        </p>
        <div className="space-y-2 text-sm">
          {PAGE_OVERLAYS.map((overlay) => (
            <CheckField
              key={overlay.id}
              data-testid={`overlay-default-${overlay.id}`}
              checked={pageOverlays[overlay.id]}
              onChange={(on) => save({ page_overlays: { ...pageOverlays, [overlay.id]: on } })}
              label={overlay.label}
              help={overlay.note}
            />
          ))}
        </div>
      </Section>
    ) },
    { id: 'keys', label: 'Keyboard shortcuts', node: (
      <Section
        title="Keyboard shortcuts"
        actions={
          <button
            onClick={() => save({ hotkeys: {} })}
            className="ml-auto text-xs text-ink-muted hover:text-accent-ink"
          >
            Reset to defaults
          </button>
        }
      >
        <p className="mb-3 text-xs text-ink-muted">
          Click a shortcut, then press the key - hold Shift, Ctrl, Alt, or ⌘ to bind a combo. Esc
          cancels, and × takes a key off again. Most commands start unbound; binding a key that is
          already taken moves it, unless the two can never be on screen together. A command only
          answers on a page that offers it.
        </p>
        <KeyboardMap scopes={HOTKEY_SCOPES} hotkeys={hotkeys} onBind={rebind} />
        <div className="space-y-4">
          {HOTKEY_SCOPES.map((scope) => (
            <div key={scope} data-testid="hotkey-group" data-group={SCOPE_LABEL[scope]}>
              <SubHeading>{SCOPE_LABEL[scope]}</SubHeading>
              <div className="divide-y divide-line rounded-md border border-line">
                {HOTKEY_ACTIONS.filter((a) => a.scope === scope).map((a) => (
                  <div key={a.id} data-testid="hotkey-row" data-command={a.id}
                       className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 text-sm text-ink">
                      {a.label}
                      {sharedWith(a.id).map((other) => (
                        <span key={other} className="ml-2 text-xs text-ink-subtle">
                          also {SCOPE_LABEL[scopeOf(other)]}: {label(other)}
                        </span>
                      ))}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        data-testid="hotkey-bind"
                        data-capture-keys=""
                        onClick={() => setCapturing(a.id)}
                        onBlur={() => setCapturing((c) => (c === a.id ? null : c))}
                        onKeyDown={(e) => {
                          if (capturing !== a.id) return
                          e.preventDefault()
                          if (e.key === 'Escape') return setCapturing(null)
                          const combo = eventCombo(e.nativeEvent)
                          if (combo) rebind(a.id, combo)
                        }}
                        className={`${keyBtn} ${capturing === a.id ? 'border-accent text-accent-ink' : ''}`}
                      >
                        {capturing === a.id ? 'press a key…' : comboLabel(hotkeys[a.id])}
                      </button>
                      <button
                        data-testid="hotkey-clear"
                        onClick={() => unbind(a.id)}
                        disabled={!hotkeys[a.id]}
                        aria-label={`Clear the shortcut for ${a.label}`}
                        className="px-1 text-sm text-ink-subtle hover:text-danger disabled:opacity-30 disabled:hover:text-ink-subtle"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
    ) },
    { id: 'characters', label: 'Character keyboard', node: <CharacterKeyboard /> },
    { id: 'tokens', label: 'API tokens', node: (
      <ApiTokens />
    ) },
    { id: 'llm', label: 'LLM connections', node: (
      <LlmConnections />
    ) },
  ]
}
