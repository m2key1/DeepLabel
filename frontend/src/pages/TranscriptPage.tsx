import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getTranscript, getTranscriptPage, renditionUrl, searchTranscript, tilesUrl } from '../api'
import { useImageSurface } from '../hooks/useImageSurface'
import type {
  TranscriptHit, TranscriptIndexPage, TranscriptLine, TranscriptPage as TranscriptPageData,
} from '../api'
import { useCrumb } from '../components/NavBar'
import { DatasetViews } from '../components/job/DatasetViews'
import { ChevronIcon, ExpandIcon, PagesIcon } from '../components/icons'
import { Check, Input } from '../components/ui/Field'
import { Segmented } from '../components/ui/Segmented'
import { searchForm } from '../lib/fuzzy'
import { displayed } from '../lib/text'
import { useSettings } from '../settings'
import type { SearchMode } from '../lib/fuzzy'
import { Splitter } from '../components/ui/Splitter'

function lineText(line: TranscriptLine): string {
  return displayed(line.corrected_text ?? line.text ?? '')
}

const MARK = 'rounded-sm bg-warn/25'

/** The line's text with the words that answered the search marked. Matching is done on the
 *  folded form, so what is marked is found by folding each word the same way rather than by
 *  looking for the query in the text - which would miss the very spellings it matched. */
function marked(text: string, words: string[]) {
  if (words.length === 0) return text
  const wanted = new Set(words)
  return text.split(/(\s+)/).map((part, i) =>
    wanted.has(part) || wanted.has(searchForm(part))
      ? <span key={i} data-testid="transcript-match" className={MARK}>{part}</span>
      : part)
}

/** How far the wheel has to keep pushing at the foot of a page before it turns. A page that
 *  ends mid-sentence should not turn itself under a reader who has only just arrived at the
 *  last line of it. */
const SEAM_PX = 140
/** How long the wheel has to rest before it is treated as a new gesture. A trackpad keeps
 *  sending for the best part of a second after the fingers have left it. */
const REST_MS = 350
/** How far into a scan the reader may go, and how far back out. Fit is 1, so there is no
 *  zooming out past the whole page - the point of the gallery is that the page is whole. */
const ZOOM = { least: 1, most: 8 } as const

/** How narrow either pane may be dragged. Past this the one being squeezed stops being a
 *  reading surface and becomes a sliver nobody meant to keep. */
const SPLIT = { least: 0.28, most: 0.72 }

interface Turner {
  push(delta: number): number
  reset(): void
}

/** Wheel deltas, answered at most once per gesture.
 *
 *  A trackpad sends a page's worth of small deltas where a mouse sends one large one, so the
 *  deltas are added up rather than the events counted. And once they have added up to a
 *  turn, nothing further is answered until the wheel has rested: one flick is one page,
 *  whether it is a single notch or a hard swipe with a second of momentum behind it.
 *
 *  Reading down a long page and off the end of it therefore stops at the next page rather
 *  than carrying on through the one after, which is the whole of what reading a page at a
 *  time is for. */
function turner(over: number): Turner {
  let total = 0
  let last = 0
  let spent = false
  return {
    push(delta) {
      const now = performance.now()
      if (now - last > REST_MS) {
        total = 0
        spent = false
      }
      last = now
      if (spent) return 0
      total += delta
      if (Math.abs(total) < over) return 0
      const by = Math.sign(total)
      total = 0
      spent = true
      return by
    },
    reset() {
      total = 0
    },
  }
}

function clampSplit(ratio: number): number {
  return Math.min(SPLIT.most, Math.max(SPLIT.least, ratio))
}

/** The scan on the wall: two layers that trade places.
 *
 *  The page coming in is loaded on whichever layer is not being shown, and takes the front
 *  only once its image is in hand - so a turn is a fade from one picture to another rather
 *  than to an empty frame. Which layer is in front is the only thing that decides what can
 *  be seen. There is no timer to lose, and so no way to be left with two pages on top of
 *  each other; a turn interrupted by the next one simply never happened.
 *
 *  It also means a scrub skips: the flip is refused unless that layer holds the page still
 *  being asked for, so dragging the spine through forty pages arrives at the one it stops
 *  on rather than dissolving through all of them.
 *
 *  The flip waits on `decode()`, not on load: load says the bytes arrived, and painting a
 *  whole scan that has not been decoded yet is the frame that drops. Decoding one on the
 *  main thread takes long enough to swallow the wheel events arriving while it happens,
 *  which is what made a turn feel like the page had stopped listening. */

const DIM = 'transcript-plate-dim'

/** The line being read, drawn on the scan by taking the rest of the page down rather than
 *  by colouring the line in: a hole in a dimmed sheet reads as "look here", where a tinted
 *  box reads as a form field.
 *
 *  The polygons are page-normalised and the viewBox is the page's own size, so the scan
 *  (object-contain) and this (preserveAspectRatio, which is the same rule) letterbox
 *  identically inside the same box - and where the box lands cannot disagree with where the
 *  ink is. */
function Ink({ size, polygon }: { size: [number, number]; polygon: number[][] }) {
  const [w, h] = size
  const points = polygon.map(([x, y]) => `${x},${y}`).join(' ')
  return (
    // Positioned, because the scan above carries a drop shadow: a filter makes its own
    // stacking context, which paints over every plain sibling whatever the order of them.
    <svg viewBox={`0 0 ${w} ${h}`}
         className="pointer-events-none absolute inset-0 h-full w-full">
      <defs>
        <mask id={DIM}>
          <rect width={w} height={h} fill="white" />
          <g transform={`scale(${w} ${h})`}>
            <polygon points={points} fill="black" />
          </g>
        </mask>
      </defs>
      <rect width={w} height={h} fill="rgb(9 9 11)" opacity="0.45" mask={`url(#${DIM})`} />
      <g transform={`scale(${w} ${h})`} data-testid="transcript-highlight">
        <polygon points={points} fill="none" stroke="rgb(129 140 248)" strokeWidth="1.5"
                 vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  )
}

/** Keyed by the dataset, so going from one volume's transcript to another's starts afresh:
 *  the router keeps the component when only the id changes, and with it the pages already
 *  fetched for the first volume. */
export function TranscriptPage() {
  const { id } = useParams<{ id: string }>()
  return <Transcript key={id} jobId={id!} />
}

function Transcript({ jobId }: { jobId: string }) {
  const [name, setName] = useState('')
  const [pages, setPages] = useState<TranscriptIndexPage[] | null>(null)
  // Each page's text and outlines, fetched when it is opened or is next to the open one.
  const [loaded, setLoaded] = useState<ReadonlyMap<number, TranscriptPageData>>(new Map())
  const asked = useRef(new Set<number>())
  const [reviewedOnly, setReviewedOnly] = useState(false)
  const [hitsOnly, setHitsOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [needle, setNeedle] = useState('')
  const [mode, setMode] = useState<SearchMode>('fuzzy')
  // Which page is open, by the page's own index rather than by where it sits in the list:
  // turning "reviewed only" on drops pages from the list, and the reader should still be
  // looking at the page they were looking at.
  const [open, setOpen] = useState(0)
  const [hitCursor, setHitCursor] = useState(0)
  const { transcriptSplit, transcriptFilmstrip, save } = useSettings()
  // Held here while it is being dragged, and written to the account when it is let go.
  const [split, setSplit] = useState(transcriptSplit)
  const [strip, setStrip] = useState(transcriptFilmstrip)
  // A mode, not a preference: it takes the search box off the screen, and coming back to a
  // page whose controls are already hidden is nobody's idea of where they left off.
  const [bare, setBare] = useState(false)
  const [hover, setHover] = useState<number[][] | null>(null)
  // How far into the current scan. The viewer holds where, and holds the ink over it, so
  // the two are magnified by the same thing and cannot drift apart. Kept only because the
  // cursor and the title say whether there is anything to drag.
  const [zoom, setZoomShown] = useState(1)
  // Not self-clearing: this message replaces the whole page, so losing it would
  // leave a blank one with no reason given.
  const [error, setError] = useState<string | null>(null)
  useCrumb(name ? `${name} · Transcript` : 'Transcript')

  useEffect(() => {
    getTranscript(jobId)
      .then((data) => {
        setName(data.job.name)
        setPages(data.pages)
      })
      .catch((e: Error) => setError(e.message))
  }, [jobId])

  // Typing searches the whole volume on the server, so it waits for a pause in the typing.
  useEffect(() => {
    const t = window.setTimeout(() => setNeedle(query.trim()), 200)
    return () => window.clearTimeout(t)
  }, [query])

  // Which question an answer is to: one arriving for an earlier query is not this one's,
  // and acting on it would take the reader to the old query's first hit.
  const asking = `${mode} ${reviewedOnly} ${needle}`
  const [answer, setAnswer] = useState<{
    asking: string; usable: boolean; hits: TranscriptHit[]; error?: string
  } | null>(null)
  useEffect(() => {
    if (!needle) return
    const abort = new AbortController()
    searchTranscript(jobId, needle, mode, reviewedOnly, abort.signal)
      .then((found) => setAnswer({ asking, ...found }))
      .catch((e: Error) => {
        if (!abort.signal.aborted) setAnswer({ asking, usable: true, hits: [], error: e.message })
      })
    return () => abort.abort()
  }, [jobId, needle, mode, reviewedOnly, asking])
  const current = needle !== '' && answer?.asking === asking ? answer : null
  const searching = needle !== '' && current === null
  // A pattern that will not compile is a search that finds nothing, not an absent one -
  // otherwise half-typing a bracket puts the whole volume back on screen.
  const unusable = current !== null && !current.usable
  const hits = useMemo(() => current?.hits ?? [], [current])
  const hitPages = useMemo(() => new Set(hits.map((h) => h.idx)), [hits])
  const hitHere = useMemo(() => new Map(hits.map((h) => [h.line, h.words])), [hits])
  const hitAt = hits.length ? Math.min(hitCursor, hits.length - 1) : 0

  // A search marks and navigates rather than filtering: a page read as a page has to be the
  // whole page, and a document with the unmatched lines cut out of it is not one. Somebody
  // who does want the sieve asks for it with "pages with hits".
  const shown = useMemo(() => (pages ?? [])
    .filter((p) => (reviewedOnly ? p.checked_with_text : p.with_text) > 0)
    .filter((p) => !hitsOnly || !needle || hitPages.has(p.idx)),
  [pages, reviewedOnly, hitsOnly, needle, hitPages])

  const at = useMemo(() => {
    if (shown.length === 0) return 0
    const i = shown.findIndex((p) => p.idx >= open)
    return i === -1 ? shown.length - 1 : i
  }, [shown, open])
  const page = shown[at]
  const content = page ? loaded.get(page.idx) : undefined
  const elements = useMemo(() => (content?.elements ?? [])
    .filter((e) => e.kind !== 'container')
    .map((element) => ({
      ...element,
      lines: element.lines
        .filter((l) => (!reviewedOnly || l.checked) && lineText(l) !== '')
        .map((l) => ({ line: l, words: hitHere.get(l.id) })),
    }))
    .filter((e) => e.lines.length > 0),
  [content, reviewedOnly, hitHere])

  // The open page and the ones either side of it, so a turn finds its text already here.
  useEffect(() => {
    for (const near of shown.slice(Math.max(0, at - 1), at + 2)) {
      if (asked.current.has(near.idx)) continue
      asked.current.add(near.idx)
      getTranscriptPage(jobId, near.idx)
        .then((data) => setLoaded((was) => new Map(was).set(near.idx, data)))
        .catch((e: Error) => {
          asked.current.delete(near.idx)
          setError(e.message)
        })
    }
  }, [jobId, shown, at])

  const textPane = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const spine = useRef<HTMLDivElement>(null)
  const filmstrip = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const lineAt = useRef(new Map<number, HTMLElement>())
  // Where a page turned backwards lands: at its foot, because the reader was on their way
  // up through it. Every other way of arriving at a page starts at its head.
  const landing = useRef<'head' | 'foot'>('head')
  const turns = useRef(0)
  // Which line to bring into view, with a count so that asking for the same line twice is
  // two requests rather than one.
  const [focus, setFocus] = useState<{ line: number; n: number } | null>(null)

  const step = useCallback((by: number, land: 'head' | 'foot' = 'head') => {
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + by))]
    if (!next || next.idx === shown[at]?.idx) return
    landing.current = land
    setOpen(next.idx)
  }, [shown, at])

  const goToHit = useCallback((by: number) => {
    if (hits.length === 0) return
    const next = (hitAt + by + hits.length) % hits.length
    setHitCursor(next)
    landing.current = 'head'
    setOpen(hits[next].idx)
    setFocus({ line: hits[next].line, n: ++turns.current })
  }, [hits, hitAt])

  // A fresh search takes the reader to its first answer. Recomputing the hits for another
  // reason - a filter toggled - is not a fresh search and moves nobody.
  const jumped = useRef('')
  useEffect(() => {
    if (!current) return
    const fresh = `${mode} ${needle}`
    if (jumped.current === fresh) return
    jumped.current = fresh
    setHitCursor(0)
    const first = current.hits[0]
    if (!first) return
    landing.current = 'head'
    setOpen(first.idx)
    setFocus({ line: first.line, n: ++turns.current })
  }, [needle, mode, current])

  useEffect(() => {
    // The polygon belongs to the page it was read on, and nothing else would take it off
    // the one that replaces it.
    setHover(null)
  }, [at])

  // Once the page's text is here to land in: a page still on its way has no foot yet.
  const arrived = content !== undefined
  useEffect(() => {
    const el = textPane.current
    if (!el || !arrived) return
    el.scrollTop = landing.current === 'foot' ? el.scrollHeight : 0
    landing.current = 'head'
  }, [at, arrived])

  // After the landing above, so that a line asked for by name wins over the page's default.
  useEffect(() => {
    if (!focus || !arrived) return
    lineAt.current.get(focus.line)?.scrollIntoView({ block: 'center' })
  }, [focus, arrived, at])

  // By index, not by the page object: that is rebuilt on every keystroke of a search, and
  // bringing the strip back into line forces a layout each time it is.
  const openIdx = page?.idx
  useEffect(() => {
    if (!strip || openIdx === undefined) return
    filmstrip.current?.querySelector(`[data-page="${openIdx}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [strip, openIdx])

  // Scans are not fetched ahead the way the text is: the viewer reads a page from its tile
  // pyramid, and what it needs to paint one is a handful of kilobytes.

  const [textWheel] = useState(() => turner(SEAM_PX))

  const plate = useRef<HTMLDivElement>(null)
  // The same viewer the page editor uses, over the same tile pyramid - so a scan read
  // here is as sharp magnified as it is there, and paging through fades rather than
  // blinking. Fit is the floor: the point of the gallery is that the page is whole.
  const scan = useMemo(
    () => (page?.width && page?.height
      ? { tiles: tilesUrl(page.id, page.rotation), width: page.width, height: page.height }
      : null),
    [page?.id, page?.rotation, page?.width, page?.height],
  )
  const { setZoom, register, onPanStart, onPanMove, onPanEnd } =
    useImageSurface(scan, {
      min: ZOOM.least, max: ZOOM.most, grab: true, frame: 'whole', onZoom: setZoomShown,
    })
  const scanRefs = register('scan')

  const onTextWheel = (e: React.WheelEvent) => {
    const el = e.currentTarget
    const room = el.scrollHeight - el.clientHeight
    const seam = e.deltaY > 0 ? el.scrollTop >= room - 1 : el.scrollTop <= 0
    if (!seam) {
      textWheel.reset()
      return
    }
    const by = textWheel.push(e.deltaY)
    if (by) step(by, by < 0 ? 'foot' : 'head')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        setBare(false)
        search.current?.focus()
      } else if (e.key === 'f') setBare((was) => !was)
      else if (e.key === 'Escape') setBare(false)
      else if (e.key === 'j' || e.key === 'ArrowRight') step(1)
      else if (e.key === 'k' || e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'n') goToHit(1)
      else if (e.key === 'p') goToHit(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, goToHit])

  const keepStrip = (shown: boolean) => {
    setStrip(shown)
    void save({ transcript_filmstrip: shown })
  }

  const keepSplit = (ratio: number) => {
    setSplit(ratio)
    void save({ transcript_split: Math.round(ratio * 100) / 100 })
  }

  const dragSplit = (e: React.PointerEvent) => {
    e.preventDefault()
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    let ratio = split
    const move = (ev: PointerEvent) => {
      ratio = clampSplit((ev.clientX - box.left) / box.width)
      setSplit(ratio)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      keepSplit(ratio)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const pickPage = (clientY: number) => {
    const el = spine.current
    if (!el || shown.length === 0) return
    const box = el.getBoundingClientRect()
    const down = Math.min(1, Math.max(0, (clientY - box.top) / Math.max(1, box.height)))
    const next = shown[Math.round(down * (shown.length - 1))]
    if (next && next.idx !== page?.idx) {
      landing.current = 'head'
      setOpen(next.idx)
    }
  }

  if (error) return <p className="p-6 text-sm text-danger">{error}</p>
  if (pages === null) return <p className="p-6 text-sm text-ink-subtle">Loading</p>

  const lineCount = pages.reduce((sum, p) => sum + p.lines, 0)
  const checkedCount = pages.reduce((sum, p) => sum + p.checked, 0)
  const found = hits.length
  const currentHit = hits[hitAt]
  const ink = hover ?? (currentHit && page && currentHit.idx === page.idx
    ? elements.flatMap((e) => e.lines)
      .find((row) => row.line.id === currentHit.line)?.line.polygon ?? null
    : null)

  const pageSize: [number, number] = [page?.width || 2000, page?.height || 3000]

  const stepBtn =
    'rounded p-1 text-ink-muted hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'
  const toolBtn = (on: boolean) => `rounded p-1 ${
    on
      ? 'bg-accent-wash text-accent-ink'
      : 'text-ink-muted hover:bg-raised hover:text-ink'
  }`

  return (
    <div className="relative flex h-full flex-col">
      {bare && (
        // Whatever hides the controls has to leave a way back to them that is on the
        // screen, not only on a key nobody was told about.
        <button
          type="button"
          data-testid="transcript-immersive-exit"
          aria-label="Show the toolbar"
          title="Show the toolbar (Esc)"
          onClick={() => setBare(false)}
          className="absolute right-6 top-2 z-20 rounded-full border border-line bg-surface/90 p-1.5 text-ink-muted shadow-sm backdrop-blur hover:text-accent-ink"
        >
          <ExpandIcon shrink />
        </button>
      )}
      {!bare && (
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <h1 className="text-base font-semibold">{name}</h1>
        <DatasetViews jobId={jobId} active="transcript" />
        <span className="text-sm text-ink-muted" data-testid="transcript-counts">
          {checkedCount}/{lineCount} lines reviewed
        </span>
        <Input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="transcript-search"
          placeholder="Search - near spellings count"
          title="Finds lines that read like this, so a name the scan spells differently is still found. Press / to come back here"
          className="w-56"
        />
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'fuzzy', label: 'Fuzzy', title: 'Near spellings count - Schmidt finds Schmitt' },
            { value: 'exact', label: 'Exact', title: 'This text exactly, in any case' },
            { value: 'case', label: 'Aa', title: 'This text exactly, matching case' },
            { value: 'regex', label: '.*', title: 'A regular expression' },
          ]}
        />
        {needle && (
          <>
            <span data-testid="transcript-found" aria-live="polite"
                  className="text-sm text-ink-muted">
              {current?.error
                ?? (searching ? 'searching'
                  : unusable ? 'not a pattern yet' : `${found} line${found === 1 ? '' : 's'}`)}
            </span>
            {found > 0 && (
              <span className="flex items-center gap-0.5">
                <button type="button" aria-label="Previous result" data-testid="transcript-hit-prev"
                        onClick={() => goToHit(-1)} className={stepBtn}>
                  <ChevronIcon dir="left" />
                </button>
                <span data-testid="transcript-hit-at"
                      className="text-xs tabular-nums text-ink-muted">
                  {hitAt + 1} of {found}
                </span>
                <button type="button" aria-label="Next result" data-testid="transcript-hit-next"
                        onClick={() => goToHit(1)} className={stepBtn}>
                  <ChevronIcon dir="right" />
                </button>
              </span>
            )}
            <label className="flex items-center gap-1.5 text-sm text-ink-muted">
              <Check
                checked={hitsOnly}
                onChange={(e) => setHitsOnly(e.target.checked)}
              />
              pages with hits
            </label>
          </>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-sm text-ink-muted">
          <Check
            checked={reviewedOnly}
            onChange={(e) => setReviewedOnly(e.target.checked)}
          />
          reviewed only
        </label>
        <button
          type="button"
          data-testid="transcript-strip-toggle"
          aria-pressed={strip}
          aria-label="Every page along the foot"
          title="Every page along the foot"
          onClick={() => keepStrip(!strip)}
          className={toolBtn(strip)}
        >
          <PagesIcon />
        </button>
        <button
          type="button"
          data-testid="transcript-immersive"
          aria-pressed={bare}
          aria-label="Reading room"
          title="Reading room - the scan and the text, nothing else (f)"
          onClick={() => setBare(true)}
          className={toolBtn(false)}
        >
          <ExpandIcon shrink={false} />
        </button>
      </header>
      )}

      <div
        ref={frame}
        onMouseLeave={() => setHover(null)}
        className="flex min-h-0 flex-1"
      >
        <div
          id="transcript-scans"
          data-testid="transcript-scans"
          style={{ flexBasis: `${split * 100}%` }}
          className="flex min-w-0 shrink-0 grow-0 flex-col overflow-hidden bg-ground"
        >
          {page ? (
            <>
              {/* The viewer clips to this box, so a magnified scan cannot reach over the
                  page arrows beneath it and swallow the clicks meant for them. */}
              <div className="min-h-0 flex-1 p-5">
                <div
                  ref={plate}
                  data-testid="transcript-scan"
                  data-page={page.idx}
                  data-zoom={zoom.toFixed(2)}
                  onPointerDown={onPanStart}
                  onPointerMove={onPanMove}
                  onPointerUp={onPanEnd}
                  onPointerCancel={onPanEnd}
                  onDoubleClick={() => setZoom(1)}
                  title={zoom > 1 ? 'Drag to move, double-click to fit' : 'Ctrl-wheel to magnify'}
                  style={{ cursor: zoom > 1 ? 'grab' : undefined }}
                  className="relative h-full w-full overflow-hidden"
                >
                  <div ref={scanRefs.host} className="absolute inset-0" />
                  <div ref={scanRefs.box} className="absolute left-0 top-0 z-10 origin-top-left invisible">
                    {ink && <Ink size={pageSize} polygon={ink} />}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-center gap-2 px-3 pb-3 text-xs text-ink-muted">
                <button type="button" aria-label="Previous page" data-testid="transcript-page-prev"
                        disabled={at === 0} onClick={() => step(-1)} className={stepBtn}>
                  <ChevronIcon dir="left" />
                </button>
                <span data-testid="transcript-page-at" className="truncate tabular-nums">
                  {at + 1} / {shown.length} · {page.filename}
                </span>
                <button type="button" aria-label="Next page" data-testid="transcript-page-next"
                        disabled={at === shown.length - 1} onClick={() => step(1)}
                        className={stepBtn}>
                  <ChevronIcon dir="right" />
                </button>
              </div>
              {strip && (
                <div
                  ref={filmstrip}
                  data-testid="transcript-strip"
                  className="flex shrink-0 gap-2 overflow-x-auto border-t border-line px-3 py-2"
                >
                  {shown.map((p, i) => (
                    <button
                      key={p.idx}
                      type="button"
                      data-testid="transcript-thumb"
                      data-page={p.idx}
                      aria-label={`Page ${p.idx + 1}`}
                      title={`Page ${p.idx + 1}`}
                      aria-current={i === at ? 'page' : undefined}
                      onClick={() => {
                        landing.current = 'head'
                        setOpen(p.idx)
                      }}
                      className={`shrink-0 rounded-sm ${
                        i === at
                          ? 'outline outline-2 outline-offset-1 outline-accent'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                    >
                      {/* Lazily, because a volume is hundreds of plates and a dozen are
                          ever in the strip at once - and each holds its own shape before it
                          arrives, or the strip is a row of nothing that widens plate by
                          plate as they load, under a reader trying to point at one. */}
                      <img
                        src={renditionUrl(p.id, 'thumb', p.rotation)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        style={{ aspectRatio: p.width && p.height ? `${p.width} / ${p.height}` : '2 / 3' }}
                        className="block h-14 w-auto rounded-sm bg-surface"
                      />
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-subtle">
              No page to show
            </div>
          )}
        </div>

        <Splitter
          orientation="vertical"
          aria-label="Width of the scan"
          data-testid="transcript-divider"
          aria-valuemin={Math.round(SPLIT.least * 100)}
          aria-valuemax={Math.round(SPLIT.most * 100)}
          aria-valuenow={Math.round(split * 100)}
          aria-controls="transcript-scans"
          onPointerDown={dragSplit}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            keepSplit(clampSplit(split + (e.key === 'ArrowLeft' ? -0.02 : 0.02)))
          }}
        />

        <div
          ref={textPane}
          data-testid="transcript-text"
          onWheel={onTextWheel}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        >
          {page && !content ? (
            <p data-testid="transcript-page-loading" className="p-8 text-sm text-ink-subtle">Loading the page</p>
          ) : page ? (
            <article className="mx-auto max-w-[74ch] px-8 pb-28 pt-8 font-serif">
              <h2 className="mb-6 font-sans text-xs font-medium uppercase tracking-widest text-ink-subtle">
                Page {page.idx + 1}
              </h2>
              {elements.map((element) => (
                <section
                  key={element.order_idx}
                  className="mb-6 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-5 max-sm:grid-cols-1 max-sm:gap-y-1"
                >
                  <p className="pt-1 text-right font-sans text-[11px] font-medium uppercase tracking-wide text-ink-subtle max-sm:text-left">
                    {element.class_name}
                  </p>
                  <div>
                    {element.lines.map(({ line, words }) => (
                      <p
                        key={line.id}
                        ref={(n) => {
                          if (n) lineAt.current.set(line.id, n)
                          else lineAt.current.delete(line.id)
                        }}
                        data-testid="transcript-line"
                        data-checked={line.checked}
                        data-hit={words ? 'true' : 'false'}
                        data-at={currentHit?.line === line.id ? 'true' : 'false'}
                        onMouseEnter={() => setHover(line.polygon)}
                        title={line.checked ? 'reviewed' : 'not reviewed yet'}
                        className={`-mx-2 rounded px-2 text-[15px] leading-7 ${
                          line.checked
                            ? 'text-ink'
                            : 'text-ink-subtle'
                        } ${
                          currentHit?.line === line.id ? 'bg-accent-wash' : ''
                        } hover:bg-accent-wash`}
                      >
                        {marked(lineText(line), words ?? [])}
                      </p>
                    ))}
                  </div>
                </section>
              ))}
            </article>
          ) : (
            <p data-testid="transcript-empty" className="p-8 text-sm text-ink-muted">
              {needle && hitsOnly
                ? `No page reads like "${needle}".`
                : reviewedOnly
                  ? 'Nothing has been reviewed yet.'
                  : 'No transcription yet.'}
            </p>
          )}
        </div>

        <div
          ref={spine}
          data-testid="transcript-spine"
          role="slider"
          aria-label="Page"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, shown.length)}
          aria-valuenow={at + 1}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            pickPage(e.clientY)
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) pickPage(e.clientY)
          }}
          onKeyDown={(e) => {
            const by = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key]
            if (by === undefined && e.key !== 'Home' && e.key !== 'End') return
            e.preventDefault()
            if (by !== undefined) step(by)
            else step(e.key === 'Home' ? -shown.length : shown.length)
          }}
          className="relative w-4 shrink-0 cursor-pointer border-l border-line bg-surface focus:outline-none"
        >
          {/* Inset by half the largest tick, so the first and last pages' ticks stay inside
              the window rather than hanging over its edges. */}
          <div className="pointer-events-none absolute inset-x-0 inset-y-1">
            {shown.map((p, i) => (
              <span
                key={p.idx}
                data-testid="transcript-tick"
                data-hit={hitPages.has(p.idx) ? 'true' : 'false'}
                data-at={i === at ? 'true' : 'false'}
                style={{ top: `${shown.length > 1 ? (i / (shown.length - 1)) * 100 : 0}%` }}
                className={`pointer-events-none absolute -translate-y-1/2 rounded-full ${
                  i === at
                    ? 'inset-x-0.5 h-1.5 bg-accent'
                    : hitPages.has(p.idx)
                      ? 'inset-x-1 h-1 bg-warn'
                      : 'inset-x-1.5 h-0.5 bg-line-strong'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
