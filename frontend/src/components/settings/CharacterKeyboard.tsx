import { useState } from 'react'
import { KEYBOARD_DEFAULT, PRESETS, VOCAB, VOCAB_GROUPS, useSettings } from '../../settings'
import type { VocabGroup } from '../../settings'
import type { KeyboardSource } from '../../api'
import { CHAR_NAMES, matchesSearch } from '../../charNames'
import { paletteKey, withKeys, withoutKeys } from '../../palette'
import { boxChrome } from '../chrome'
import { Toggle } from '../ui/Button'
import { Input } from '../ui/Field'
import { Section } from '../ui/Section'
import { Segmented } from '../ui/Segmented'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const inGroups = new Set(VOCAB)

const SOURCES: { value: KeyboardSource; label: string; note: string }[] = [
  { value: 'own', label: 'My keys', note: 'The line editor shows the keys below, in their order.' },
  { value: 'dataset', label: 'From the dataset',
    note: 'The line editor shows what the open dataset writes beyond a plain keyboard; the keys below '
      + 'stand in until it has been read.' },
]

const named = (c: string) => {
  const name = CHAR_NAMES[paletteKey(c)]
  return name ? `${c} ${name}` : c
}

/** The characters offered under the line editor: the keyboard you arrange, and the groups
 *  and presets it is filled from. */
export function CharacterKeyboard() {
  const { keyboard, keyboardSource, save } = useSettings()
  const [search, setSearch] = useState('')
  const [pasted, setPasted] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const chosen = new Set(keyboard.map(paletteKey))
  // Added by hand, so no group below would otherwise show them - or let one go again.
  const own = keyboard.filter((c) => !inGroups.has(paletteKey(c)))
  const searching = search.trim() !== ''

  const addChars = (chars: string[]) => save({ keyboard: withKeys(keyboard, chars) })
  const removeChars = (chars: string[]) => save({ keyboard: withoutKeys(keyboard, chars) })
  const toggleGlyph = (c: string) => (chosen.has(paletteKey(c)) ? removeChars([c]) : addChars([c]))
  const allOn = (g: VocabGroup) => g.chars.every((c) => chosen.has(paletteKey(c)))
  const toggleGroup = (g: VocabGroup) => (allOn(g) ? removeChars(g.chars) : addChars(g.chars))
  const toggleOpen = (label: string) =>
    setOpen((was) => new Set(was.has(label) ? [...was].filter((l) => l !== label) : [...was, label]))
  // The stored order is the order of the bar under the line editor, so rearranging the
  // keyboard is rearranging this array.
  const moveChar = (from: number, to: number) => {
    if (to < 0 || to >= keyboard.length || from === to) return
    const next = [...keyboard]
    next.splice(to, 0, ...next.splice(from, 1))
    save({ keyboard: next })
  }
  // Split by grapheme, so a pasted decomposed umlaut stays one key instead of becoming
  // a letter and a bare combining mark.
  const addPasted = () => {
    addChars([...segmenter.segment(pasted)].map((s) => s.segment).filter((c) => c.trim()))
    setPasted('')
  }

  const groups: (VocabGroup & { testId: string; shown: string[] })[] = [
    ...(own.length > 0 ? [{ label: 'Your own', chars: own, testId: 'own-glyphs' }] : []),
    ...VOCAB_GROUPS.map((g) => ({ ...g, testId: 'vocab-group' })),
  ].map((g) => ({ ...g, shown: searching ? g.chars.filter((c) => matchesSearch(c, search)) : g.chars }))
    .filter((g) => !searching || g.shown.length > 0)

  return (
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
      <Segmented
        value={keyboardSource}
        options={SOURCES}
        onChange={(source) => save({ keyboard_source: source })}
        className="w-fit"
      />
      <p data-testid="keyboard-source-note" className="mb-3 mt-1 text-xs text-ink-muted">
        {SOURCES.find((s) => s.value === keyboardSource)?.note}
      </p>

      <div data-testid="palette-order" className={`flex min-h-11 flex-wrap justify-center gap-1 p-1.5 ${boxChrome}`}>
        {keyboard.length === 0 && (
          <span className="self-center text-xs text-ink-subtle">No keys yet - add some below.</span>
        )}
        {keyboard.map((c, i) => (
          <button
            // Keyed by the character, which is unique in a palette: moving one then keeps
            // the same DOM node, so it keeps focus and can be moved again without being
            // picked up a second time.
            key={c}
            type="button"
            draggable
            data-testid="palette-key"
            data-capture-keys=""
            data-char={c}
            aria-label={`${c}, position ${i + 1} of ${keyboard.length}`}
            title={`${named(c)} - drag, or ← → to move; Backspace removes it`}
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
            className="flex h-7 min-w-7 cursor-grab items-center justify-center rounded border border-line px-1 font-ocr text-sm leading-none hover:border-accent hover:bg-accent-wash active:cursor-grabbing"
          >
            {c}
          </button>
        ))}
      </div>
      {keyboard.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-muted">Drag to reorder, Backspace removes</p>
      )}

      <div className="mb-2 mt-4 flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find by name: long s, macron"
          aria-label="Find a character"
          className="w-56"
        />
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            addPasted()
          }}
        >
          <Input
            data-testid="custom-glyphs"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="paste characters"
            aria-label="Characters to add"
            className="w-36 font-ocr placeholder:font-sans placeholder:text-xs"
          />
          <button
            type="submit"
            disabled={!pasted.trim()}
            className="rounded-full border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-muted hover:border-accent hover:text-accent-ink disabled:opacity-40"
          >
            Add
          </button>
        </form>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const on = allOn(p)
          return (
            <Toggle key={p.label} on={on} onClick={() => toggleGroup(p)} title={p.chars.join(' ')}>
              {on ? '− ' : '+ '}
              {p.label}
            </Toggle>
          )
        })}
      </div>

      <div className="space-y-1.5">
        {groups.map((g) => {
          const isOpen = searching || open.has(g.label)
          return (
            <div key={g.label} data-testid={g.testId} data-group={g.label}>
              <div className="flex items-baseline gap-2">
                <h3 className="text-xs font-semibold text-ink-muted">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    disabled={searching}
                    onClick={() => toggleOpen(g.label)}
                    className="hover:text-ink disabled:hover:text-ink-muted"
                  >
                    <span aria-hidden="true" className="inline-block w-3 text-ink-subtle">{isOpen ? '▾' : '▸'}</span>
                    {g.label}
                  </button>
                </h3>
                <span data-testid="group-count" className="text-[11px] text-ink-subtle">
                  {searching ? `${g.shown.length} of ${g.chars.length}` : g.chars.length}
                </span>
                {!searching && (
                  <button onClick={() => toggleGroup(g)} className="text-[11px] text-ink-muted hover:text-accent-ink">
                    {allOn(g) ? 'Clear' : 'Add all'}
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="mb-2 ml-3 mt-1">
                  {g.note && (
                    <p data-testid="group-note" className="mb-1 text-[11px] text-ink-muted">{g.note}</p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {g.shown.map((c) => (
                      <Toggle
                        key={c}
                        on={chosen.has(paletteKey(c))}
                        size="icon"
                        onClick={() => toggleGlyph(c)}
                        title={named(c)}
                        data-testid="glyph"
                        data-char={c}
                        className="h-8 w-8 font-ocr text-sm"
                      >
                        {c}
                      </Toggle>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {searching && groups.length === 0 && (
          <p data-testid="no-glyph-found" className="text-xs text-ink-muted">
            No character in the groups is called that - paste it into the field above.
          </p>
        )}
      </div>

      <details className="group mt-4 text-xs text-ink-muted">
        <summary className="cursor-pointer list-none select-none hover:text-ink [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="inline-block w-3 text-ink-subtle group-open:hidden">▸</span>
          <span aria-hidden="true" className="hidden w-3 text-ink-subtle group-open:inline-block">▾</span>
          How this works
        </summary>
        <p className="ml-3 mt-1 max-w-3xl">
          The groups hold the characters the corpora carry, minus the ones a keyboard types. The
          model reads bytes, so no character is out of its reach: paste whatever the groups lack.
          Accented letters are stored decomposed, the way the model writes them, so a pasted one
          and the one in the groups are the same key.
        </p>
      </details>
    </Section>
  )
}
