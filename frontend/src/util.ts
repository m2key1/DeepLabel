import type { Counters, JobStatus } from './api'
import type { Tone } from './components/ui/Badge'

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = ''
  for (const u of units) {
    value /= 1024
    unit = u
    if (value < 1024) break
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`
}

export function formatDate(iso: string): string {
  // Backend timestamps are UTC but carry no timezone marker; without the Z the
  // browser would read them as local time and shift every display.
  const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(iso)
    ? `${iso.replace(' ', 'T')}Z`
    : iso
  const d = new Date(utc)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// "3 min ago", "yesterday", "12 days ago": for last-seen stamps, where the distance
// matters more than the clock time. Older than a month falls back to the date.
/** A stored timestamp as a Date. The server writes UTC without a marker, which a browser
 *  would otherwise read as local time and put hours out. */
export function parseStamp(iso: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso)
}

/** How recently an account has to have been used to count as here now. Wider than the
 *  minute the server writes at, so someone mid-read is not flickering on and off. */
export const ONLINE_WITHIN_SECONDS = 300

export function isOnline(seen: string | null, now: Date = new Date()): boolean {
  if (!seen) return false
  const then = parseStamp(seen)
  if (isNaN(then.getTime())) return false
  return (now.getTime() - then.getTime()) / 1000 <= ONLINE_WITHIN_SECONDS
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = parseStamp(iso)
  if (isNaN(then.getTime())) return iso
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 31) return `${days} days ago`
  return formatDate(iso).slice(0, 10)
}

/** What each run state means, as a tone rather than a colour: waiting, working,
 *  finished, stopped by hand, broken. The badge and the dashboard's row accent both
 *  read this, so they cannot say different things about the same job. */
export const STATUS_TONE: Record<JobStatus, Tone> = {
  uploading: 'neutral',
  queued: 'neutral',
  running: 'accent',
  done: 'ok',
  error: 'danger',
  cancelled: 'warn',
}

export interface PhaseSpec {
  key: 'ingest' | 'layout' | 'lines' | 'ocr' | 'predict' | 'tile'
  label: string
  done: (c: Counters) => number
  total: (c: Counters) => number
  hint?: (c: Counters) => string
}

export const PHASES: PhaseSpec[] = [
  { key: 'ingest', label: 'Ingest', done: (c) => c.pages_ingested, total: (c) => c.pages_total },
  { key: 'layout', label: 'Layout', done: (c) => c.pages_layout_done, total: (c) => c.pages_total },
  // Counts elements, not lines: detection walks elements and finds lines inside them.
  { key: 'lines', label: 'Lines', done: (c) => c.elements_lines_done, total: (c) => c.elements_total,
    hint: (c) => `${c.elements_lines_done}/${c.elements_total} elements scanned - ${c.lines_total} lines found` },
  { key: 'ocr', label: 'OCR', done: (c) => c.lines_ocr_done, total: (c) => c.lines_total },
]

// Map-segmentation pre-annotation. Not in PHASES (those are the text pipeline); appended
// by jobPhases only for map jobs that run it, so its counter holds the bar back until done.
const PREDICT_PHASE: PhaseSpec = {
  key: 'predict', label: 'Predict',
  done: (c) => c.pages_predicted ?? 0, total: (c) => c.pages_total,
}

// Map tiling — cutting uploaded full maps into tiles; precedes ingest. Counted in maps.
const TILE_PHASE: PhaseSpec = {
  key: 'tile', label: 'Tiling',
  done: (c) => c.maps_tiled ?? 0, total: (c) => c.maps_total ?? 0,
}

// Which phases a job actually runs; ingest always does. A skipped phase has no work
// to report, so counting it would hold the bar short of 100% forever.
export type PhaseFlags = {
  run_layout: boolean; run_lines: boolean; run_ocr: boolean; run_predict?: boolean; run_tile?: boolean
}

export function jobPhases(job: PhaseFlags): PhaseSpec[] {
  const on = { ingest: true, layout: job.run_layout, lines: job.run_lines, ocr: job.run_ocr }
  const phases = PHASES.filter((p) => on[p.key as keyof typeof on])
  if (job.run_tile) phases.unshift(TILE_PHASE) // tiling precedes ingest
  if (job.run_predict) phases.push(PREDICT_PHASE)
  return phases
}

export function phaseFraction(spec: PhaseSpec, c: Counters, jobDone = false): number {
  const total = spec.total(c)
  if (total > 0) return Math.min(1, spec.done(c) / total)
  // Nothing to count against: per-page line detection creates no elements, so its
  // element totals stay 0 even after it has run. Finished means finished.
  return jobDone ? 1 : 0
}

const PHASE_WEIGHTS: Record<PhaseSpec['key'], number> = { ingest: 0.1, layout: 0.2, lines: 0.3, ocr: 0.4, predict: 0.4, tile: 0.2 }

export function overallProgress(c: Counters, job?: PhaseFlags & { status?: string }): number {
  const phases = job ? jobPhases(job) : PHASES
  const total = phases.reduce((s, p) => s + PHASE_WEIGHTS[p.key], 0) || 1
  const done = job?.status === 'done'
  return phases.reduce((s, p) => s + (PHASE_WEIGHTS[p.key] / total) * phaseFraction(p, c, done), 0)
}

// The colours a dataset chose for its layout classes, by stored class name; a class without
// one keeps the hue derived from its name.
const chosenColors = new Map<string, string>()

export function setClassColors(colors: Record<string, string>): void {
  chosenColors.clear()
  for (const [name, hex] of Object.entries(colors)) chosenColors.set(name, hex)
}

function nameHue(className: string): number {
  let hash = 0
  for (let i = 0; i < className.length; i++) {
    hash = (hash * 31 + className.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

export function classColor(className: string, alpha?: number): string {
  const chosen = chosenColors.get(className)
  if (chosen) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(chosen.slice(i, i + 2), 16))
    return `rgb(${r} ${g} ${b}${alpha !== undefined ? ` / ${alpha}` : ''})`
  }
  return `hsl(${nameHue(className)} 70% 48%${alpha !== undefined ? ` / ${alpha}` : ''})`
}

/** A class's colour as '#rrggbb', for a colour input: the chosen one, or its name's hue. */
export function classHex(className: string, chosen: string | null): string {
  if (chosen) return chosen
  const h = nameHue(className), s = 0.7, l = 0.48
  const k = (n: number) => (n + h / 30) % 12
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return `#${[0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('')}`
}

const HIDDEN_CLASSES_KEY = 'deeplabel.hiddenClasses'

export function getHiddenClasses(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_CLASSES_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

export function setHiddenClasses(hidden: Set<string>): void {
  localStorage.setItem(HIDDEN_CLASSES_KEY, JSON.stringify([...hidden]))
}

const OCR_FRAC_KEY = 'deeplabel.ocrFrac'

// Fraction of the editor width given to the OCR panel; 0 collapses it (full-width scan).
export function getOcrFrac(): number {
  const stored = localStorage.getItem(OCR_FRAC_KEY)
  const v = Number(stored)
  return stored !== null && v >= 0 && v <= 0.7 ? v : 0.5
}

export function setOcrFrac(v: number): void {
  localStorage.setItem(OCR_FRAC_KEY, String(v))
}

// How much of the line panel the readings that matched nothing are given. Their own
// scroller, so a reading and the line it belongs to can be on screen at the same time
// however long the page is.
const READINGS_FRAC_KEY = 'deeplabel.readingsFrac'

export function getReadingsFrac(): number {
  const stored = localStorage.getItem(READINGS_FRAC_KEY)
  const v = Number(stored)
  return stored !== null && v >= 0.1 && v <= 0.8 ? v : 0.35
}

export function setReadingsFrac(v: number): void {
  localStorage.setItem(READINGS_FRAC_KEY, String(v))
}

// How tall the line loupe is, in pixels. Kept with the browser like the dividers beside it
// rather than with the account: how much room a line crop wants is a property of the screen
// it is being read on, and a big monitor and a laptop want different answers.
const LOUPE_HEIGHT_KEY = 'deeplabel.loupeHeight'

export const LOUPE_HEIGHT = { least: 56, most: 360, fallback: 80 } as const

export function clampLoupeHeight(px: number): number {
  return Math.min(LOUPE_HEIGHT.most, Math.max(LOUPE_HEIGHT.least, Math.round(px)))
}

export function getLoupeHeight(): number {
  const stored = Number(localStorage.getItem(LOUPE_HEIGHT_KEY))
  return stored > 0 ? clampLoupeHeight(stored) : LOUPE_HEIGHT.fallback
}

export function setLoupeHeight(px: number): void {
  localStorage.setItem(LOUPE_HEIGHT_KEY, String(Math.round(px)))
}

// The virtual keyboard's own shape. Its height is not set directly - the keys wrap, so a
// wider board needs fewer rows and a smaller key shortens every row it is on. Both, then,
// because full width alone does not make it short enough for everybody.
const KEYBOARD_SIZE_KEY = 'deeplabel.keyboardSize'

export interface KeyboardSize {
  /** How much of the window it may span, as a fraction. */
  span: number
  /** The side of one key, in pixels. */
  key: number
}

const KEYBOARD_LIMITS = { span: [0.25, 0.98], key: [16, 44] } as const

export function getKeyboardSize(): KeyboardSize {
  const [minSpan, maxSpan] = KEYBOARD_LIMITS.span
  const [minKey, maxKey] = KEYBOARD_LIMITS.key
  try {
    const held = JSON.parse(localStorage.getItem(KEYBOARD_SIZE_KEY) ?? '') as KeyboardSize
    return {
      span: Math.min(maxSpan, Math.max(minSpan, Number(held.span) || 0.92)),
      key: Math.min(maxKey, Math.max(minKey, Number(held.key) || 28)),
    }
  } catch {
    return { span: 0.92, key: 28 }
  }
}

export function setKeyboardSize(size: KeyboardSize): void {
  localStorage.setItem(KEYBOARD_SIZE_KEY, JSON.stringify(size))
}

export function clampKeyboardSize(size: KeyboardSize): KeyboardSize {
  const [minSpan, maxSpan] = KEYBOARD_LIMITS.span
  const [minKey, maxKey] = KEYBOARD_LIMITS.key
  return {
    span: Math.min(maxSpan, Math.max(minSpan, size.span)),
    key: Math.min(maxKey, Math.max(minKey, size.key)),
  }
}

// Where the keyboard was dragged to, as its centre in fractions of the canvas, or null
// while it sits in its place above the footer.
const KEYBOARD_PLACE_KEY = 'deeplabel.keyboardPlace'

export interface KeyboardPlace {
  x: number
  y: number
}

export function getKeyboardPlace(): KeyboardPlace | null {
  try {
    const held = JSON.parse(localStorage.getItem(KEYBOARD_PLACE_KEY) ?? 'null') as KeyboardPlace | null
    const inside = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
    return held && inside(held.x) && inside(held.y) ? { x: held.x, y: held.y } : null
  } catch {
    return null
  }
}

export function setKeyboardPlace(place: KeyboardPlace | null): void {
  if (place) localStorage.setItem(KEYBOARD_PLACE_KEY, JSON.stringify(place))
  else localStorage.removeItem(KEYBOARD_PLACE_KEY)
}

const PEN_CLASS_KEY = 'deeplabel.penClass'

/** The class the next stroke draws. Which tool is in hand is not kept: an editor opens
 *  ready to draw, the way the tile editor does. */
export function getPenClass(): string {
  return localStorage.getItem(PEN_CLASS_KEY) || 'Paragraph'
}

export function setPenClass(className: string): void {
  localStorage.setItem(PEN_CLASS_KEY, className)
}

const LINE_PEN_KEY = 'deeplabel.linePen'

/** What the Line pen draws: a turned box from three clicks, or a polygon clicked corner
 *  by corner. A hand that slants or curves wants the second; most pages want the first. */
export type LinePenShape = 'box' | 'polygon'

export function getLinePenShape(): LinePenShape {
  return localStorage.getItem(LINE_PEN_KEY) === 'polygon' ? 'polygon' : 'box'
}

export function setLinePenShape(shape: LinePenShape): void {
  localStorage.setItem(LINE_PEN_KEY, shape)
}

const REVIEW_CONF_KEY = 'deeplabel.reviewConf'

export const REVIEW_THRESHOLDS = [0.5, 0.7, 0.85, 0.95]

export function getReviewConf(): number {
  const stored = Number(localStorage.getItem(REVIEW_CONF_KEY))
  return REVIEW_THRESHOLDS.includes(stored) ? stored : 0.85
}

export function setReviewConf(conf: number): void {
  localStorage.setItem(REVIEW_CONF_KEY, String(conf))
}

/** "1 line", "3 lines": a number with its noun, plural when it is not one. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A count at a glance. The dataset list shows two pairs of these per row in one narrow
 *  column, and a volume here reaches six figures - written out in full they outgrow the
 *  column and paint over the one beside it. The exact figure stays in the row's title. */
export function compactCount(n: number): string {
  if (n < 10_000) return String(n)
  const thousands = Math.round(n / 1000)
  if (thousands < 1000) return `${thousands}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** How much a reading is to be trusted, on the same five-tone scale as everything else.
 *  The thresholds are the review thresholds, so the colour and the filter agree. */
export function confTone(c: number | null): Tone {
  if (c === null) return 'neutral'
  if (c >= 0.85) return 'ok'
  if (c >= 0.7) return 'warn'
  return 'danger'
}

const CONF_FILL: Record<Tone, string> = {
  neutral: 'bg-raised text-ink-subtle',
  accent: 'bg-accent-wash text-accent-ink',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
}

export function confBadgeClass(c: number | null): string {
  return CONF_FILL[confTone(c)]
}

const CONF_OUTLINE: Record<Tone, string> = {
  neutral: 'border-line text-ink-subtle',
  accent: 'border-accent/50 text-accent-ink',
  ok: 'border-ok/50 text-ok',
  warn: 'border-warn/50 text-warn',
  danger: 'border-danger/50 text-danger',
}

/** The same reading, outlined rather than filled. For a figure shown beside a filled badge
 *  that matters more - an average next to the worst line - so the pair reads as one thing
 *  and the alarming half still carries the weight. */
export function confOutlineClass(c: number | null): string {
  return CONF_OUTLINE[confTone(c)]
}


/** A running time as a clock reads it - 0:42, 12:03, 3:02:13 - and in days past two, where
 *  the seconds no longer tell anyone anything. */
export function formatRunTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = String(total % 60).padStart(2, '0')
  if (days >= 2) return `${days}d ${hours % 24}h`
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}
