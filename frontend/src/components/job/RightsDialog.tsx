import { useEffect, useState } from 'react'
import {
  NOT_EVALUATED, getJobRights, getPageRights, permitTraining, putJobRights, putPagesRights, refreshJobRights,
} from '../../api'
import type {
  JobRights, PageRights, PageRightsField, PageRightsFields, RightsChange, RightsField, RightsStatement,
} from '../../api'
import { formatDate } from '../../util'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Badge, ChipButton } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Check, Input, Select, Textarea } from '../ui/Field'
import { useStatements } from './rightsStatements'

const FIELD_LABELS: Record<RightsField, string> = {
  status: 'Rights', credit: 'Credit line', holder: 'Rights holder', source: 'Source', note: 'Note',
  transcription_licence: 'Licence of the transcriptions',
}
const TEXT_FIELDS = ['credit', 'holder', 'source'] as const
const PAGE_FIELDS: PageRightsField[] = ['status', 'credit', 'holder', 'source', 'note']
const EMPTY_PAGE: PageRightsFields = { status: '', credit: '', holder: '', source: '', note: '' }

const labelOf = (statements: RightsStatement[], uri: string | null) =>
  (uri ? statements.find((s) => s.uri === uri)?.label ?? uri : null)

const unevaluated = (status: string | null) => status === null || status === NOT_EVALUATED

/** A dataset's rights on its title: amber while nobody has evaluated them, the statement once
 *  somebody has, and everything about them a click away. */
export function RightsChip({ jobId, status, canEdit, isOwner, fromIiif, onChanged }: {
  jobId: string
  status: string | null
  canEdit: boolean
  /** Only the owner gives the word that training on restricted material is permitted. */
  isOwner: boolean
  /** A dataset made from a IIIF manifest can read it again. */
  fromIiif: boolean
  onChanged: (status: string | null) => void
}) {
  const statements = useStatements()
  const [open, setOpen] = useState(false)
  return (
    <>
      <ChipButton data-testid="job-rights" tone={unevaluated(status) ? 'warn' : 'neutral'} caret onClick={() => setOpen(true)}
                  title="The rights of the scans and the licence of the transcriptions">
        {unevaluated(status) ? 'Rights not evaluated' : labelOf(statements, status) ?? 'Rights'}
      </ChipButton>
      {open && (
        <RightsDialog jobId={jobId} canEdit={canEdit} isOwner={isOwner} fromIiif={fromIiif} statements={statements}
                      onClose={() => setOpen(false)} onChanged={onChanged} />
      )}
    </>
  )
}

/** The fields that describe the scans, shared by a dataset's rights and a page's own. */
function ScansFields({ value, put, statements, imported, disabled }: {
  value: (field: PageRightsField) => string
  put: (field: PageRightsField, next: string) => void
  statements: RightsStatement[]
  imported: string[]
  disabled: boolean
}) {
  const label = (field: PageRightsField) => (
    <span className="flex items-center gap-1.5">
      {FIELD_LABELS[field]}
      {imported.includes(field) && <Badge data-testid="rights-imported">from the import</Badge>}
    </span>
  )
  return (
    <fieldset className="space-y-2" disabled={disabled}>
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
  )
}

/** Every change, newest first. A page's field emptied went back to its dataset's. */
function RightsHistory({ history, statements, emptied = '-' }: {
  history: RightsChange[]
  statements: RightsStatement[]
  emptied?: string
}) {
  if (history.length === 0) return null
  const shown = (field: RightsField, raw: string | null) =>
    (raw === null || raw === '' ? emptied
      : field === 'status' || field === 'transcription_licence' ? labelOf(statements, raw) ?? raw : raw)
  return (
    <section>
      <h3 className="mb-1 font-semibold text-ink">Changes</h3>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-ink-muted" data-testid="rights-history">
        {history.map((h, i) => (
          <li key={i} data-testid="rights-change" data-field={h.field}>
            <span className="tabular-nums">{formatDate(h.at)}</span> · {h.author} ·{' '}
            {h.field === 'training' ? 'confirmed that training is permitted' : (
              <>
                {FIELD_LABELS[h.field]}: <span className="text-ink">{shown(h.field, h.old)}</span> to{' '}
                <span className="text-ink">{shown(h.field, h.new)}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Whether training on the material waits for its owner's word: a research exception or a
 *  contract may permit it, and only the owner knows which applies. */
function TrainingPermission({ held, isOwner, busy, onPermit }: {
  held: JobRights
  isOwner: boolean
  busy: boolean
  onPermit: () => void
}) {
  if (!held.training.restrictive) return null
  const permitted = held.training.permitted
  return (
    <section data-testid="rights-training"
             className={`rounded border px-3 py-2 ${permitted ? 'border-line bg-raised' : 'border-warn/40 bg-warn/5'}`}>
      <h3 className="font-semibold text-ink">Training</h3>
      {permitted ? (
        <p className="mt-0.5 text-ink-muted">
          Training permitted, confirmed by {permitted.by} on {formatDate(permitted.at)}.
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-ink-muted">
            {isOwner
              ? 'Training waits for your confirmation: this material is under a restrictive rights statement, so no '
                + 'run trains or validates on it until you confirm that a research exception or a contract permits it. '
                + 'Your confirmation is logged and switches nothing.'
              : "Training waits for the owner's confirmation: this material is under a restrictive rights statement, "
                + 'so no run trains or validates on it until its owner confirms that a research exception or a '
                + 'contract permits it.'}
          </p>
          {isOwner && (
            <Button size="sm" className="mt-2" data-testid="rights-permit-training" disabled={busy} onClick={onPermit}>
              Training on this material is permitted
            </Button>
          )}
        </>
      )}
    </section>
  )
}

function RightsDialog({ jobId, canEdit, isOwner, fromIiif, statements, onClose, onChanged }: {
  jobId: string
  canEdit: boolean
  isOwner: boolean
  fromIiif: boolean
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

  const act = (work: () => Promise<JobRights>, keepDraft = false) => {
    setBusy(true)
    setError(null)
    work().then((next) => {
      setHeld(next)
      if (!keepDraft) setDraft({})
      onChanged(next.status)
    }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }

  return (
    <Modal title="Rights" width="lg" onClose={onClose}>
      {!held && !error && <p className="text-sm text-ink-muted">Loading…</p>}
      {held && (
        <div className="space-y-4 text-sm" data-testid="rights-dialog">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="font-semibold text-ink">The scans</h3>
              {fromIiif && canEdit && (
                <Button size="xs" variant="ghost" data-testid="rights-refresh" disabled={busy}
                        title="Fill the fields still empty from what the IIIF manifest says now"
                        onClick={() => act(() => refreshJobRights(jobId), true)}>
                  Read the manifest again
                </Button>
              )}
            </div>
            <ScansFields value={value} put={put} statements={statements} imported={held.imported}
                         disabled={!canEdit || busy} />
          </div>
          <fieldset disabled={!canEdit || busy}>
            <legend className="mb-1 font-semibold text-ink">The transcriptions</legend>
            <label className="block">
              {FIELD_LABELS.transcription_licence}
              <Select size="sm" className="mt-1 w-full" data-testid="rights-licence" aria-label="Licence of the transcriptions"
                      value={value('transcription_licence')} onChange={(e) => put('transcription_licence', e.target.value)}>
                <option value="" disabled>Not given - choose one</option>
                {statements.map((s) => <option key={s.uri} value={s.uri}>{s.label}</option>)}
              </Select>
            </label>
          </fieldset>
          <TrainingPermission held={held} isOwner={isOwner} busy={busy} onPermit={() => act(() => permitTraining(jobId), true)} />
          <RightsHistory history={held.history} statements={statements} />
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>{Object.keys(changed).length > 0 ? 'Cancel' : 'Close'}</button>
        {canEdit && (
          <button data-testid="rights-save" className={modalPrimaryBtn} disabled={busy || Object.keys(changed).length === 0}
                  onClick={() => act(() => putJobRights(jobId, changed))}>Save</button>
        )}
      </div>
    </Modal>
  )
}

/** A page's rights in the viewer bar: its own where it has them, else its dataset's. */
export function PageRightsChip({ jobId, pageId, own, datasetStatus, canEdit, onChanged }: {
  jobId: string
  pageId: number
  own: string | null
  datasetStatus: string | null
  canEdit: boolean
  onChanged: (own: string | null) => void
}) {
  const statements = useStatements()
  const [open, setOpen] = useState(false)
  const status = own ?? datasetStatus
  const label = unevaluated(status) ? 'Rights not evaluated' : labelOf(statements, status) ?? 'Rights'
  return (
    <>
      {/* Below xl the viewer bar has no room for a statement's name: the chip keeps its mark
          and colour and says the rest when asked. */}
      <ChipButton data-testid="page-rights" data-own={own !== null} tone={unevaluated(status) ? 'warn' : 'neutral'}
                  caret onClick={() => setOpen(true)} aria-label={`Rights: ${label}`}
                  title={own !== null ? `This page's own rights: ${label}` : `The dataset's rights: ${label}`}>
        <span aria-hidden="true" className="xl:hidden">©</span>
        <span className="hidden max-w-48 truncate xl:inline-block">{label}</span>
      </ChipButton>
      {open && (
        <PageRightsDialog jobId={jobId} pageIds={[pageId]} canEdit={canEdit} onClose={() => setOpen(false)}
                          onSaved={(next) => { onChanged(next); setOpen(false) }} />
      )}
    </>
  )
}

/** One page's own rights, or those of the pages selected in the table: their own, or their
 *  dataset's again. A single page shows what it has and its changes; a selection starts
 *  from nothing chosen, as the pages in it may hold different rights. */
export function PageRightsDialog({ jobId, pageIds, selection = false, canEdit, onClose, onSaved }: {
  jobId: string
  pageIds: number[]
  /** Pages ticked in the table rather than the one open in the viewer. */
  selection?: boolean
  canEdit: boolean
  onClose: () => void
  /** The pages' own statement now, null where they follow the dataset's. */
  onSaved: (own: string | null) => void
}) {
  const statements = useStatements()
  const single = !selection
  const first = pageIds[0]
  const [held, setHeld] = useState<PageRights | null>(null)
  const [mode, setMode] = useState<'follow' | 'own' | null>(null)
  const [fields, setFields] = useState<PageRightsFields>(EMPTY_PAGE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    getPageRights(jobId, first).then((found) => {
      setHeld(found)
      if (single) {
        setMode(found.own ? 'own' : 'follow')
        setFields(found.own ?? fromDataset(found))
      } else {
        setFields(fromDataset(found))
      }
    }).catch((e: Error) => setError(e.message))
  }, [jobId, first, single])

  const dataset = held ? labelOf(statements, held.dataset.status) ?? 'Copyright Not Evaluated' : ''
  const ready = mode === 'follow' || (mode === 'own' && fields.status !== '')
  const save = () => {
    setBusy(true)
    setError(null)
    putPagesRights(jobId, pageIds, mode === 'own' ? fields : null)
      .then(() => onSaved(mode === 'own' ? fields.status : null))
      .catch((e: Error) => { setError(e.message); setBusy(false) })
  }
  const choice = (value: 'follow' | 'own', text: string) => (
    <label className="flex cursor-pointer items-center gap-2">
      <Check type="radio" name="page-rights-mode" data-testid={`page-rights-${value}`} checked={mode === value}
             disabled={!canEdit || busy} onChange={() => setMode(value)} />
      {text}
    </label>
  )

  return (
    <Modal title={single ? 'Rights of this page' : `Rights of ${pageIds.length} pages`} width="lg" onClose={onClose}>
      {!held && !error && <p className="text-sm text-ink-muted">Loading…</p>}
      {held && (
        <div className="space-y-4 text-sm" data-testid="page-rights-dialog">
          {!single && (
            <p className="text-ink-muted">
              {pageIds.length === 1 ? '1 page' : `${pageIds.length} pages`} selected. What you save here replaces
              whatever rights of their own they had.
            </p>
          )}
          <div role="radiogroup" aria-label="Whose rights" className="space-y-1.5">
            {choice('follow', `Same as the dataset: ${dataset}`)}
            {choice('own', single ? 'Rights of its own' : 'Rights of their own')}
          </div>
          {mode === 'own' && (
            <ScansFields value={(field) => fields[field]} put={(field, next) => setFields({ ...fields, [field]: next })}
                         statements={statements} imported={single ? held.imported : []} disabled={!canEdit || busy} />
          )}
          {single && <RightsHistory history={held.history} statements={statements} emptied="the dataset's" />}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        {canEdit && (
          <button data-testid="page-rights-save" className={modalPrimaryBtn} disabled={busy || !ready}
                  onClick={save}>Save</button>
        )}
      </div>
    </Modal>
  )
}

function fromDataset(found: PageRights): PageRightsFields {
  return Object.fromEntries(PAGE_FIELDS.map((field) => [field, found.dataset[field] ?? ''])) as PageRightsFields
}
