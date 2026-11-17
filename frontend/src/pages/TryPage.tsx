import { useEffect, useRef, useState } from 'react'
import type { DragEvent, RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { READING_ORDERS, READING_ORDER_LABEL, getRecognitionOffer, getRecognitionReading, recognizePage, saveBlob } from '../api'
import type { OfferedModel, RecognitionOffer, RecognitionRequest, Recognized } from '../api'
import { useAuth } from '../auth'
import { DECODE_NAMES } from '../components/job/processing'
import { useCrumb } from '../components/NavBar'
import { Button, Toggle } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { RegionLabel } from '../components/viewer/RegionLabel'
import { Select } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'
import { pageShell } from '../components/ui/page'
import { classColor, getReviewConf, getTryLineNumbers, plural, setTryLineNumbers } from '../util'
import { viewableScan } from '../viewableScan'

const MAX_SCANS = 10
let scanCount = 0

interface Picks {
  /** '' runs no layout model: the lines are found on the whole page. */
  layout: string
  lines: string
  ocr: string
  /** 'auto' leaves the reading to the model, as a dataset on Automatic does. */
  decode: string
  /** How the page is laid out, as a dataset says it; 'auto' works it out per page. */
  order: string
}

interface Scan {
  key: string
  file: File
  /** What is drawn: the file, or a copy decoded on the page where the browser cannot show
   *  it; unset while that is worked out, null when neither can be drawn. */
  url?: string | null
  answer?: Recognized
  seconds?: number
  error?: string
  reading: boolean
  /** When its request went out; unset while it waits in line behind another scan. */
  sentAt?: number
}

const STEPS: Record<RecognitionRequest['state'], string> = {
  'finding regions': 'Finding regions', 'finding lines': 'Finding lines', reading: 'Reading',
  'waiting for the GPU': 'Waiting for the GPU',
}

/** What a scan still being read is waiting on, kept short: its step on the backend, or its place in line. */
function waitingFor(sent: boolean, ahead: number, progress: RecognitionRequest | null): string {
  if (!sent) return ahead > 1 ? `In line · ${ahead} ahead` : 'Next in line'
  if (!progress) return 'Sending'
  if (progress.state === 'reading' && progress.lines_total) return `Reading ${progress.lines_read} of ${progress.lines_total} lines`
  return STEPS[progress.state]
}

/** Consecutive lines of one region - or of none, without layout - each run shown under its region. */
function runsOf(lines: { region?: number | null }[]) {
  const runs: { region: number | null; start: number; count: number }[] = []
  lines.forEach((line, i) => {
    const region = line.region ?? null
    const last = runs.at(-1)
    if (last && last.region === region) last.count += 1
    else runs.push({ region, start: i, count: 1 })
  })
  return runs
}

const defaultOf = (models: OfferedModel[]) => String(models.find((m) => m.default)?.id ?? models[0]?.id ?? '')

function fieldsOf(picks: Picks): Record<string, string> {
  return {
    format: 'page',
    ...(picks.layout ? { layout_model: picks.layout } : {}),
    ...(picks.lines ? { lines_model: picks.lines } : {}),
    ...(picks.ocr ? { ocr_model: picks.ocr } : {}),
    ...(picks.decode !== 'auto' ? { decode: picks.decode } : {}),
    ...(picks.order !== 'auto' ? { reading_order: picks.order } : {}),
  }
}

function curlFor(name: string, picks: Picks): string {
  const options = [`-H "Authorization: Bearer $DEEPLABEL_TOKEN"`, `-F files=@${name}`,
                   ...Object.entries(fieldsOf(picks)).map(([key, value]) => `-F ${key}=${value}`)]
  return ['curl', ...options.map((o) => `  ${o}`), '  $DEEPLABEL_URL/api/recognize/pages'].join(' \\\n')
}

/** The scan's height while its text stands beside it, for the text to match; null while the
 *  two are stacked on a narrow screen, where the text grows with its lines. */
function useHeightBeside(scanBox: RefObject<HTMLElement | null>, textBox: RefObject<HTMLElement | null>,
                         shown: string | undefined): number | null {
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    const scanEl = scanBox.current
    const textEl = textBox.current
    if (!scanEl || !textEl?.parentElement) return
    const measure = () => setHeight(scanEl.offsetTop === textEl.offsetTop ? scanEl.offsetHeight : null)
    const observer = new ResizeObserver(measure)
    observer.observe(scanEl)
    observer.observe(textEl.parentElement)
    return () => observer.disconnect()
  }, [scanBox, textBox, shown])
  return height
}

/** Scrolls `box` just enough to show `row`, leaving every other scroll where it is. */
function revealWithin(box: HTMLElement, row: HTMLElement) {
  const view = box.getBoundingClientRect()
  const item = row.getBoundingClientRect()
  if (item.top < view.top) box.scrollTop -= view.top - item.top
  else if (item.bottom > view.bottom) box.scrollTop += item.bottom - view.bottom
}

/** Read a scan of one's own through the recognition API and see what came back: the lines
 *  on the scan, their text beside it. Nothing is kept - the scans stay in the browser. */
export function TryPage() {
  useCrumb('Try recognition')
  const { can } = useAuth()
  const [params] = useSearchParams()
  const [offer, setOffer] = useState<RecognitionOffer | null>(null)
  const [picks, setPicks] = useState<Picks>({ layout: '', lines: '', ocr: params.get('ocr') ?? '', decode: 'auto', order: 'auto' })
  const [scans, setScans] = useState<Scan[]>([])
  const [shown, setShown] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [numbered, setNumbered] = useState(getTryLineNumbers)
  const scanBox = useRef<HTMLElement>(null)
  const textBox = useRef<HTMLElement>(null)
  const textScroll = useRef<HTMLDivElement>(null)
  const outlines = useRef<SVGSVGElement>(null)
  const heightBeside = useHeightBeside(scanBox, textBox, scans[shown]?.key)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<RecognitionRequest | null>(null)
  const [now, setNow] = useState(() => performance.now())
  // One request at a time - the API reads one per account - and a newer choice of models
  // makes whatever is still waiting on an older one moot.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const generation = useRef(0)
  const previews = useRef<string[]>([])

  useEffect(() => {
    getRecognitionOffer().then((answer) => {
      setOffer(answer)
      setPicks((held) => ({
        ...held, lines: held.lines || defaultOf(answer.models.lines), ocr: held.ocr || defaultOf(answer.models.ocr),
      }))
    }).catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), [])

  // The shown scan's request, while it runs: its step asked of the backend, and its seconds.
  const sentAt = scans[shown]?.reading ? scans[shown].sentAt : undefined
  useEffect(() => {
    setProgress(null)
    if (sentAt === undefined) return
    let live = true
    const tick = () => {
      setNow(performance.now())
      getRecognitionReading().then((answer) => { if (live) setProgress(answer) }).catch(() => {})
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => { live = false; window.clearInterval(timer) }
  }, [sentAt])

  const update = (key: string, change: Partial<Scan>) =>
    setScans((held) => held.map((s) => (s.key === key ? { ...s, ...change } : s)))

  const read = (batch: Scan[], chosen: Picks) => {
    const run = generation.current
    const keys = new Set(batch.map((s) => s.key))
    setScans((held) => held.map((s) => (keys.has(s.key) ? { ...s, reading: true, sentAt: undefined } : s)))
    for (const scan of batch) {
      queue.current = queue.current.then(async () => {
        if (run !== generation.current) return
        const started = performance.now()
        update(scan.key, { error: undefined, sentAt: started })
        try {
          const answer = await recognizePage(scan.file, fieldsOf(chosen))
          if (run !== generation.current) return
          const page = answer.pages[0]
          update(scan.key, page.error
            ? { reading: false, sentAt: undefined, error: page.error, answer: undefined }
            : { reading: false, sentAt: undefined, answer, seconds: (performance.now() - started) / 1000 })
        } catch (e) {
          if (run === generation.current) {
            update(scan.key, { reading: false, sentAt: undefined, error: (e as Error).message, answer: undefined })
          }
        }
      })
    }
  }

  const choose = (key: keyof Picks, value: string) => {
    const next = { ...picks, [key]: value, ...(key === 'ocr' ? { decode: 'auto' } : {}) }
    setPicks(next)
    generation.current += 1
    read(scans, next)
  }

  const add = (files: FileList | null) => {
    const room = MAX_SCANS - scans.length
    const taken = Array.from(files ?? []).filter((f) => f.type.startsWith('image/')).slice(0, room)
    if (!taken.length) return
    const added = taken.map((file) => ({ key: `scan-${(scanCount += 1)}`, file, reading: true }))
    setScans((held) => [...held, ...added])
    setShown(scans.length)
    read(added, picks)
    for (const scan of added) {
      void viewableScan(scan.file).then((url) => {
        if (url) previews.current.push(url)
        update(scan.key, { url })
      })
    }
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    add(e.dataTransfer.files)
  }

  if (!can('recognize')) {
    return (
      <div className={pageShell}>
        <PageHeader title="Try recognition" />
        <EmptyState>Trying recognition needs the Recognize permission, which an admin can grant on the Admin page.</EmptyState>
      </div>
    )
  }

  const scan = scans[shown] as Scan | undefined
  // A scan read again shows nothing of its last answer until the new one is in.
  const page = scan?.reading ? undefined : scan?.answer?.pages[0]
  const waiting = scan?.reading
    ? waitingFor(scan.sentAt !== undefined, scans.slice(0, shown).filter((s) => s.reading).length, progress)
    : null
  const seconds = scan?.sentAt !== undefined ? Math.max(0, Math.floor((now - scan.sentAt) / 1000)) : null
  const lines = page?.lines ?? []
  const regions = page?.regions ?? []
  const threshold = getReviewConf()
  const ocrModel = offer?.models.ocr.find((m) => String(m.id) === picks.ocr)
  const used = scan?.answer?.models
  const stem = (name: string) => name.replace(/\.[^.]+$/, '')
  const pick = (label: string, key: keyof Picks, testid: string, options: [string, string][]) => (
    <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-ink-muted sm:flex-none">
      {label}
      <Select size="md" data-testid={testid} value={picks[key]} onChange={(e) => choose(key, e.target.value)}
              className="cursor-pointer">
        {options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </Select>
    </label>
  )

  return (
    <div className={pageShell}>
      <PageHeader title="Try recognition">
        Drop a scan and see what the models make of it - the lines found, in reading order, each
        read. Nothing is kept.
      </PageHeader>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-line bg-surface p-3">
        {pick('Layout', 'layout', 'try-layout-model', [['', 'None'],
              ...(offer?.models.layout ?? []).map((m): [string, string] => [String(m.id), m.default ? `${m.name} (default)` : m.name])])}
        {pick('Lines', 'lines', 'try-lines-model',
              (offer?.models.lines ?? []).map((m) => [String(m.id), m.default ? `${m.name} (default)` : m.name]))}
        {pick('OCR', 'ocr', 'try-ocr-model',
              (offer?.models.ocr ?? []).map((m) => [String(m.id), m.default ? `${m.name} (default)` : m.name]))}
        {pick('OCR decoding', 'decode', 'try-decode',
              [['auto', DECODE_NAMES.auto], ...(ocrModel?.decodes ?? []).map((d): [string, string] => [d, DECODE_NAMES[d]])])}
        {pick('Reading order', 'order', 'try-reading-order',
              READING_ORDERS.map((value) => [value, READING_ORDER_LABEL[value]]))}
        <span className="pb-2 text-xs text-ink-subtle">The scans are read again when a choice changes.</span>
      </div>

      {scan && (
        <div className="mb-4 flex flex-wrap items-start gap-4">
          <section ref={scanBox} aria-label="Scan" className="min-w-0 flex-[999_1_480px] rounded-md border border-line bg-surface p-3">
            <div className="mb-2 flex justify-end">
              <Toggle on={numbered} onClick={() => { setNumbered(!numbered); setTryLineNumbers(!numbered) }}
                      title="Number the outlines on the scan; the text keeps its numbers either way">
                Line numbers
              </Toggle>
            </div>
            <div className="relative">
              {waiting && (
                // Sticky, so a tall scan scrolled to its foot still shows what it waits on.
                <div className="pointer-events-none sticky top-0 z-10 flex h-0 items-start justify-center">
                  <p data-testid="try-reading" role="status"
                     className="mt-3 flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface/95 px-2.5 py-1 text-xs text-ink shadow-sm">
                    <span aria-hidden className="size-3 flex-none rounded-full border-[1.5px] border-accent border-t-transparent motion-safe:animate-spin" />
                    {waiting}
                    {seconds !== null && <span aria-hidden className="tabular-nums text-ink-muted"> · {seconds} s</span>}
                  </p>
                </div>
              )}
              {scan.url ? <img src={scan.url} alt={scan.file.name} className="block h-auto w-full rounded" />
                : scan.url === null && (
                  <p data-testid="try-unviewable" role="note"
                     style={{ aspectRatio: page?.width && page.height ? `${page.width} / ${page.height}` : '3 / 4' }}
                     className="flex items-center justify-center rounded border border-dashed border-line-strong p-4 text-center text-sm text-ink-muted">
                    This scan&apos;s format cannot be drawn in the browser; what was read is listed beside it.
                  </p>
                )}
              {waiting && (
                <div data-testid="try-sweep" aria-hidden
                     className="pointer-events-none absolute inset-0 overflow-hidden rounded bg-surface/45">
                  {scan.sentAt !== undefined && (
                    <div className="absolute inset-x-0 top-0 h-1/4 bg-linear-to-b from-transparent via-accent/25 to-transparent motion-safe:animate-sweep motion-reduce:hidden" />
                  )}
                </div>
              )}
              {page?.width && page.height && regions.map((region, r) => {
                const xs = region.polygon.map(([px]) => px)
                // A container is tagged at its top right, clear of the box it holds at its top
                // left; a box far to the right too, so its tag stays on the scan.
                const end = region.role === 'container' || Math.min(...xs) / page.width! > 0.7
                return (
                  <RegionLabel key={`t${r}`} className={region.class} container={region.role === 'container'} end={end}
                               x={(end ? Math.max(...xs) : Math.min(...xs)) / page.width!}
                               y={Math.min(...region.polygon.map(([, py]) => py)) / page.height!} />
                )
              })}
              {page?.width && page.height && (
                <svg ref={outlines} viewBox={`0 0 ${page.width} ${page.height}`} className="absolute inset-0 h-full w-full"
                     aria-label={`${plural(lines.length, 'line')} found`}>
                  {regions.map((region, r) => (
                    <polygon key={`r${r}`} data-testid="try-region" data-class={region.class} data-role={region.role}
                             points={region.polygon.map(([px, py]) => `${px},${py}`).join(' ')}
                             vectorEffect="non-scaling-stroke" strokeWidth={1.5} pointerEvents="none"
                             stroke={classColor(region.class)} strokeDasharray={region.role === 'container' ? '4 3' : undefined}
                             fill={region.role === 'container' ? 'none' : classColor(region.class, 0.08)} />
                  ))}
                  {lines.map((line, i) => {
                    const n = i + 1
                    const unsure = line.confidence !== null && line.confidence < threshold
                    const [x, y] = line.polygon.reduce(([mx, my], [px, py]) => [Math.min(mx, px), Math.min(my, py)], [Infinity, Infinity])
                    const r = Math.max(page.width!, page.height!) / 70
                    // Left of the line, but never off the scan, where a margin's lines start.
                    const badge = Math.max(r * 1.1, x - r * 1.4)
                    return (
                      <g key={n}>
                        <polygon data-testid="try-line" data-line={n} data-active={hover === n || undefined}
                                 points={line.polygon.map(([px, py]) => `${px},${py}`).join(' ')}
                                 vectorEffect="non-scaling-stroke" strokeWidth={hover === n ? 3 : 1.5}
                                 onMouseEnter={() => {
                                   setHover(n)
                                   const row = textScroll.current?.querySelector<HTMLElement>(`[data-line="${n}"]`)
                                   if (row) revealWithin(textScroll.current!, row)
                                 }}
                                 onMouseLeave={() => setHover(null)}
                                 className={`cursor-pointer ${unsure ? 'stroke-warn' : 'stroke-accent'} ${
                                   hover === n ? 'fill-accent/25' : unsure ? 'fill-warn/25' : 'fill-transparent'}`} />
                        {numbered && (
                          <>
                            <circle cx={badge} cy={y + r * 0.6} r={r} className={unsure ? 'fill-warn' : 'fill-accent'} />
                            <text x={badge} y={y + r * 0.6} dy="0.35em" textAnchor="middle" fontSize={r * 1.15}
                                  className="fill-on-accent font-mono">{n}</text>
                          </>
                        )}
                      </g>
                    )
                  })}
                </svg>
              )}
            </div>
          </section>

          <section ref={textBox} aria-label="Text" style={{ height: heightBeside ?? undefined }}
                   className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 rounded-md border border-line bg-surface p-3">
            <div className="shrink-0">
              <p className="text-sm font-semibold">{scan.file.name}</p>
              <p className="text-xs text-ink-muted">
                {scan.reading ? (scan.sentAt === undefined ? 'in line' : 'reading…') : scan.error ? 'not read'
                  : `${plural(lines.length, 'line')} · read in ${scan.seconds?.toFixed(1)} s · ${
                    [used?.layout && `layout ${used.layout.name}`, used?.lines && `lines ${used.lines.name}`,
                     used?.ocr && `OCR ${used.ocr.name} (${DECODE_NAMES[used.ocr.decode]})`].filter(Boolean).join(', ')}`}
              </p>
            </div>
            <div ref={textScroll} data-testid="try-text-scroll"
                 className="-mx-3 -mb-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
              {scan.error && <p role="alert" className="text-sm text-danger">{scan.error}</p>}
              {scan.reading && (
                <div data-testid="try-text-waiting" aria-hidden className="flex flex-col gap-3 border-t border-line px-2 pt-3">
                  {[88, 64, 76, 52, 70].map((width) => (
                    <span key={width} className="h-2.5 rounded-full bg-line motion-safe:animate-pulse" style={{ width: `${width}%` }} />
                  ))}
                </div>
              )}
              {!scan.error && !scan.reading && (
                <div className="border-t border-line text-sm">
                  {runsOf(lines).map(({ region, start, count }) => {
                    const heading = region === null ? undefined : regions[region]
                    return (
                      <section key={start}>
                        {heading && (
                          <h3 data-testid="try-region-label"
                              className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-xs font-medium text-ink-muted">
                            <span aria-hidden className="size-2 flex-none rounded-sm" style={{ backgroundColor: classColor(heading.class) }} />
                            {heading.class}
                          </h3>
                        )}
                        <ol start={start + 1}>
                          {lines.slice(start, start + count).map((line, k) => {
                            const n = start + k + 1
                            const unsure = line.confidence !== null && line.confidence < threshold
                            return (
                              <li key={n} data-testid="try-text-line" data-line={n} data-unsure={unsure || undefined}
                                  data-active={hover === n || undefined}
                                  onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(null)}
                                  onClick={() => outlines.current?.querySelector(`[data-line="${n}"]`)
                                    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
                                  className={`flex cursor-pointer gap-2.5 border-b border-line px-2 py-1.5 ${
                                    hover === n ? 'bg-accent-wash text-accent-ink shadow-[inset_3px_0_0_var(--color-accent)]'
                                      : unsure ? 'bg-warn/15' : ''}`}>
                                <span className={`w-5 flex-none pt-px text-right font-mono text-xs ${unsure ? 'text-warn' : 'text-ink-subtle'}`}>{n}</span>
                                <span data-testid="try-text">{line.text}</span>
                                {unsure && (
                                  <span className="ml-auto whitespace-nowrap text-xs text-warn">
                                    unsure · {Math.round((line.confidence ?? 0) * 100)} %
                                  </span>
                                )}
                              </li>
                            )
                          })}
                        </ol>
                      </section>
                    )
                  })}
                </div>
              )}
              {page?.lines && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void navigator.clipboard?.writeText(lines.map((l) => l.text).join('\n'))}>
                    Copy text
                  </Button>
                  <Button size="sm" disabled={!page.document}
                          onClick={() => saveBlob(new Blob([page.document ?? ''], { type: 'application/xml' }), `${stem(scan.file.name)}.xml`)}>
                    Download PAGE XML
                  </Button>
                </div>
              )}
              <details open className="rounded border border-line bg-ground">
                <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium">Do this with the API</summary>
                <pre data-testid="try-api" className="overflow-x-auto px-2.5 pb-2.5 font-mono text-xs text-ink-muted">
                  {curlFor(scan.file.name, picks)}
                </pre>
              </details>
            </div>
          </section>
        </div>
      )}

      <div onDragOver={(e) => e.preventDefault()} onDrop={drop}
           className="flex flex-wrap items-center gap-2.5 rounded-md border border-dashed border-line-strong bg-surface p-2.5">
        <label className={`flex h-16 cursor-pointer items-center rounded border border-dashed border-accent bg-accent-wash px-4 text-sm font-medium text-accent-ink ${
          scans.length >= MAX_SCANS ? 'pointer-events-none opacity-50' : ''}`}>
          + Drop scans here or choose files
          <input data-testid="try-files" type="file" accept="image/*" multiple className="sr-only"
                 onChange={(e) => { add(e.target.files); e.target.value = '' }} />
        </label>
        {scans.map((s, i) => (
          <button key={s.key} type="button" onClick={() => setShown(i)} aria-label={s.file.name} aria-current={i === shown || undefined}
                  className={`relative h-16 w-12 overflow-hidden rounded border ${i === shown ? 'border-2 border-accent' : 'border-line-strong'}`}>
            {s.url && <img src={s.url} alt="" className="h-full w-full object-cover" />}
            {s.reading && <span className="absolute inset-0 animate-pulse bg-surface/60" />}
            {s.error && <span className="absolute inset-x-0 bottom-0 bg-danger text-[10px] text-on-accent">!</span>}
          </button>
        ))}
        <span className="text-xs text-ink-muted">
          {scans.length ? `${plural(scans.length, 'scan')} · ` : ''}up to {MAX_SCANS} at a time · nothing is kept
        </span>
      </div>
    </div>
  )
}
