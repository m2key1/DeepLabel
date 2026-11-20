import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDataUse } from '../../api'
import type { DataUse, DataUseDetail } from '../../api'
import { formatDate } from '../../util'
import { DataUseSwitches } from './DataUseSwitches'

const ROLE = { train: 'trained', valid: 'validated', test: 'scored' }

/** The owner's switches for what a dataset that exists may be used for, with the models
 *  already made from it and the admins who opened it while it restricted its use. */
export function DataUseEditor({ jobId, value, onChange }: {
  jobId: string
  value: DataUse
  onChange: (next: DataUse) => void
}) {
  const [detail, setDetail] = useState<DataUseDetail | null>(null)
  useEffect(() => {
    getDataUse(jobId).then(setDetail).catch(() => {})
  }, [jobId])

  const trainedOn = detail?.models.filter((m) => m.roles.some((r) => r !== 'test')) ?? []
  const trainingNote = !value.training && trainedOn.length > 0 && (
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
    <>
      <DataUseSwitches value={value} onChange={onChange} notes={{ training: trainingNote }} />
    </>
  )
}
