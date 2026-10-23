import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  HOTKEY_ACTIONS, HOTKEY_SCOPES, KEYBOARD_DEFAULT, PAGE_OVERLAYS, PRESETS, SCOPE_LABEL, VOCAB, VOCAB_GROUPS, comboLabel, commandsFor, eventCombo, evictedBy, scopeOf, useSettings,
} from '../../settings'
import type { VocabGroup } from '../../settings'
import { paletteKey, withKeys, withoutKeys } from '../../palette'
import { ApiTokens } from '../ApiTokens'
import { LlmConnections } from '../llm/LlmConnections'
import { Toggle } from '../ui/Button'
import { CheckField, Input } from '../ui/Field'
import { Section, SubHeading } from '../ui/Section'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const inGroups = new Set(VOCAB)

export interface SettingsPanel {
  id: string
  label: string
  node: ReactNode
}

/** Your own settings, one panel each, shown as tabs on your profile. */
export function useSettingsPanels(): SettingsPanel[] {
  const { hotkeys, keyboard, keyboardSource, pageOverlays, shareActivity, showActivity, save } =
    useSettings()
  const [capturing, setCapturing] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const chosen = new Set(keyboard.map(paletteKey))
  // Added by hand, so no group below would otherwise show them - or let one go again.
  const own = keyboard.filter((c) => !inGroups.has(paletteKey(c)))

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
  const addChars = (chars: string[]) => save({ keyboard: withKeys(keyboard, chars) })
  const removeChars = (chars: string[]) => save({ keyboard: withoutKeys(keyboard, chars) })
  const toggleGlyph = (ch: string) => (chosen.has(paletteKey(ch)) ? removeChars([ch]) : addChars([ch]))
  // The stored order is the order of the bar under the line editor, so rearranging the
  // palette is rearranging this array.
  const moveChar = (from: number, to: number) => {
    if (to < 0 || to >= keyboard.length || from === to) return
    const next = [...keyboard]
    next.splice(to, 0, ...next.splice(from, 1))
    save({ keyboard: next })
  }
  const allOn = (g: VocabGroup) => g.chars.every((c) => chosen.has(paletteKey(c)))
  const toggleGroup = (g: VocabGroup) => (allOn(g) ? removeChars(g.chars) : addChars(g.chars))
  // Split by grapheme, so a pasted decomposed umlaut stays one key instead of becoming
  // a letter and a bare combining mark.
  const addCustom = () => {
    const graphemes = [...segmenter.segment(custom)].map((s) => s.segment).filter((c) => c.trim())
    addChars(graphemes)
    setCustom('')
  }

  const keyBtn =
    'min-w-20 rounded border border-line-strong px-2 py-1 text-center text-sm font-medium text-ink hover:border-accent'

  const glyphKey = (c: string, key: string | number) => (
    <Toggle
      key={key}
      on={chosen.has(paletteKey(c))}
      size="icon"
      onClick={() => toggleGlyph(c)}
      title={c}
      className="h-8 w-8 font-ocr text-sm"
    >
      {c}
    </Toggle>
  )

  return [
    { id: 'together', label: 'Working together', node: (
      <Section title="Working together">
        <div className="space-y-2 text-sm">
          <CheckField
            data-testid="share-activity"
            checked={shareActivity}
            onChange={(on) => save({ share_activity: on })}
            label="Share what I am working on"
            help="Others see which dataset and page you have open. Off makes you invisible; you still see them."
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
    { id: 'opening', label: 'Opening a page', node: (
      <Section title="Opening a page">
        <p className="mb-2 text-xs text-ink-muted">
          What a freshly opened page shows. Switching an overlay in the viewer stays with that page for
          as long as it is open; this is where it starts.
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
    { id: 'characters', label: 'Character keyboard', node: (
      <Section
        title="Character keyboard"
        actions={
          <div className="ml-auto flex items-center gap-3">
            <button
              data-testid="palette-clear"
              onClick={() => save({ keyboard: [] })}
              className="text-xs text-ink-muted hover:text-danger"
            >
              Clear
            </button>
            <button
              data-testid="palette-reset"
              onClick={() => save({ keyboard: KEYBOARD_DEFAULT })}
              className="text-xs text-ink-muted hover:text-accent-ink"
            >
              Reset to defaults
            </button>
          </div>
        }
      >
        <div className="mb-2 space-y-1 text-sm">
          {([['own', 'Keys I pick myself'],
             ['dataset', 'Fill from the dataset I am working on']] as const).map(([id, label]) => (
            <label key={id} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="keyboard-source"
                data-testid={`keyboard-source-${id}`}
                checked={keyboardSource === id}
                onChange={() => save({ keyboard_source: id })}
                className="mt-0.5 cursor-pointer accent-accent"
              />
              <span>
                {label}
                <span className="block text-xs text-ink-muted">
                  {id === 'own'
                    ? 'The palette below, in the order you arranged it.'
                    : 'Every character that dataset writes which a keyboard cannot type, in the '
                      + 'order of the groups below, and it grows as the text does. Your own picks '
                      + 'stand in until it has been read.'}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mb-2 text-xs text-ink-muted">
          The characters the corpora actually carry, minus the plain keyboard ones. Click to add them
          to the bar under the line editor; selected ({chosen.size}) are highlighted. Anything missing goes
          in the box below - the model reads bytes, so no character is out of its reach. Accented letters
          are written decomposed to match the model.
        </p>
        {keyboard.length > 0 && (
          <div className="mb-3">
            <SubHeading>
              Your keyboard, in order
            </SubHeading>
            <p className="mb-1 text-[11px] text-ink-muted">
              Drag a key, or focus one and use ← and → to move it. Backspace takes it off.
            </p>
            <div data-testid="palette-order" className="flex flex-wrap gap-1">
              {keyboard.map((c, i) => (
                <button
                  // Keyed by the character, which is unique in a palette: moving one
                  // then keeps the same DOM node, so it keeps focus and can be moved
                  // again without being picked up a second time.
                  key={c}
                  type="button"
                  draggable
                  data-testid="palette-key"
                  data-capture-keys=""
                  data-char={c}
                  aria-label={`${c}, position ${i + 1} of ${keyboard.length}`}
                  title={`${c} - drag, or ← → to move, Backspace to remove`}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', String(i))
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const from = Number(e.dataTransfer.getData('text/plain'))
                    if (Number.isInteger(from)) moveChar(from, i)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') {
                      e.preventDefault()
                      moveChar(i, i - 1)
                    } else if (e.key === 'ArrowRight') {
                      e.preventDefault()
                      moveChar(i, i + 1)
                    } else if (e.key === 'Backspace' || e.key === 'Delete') {
                      e.preventDefault()
                      removeChars([c])
                    }
                  }}
                  className="flex h-8 w-8 cursor-grab items-center justify-center rounded border border-accent bg-accent-wash font-ocr text-sm text-accent-ink active:cursor-grabbing"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-muted">Presets:</span>
          {PRESETS.map((p) => {
            const on = allOn(p)
            return (
              <Toggle
                key={p.label}
                on={on}
                onClick={() => toggleGroup(p)}
                title={p.chars.join(' ')}
              >
                {on ? '− ' : '+ '}
                {p.label}
              </Toggle>
            )
          })}
        </div>
        <form
          className="mb-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            addCustom()
          }}
        >
          <label className="text-xs text-ink-muted" htmlFor="custom-glyphs">
            Your own:
          </label>
          <Input
            id="custom-glyphs"
            data-testid="custom-glyphs"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="type or paste characters"
            className="w-56 font-ocr placeholder:font-sans placeholder:text-xs"
          />
          <button
            type="submit"
            disabled={!custom.trim()}
            className="rounded-full border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-muted hover:border-accent hover:text-accent-ink disabled:opacity-40"
          >
            Add
          </button>
        </form>
        {own.length > 0 && (
          <div className="mb-3" data-testid="own-glyphs">
            <SubHeading>Your own</SubHeading>
            <div className="flex flex-wrap gap-1">{own.map(glyphKey)}</div>
          </div>
        )}
        <div className="space-y-3">
          {VOCAB_GROUPS.map((g) => (
            <div key={g.label} data-testid="vocab-group" data-group={g.label}>
              <div className="mb-1 flex items-baseline gap-2">
                <SubHeading className="mb-0">{g.label}</SubHeading>
                <span className="text-[11px] text-ink-subtle">{g.chars.length}</span>
                <button
                  onClick={() => toggleGroup(g)}
                  className="text-[11px] text-ink-muted hover:text-accent-ink"
                >
                  {allOn(g) ? 'Clear' : 'Add all'}
                </button>
              </div>
              {g.note && (
                <p data-testid="group-note" className="mb-1 text-[11px] text-ink-muted">
                  {g.note}
                </p>
              )}
              <div className="flex flex-wrap gap-1">{g.chars.map(glyphKey)}</div>
            </div>
          ))}
        </div>
      </Section>
    ) },
    { id: 'tokens', label: 'API tokens', node: (
      <ApiTokens />
    ) },
    { id: 'llm', label: 'LLM connections', node: (
      <LlmConnections />
    ) },
  ]
}
