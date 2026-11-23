import { useEffect, useState } from 'react'
import { compareTraining, getLayoutEvaluationPage, getLayoutEvaluationPages, renditionUrl } from '../../api'
import type { Evaluation, LayoutBox, LayoutEvaluatedPage, LayoutScores, RegistryModel, Training } from '../../api'
import { classColor } from '../../util'
import { ChevronIcon } from '../icons'
import { Button } from '../ui/Button'
import { cardChrome } from '../ui/Card'
import { Section } from '../ui/Section'
import { ScoreChange } from '../evaluation/ScoreChange'

const percent = (value: number | null | undefined) => (value == null ? '-' : `${(value * 100).toFixed(1)}`)
const change = (after: number | null | undefined, before: number | null | undefined) =>
  after == null || before == null ? null : after - before

/** A layout run beside its base model on the pages it held out: the scores, then the pages
 *  themselves with the checked boxes and each model's. */
export function LayoutComparison({ run, model, base, evaluations, canCompare, onChange, onError }: {
  run: Training
  model: RegistryModel
  base: RegistryModel | null
  evaluations: Evaluation[]
  canCompare: boolean
  onChange: () => void
  onError: (message: string) => void
}) {
  const ofRun = evaluations.filter((ev) => ev.training_id === run.id && ev.source.split)
  const trained = ofRun.find((ev) => ev.model_id === model.id)
  const before = base ? ofRun.find((ev) => ev.model_id === base.id) : undefined
  const [asking, setAsking] = useState(false)

  if (!trained) {
    if (run.status !== 'done') return null
    return (
      <Section title="Compared with the base model" data-testid="layout-comparison">
        <p className="mb-2 text-sm text-ink-muted">
          This run finished before runs were compared with their base model.
        </p>
        {canCompare && (
          <Button size="sm" data-testid="layout-compare" disabled={asking} onClick={() => {
            setAsking(true)
            compareTraining(run.id).then(onChange).catch((e: Error) => onError(e.message)).finally(() => setAsking(false))
          }}>Compare with {base ? base.name : 'the base model'}</Button>
        )}
      </Section>
    )
  }

  const pending = [trained, before].some((ev) => ev && (ev.status === 'queued' || ev.status === 'running'))
  const failed = [trained, before].find((ev) => ev?.status === 'error')
  const scores = trained.status === 'done' ? trained.metrics as LayoutScores : null
  const baseScores = before?.status === 'done' ? before.metrics as LayoutScores : null
  const split = scores?.split ?? trained.source.split ?? 'valid'
  return (
    <Section title="Compared with the base model" data-testid="layout-comparison"
             description={split === 'test'
               ? `${base?.name ?? 'The base model'} and this run's model, on the test pages the run never saw.`
               : `${base?.name ?? 'The base model'} and this run's model, on the validation pages the run was checked `
                 + 'against while it trained. Those pages also chose the epoch it kept, so these scores read a little kind.'}>
      {pending && <p data-testid="layout-comparison-pending" className="text-sm text-ink-muted">Both models are reading the pages…</p>}
      {failed && <p role="alert" className="text-sm text-danger">{failed.error}</p>}
      {scores && (
        <>
          <div className={`overflow-x-auto ${cardChrome}`}>
            <table data-testid="layout-comparison-scores" className="w-full whitespace-nowrap text-xs">
              <thead className="text-left text-ink-subtle">
                <tr>
                  <th className="p-2 font-normal">class</th>
                  <th className="p-2 text-right font-normal">boxes</th>
                  <th className="p-2 text-right font-normal">base AP50</th>
                  <th className="p-2 text-right font-normal">this run AP50</th>
                  <th className="p-2 text-right font-normal">base AP50-95</th>
                  <th className="p-2 text-right font-normal">this run AP50-95</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                <tr data-testid="layout-comparison-row" data-class="all" className="border-t border-line font-semibold">
                  <td className="p-2 font-sans">all classes</td>
                  <td className="p-2 text-right">{scores.truth}</td>
                  <ScoreCells base={baseScores?.mAP_50} trained={scores.mAP_50} at="50" />
                  <ScoreCells base={baseScores?.mAP_50_95} trained={scores.mAP_50_95} at="50-95" />
                </tr>
                {Object.entries(scores.per_class).map(([name, row]) => {
                  const was = baseScores?.per_class[name]
                  return (
                    <tr key={name} data-testid="layout-comparison-row" data-class={name} className="border-t border-line">
                      <td className="p-2 font-sans">
                        <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: classColor(name) }} />
                        {name}
                      </td>
                      <td className="p-2 text-right">{row.truth}</td>
                      <ScoreCells base={was?.ap_50} trained={row.ap_50} at="50" />
                      <ScoreCells base={was?.ap_50_95} trained={row.ap_50_95} at="50-95" />
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <ComparedPages trained={trained} before={before?.status === 'done' ? before : undefined}
                         baseName={base?.name ?? 'Base model'} onError={onError} />
        </>
      )}
    </Section>
  )
}

/** One IoU's pair of cells: the base model's score, then the trained model's with its change. */
function ScoreCells({ base, trained, at }: { base: number | null | undefined; trained: number | null; at: string }) {
  return (
    <>
      <td data-score={`base-${at}`} className="p-2 text-right">{percent(base)}</td>
      <td className="p-2 text-right">
        <span data-score={`trained-${at}`}>{percent(trained)}</span>
        <ScoreChange change={change(trained, base)} higherIsBetter digits={1} />
      </td>
    </>
  )
}

/** The held-out pages one at a time, worst first for the trained model: the checked boxes,
 *  the base model's and the trained model's, side by side. */
function ComparedPages({ trained, before, baseName, onError }: {
  trained: Evaluation
  before: Evaluation | undefined
  baseName: string
  onError: (message: string) => void
}) {
  const [pages, setPages] = useState<LayoutEvaluatedPage[]>([])
  const [at, setAt] = useState(0)
  const [shown, setShown] = useState<{ truth: LayoutBox[]; trained: LayoutBox[]; base: LayoutBox[] | null;
                                       trainedScore: number | null; baseScore: number | null } | null>(null)
  useEffect(() => {
    getLayoutEvaluationPages(trained.id).then((r) => setPages(r.pages.filter((p) => p.page_id !== null)))
      .catch((e: Error) => onError(e.message))
  }, [trained.id, onError])
  // The list can shrink under the stepper when a page is deleted between polls.
  const index = Math.min(at, pages.length - 1)
  const page = pages[index]
  const pageId = page?.page_id ?? null
  const beforeId = before?.id ?? null
  useEffect(() => {
    if (pageId === null) return
    setShown(null)
    Promise.all([getLayoutEvaluationPage(trained.id, pageId),
                 beforeId !== null ? getLayoutEvaluationPage(beforeId, pageId).catch(() => null) : Promise.resolve(null)])
      .then(([mine, theirs]) => setShown({ truth: mine.boxes.truth, trained: mine.boxes.found, base: theirs?.boxes.found ?? null,
                                           trainedScore: mine.map_50, baseScore: theirs?.map_50 ?? null }))
      .catch((e: Error) => onError(e.message))
  }, [trained.id, beforeId, pageId, onError])
  if (!page || pageId === null) return null
  const step = (by: number) => setAt((now) => (Math.min(now, pages.length - 1) + by + pages.length) % pages.length)
  return (
    <div data-testid="layout-compared-pages" className="mt-4">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <Button size="xs" variant="ghost" aria-label="Previous page" data-testid="compared-page-prev" onClick={() => step(-1)}>
          <ChevronIcon dir="left" />
        </Button>
        <span data-testid="compared-page-at" className="tabular-nums text-ink-muted">
          page {index + 1} of {pages.length}
        </span>
        <Button size="xs" variant="ghost" aria-label="Next page" data-testid="compared-page-next" onClick={() => step(1)}>
          <ChevronIcon dir="right" />
        </Button>
        <span className="truncate text-xs text-ink-subtle">{page.filename}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <BoxedPage pageId={pageId} title="Checked" boxes={shown?.truth} testId="compared-page-truth" />
        <BoxedPage pageId={pageId} title={baseName} boxes={shown?.base ?? undefined} score={shown?.baseScore}
                   testId="compared-page-base" />
        <BoxedPage pageId={pageId} title="This run" boxes={shown?.trained} score={shown?.trainedScore}
                   testId="compared-page-trained" />
      </div>
    </div>
  )
}

function BoxedPage({ pageId, title, boxes, score, testId }: {
  pageId: number
  title: string
  boxes: LayoutBox[] | undefined
  score?: number | null
  testId: string
}) {
  return (
    <figure data-testid={testId} data-boxes={boxes?.length ?? ''} className="min-w-0">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="truncate font-medium text-ink">{title}</span>
        {score !== undefined && <span className="font-mono tabular-nums text-ink-muted">AP50 {percent(score)}</span>}
      </figcaption>
      <div className="relative overflow-hidden rounded border border-line bg-ground">
        <img src={renditionUrl(pageId, 'screen')} alt="" className="block w-full" />
        {boxes && (
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 size-full">
            {boxes.map((box, i) => (
              <rect key={i} x={box.bbox[0]} y={box.bbox[1]} width={box.bbox[2] - box.bbox[0]} height={box.bbox[3] - box.bbox[1]}
                    fill={classColor(box.class, 0.12)} stroke={classColor(box.class)} strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
        )}
      </div>
    </figure>
  )
}
