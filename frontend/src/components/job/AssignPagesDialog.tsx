import { useState } from 'react'
import { assignPages, setKeying } from '../../api'
import type { JobWithoutPages, Role, UserName } from '../../api'
import { ROLE_LABEL } from '../../lib/roles'
import { Modal, modalPrimaryBtn } from '../Modal'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Field'
import { useAssignments } from './assignments'
import { formatRanges, parseRanges } from './PagePicker'

const NOBODY = ''

/** The role someone works with on this dataset: its creator manages it, and an Annotator or
 *  Reviewer may have been made the other role on it alone. */
function roleHere(job: JobWithoutPages, account: UserName): Role {
  if (account.role === 'admin' || account.role === 'viewer') return account.role
  if (account.username === job.owner) return 'manager'
  return job.roles?.[account.username] ?? account.role
}

type Keying = Pick<JobWithoutPages, 'double_keying' | 'keying_from_empty'>

interface AssignPagesDialogProps {
  job: JobWithoutPages
  /** The pages it opens on, as ranges. */
  pages?: string
  onClose: () => void
  /** After each change, so the page table behind the dialog shows it at once. */
  onChanged: () => void
  /** After double-keying is switched, so the dataset shows it. */
  onKeying: (keying: Keying) => void
}

/** A Manager hands out the dataset's pages by number, a range at a time (#137), to one person
 *  each or, double-keying, to two (#37). */
export function AssignPagesDialog({ job, pages: opened = '', onClose, onChanged, onKeying }: AssignPagesDialogProps) {
  const { assignments, setAssignments, accounts, assignable, error, setError } = useAssignments(job.id, true)
  const [pages, setPages] = useState(opened)
  const [to, setTo] = useState<string | null>(null)
  const [alsoTo, setAlsoTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [keying, setKeyingShown] = useState<Keying>(
    { double_keying: job.double_keying ?? false, keying_from_empty: job.keying_from_empty ?? false })
  const assignee = to ?? assignable[0]?.username ?? NOBODY
  const others = assignable.filter((a) => a.username !== assignee)
  const second = keying.double_keying && assignee !== NOBODY
    ? (alsoTo !== null && alsoTo !== assignee ? alsoTo : others[0]?.username ?? NOBODY)
    : NOBODY

  // Shown at once, and put back if the server refuses it.
  const switchKeying = async (next: Keying) => {
    const before = keying
    setKeyingShown(next)
    try {
      await setKeying(job.id, next.double_keying ?? false, next.keying_from_empty ?? false)
      onKeying(next)
      setError(null)
    } catch (e) {
      setKeyingShown(before)
      setError((e as Error).message)
    }
  }
  const lastPage = assignments
    ? Math.max(0, ...assignments.unassigned, ...assignments.people.flatMap((p) => p.pages)) : 0

  const assign = async () => {
    const numbers = parseRanges(pages, lastPage)
    if (!numbers) return setError(`Write page numbers from 1 to ${lastPage}, or ranges, like 1-40, 52`)
    setBusy(true)
    try {
      setAssignments(await assignPages(job.id, assignee || null, { numbers: [...numbers] }, second || null))
      setPages('')
      setError(null)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const held = assignments?.people.filter((p) => p.pages.length > 0 || assignable.some((a) => a.username === p.username))
  return (
    <Modal title={`Assign pages of "${job.name}"`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        An Annotator&apos;s page table lists only the pages handed to them and the ones nobody has, and
        Next in the page viewer takes each person on to their own next page.
      </p>
      <fieldset data-testid="double-keying" className="mb-4 rounded-md border border-line px-3 py-2 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" className="cursor-pointer accent-accent" checked={keying.double_keying ?? false}
                 onChange={(e) => void switchKeying({ ...keying, double_keying: e.target.checked })} />
          Two people key each page
        </label>
        {keying.double_keying && (
          <>
            <p className="mt-1 text-xs text-ink-muted">
              Neither sees the other&apos;s text until both have handed the page in. Then the lines they
              typed alike are checked, and a Reviewer settles the rest. Keyers type text only; the boxes and
              lines stay as they are.
            </p>
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="cursor-pointer accent-accent" checked={keying.keying_from_empty ?? false}
                     onChange={(e) => void switchKeying({ ...keying, keying_from_empty: e.target.checked })} />
              Keyers start from empty lines
            </label>
            <p className="mt-1 text-xs text-ink-muted">
              {keying.keying_from_empty
                ? 'Fully independent: neither keyer sees what the lines were read as.'
                : 'Faster: both start from the recognised text, so a misreading both overlook is checked.'}
            </p>
          </>
        )}
      </fieldset>
      <form className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => { e.preventDefault(); void assign() }}>
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-ink-muted">
          Pages
          <Input size="md" value={pages} onChange={(e) => setPages(e.target.value)} placeholder="e.g. 1-40, 52"
                 className="w-full" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          To
          <Select size="md" aria-label="Assign to" value={assignee} onChange={(e) => setTo(e.target.value)}>
            {assignable.map((a) => <option key={a.username} value={a.username}>{a.display_name || a.username}</option>)}
            <option value={NOBODY}>Nobody</option>
          </Select>
        </label>
        {keying.double_keying && assignee !== NOBODY && (
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            and
            <Select size="md" aria-label="Second keyer" value={second} onChange={(e) => setAlsoTo(e.target.value)}>
              {others.map((a) => <option key={a.username} value={a.username}>{a.display_name || a.username}</option>)}
              <option value={NOBODY}>Nobody yet</option>
            </Select>
          </label>
        )}
        <Button type="submit" variant="primary" size="md" disabled={busy || !pages.trim() || !assignments}>Assign</Button>
      </form>
      <ul data-testid="assignments" className="mt-4 divide-y divide-line">
        {!assignments && !error && <li className="py-1.5 text-sm text-ink-subtle">Loading…</li>}
        {held?.map((person) => {
          const account = accounts?.get(person.username)
          return (
            <li key={person.username} data-testid="assignment" data-username={person.username}
                className="flex items-center gap-2 py-1.5">
              <Avatar name={person.username} displayName={account?.display_name} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{account?.display_name || person.username}</span>
                <span className="text-xs text-ink-subtle">
                  {account ? ROLE_LABEL[roleHere(job, account)] : 'No account any more'}
                </span>
              </span>
              <Handed pages={person.pages} />
            </li>
          )
        })}
        {assignments && (
          <li data-testid="assignment-unassigned" className="flex items-center gap-2 py-1.5">
            <span className="h-6 w-6 shrink-0 rounded-full border border-dashed border-line-strong" aria-hidden />
            <span className="flex-1 text-sm text-ink-muted">Nobody</span>
            <Handed pages={assignments.unassigned} />
          </li>
        )}
      </ul>
      <div className="mt-4 flex items-center justify-end gap-3">
        {error && <p role="alert" className="mr-auto text-sm text-danger">{error}</p>}
        <button onClick={onClose} className={modalPrimaryBtn}>Done</button>
      </div>
    </Modal>
  )
}

function Handed({ pages }: { pages: number[] }) {
  return (
    <span className="flex shrink-0 flex-col items-end">
      <span data-testid="assignment-pages" className="max-w-56 truncate text-sm tabular-nums"
            title={formatRanges(pages)}>
        {pages.length ? formatRanges(pages) : '-'}
      </span>
      <span className="text-xs text-ink-subtle">{pages.length} page{pages.length === 1 ? '' : 's'}</span>
    </span>
  )
}
