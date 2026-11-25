import { useState } from 'react'
import { handInPage, reviewPage, takeReviewBack } from '../../api'
import type { PageReview as Review, ReviewState } from '../../api'
import { formatDate } from '../../util'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Badge } from '../ui/Badge'
import type { Tone } from '../ui/Badge'
import { Button } from '../ui/Button'

const SHOWN: Record<Exclude<ReviewState, null>, { label: string; tone: Tone; verb: string }> = {
  handed_in: { label: 'Handed in', tone: 'accent', verb: 'Handed in by' },
  signed_off: { label: 'Signed off', tone: 'ok', verb: 'Signed off by' },
  sent_back: { label: 'Sent back', tone: 'warn', verb: 'Sent back by' },
}

interface PageReviewProps {
  pageId: number
  review: Review
  /** The page is assigned to the person looking at it, who hands it in. */
  mine: boolean
  /** Somebody has the page, so a Reviewer can send it back to them. */
  assigned: boolean
  canReview: boolean
  /** Lines on the page still waiting for a check, which a sign-off waits for. */
  unchecked: number
  onChange: (review: Review) => void
  onError: (message: string) => void
}

/** Where the page stands in review, and what the person looking at it can do about it (#36):
 *  its assignee hands it in, a Reviewer signs it off or sends it back with a note. A row atop
 *  the page's lines, which a sign-off waits on; nothing at all for whoever has neither to do. */
export function PageReview({ pageId, review, mine, assigned, canReview, unchecked, onChange, onError }: PageReviewProps) {
  const [busy, setBusy] = useState(false)
  const [sendingBack, setSendingBack] = useState(false)
  const { state } = review
  if (!state && !mine && !canReview) return null

  const act = async (call: () => Promise<Review>) => {
    setBusy(true)
    try {
      onChange(await call())
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const notChecked = `${unchecked} line${unchecked === 1 ? '' : 's'} on this page ${
    unchecked === 1 ? 'is' : 'are'} not checked yet`
  const signOff = () => (unchecked > 0 ? onError(notChecked) : act(() => reviewPage(pageId, 'signed_off')))
  const answerable = canReview && (state === null || state === 'handed_in')

  const shown = state && SHOWN[state]
  return (
    <div data-testid="page-review" data-state={state ?? 'none'}
         className="mb-2 flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-line pb-2">
      {shown ? (
        <Badge tone={shown.tone} title={`${shown.verb} ${review.by}, ${formatDate(review.at ?? '')}`}>
          <span data-testid="page-review-label">{shown.label}</span>
        </Badge>
      ) : (
        <span className="text-[11px] text-ink-subtle">
          {mine ? 'Yours to hand in' : assigned ? 'Not handed in' : 'Not signed off'}
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        {answerable && unchecked > 0 && (
          <span data-testid="page-review-unchecked" className="whitespace-nowrap text-[11px] text-warn">
            {unchecked} unchecked
          </span>
        )}
        {mine && (state === null || state === 'sent_back') && (
          <Button size="xs" variant="primary" disabled={busy} onClick={() => act(() => handInPage(pageId, true))}
                  title="Say the page is done, for a Reviewer to sign off">
            Hand in
          </Button>
        )}
        {mine && state === 'handed_in' && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(() => handInPage(pageId, false))}
                  title="Take the hand-in back to go on working on the page">
            Take back
          </Button>
        )}
        {answerable && state === 'handed_in' && assigned && (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => setSendingBack(true)}>
            Send back…
          </Button>
        )}
        {answerable && (
          <Button size="xs" variant={state === 'handed_in' && unchecked === 0 ? 'primary' : 'outline'} disabled={busy}
                  onClick={signOff} title={unchecked > 0 ? notChecked : 'Every line is checked: sign the page off'}>
            Sign off
          </Button>
        )}
        {canReview && (state === 'signed_off' || state === 'sent_back') && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(() => takeReviewBack(pageId))}
                  title={state === 'signed_off' ? 'Take the sign-off back' : 'Take the send-back back'}>
            Undo
          </Button>
        )}
      </span>
      {review.note && (
        <p className="w-full whitespace-pre-wrap text-xs text-ink">
          <span className="text-ink-subtle">{review.by}: </span>
          <span data-testid="page-review-note">{review.note}</span>
        </p>
      )}
      {sendingBack && (
        <SendBackDialog onClose={() => setSendingBack(false)}
                        onSend={async (note) => onChange(await reviewPage(pageId, 'sent_back', note))} />
      )}
    </div>
  )
}

function SendBackDialog({ onSend, onClose }: { onSend: (note: string) => Promise<void>; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSend(note)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Send the page back" onClose={onClose}>
      <p className="mb-2 text-sm text-ink-muted">
        Its assignee sees your note above the page&apos;s lines. Every edit and check made on it stays.
      </p>
      <textarea
        aria-label="What is to be done"
        autoFocus
        rows={4}
        maxLength={2000}
        value={note}
        placeholder="What is to be done on the page"
        onChange={(e) => setNote(e.target.value)}
        className="mb-3 w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none"
      />
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button disabled={busy || !note.trim()} onClick={() => void send()} className={modalPrimaryBtn}>Send back</button>
      </div>
    </Modal>
  )
}
