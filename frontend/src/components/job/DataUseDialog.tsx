import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDataUse, setDataUse } from '../../api'
import type { DataUse, DataUseDetail } from '../../api'
import { formatDate } from '../../util'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { DataUseSwitches } from './DataUseSwitches'

const ROLE = { train: 'trained', valid: 'validated', test: 'scored' }

/** The owner's switches for what a dataset may be used for, the models already made from
 *  it, and the admins who opened it while it restricted its use. */
export function DataUseDialog({ jobId, jobName, onClose, onSaved }: {
  jobId: string
  jobName: string
  onClose: () => void
  onSaved: () => void
}) {
  const [detail, setDetail] = useState<DataUseDetail | null>(null)
  const [draft, setDraft] = useState<DataUse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getDataUse(jobId).then((d) => { setDetail(d); setDraft(d.data_use) }).catch((e: Error) => setError(e.message))
  }, [jobId])

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await setDataUse(jobId, draft)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const trainedOn = detail?.models.filter((m) => m.roles.some((r) => r !== 'test')) ?? []
  const trainingNote = draft && !draft.training && trainedOn.length > 0 && (
    <div data-testid="data-use-models" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink">
      Switching this off keeps the dataset out of new trainings. These models were already made from it and stay
      as they are - ask an admin to remove them if they must go:
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
        {trainedOn.map((m) => (
          <li key={m.id} data-testid="data-use-model">
            <Link to={`/models/${m.id}`} className="font-medium text-accent-ink hover:underline">{m.name}</Link>
            {' - '}{m.roles.map((r) => ROLE[r]).join(' and ')} on it, {formatDate(m.created_at)}
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <Modal title={`Data use - ${jobName}`} width="lg" onClose={onClose}>
      <p className="text-sm text-ink-muted">
        Applies to everyone, you included. Admins can still open the dataset for support; while anything here is
        off, each such visit is listed below.
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {draft && <DataUseSwitches value={draft} onChange={setDraft} notes={{ training: trainingNote }} />}
      {detail && detail.admin_visits.length > 0 && (
        <section className="mt-3">
          <h3 className="text-sm font-semibold text-ink">Opened by admins</h3>
          <table data-testid="data-use-visits" className="mt-1 w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-muted"><th className="py-1 font-medium">Admin</th>
              <th className="py-1 font-medium">When</th></tr></thead>
            <tbody>
              {detail.admin_visits.map((v, i) => (
                <tr key={i} className="border-t border-line"><td className="py-1">{v.username}</td>
                  <td className="py-1">{formatDate(v.created_at)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button data-testid="data-use-save" onClick={save} disabled={!draft || busy}
                className={`${modalPrimaryBtn} disabled:opacity-40`}>
          Save
        </button>
      </div>
    </Modal>
  )
}
