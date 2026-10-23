import { useEffect, useRef, useState } from 'react'
import { previewAugmentation } from '../../api'
import type { AugmentPreview, AugmentSpec, ModelTask } from '../../api'
import { Button } from '../ui/Button'
import { Hint } from '../ui/Hint'
import { useAutoClear } from '../../messages'
import { cardChrome } from '../ui/Card'

const DEBOUNCE_MS = 400

/** What the stack does to real checked lines: a band across the top, each crop before the
 *  augmentation, one draw at the stack's own probabilities, and the harshest of the
 *  several draws taken. Steps fire at p 0.3 or so, so the damaging draw is rare - showing
 *  only a typical one would hide exactly what hurts training. Each spans the full width it
 *  is given, and it scrolls with the page like everything else. Re-renders as the pipeline
 *  is edited, one render per settled edit. */
export function PipelinePreview({ task, spec, jobIds }: {
  task: ModelTask
  spec: AugmentSpec
  jobIds: string[]
}) {
  // Which lines are drawn, and the roll the stack makes on them - moved separately, so
  // "does this hold elsewhere" and "was that one roll unlucky" are two different clicks.
  const [lineSeed, setLineSeed] = useState(1)
  const [renderSeed, setRenderSeed] = useState(1)
  const [preview, setPreview] = useState<AugmentPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)
  // Both are rebuilt by callers on every render, so the effect keys off their content:
  // an unchanged pipeline and dataset must not re-run a render.
  const serialised = JSON.stringify(spec)
  const datasets = jobIds.join(',')

  useEffect(() => {
    if (datasets === '') {
      // Bumped too, so a render already on its way for the datasets just cleared is dropped.
      latest.current += 1
      setBusy(false)
      setPreview(null)
      setError(null)
      return
    }
    const request = ++latest.current
    setBusy(true)
    const timer = setTimeout(() => {
      previewAugmentation({
        task, spec: JSON.parse(serialised), job_ids: datasets.split(','),
        line_seed: lineSeed, render_seed: renderSeed,
      })
        .then((result) => {
          if (request !== latest.current) return
          setPreview(result)
          setError(null)
        })
        .catch((e: Error) => {
          if (request !== latest.current) return
          setError(e.message)
          setPreview(null)
        })
        .finally(() => {
          if (request === latest.current) setBusy(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [task, serialised, datasets, lineSeed, renderSeed])

  const message = error ?? (preview && !preview.ok ? preview.error : null)

  return (
    <div data-testid="pipeline-preview"
         className={`${cardChrome}`}>
      <div className="flex flex-wrap items-center gap-2 px-2 pt-1.5">
        <span className="text-sm font-medium text-ink">Preview</span>
        <span className="text-xs text-ink-muted">
          {datasets === ''
            ? 'pick a dataset to see it on real lines'
            : `checked lines at the model's ${preview?.height ?? '…'} px input height`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {busy && <span className="text-xs text-ink-muted">Rendering…</span>}
          <Button
            variant="ghost"
            size="xs"
            data-testid="preview-reapply"
            title="Same lines, another random draw of this stack"
            disabled={datasets === ''}
            onClick={() => setRenderSeed((value) => value + 1)}
          >
            Reapply
          </Button>
          <Button
            variant="ghost"
            size="xs"
            data-testid="preview-change-lines"
            title="Draw a different set of checked lines from the chosen dataset"
            disabled={datasets === ''}
            onClick={() => setLineSeed((value) => value + 1)}
          >
            Change lines
          </Button>
        </span>
      </div>
      {message && (
        <p data-testid="preview-error" className="px-2 py-1 text-xs text-danger">
          {message}
        </p>
      )}
      <div className={`px-2 py-1.5 ${busy ? 'opacity-60' : ''}`}>
        {/* Wider apart between lines than within a pair, so a before and its after read
            as one thing rather than as four loose strips. */}
        <div className="space-y-4">
          {preview?.samples.map((sample) => (
            <div key={sample.line_id} data-testid="preview-sample">
              <div className="flex gap-2 text-[11px] text-ink-muted">
                <span className="truncate">{sample.dataset}</span>
                <span className="min-w-0 flex-1 truncate italic">{sample.text}</span>
              </div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                Before
              </p>
              <img src={sample.original} alt={`line ${sample.line_id} before augmentation`}
                   className="block w-full" />
              <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wide text-accent-ink">
                After
              </p>
              <img
                src={sample.augmented}
                alt={`line ${sample.line_id} after augmentation`}
                data-testid="preview-augmented"
                className="block w-full"
              />
              {sample.harshest && (
                <>
                  <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-warn">
                    Harshest of {preview?.draws ?? '…'}
                    <Hint
                      about="the harshest draw"
                      text={`Every step fires at its own probability, so most draws are mild and the damaging one is rare. This is the draw, out of ${preview?.draws ?? 'several'}, that strayed furthest from the scan - what the model sees on a bad roll.`}
                    />
                  </p>
                  <img
                    src={sample.harshest}
                    alt={`line ${sample.line_id} on its harshest draw`}
                    data-testid="preview-harshest"
                    className="block w-full"
                  />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
