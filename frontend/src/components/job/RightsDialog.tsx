import { useEffect, useState } from 'react'
import { NOT_EVALUATED, getJobRights, getRightsStatements, putJobRights } from '../../api'
import type { JobRights, RightsField, RightsStatement } from '../../api'
import { formatDate } from '../../util'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Badge, ChipButton } from '../ui/Badge'
import { Input, Select, Textarea } from '../ui/Field'

const FIELD_LABELS: Record<RightsField, string> = {
  status: 'Rights', credit: 'Credit line', holder: 'Rights holder', source: 'Source', note: 'Note',
  transcription_licence: 'Licence of the transcriptions',
}
const TEXT_FIELDS = ['credit', 'holder', 'source'] as const

let statementsOnce: Promise<RightsStatement[]> | null = null
function useStatements(): RightsStatement[] {
  const [statements, setStatements] = useState<RightsStatement[]>([])
  useEffect(() => {
    statementsOnce ??= getRightsStatements().then((found) => found.statements)
    statementsOnce.then(setStatements).catch(() => { statementsOnce = null })
  }, [])
  return statements
}

/** A dataset's rights on its title: amber while nobody has evaluated them, the statement once
 *  somebody has, and everything about them a click away. */
export function RightsChip({ jobId, status, canEdit, onChanged }: {
  jobId: string
  status: string | null
  canEdit: boolean
  onChanged: (status: string | null) => void
}) {
  const statements = useStatements()
  const [open, setOpen] = useState(false)
  const unknown = status === null || status === NOT_EVALUATED
  const label = statements.find((s) => s.uri === status)?.label
  return (
    <>
      <ChipButton data-testid="job-rights" tone={unknown ? 'warn' : 'neutral'} caret onClick={() => setOpen(true)}
                  title="The rights of the scans and the licence of the transcriptions">
        {unknown ? 'Rights not evaluated' : label ?? 'Rights'}
      </ChipButton>
      {open && (
        <RightsDialog jobId={jobId} canEdit={canEdit} statements={statements} onClose={() => setOpen(false)}
                      onChanged={onChanged} />
      )}
    </>
  )
}

function RightsDialog({ jobId, canEdit, statements, onClose, onChanged }: {
  jobId: string
  canEdit: boolean
  statements: RightsStatement[]
  onClose: () => void
  onChanged: (status: string | null) => void
}) {
  const [held, setHeld] = useState<JobRights | null>(null)
  const [draft, setDraft] = useState<Partial<Record<RightsField, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    getJobRights(jobId).then(setHeld).catch((e: Error) => setError(e.message))
  }, [jobId])

  const value = (field: RightsField) => draft[field] ?? (held?.[field] as string | null) ?? ''
  const put = (field: RightsField, next: string) => setDraft({ ...draft, [field]: next })
  const changed = Object.fromEntries(Object.entries(draft).filter(([field, next]) =>
    next !== ((held?.[field as RightsField] as string | null) ?? ''))) as Partial<Record<RightsField, string>>
  const named = (uri: string | null) => (uri ? statements.find((s) => s.uri === uri)?.label ?? uri : '-')
  const shown = (field: RightsField, raw: string | null) =>
    field === 'status' || field === 'transcription_licence' ? named(raw) : raw || '-'
  const label = (field: RightsField) => (
    <span className="flex items-center gap-1.5">
      {FIELD_LABELS[field]}
      {held?.imported.includes(field) && <Badge data-testid="rights-imported">from the import</Badge>}
    </span>
  )

  const save = () => {
    setBusy(true)
    setError(null)
    putJobRights(jobId, changed).then((next) => {
      setHeld(next)
      setDraft({})
      onChanged(next.status)
    }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }

  return (
    <Modal title="Rights" width="lg" onClose={onClose}>
      {!held && !error && <p className="text-sm text-ink-muted">Loading…</p>}
      {held && (
        <div className="space-y-4 text-sm" data-testid="rights-dialog">
          <fieldset className="space-y-2" disabled={!canEdit || busy}>
            <legend className="mb-1 font-semibold text-ink">The scans</legend>
            <label className="block">
              {label('status')}
              <Select size="sm" className="mt-1 w-full" data-testid="rights-status" aria-label="Rights"
                      value={value('status')} onChange={(e) => put('status', e.target.value)}>
                <option value="" disabled>Not evaluated yet - choose one</option>
                {statements.map((s) => <option key={s.uri} value={s.uri}>{s.label}</option>)}
              </Select>
            </label>
            {TEXT_FIELDS.map((field) => (
              <label key={field} className="block">
                {label(field)}
                <Input size="sm" className="mt-1 w-full" data-testid={`rights-${field}`} aria-label={FIELD_LABELS[field]}
                       value={value(field)} onChange={(e) => put(field, e.target.value)} />
              </label>
            ))}
            <label className="block">
              {label('note')}
              <Textarea size="sm" className="mt-1 w-full" rows={2} data-testid="rights-note" aria-label="Note"
                        placeholder="A contract, a permission, what is not allowed"
                        value={value('note')} onChange={(e) => put('note', e.target.value)} />
            </label>
          </fieldset>
          <fieldset disabled={!canEdit || busy}>
            <legend className="mb-1 font-semibold text-ink">The transcriptions</legend>
            <label className="block">
              {label('transcription_licence')}
              <Select size="sm" className="mt-1 w-full" data-testid="rights-licence" aria-label="Licence of the transcriptions"
                      value={value('transcription_licence')} onChange={(e) => put('transcription_licence', e.target.value)}>
                <option value="" disabled>Not given - choose one</option>
                {statements.map((s) => <option key={s.uri} value={s.uri}>{s.label}</option>)}
              </Select>
            </label>
          </fieldset>
          {held.history.length > 0 && (
            <section>
              <h3 className="mb-1 font-semibold text-ink">Changes</h3>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-ink-muted" data-testid="rights-history">
                {held.history.map((h, i) => (
                  <li key={i} data-testid="rights-change" data-field={h.field}>
                    <span className="tabular-nums">{formatDate(h.at)}</span> · {h.author} · {FIELD_LABELS[h.field]}:{' '}
                    <span className="text-ink">{shown(h.field, h.old)}</span> to <span className="text-ink">{shown(h.field, h.new)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>{Object.keys(changed).length > 0 ? 'Cancel' : 'Close'}</button>
        {canEdit && (
          <button data-testid="rights-save" className={modalPrimaryBtn} disabled={busy || Object.keys(changed).length === 0}
                  onClick={save}>Save</button>
        )}
      </div>
    </Modal>
  )
}
