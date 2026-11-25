import { useState } from 'react'
import { handInPage, reviewPage, takeReviewBack } from '../../api'
import type { PageKeying, PageReview as Review, ReviewState } from '../../api'
import { formatDate } from '../../util'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Badge } from '../ui/Badge'
import type { Tone } from '../ui/Badge'
import { Button } from '../ui/Button'

const SHOWN: Record<Exclude<ReviewState, null>, { label: string; tone: Tone; verb: string }> = {
  partly_handed_in: { label: '1 of 2 handed in', tone: 'neutral', verb: 'Handed in by' },
  handed_in: { label: 'Handed in', tone: 'accent', verb: 'Handed in by' },
  signed_off: { label: 'Signed off', tone: 'ok', verb: 'Signed off by' },
  sent_back: { label: 'Sent back', tone: 'warn', verb: 'Sent back by' },
}

interface PageReviewProps {
  pageId: number
  review: Review
  /** Who keys a double-keyed page (#37); null where it is keyed once. */
  keying: PageKeying | null
  /** The person looking at it. */
  me: string
  /** Whom the page is assigned to: its one assignee, or its keyers. */
  assignees: string[]
  canReview: boolean
  /** Lines on the page still waiting for a check, which a sign-off waits for. */
  unchecked: number
  onChange: (review: Review) => void
  onError: (message: string) => void
}

/** Where the page stands in review, and what the person looking at it can do about it (#36):
 *  its assignee hands it in, a Reviewer signs it off or sends it back with a note. A row atop
 *  the page's lines, which a sign-off waits on; nothing at all for whoever has neither to do.
 *
 *  A double-keyed page (#37) is handed in by each of its two keyers, and only then reviewed;
 *  its Reviewer settles what they disagree on rather than sending it back. */
export function PageReview({
  pageId, review, keying, me, assignees, canReview, unchecked, onChange, onError,
}: PageReviewProps) {
  const [busy, setBusy] = useState(false)
  const [sendingBack, setSendingBack] = useState(false)
  const { state } = review
  const mine = assignees.includes(me)
  const assigned = assignees.length > 0
  const beingKeyed = keying?.open ?? false
  const handedIn = keying ? keying.handed_in.includes(me) : state === 'handed_in'
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
  const answerable = canReview && !beingKeyed && (state === null || state === 'handed_in')
  const handable = keying ? beingKeyed : state !== 'signed_off'
  const otherKeyer = keying?.keyers.find((name) => name !== me)

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
          {mine ? (keying ? 'Yours to key' : 'Yours to hand in')
            : assigned ? (keying ? 'Being keyed' : 'Not handed in') : 'Not signed off'}
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        {answerable && unchecked > 0 && (
          <span data-testid="page-review-unchecked" className="whitespace-nowrap text-[11px] text-warn">
            {unchecked} unchecked
          </span>
        )}
        {mine && handable && !handedIn && (state === null || state === 'sent_back' || state === 'partly_handed_in') && (
          <Button size="xs" variant="primary" disabled={busy} onClick={() => act(() => handInPage(pageId, true))}
                  title="Say the page is done, for a Reviewer to sign off">
            Hand in
          </Button>
        )}
        {mine && handable && handedIn && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(() => handInPage(pageId, false))}
                  title="Take the hand-in back to go on working on the page">
            Take back
          </Button>
        )}
        {answerable && state === 'handed_in' && assigned && !keying && (
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
      {mine && beingKeyed && (
        <p data-testid="keying-hint" className="w-full text-[11px] text-ink-subtle">
          {otherKeyer
            ? `${otherKeyer} keys this page too. Neither of you sees the other's text until both have handed it in.`
            : 'Nobody keys this page with you yet. It is compared once a second keyer has handed it in too.'}
        </p>
      )}
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
