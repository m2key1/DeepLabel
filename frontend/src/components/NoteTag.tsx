import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { Note } from '../api'
import { formatDate } from '../util'
import { NoteIcon } from './icons'
import { Modal, modalBtn, modalDangerBtn, modalPrimaryBtn } from './Modal'

/** A dataset's or a page's shared note: a small tag that opens it. Editors can add one
 *  where `addable`, from a faint dashed "+ Note"; everywhere else the tag shows only once there
 *  is a note. */
export function NoteTag({ note, title, canEdit, addable = false, compact = false, onSave }: {
  note: Note | null | undefined
  /** What the note is on, as the dialog's title says it. */
  title: string
  canEdit: boolean
  addable?: boolean
  /** Only the icon, for a row whose name needs the room; otherwise the first words too. */
  compact?: boolean
  onSave: (text: string) => Promise<Note | null>
}) {
  const [open, setOpen] = useState(false)
  if (!note && !(canEdit && addable)) return null
  return (
    // The tag sits in clickable rows, and the dialog's events bubble through the portal.
    <span onClick={(e) => e.stopPropagation()} className="inline-flex min-w-0">
      <button
        data-testid={note ? 'note-tag' : 'note-add'}
        aria-label={note ? 'Note' : 'Add note'}
        title={note ? 'Show the note' : 'Add a note others can read'}
        onClick={() => setOpen(true)}
        className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full ${compact ? 'p-1' : 'px-2 py-0.5'} text-[11px] font-medium ${note
          ? 'bg-note-wash text-note hover:brightness-95'
          : 'border border-dashed border-line-strong text-ink-subtle hover:border-note hover:text-note'}`}
      >
        <NoteIcon />
        {note ? !compact && <span className="max-w-[14rem] truncate">{note.text.split('\n')[0]}</span> : '+ Note'}
      </button>
      {open && createPortal(
        <span onClick={(e) => e.stopPropagation()}>
          <NoteDialog note={note ?? null} title={title} canEdit={canEdit} onSave={onSave}
                      onClose={() => setOpen(false)} />
        </span>,
        document.body)}
    </span>
  )
}

function NoteDialog({ note, title, canEdit, onSave, onClose }: {
  note: Note | null
  title: string
  canEdit: boolean
  onSave: (text: string) => Promise<Note | null>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<string | null>(note ? null : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (text: string) => {
    setBusy(true)
    setError(null)
    try {
      await onSave(text)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Note on ${title}`} onClose={onClose}>
      {draft === null ? (
        <>
          <p data-testid="note-text" className="mb-1 whitespace-pre-wrap text-sm text-ink">{note?.text}</p>
          <p data-testid="note-by" className="mb-4 text-xs text-ink-subtle">
            {note?.by}, {note && formatDate(note.at)}
          </p>
        </>
      ) : (
        <textarea
          data-testid="note-input"
          aria-label="Note"
          autoFocus
          rows={5}
          maxLength={10000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="mb-3 w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none"
        />
      )}
      {error && <p data-testid="dialog-error" className="mb-2 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {draft === null ? (
          <>
            <button onClick={onClose} className={modalBtn}>Close</button>
            {canEdit && (
              <button onClick={() => setDraft(note?.text ?? '')} className={modalPrimaryBtn}>Edit</button>
            )}
          </>
        ) : (
          <>
            {note && (
              <button disabled={busy} onClick={() => save('')} className={`${modalDangerBtn} mr-auto`}>
                Remove
              </button>
            )}
            <button onClick={onClose} className={modalBtn}>Cancel</button>
            <button disabled={busy || !draft.trim() || draft.trim() === note?.text}
                    onClick={() => save(draft)} className={`${modalPrimaryBtn} disabled:opacity-40`}>
              Save
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
