import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  getSettings, patchSettings,
  type AppSettings, type KeyboardMode, type KeyboardSource, type PageOverlays,
} from './api'
import { useAutoClear } from './messages'

/** Where a command can be live. The page viewer and the map editor never share a
 *  screen, so each may put the same letter on something of its own; a command of both
 *  editors, or of anywhere, competes with everything it can be on screen with. */
export type HotkeyScope = 'global' | 'editor' | 'viewer' | 'map' | 'dataset'

export const HOTKEY_SCOPES: HotkeyScope[] = ['global', 'editor', 'viewer', 'map', 'dataset']

export const SCOPE_LABEL: Record<HotkeyScope, string> = {
  global: 'Anywhere', editor: 'Both editors', viewer: 'Page viewer', map: 'Map editor', dataset: 'Dataset',
}

export interface HotkeyAction {
  id: string
  label: string
  scope: HotkeyScope
  /** Bound out of the box. Most commands have none: a shortcut nobody asked for is a
   *  key taken away from the person who wanted it for something else. */
  default?: string
}

// Every command a key can be put on. Each binding is a combo string (see eventCombo):
// a plain key like 'r', or modifiers + key like 'shift+r', 'ctrl+z'. Structural keys
// (arrows, Enter, Escape, digits, Delete) stay fixed and are not listed.
//
// The page-viewer and map entries are dispatched by those pages' own key handlers,
// which read the same bindings; everything else is a button that registers itself with
// useCommand (see commands.tsx). Adding a command is one entry here plus one
// useCommand call next to the button it presses.
export const HOTKEY_ACTIONS: HotkeyAction[] = [
  { id: 'goJobs', label: 'Go to datasets', scope: 'global' },
  { id: 'goQueue', label: 'Go to the queue', scope: 'global' },
  { id: 'goModels', label: 'Go to models', scope: 'global' },
  { id: 'goSettings', label: 'Go to your profile and settings', scope: 'global' },
  { id: 'goAdmin', label: 'Go to admin', scope: 'global' },
  { id: 'newJob', label: 'New dataset', scope: 'global' },
  { id: 'toggleTheme', label: 'Switch light/dark', scope: 'global' },
  { id: 'toolSelect', label: 'Select tool', scope: 'editor', default: 'v' },
  { id: 'toolHand', label: 'Hand tool', scope: 'editor' },
  { id: 'toolDraw', label: 'Draw tool', scope: 'editor', default: 'd' },
  { id: 'toolErase', label: 'Erase tool', scope: 'editor', default: 'shift+e' },
  { id: 'toolDetect', label: 'Detect tool', scope: 'editor', default: 't' },
  { id: 'split', label: 'Split (arm/flip)', scope: 'editor', default: 's' },
  { id: 'merge', label: 'Merge selection', scope: 'editor', default: 'm' },
  { id: 'hole', label: 'Cut hole in region', scope: 'editor', default: 'g' },
  { id: 'prevPage', label: 'Previous page', scope: 'editor', default: 'h' },
  { id: 'nextPage', label: 'Next page', scope: 'editor', default: 'l' },
  { id: 'edit', label: 'Toggle edit mode', scope: 'viewer', default: 'e' },
  { id: 'rotateCw', label: 'Rotate line clockwise', scope: 'viewer', default: 'r' },
  { id: 'rotateCcw', label: 'Rotate line counter-clockwise', scope: 'viewer', default: 'shift+r' },
  { id: 'reocr', label: 'Re-OCR focused line', scope: 'viewer', default: 'o' },
  { id: 'verify', label: 'Verify page layout', scope: 'viewer', default: 'shift+v' },
  { id: 'lineTurnCw', label: 'Turn selected line clockwise (1 degree)', scope: 'viewer', default: '.' },
  { id: 'lineTurnCcw', label: 'Turn selected line counter-clockwise (1 degree)', scope: 'viewer', default: ',' },
  { id: 'lineDown', label: 'Next line', scope: 'viewer', default: 'j' },
  { id: 'lineUp', label: 'Previous line', scope: 'viewer', default: 'k' },
  { id: 'readings', label: 'Step into the line\'s readings', scope: 'viewer', default: 'i' },
  { id: 'keyboardMode', label: 'Cycle the character keyboard', scope: 'viewer' },
  { id: 'mapReduce', label: 'Reduce polygons', scope: 'map', default: 'p' },
  { id: 'mapResolve', label: 'Resolve overlaps', scope: 'map', default: 'x' },
  { id: 'transcript', label: 'Open the transcript', scope: 'dataset' },
  { id: 'review', label: 'Review the flagged lines', scope: 'dataset' },
]

// Bindings stored under the ids the map editor's tools used to have.
const LEGACY_IDS: Record<string, string> = {
  mapDraw: 'toolDraw', mapSelect: 'toolSelect', mapErase: 'toolErase', mapDetect: 'toolDetect', mapHole: 'hole',
}

export const scopeOf = (id: string): HotkeyScope =>
  HOTKEY_ACTIONS.find((a) => a.id === id)?.scope ?? 'global'

/** Whether two scopes can be live at the same time - when they can, one key must not
 *  run a command in each. */
const overlaps = (a: HotkeyScope, b: HotkeyScope): boolean =>
  a === b || a === 'global' || b === 'global' ||
  (a === 'editor' && (b === 'viewer' || b === 'map')) ||
  (b === 'editor' && (a === 'viewer' || a === 'map'))

// The pool of glyphs a user picks their palette from, shown in Settings as a grid.
// A curated set of what the corpora actually contain, grouped by script for navigability -
// a starting point, not a limit: the OCR model reads a byte vocabulary, so every character
// is within its reach and Settings takes free-text additions alongside these groups.
// Accented letters are shown precomposed, as all text is; the server stores what is saved
// decomposed (NFD) to match the model's output and the stored corpus.
export interface VocabGroup {
  label: string
  chars: string[]
  /** Shown under the group heading, for a set whose characters need explaining. */
  note?: string
}

export const VOCAB_GROUPS: VocabGroup[] = [
  { label: 'Latin - accented', chars: ['Á', 'Ă', 'Ǎ', 'Â', 'Ä', 'Ȧ', 'Ạ', 'À', 'Ā', 'Ą', 'Å', 'Ã', 'Ǽ', 'Ǣ', 'Ḃ', 'Ḅ', 'Ć', 'Č', 'Ç', 'Ĉ', 'Ċ', 'Ď', 'Ḑ', 'Ḋ', 'Ḍ', 'É', 'Ĕ', 'Ě', 'Ȩ', 'Ê', 'Ë', 'Ė', 'Ẹ', 'È', 'Ē', 'Ę', 'Ẽ', 'Ḟ', 'Ǵ', 'Ğ', 'Ǧ', 'Ģ', 'Ĝ', 'Ġ', 'Ḡ', 'Ȟ', 'Ḩ', 'Ĥ', 'Ḧ', 'Ḣ', 'Ḥ', 'Í', 'Ĭ', 'Ǐ', 'Î', 'Ï', 'İ', 'Ị', 'Ì', 'Ī', 'Į', 'Ĩ', 'Ĵ', 'Ḱ', 'Ǩ', 'Ķ', 'Ḳ', 'Ĺ', 'Ľ', 'Ļ', 'Ḷ', 'Ḿ', 'Ṁ', 'Ṃ', 'Ń', 'Ň', 'Ņ', 'Ṅ', 'Ṇ', 'Ǹ', 'Ñ', 'Ó', 'Ŏ', 'Ǒ', 'Ô', 'Ö', 'Ȯ', 'Ọ', 'Ő', 'Ò', 'Ō', 'Ǫ', 'Ǿ', 'Õ', 'Ṕ', 'Ṗ', 'Ŕ', 'Ř', 'Ŗ', 'Ṙ', 'Ṛ', 'Ś', 'Š', 'Ş', 'Ŝ', 'Ș', 'Ṡ', 'Ṣ', 'Ť', 'Ţ', 'Ț', 'Ṫ', 'Ṭ', 'Ú', 'Ŭ', 'Ǔ', 'Û', 'Ü', 'Ụ', 'Ű', 'Ù', 'Ū', 'Ų', 'Ů', 'Ũ', 'Ṿ', 'Ṽ', 'Ẃ', 'Ŵ', 'Ẅ', 'Ẇ', 'Ẉ', 'Ẁ', 'Ẍ', 'Ẋ', 'Ý', 'Ŷ', 'Ÿ', 'Ẏ', 'Ỵ', 'Ỳ', 'Ȳ', 'Ỹ', 'Ź', 'Ž', 'Ẑ', 'Ż', 'Ẓ', 'á', 'ă', 'ǎ', 'â', 'ä', 'ȧ', 'ạ', 'à', 'ā', 'ą', 'å', 'ã', 'ǽ', 'ǣ', 'ḃ', 'ḅ', 'ć', 'č', 'ç', 'ĉ', 'ċ', 'ď', 'ḑ', 'ḋ', 'ḍ', 'é', 'ĕ', 'ě', 'ȩ', 'ê', 'ë', 'ė', 'ẹ', 'è', 'ē', 'ę', 'ẽ', 'ḟ', 'ǵ', 'ğ', 'ǧ', 'ģ', 'ĝ', 'ġ', 'ḡ', 'ȟ', 'ḩ', 'ĥ', 'ḧ', 'ḣ', 'ḥ', 'í', 'ĭ', 'ǐ', 'î', 'ï', 'ị', 'ì', 'ī', 'į', 'ĩ', 'ǰ', 'ĵ', 'ḱ', 'ǩ', 'ķ', 'ḳ', 'ĺ', 'ľ', 'ļ', 'ḷ', 'ẛ', 'ḿ', 'ṁ', 'ṃ', 'ń', 'ň', 'ņ', 'ṅ', 'ṇ', 'ǹ', 'ñ', 'ó', 'ŏ', 'ǒ', 'ô', 'ö', 'ȯ', 'ọ', 'ő', 'ò', 'ō', 'ǫ', 'ǿ', 'õ', 'ṕ', 'ṗ', 'ŕ', 'ř', 'ŗ', 'ṙ', 'ṛ', 'ś', 'š', 'ş', 'ŝ', 'ș', 'ṡ', 'ṣ', 'ť', 'ţ', 'ț', 'ẗ', 'ṫ', 'ṭ', 'ú', 'ŭ', 'ǔ', 'û', 'ü', 'ụ', 'ű', 'ù', 'ū', 'ų', 'ů', 'ũ', 'ṿ', 'ṽ', 'ẃ', 'ŵ', 'ẅ', 'ẇ', 'ẉ', 'ẁ', 'ẘ', 'ẍ', 'ẋ', 'ý', 'ŷ', 'ÿ', 'ẏ', 'ỵ', 'ỳ', 'ȳ', 'ẙ', 'ỹ', 'ź', 'ž', 'ẑ', 'ż', 'ẓ'] },
  { label: 'Latin - special', chars: ['ª', 'µ', 'º', 'Æ', 'Ð', 'Ø', 'Þ', 'ß', 'æ', 'ð', 'ø', 'þ', 'đ', 'Ħ', 'ħ', 'ĸ', 'Ł', 'ł', 'œ', 'ŧ', 'ſ', 'Đ', 'ı', 'Œ', 'ƀ', 'ƒ', 'ɂ', 'ɨ', 'ẜ', 'Ꝑ', 'ꝑ', 'ꝓ', 'ꝗ', 'Ꝙ', 'ꝙ', 'ꝟ', 'ꝫ', 'ꝭ', 'ꝯ', 'ꝵ', 'Ꞧ'] },
  { label: 'Punctuation', chars: ['¡', '§', '«', '¶', '·', '»', '¿', '–', '—', '‗', '‘', '’', '‚', '“', '”', '„', '†', '‡', '•', '…', '‰', '‹', '›', '‸', '⁊', '⁋', '⁓', '⁜', '⟦', '⟧'] },
  { label: 'Numbers & fractions', chars: ['²', '³', '¹', '¼', '½', '¾', '⁰', '⁴', '₀', '₁', '₂', '₃', '⅓', '⅔', '⅕', '⓪', '⁷', '⁹', 'Ⅶ', '❶'] },
  { label: 'Symbols', chars: ['¢', '£', '¥', '©', '¬', '®', '¯', '°', '±', '´', '×', '÷', '˜', '⁄', '€', '№', '™', '←', '↑', '→', '↓', '∆', '∏', '∑', '√', '∞', '≈', 'Ⓡ', 'Ⓢ', 'Ⓣ', '★', '⚠', '✝', '℥', '⊖', '⊗', '⌀', 'Ⓐ', 'Ⓘ', 'Ⓞ', 'Ⓟ', 'Ⓥ', 'ⓘ', 'ⓝ', 'ⓞ', 'ⓢ', '┘', '┴', '♂', '♡', '⚫', '✓', '✙', '❧', '⧫'] },
  { label: 'Greek', chars: ['Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ', 'Η', 'Θ', 'Ι', 'Κ', 'Λ', 'Μ', 'Ν', 'Ξ', 'Ο', 'Π', 'Ρ', 'Σ', 'Τ', 'Υ', 'Φ', 'Χ', 'Ψ', 'Ω', 'α', 'β', 'γ', 'ε', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ο', 'π', 'ρ', 'ς', 'σ', 'τ', 'υ', 'χ', 'ω', 'Ἁ', 'Ᾱ', 'Ἀ', 'Ά', 'Ὰ', 'Ᾰ', 'Ἑ', 'Ἐ', 'Έ', 'Ὲ', 'Ἡ', 'Ἠ', 'Ή', 'Ὴ', 'Ἱ', 'Ϊ', 'Ῑ', 'Ἰ', 'Ί', 'Ὶ', 'Ῐ', 'Ὡ', 'Ὠ', 'Ώ', 'Ὼ', 'Ὁ', 'Ὀ', 'Ό', 'Ὸ', 'Ῥ', 'Ὑ', 'Ϋ', 'Ῡ', 'Ύ', 'Ὺ', 'Ῠ', 'ἁ', 'ᾱ', 'ᾶ', 'ἀ', 'ά', 'ὰ', 'ᾰ', 'ἑ', 'ἐ', 'έ', 'ὲ', 'ἡ', 'ῆ', 'ἠ', 'ή', 'ὴ', 'ἱ', 'ϊ', 'ῑ', 'ῖ', 'ἰ', 'ί', 'ὶ', 'ῐ', 'ὡ', 'ῶ', 'ὠ', 'ώ', 'ὼ', 'ὁ', 'ὀ', 'ό', 'ὸ', 'ῥ', 'ῤ', 'ὑ', 'ϋ', 'ῡ', 'ῦ', 'ὐ', 'ύ', 'ὺ', 'ῠ'] },
  { label: 'Cyrillic', chars: ['а', 'е', 'к', 'л', 'м', 'р', 'ӑ', 'ӓ', 'ӗ', 'ѐ', 'ё', 'ќ'] },
  {
    label: 'Schematismus',
    note: 'Printer\'s marks the corpus writes as stand-in codepoints. Shown as they were '
      + 'printed - the stored text is the codepoint, so an export carries plain Unicode.',
    chars: ['ʘ', '⊕', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', 'Ⓑ', 'Ⓒ', 'Ⓚ', 'Ⓜ', '⚇', '⚐', '✕', '⬯', '㊵', '㏋'],
  },
  { label: 'Modifier/superscript', chars: ['ˆ', 'ʰ', 'ʳ', 'ˡ', 'ˢ', 'ˣ', 'ᵃ', 'ᵇ', 'ᵈ', 'ᵉ', 'ᵐ', 'ᵒ', 'ᵖ', 'ᵗ', 'ᵘ', 'ᶜ', 'ᶠ', 'ᶻ', 'ⁱ', 'ⁿ', 'ꝰ', '𐞥'] },
]

export const VOCAB: string[] = VOCAB_GROUPS.flatMap((g) => g.chars)

// One-click starting sets a user can add to their palette. Cross-script, so they
// complement the per-group "add all" toggles. Each is a subset of VOCAB.
export const PRESETS: VocabGroup[] = [
  { label: 'German', chars: ['ä', 'ö', 'ü', 'Ä', 'Ö', 'Ü', 'ß', 'ſ', '„', '“', '”', '«', '»', '–', '—', '§'] },
  { label: 'French', chars: ['à', 'â', 'ç', 'é', 'è', 'ê', 'ë', 'î', 'ï', 'ô', 'û', 'ù', 'ü', 'ÿ', 'œ', 'æ', '«', '»'] },
  { label: 'Central European', chars: ['ą', 'ć', 'ę', 'ł', 'ń', 'ó', 'ś', 'ź', 'ż', 'č', 'ď', 'ě', 'ň', 'ř', 'š', 'ť', 'ů', 'ž', 'ő', 'ű'] },
  { label: 'Nordic', chars: ['å', 'ä', 'ö', 'ø', 'æ', 'Å', 'Ä', 'Ö', 'Ø', 'Æ', 'ð', 'þ', 'é'] },
  { label: 'Medieval Latin', chars: ['ā', 'ē', 'ī', 'ō', 'ū', 'ſ', 'ẜ', '⁊', 'ꝑ', 'ꝓ', 'ꝗ', 'ꝟ', 'ꝫ', 'ꝯ', 'ꝰ', 'ꝭ', 'ĸ', 'ŧ', 'æ', 'œ'] },
  { label: 'ISO 8859-2', chars: ['Ą', 'Ł', 'Ľ', 'Ś', '§', 'Š', 'Ş', 'Ť', 'Ź', 'Ž', 'Ż', '°', 'ą', 'ł', '´', 'ľ', 'ś', 'š', 'ş', 'ť', 'ź', 'ž', 'ż', 'Ŕ', 'Á', 'Â', 'Ă', 'Ä', 'Ĺ', 'Ć', 'Ç', 'Č', 'É', 'Ę', 'Ë', 'Ě', 'Í', 'Î', 'Ď', 'Đ', 'Ń', 'Ň', 'Ó', 'Ô', 'Ő', 'Ö', '×', 'Ř', 'Ů', 'Ú', 'Ű', 'Ü', 'Ý', 'Ţ', 'ß', 'ŕ', 'á', 'â', 'ă', 'ä', 'ĺ', 'ć', 'ç', 'č', 'é', 'ę', 'ë', 'ě', 'í', 'î', 'ď', 'đ', 'ń', 'ň', 'ó', 'ô', 'ő', 'ö', '÷', 'ř', 'ů', 'ú', 'ű', 'ü', 'ý', 'ţ'] },
  { label: 'Editorial', chars: ['·', '–', '—', '‘', '’', '‚', '“', '”', '„', '†', '‡', '•', '…', '§', '¶', '‹', '›', '«', '»'] },
]

// A sensible starting palette; a subset of VOCAB, in insertion order.
export const KEYBOARD_DEFAULT = [
  'ä', 'ö', 'ü', 'Ä', 'Ö', 'Ü', 'ß', 'ſ', 'æ', 'œ', 'ā', 'ē', 'ī', 'ō', 'ū',
  'é', 'è', 'ç', '·', '—', '„', '“', '”', '§', '†', '‡', '⁊', '№', '½',
]

const MOD_KEYS = new Set(['Shift', 'Control', 'Meta', 'Alt'])
const MOD_LABEL: Record<string, string> = { ctrl: 'Ctrl', meta: '⌘', alt: 'Alt', shift: 'Shift' }

// A keyboard event's canonical binding string: modifiers (fixed order) + the key,
// lowercased. A bare modifier press yields '' so it never binds on its own.
export function eventCombo(e: KeyboardEvent): string {
  if (MOD_KEYS.has(e.key)) return ''
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.metaKey) parts.push('meta')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

// Keys are stored lowercased; a label reads them back the way a keyboard prints them.
function keyLabel(key: string): string {
  if (key.length === 1 || /^f\d{1,2}$/.test(key)) return key.toUpperCase()
  return key.charAt(0).toUpperCase() + key.slice(1)
}

export function comboLabel(combo: string | undefined): string {
  if (!combo) return '-'
  const parts = combo.split('+')
  const key = parts.pop() ?? ''
  return [...parts.map((p) => MOD_LABEL[p] ?? p), keyLabel(key)].join('+')
}

export const hotkeyDefaults = (): Record<string, string> =>
  Object.fromEntries(HOTKEY_ACTIONS.flatMap((a) => (a.default ? [[a.id, a.default]] : [])))

/** Every command a combo is bound to, in the order the commands are declared. */
export function commandsFor(hotkeys: Record<string, string>, combo: string): string[] {
  if (!combo) return []
  return HOTKEY_ACTIONS.map((a) => a.id).filter((id) => hotkeys[id] === combo)
}

/** The command a combo runs where these scopes are live, if any. */
export function commandFor(
  hotkeys: Record<string, string>, combo: string, scopes: HotkeyScope[],
): string | undefined {
  return commandsFor(hotkeys, combo).find((id) => scopes.includes(scopeOf(id)))
}

/** What binding `combo` to `id` takes it off: only commands that could be on screen at
 *  the same time, so a viewer letter and a map letter may coincide (see SettingsPage). */
export function evictedBy(hotkeys: Record<string, string>, id: string, combo: string): string[] {
  const scope = scopeOf(id)
  return commandsFor(hotkeys, combo).filter((other) => other !== id && overlaps(scope, scopeOf(other)))
}

/** Stored overrides, with the ids of renamed commands brought forward. */
function currentIds(hotkeys: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(hotkeys).map(([id, combo]) => [LEGACY_IDS[id] ?? id, combo]))
}

interface SettingsCtx {
  hotkeys: Record<string, string> // defaults merged with the user's overrides
  keyboard: string[]
  keyboardMode: KeyboardMode
  keyboardSource: KeyboardSource
  shareActivity: boolean
  showActivity: boolean
  pageOverlays: PageOverlays
  collapsedGroups: (number | 'ungrouped')[]
  transcriptSplit: number
  transcriptFilmstrip: boolean
  save: (patch: Partial<AppSettings>) => Promise<void>
}

export const PAGE_OVERLAYS: { id: keyof PageOverlays; label: string; note: string }[] = [
  { id: 'layout', label: 'Layout', note: 'The region boxes the layout model found.' },
  { id: 'lines', label: 'Lines', note: 'The line polygons inside those regions.' },
  { id: 'labels', label: 'Labels', note: "Each region's class name on its box." },
  { id: 'confidence', label: 'Confidence', note: 'How sure the model was, per region.' },
  { id: 'order', label: 'Order', note: 'The reading order the regions are exported in.' },
]

const OVERLAY_DEFAULTS: PageOverlays = {
  layout: true, lines: false, labels: true, confidence: false, order: false,
}

// Unset keyboard → seed the defaults; an explicit [] is an empty palette the user chose.
const DEFAULTS: AppSettings = {
  hotkeys: {}, keyboard: KEYBOARD_DEFAULT, keyboard_mode: 'auto', keyboard_source: 'own',
  share_activity: true, show_activity: true, page_overlays: OVERLAY_DEFAULTS,
  collapsed_groups: [], transcript_split: 0.55, transcript_filmstrip: false,
}

function withDefaults(stored: Partial<AppSettings>): AppSettings {
  return {
    hotkeys: stored.hotkeys ?? DEFAULTS.hotkeys,
    keyboard: stored.keyboard ?? DEFAULTS.keyboard,
    keyboard_mode: stored.keyboard_mode ?? DEFAULTS.keyboard_mode,
    keyboard_source: stored.keyboard_source ?? DEFAULTS.keyboard_source,
    share_activity: stored.share_activity ?? DEFAULTS.share_activity,
    show_activity: stored.show_activity ?? DEFAULTS.show_activity,
    page_overlays: { ...OVERLAY_DEFAULTS, ...stored.page_overlays },
    collapsed_groups: stored.collapsed_groups ?? DEFAULTS.collapsed_groups,
    transcript_split: stored.transcript_split ?? DEFAULTS.transcript_split,
    transcript_filmstrip: stored.transcript_filmstrip ?? DEFAULTS.transcript_filmstrip,
  }
}

const Ctx = createContext<SettingsCtx | null>(null)

const SETTINGS_REFRESH_MS = 5_000

const settingsChannel = (): BroadcastChannel | null =>
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('deeplabel-settings')

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useState<AppSettings>(DEFAULTS)
  const shown = useRef(raw)
  shown.current = raw
  const [loaded, setLoaded] = useState(false)
  const latestSave = useRef(0)
  const saving = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)
  const reread = useRef<() => void>(() => undefined)
  const [saveError, setSaveError] = useState<string | null>(null)
  useAutoClear(saveError, setSaveError)

  // Settings follow the person into every tab they have open: a save tells the other tabs
  // of this browser to re-read them at once, and a visible tab also re-reads them now and
  // then and whenever it comes back into view, for a change made on another device. A read
  // that overlaps a save of this tab's is dropped, since the save's own reply is the newer
  // answer.
  useEffect(() => {
    const read = (forced: boolean) => {
      if (!forced && (document.visibilityState !== 'visible' || saving.current > 0)) return
      const ticket = latestSave.current
      getSettings()
        .then((s) => {
          if (saving.current > 0 || ticket !== latestSave.current) return
          const next = withDefaults(s)
          setRaw((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
        })
        .catch(() => undefined)
        .finally(() => setLoaded(true))
    }
    read(true)
    reread.current = () => read(true)
    const refresh = () => read(false)
    const timer = setInterval(refresh, SETTINGS_REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    channel.current = settingsChannel()
    if (channel.current) channel.current.onmessage = () => read(true)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      channel.current?.close()
      channel.current = null
    }
  }, [])

  // Shown at once, then written. The server merges, so what comes back carries anything
  // another tab changed meanwhile - which is what this state then holds, unless a later
  // save has started since: that one's reply is the current one, whichever lands first.
  // A refused save is said and taken back - to what was shown before it, then to what the
  // server holds - rather than looking saved until the next re-read quietly flips it.
  const save = async (patch: Partial<AppSettings>) => {
    const before = shown.current
    shown.current = withDefaults({ ...before, ...patch })
    setRaw(shown.current)
    const ticket = ++latestSave.current
    saving.current += 1
    try {
      const stored = await patchSettings(patch)
      saving.current -= 1
      channel.current?.postMessage('saved')
      if (ticket === latestSave.current) setRaw(withDefaults(stored))
    } catch (e) {
      saving.current -= 1
      setSaveError(`Your settings were not saved: ${(e as Error).message}`)
      if (ticket === latestSave.current) setRaw(before)
      reread.current()
    }
  }

  if (!loaded) return null
  const hotkeys = { ...hotkeyDefaults(), ...currentIds(raw.hotkeys) }
  return (
    <Ctx.Provider
      value={{
        hotkeys, keyboard: raw.keyboard, keyboardMode: raw.keyboard_mode,
        collapsedGroups: raw.collapsed_groups, transcriptSplit: raw.transcript_split,
        transcriptFilmstrip: raw.transcript_filmstrip,
        keyboardSource: raw.keyboard_source,
        shareActivity: raw.share_activity, showActivity: raw.show_activity,
        pageOverlays: raw.page_overlays, save,
      }}
    >
      {children}
      {saveError && (
        <p role="alert" data-testid="settings-save-error"
           className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-danger shadow-lg">
          {saveError}
        </p>
      )}
    </Ctx.Provider>
  )
}

export function useSettings(): SettingsCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useSettings used outside SettingsProvider')
  return c
}
