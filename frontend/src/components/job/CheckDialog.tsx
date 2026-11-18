import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listChecks, listModels, listTrainings, startCheck } from '../../api'
import type { RegistryModel, Training, TranscriptionCheck } from '../../api'
import { LIKELY_TRANSCRIPTION_ERROR } from '../evaluation/lineFilter'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Badge } from '../ui/Badge'
import { Select } from '../ui/Field'
import { STATUS_TONE, formatDate } from '../../util'

const LIKELY_ERRORS = new URLSearchParams(
  Object.entries(LIKELY_TRANSCRIPTION_ERROR).map(([key, value]) => [key, String(value)])).toString()

/** Where a check opens: on the lines whose confident reading looks nothing like their text. */
const checkLink = (id: number) => `/evaluations/${id}?${LIKELY_ERRORS}`

/** Read a dataset's checked lines with a model to find transcriptions that look nothing
 *  like the reading, and the checks run on it before. */
export function CheckDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [models, setModels] = useState<RegistryModel[]>([])
  const [trainings, setTrainings] = useState<Training[]>([])
  const [checks, setChecks] = useState<TranscriptionCheck[]>([])
  const [modelId, setModelId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listModels().then((r) => {
      const ocr = r.models.filter((m) => m.task === 'ocr')
      setModels(ocr)
      setModelId((ocr.find((m) => m.is_default) ?? ocr[0])?.id ?? null)
    }).catch((e: Error) => setError(e.message))
    listTrainings().then((r) => setTrainings(r.trainings)).catch(() => {})
    listChecks(jobId).then((r) => setChecks(r.checks)).catch(() => {})
  }, [jobId])

  const trainedHere = trainings.some((t) => t.model_id === modelId && t.dataset_job_ids.includes(jobId))

  const start = () => {
    if (modelId === null) return
    setBusy(true)
    setError(null)
    startCheck(jobId, modelId)
      .then((check) => navigate(checkLink(check.id)))
      .catch((e: Error) => { setError(e.message); setBusy(false) })
  }

  return (
    <Modal title="Check transcriptions" onClose={onClose}>
      <p className="mb-3 text-xs text-ink-muted">
        A model reads every checked line, and the lines whose confident reading looks nothing like
        their text are listed, worst first. Nothing changes until you fix a line yourself.
      </p>
      <label className="mb-1 block text-sm font-medium text-ink" htmlFor="check-model">Model</label>
      <Select id="check-model" data-testid="check-model" className="w-full" value={modelId ?? ''}
              onChange={(e) => setModelId(Number(e.target.value))}>
        {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.is_default ? ' (default)' : ''}</option>)}
      </Select>
      {trainedHere && (
        <p data-testid="check-trained-here" className="mt-1 text-xs text-warn">
          This model was trained on this dataset, so it may have learned its mistakes.
        </p>
      )}
      {checks.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-sm font-medium text-ink">Earlier checks</div>
          <ul className="space-y-1 text-xs text-ink-muted">
            {checks.map((check) => (
              <li key={check.id} data-testid="earlier-check" className="flex items-center gap-2">
                <Link to={checkLink(check.id)} className="text-accent-ink hover:underline">
                  {formatDate(check.created_at)}
                </Link>
                <span>{check.model_name ?? `model ${check.model_id}`}</span>
                {check.status !== 'done' && <Badge tone={STATUS_TONE[check.status]}>{check.status}</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p data-testid="dialog-error" role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button data-testid="start-check" disabled={busy || modelId === null} onClick={start}
                className={`${modalPrimaryBtn} disabled:opacity-40`}>
          {busy ? 'Starting…' : 'Check'}
        </button>
      </div>
    </Modal>
  )
}
