import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getRecognitionOffer, recognizePage, saveBlob } from '../api'
import type { OfferedModel, RecognitionOffer, Recognized } from '../api'
import { useAuth } from '../auth'
import { DECODE_NAMES } from '../components/job/processing'
import { useCrumb } from '../components/NavBar'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Select } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'
import { pageShell } from '../components/ui/page'
import { getReviewConf, plural } from '../util'

const MAX_SCANS = 10
let scanCount = 0

interface Picks {
  lines: string
  ocr: string
  /** 'auto' leaves the reading to the model, as a dataset on Automatic does. */
  decode: string
}

interface Scan {
  key: string
  file: File
  url: string
  answer?: Recognized
  seconds?: number
  error?: string
  reading: boolean
}

const defaultOf = (models: OfferedModel[]) => String(models.find((m) => m.default)?.id ?? models[0]?.id ?? '')

function fieldsOf(picks: Picks): Record<string, string> {
  return {
    format: 'page',
    ...(picks.lines ? { lines_model: picks.lines } : {}),
    ...(picks.ocr ? { ocr_model: picks.ocr } : {}),
    ...(picks.decode !== 'auto' ? { decode: picks.decode } : {}),
  }
}

function curlFor(name: string, picks: Picks): string {
  const options = [`-H "Authorization: Bearer $DEEPLABEL_TOKEN"`, `-F files=@${name}`,
                   ...Object.entries(fieldsOf(picks)).map(([key, value]) => `-F ${key}=${value}`)]
  return ['curl', ...options.map((o) => `  ${o}`), '  $DEEPLABEL_URL/api/recognize/pages'].join(' \\\n')
}

/** Read a scan of one's own through the recognition API and see what came back: the lines
 *  on the scan, their text beside it. Nothing is kept - the scans stay in the browser. */
export function TryPage() {
  useCrumb('Try recognition')
  const { can } = useAuth()
  const [params] = useSearchParams()
  const [offer, setOffer] = useState<RecognitionOffer | null>(null)
  const [picks, setPicks] = useState<Picks>({ lines: '', ocr: params.get('ocr') ?? '', decode: 'auto' })
  const [scans, setScans] = useState<Scan[]>([])
  const [shown, setShown] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  const update = (key: string, change: Partial<Scan>) =>
    setScans((held) => held.map((s) => (s.key === key ? { ...s, ...change } : s)))

  const read = (batch: Scan[], chosen: Picks) => {
    const run = generation.current
    for (const scan of batch) {
      queue.current = queue.current.then(async () => {
        if (run !== generation.current) return
        update(scan.key, { reading: true, error: undefined })
        const started = performance.now()
        try {
          const answer = await recognizePage(scan.file, fieldsOf(chosen))
          if (run !== generation.current) return
          const page = answer.pages[0]
          update(scan.key, page.error
            ? { reading: false, error: page.error, answer: undefined }
            : { reading: false, answer, seconds: (performance.now() - started) / 1000 })
        } catch (e) {
          if (run === generation.current) update(scan.key, { reading: false, error: (e as Error).message, answer: undefined })
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
    const added = taken.map((file) => ({ key: `scan-${(scanCount += 1)}`, file, url: URL.createObjectURL(file), reading: true }))
    previews.current.push(...added.map((s) => s.url))
    setScans((held) => [...held, ...added])
    if (!scans.length) setShown(0)
    read(added, picks)
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
  const page = scan?.answer?.pages[0]
  const lines = page?.lines ?? []
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
        {pick('Lines', 'lines', 'try-lines-model',
              (offer?.models.lines ?? []).map((m) => [String(m.id), m.default ? `${m.name} (default)` : m.name]))}
        {pick('OCR', 'ocr', 'try-ocr-model',
              (offer?.models.ocr ?? []).map((m) => [String(m.id), m.default ? `${m.name} (default)` : m.name]))}
        {pick('Reading', 'decode', 'try-decode',
              [['auto', DECODE_NAMES.auto], ...(ocrModel?.decodes ?? []).map((d): [string, string] => [d, DECODE_NAMES[d]])])}
        <span className="pb-2 text-xs text-ink-subtle">The scans are read again when a choice changes.</span>
      </div>

      {scan && (
        <div className="mb-4 flex flex-wrap items-start gap-4">
          <section aria-label="Scan" className="min-w-0 flex-[999_1_480px] rounded-md border border-line bg-surface p-3">
            <div className="relative">
              <img src={scan.url} alt={scan.file.name} className="block h-auto w-full rounded" />
              {page?.width && page.height && (
                <svg viewBox={`0 0 ${page.width} ${page.height}`} className="absolute inset-0 h-full w-full"
                     aria-label={`${plural(lines.length, 'line')} found`}>
                  {lines.map((line, i) => {
                    const n = i + 1
                    const unsure = line.confidence !== null && line.confidence < threshold
                    const [x, y] = line.polygon.reduce(([mx, my], [px, py]) => [Math.min(mx, px), Math.min(my, py)], [Infinity, Infinity])
                    const r = Math.max(page.width!, page.height!) / 70
                    return (
                      <g key={n}>
                        <polygon data-testid="try-line" data-line={n} data-active={hover === n || undefined}
                                 points={line.polygon.map(([px, py]) => `${px},${py}`).join(' ')}
                                 vectorEffect="non-scaling-stroke" strokeWidth={hover === n ? 3 : 1.5}
                                 onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(null)}
                                 className={`cursor-pointer ${unsure ? 'stroke-warn' : 'stroke-accent'} ${
                                   hover === n ? 'fill-accent/25' : unsure ? 'fill-warn/25' : 'fill-transparent'}`} />
                        <circle cx={x - r * 1.4} cy={y + r * 0.6} r={r} className={unsure ? 'fill-warn' : 'fill-accent'} />
                        <text x={x - r * 1.4} y={y + r * 0.6} dy="0.35em" textAnchor="middle" fontSize={r * 1.15}
                              className="fill-on-accent font-mono">{n}</text>
                      </g>
                    )
                  })}
                </svg>
              )}
            </div>
          </section>

          <section aria-label="Text" className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 rounded-md border border-line bg-surface p-3">
            <div>
              <p className="text-sm font-semibold">{scan.file.name}</p>
              <p className="text-xs text-ink-muted">
                {scan.reading ? 'reading…' : scan.error ? 'not read'
                  : `${plural(lines.length, 'line')} · read in ${scan.seconds?.toFixed(1)} s · ${
                    [used?.lines?.name, used?.ocr && `${used.ocr.name}, ${DECODE_NAMES[used.ocr.decode]}`].filter(Boolean).join(', ')}`}
              </p>
            </div>
            {scan.error && <p role="alert" className="text-sm text-danger">{scan.error}</p>}
            {!scan.error && (
              <ol className="border-t border-line text-sm">
                {lines.map((line, i) => {
                  const n = i + 1
                  const unsure = line.confidence !== null && line.confidence < threshold
                  return (
                    <li key={n} data-testid="try-text-line" data-line={n} data-unsure={unsure || undefined}
                        data-active={hover === n || undefined}
                        onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(null)}
                        className={`flex gap-2.5 border-b border-line px-2 py-1.5 ${
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
            <img src={s.url} alt="" className="h-full w-full object-cover" />
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
