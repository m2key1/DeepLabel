import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ApiError } from '../../api'
import { cutReference, type ReferencePage } from '../../lib/corpusApi'
import { displayed } from '../../lib/text'
import { Badge } from '../ui/Badge'
import { Button, Toggle } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Section } from '../ui/Section'
import { GtSource } from './GtSource'
import { Note, type NoteTone } from './Note'

// A page's score is the mean similarity of the anchors that held, so it can never fall
// below the backend's anchoring floor. Well short of a confident match is what wants eyes.
const WEAK_SCORE = 0.75

type Trouble = 'unplaced' | 'unanchored' | 'weak'

const TROUBLE: Record<Trouble, { label: string; why: string; severe: boolean }> = {
  unplaced: {
    label: 'no span',
    why: 'The cut put no corpus text on this page, so no model will be asked about it',
    severe: true,
  },
  unanchored: {
    label: 'not anchored',
    why: 'No line of this page matched the corpus. Its span is only what the pages around '
      + 'it left over, which is where a cut goes wrong quietly',
    severe: true,
  },
  weak: {
    label: 'weak anchors',
    why: 'The lines that did match agree only loosely, so the cut may sit in the wrong place',
    severe: false,
  },
}

function troubleOf(page: ReferencePage): Trouble | null {
  if (!page.document || !page.text) return 'unplaced'
  if (page.anchors === 0) return 'unanchored'
  return page.score < WEAK_SCORE ? 'weak' : null
}

// The order the review is read in. A span nothing anchored looks like any other and is
// wrong without saying so; a page with no span at all is at least plain to see.
const REVIEW_ORDER: (Trouble | null)[] = ['unanchored', 'unplaced', 'weak', null]

function inReviewOrder(pages: ReferencePage[]): ReferencePage[] {
  const rank = (page: ReferencePage) => REVIEW_ORDER.indexOf(troubleOf(page))
  return [...pages].sort((a, b) => rank(a) - rank(b))
}

function summarize(pages: ReferencePage[]): string {
  const troubles = pages.map(troubleOf)
  const count = (kind: Trouble) => troubles.filter((t) => t === kind).length
  const placed = pages.length - count('unplaced')
  const parts = (['unplaced', 'unanchored', 'weak'] as Trouble[])
    .filter((kind) => count(kind) > 0)
    .map((kind) => `${count(kind)} ${TROUBLE[kind].label}`)
  return [`${placed} of ${pages.length} pages placed`,
          ...(parts.length ? parts : ['every page anchored'])].join(' · ')
}

export function ReferenceReview({ jobId, pages, onChanged }: {
  jobId: string
  pages: ReferencePage[]
  onChanged: () => void
}) {
  const [note, setNote] = useState<{ tone: NoteTone; text: string } | null>(null)
  const [cutting, setCutting] = useState(false)
  const [troubleOnly, setTroubleOnly] = useState(false)

  const cut = async () => {
    setCutting(true)
    try {
      const outcome = await cutReference(jobId)
      setNote({
        tone: 'ok',
        text: `Placed ${outcome.placed} of ${outcome.pages} pages from `
          + `${outcome.documents} document${outcome.documents === 1 ? '' : 's'}. `
          + `${outcome.unanchored} anchored nothing of their own.`,
      })
      onChanged()
    } catch (error) {
      setNote({ tone: 'bad', text: (error as ApiError).message })
    }
    setCutting(false)
  }

  const shown = inReviewOrder(troubleOnly ? pages.filter((page) => troubleOf(page) !== null) : pages)

  return (
    <Section
      data-testid="reference-review"
      title="What each page is answerable for"
      actions={
        <div className="ml-auto flex items-center gap-2">
          <Toggle
            on={troubleOnly}
            onClick={() => setTroubleOnly((only) => !only)}
            data-testid="reference-trouble-only"
          >
            Only what needs a look
          </Toggle>
          <Button
            variant="primary"
            disabled={cutting}
            data-testid="reference-cut"
            onClick={() => void cut()}
          >
            {cutting ? 'Cutting…' : 'Cut the corpus'}
          </Button>
        </div>
      }
    >
      {note && <div className="mb-2"><Note tone={note.tone} testId="cut-note">{note.text}</Note></div>}

      {pages.length === 0 ? (
        <div data-testid="reference-empty">
          <EmptyState>This dataset has no pages to place a corpus on.</EmptyState>
        </div>
      ) : (
        <>
          <p data-testid="reference-summary" className="mb-2 text-sm text-ink-muted">
            {summarize(pages)}
          </p>
          {troubleOnly && shown.length === 0 && (
            <p data-testid="reference-all-well" className="text-sm text-ink-muted">
              Every page anchored lines of its own and agrees well with the corpus.
            </p>
          )}
          <ul className="space-y-1">
            {shown.map((page) => {
              const trouble = troubleOf(page)
              const edge = trouble === null
                ? 'border-l-line'
                : TROUBLE[trouble].severe ? 'border-l-danger' : 'border-l-warn'
              return (
                <li
                  key={page.page_id}
                  data-testid="reference-row"
                  data-page-id={page.page_id}
                  data-document={page.document ?? ''}
                  data-anchors={page.anchors}
                  data-score={page.score}
                  data-trouble={trouble ?? 'none'}
                  className={`border-l-4 ${edge} bg-raised/40 py-1 pl-2 pr-1`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Link
                      to={`/jobs/${jobId}/pages/${page.page_id}`}
                      className="text-sm font-medium text-accent-ink hover:underline"
                    >
                      {page.idx + 1}. {page.filename}
                    </Link>
                    <span data-testid="reference-document" className="text-xs text-ink-muted">
                      {page.document ?? 'no document'}
                    </span>
                    <span data-testid="reference-anchors" className="text-xs tabular-nums text-ink-subtle">
                      {page.anchors} anchored
                    </span>
                    <span data-testid="reference-score" className="text-xs tabular-nums text-ink-subtle">
                      score {page.score.toFixed(2)}
                    </span>
                    <GtSource source={page.gt_source} />
                    {trouble && (
                      <Badge
                        tone={TROUBLE[trouble].severe ? 'danger' : 'warn'}
                        data-testid="reference-trouble"
                        title={TROUBLE[trouble].why}
                      >
                        {TROUBLE[trouble].label}
                      </Badge>
                    )}
                  </div>
                  <pre
                    data-testid="reference-text"
                    className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-ocr text-xs text-ink-muted"
                  >
                    {displayed(page.text)}
                  </pre>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Section>
  )
}
