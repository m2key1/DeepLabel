import { useState } from 'react'
import { assignPages } from '../../api'
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

interface AssignPagesDialogProps {
  job: JobWithoutPages
  onClose: () => void
  /** After each change, so the page table behind the dialog shows it at once. */
  onChanged: () => void
}

/** A Manager hands out the dataset's pages by number, a range at a time (#137). */
export function AssignPagesDialog({ job, onClose, onChanged }: AssignPagesDialogProps) {
  const { assignments, setAssignments, accounts, assignable, error, setError } = useAssignments(job.id, true)
  const [pages, setPages] = useState('')
  const [to, setTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const assignee = to ?? assignable[0]?.username ?? NOBODY
  const lastPage = assignments
    ? Math.max(0, ...assignments.unassigned, ...assignments.people.flatMap((p) => p.pages)) : 0

  const assign = async () => {
    const numbers = parseRanges(pages, lastPage)
    if (!numbers) return setError(`Write page numbers from 1 to ${lastPage}, or ranges, like 1-40, 52`)
    setBusy(true)
    try {
      setAssignments(await assignPages(job.id, assignee || null, { numbers: [...numbers] }))
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
