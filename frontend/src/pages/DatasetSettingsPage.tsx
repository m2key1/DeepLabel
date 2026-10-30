import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, getJob } from '../api'
import type { JobWithoutPages } from '../api'
import { pageShell } from '../components/ui/page'
import { NewJobPage } from './NewJobPage'
import { NotFoundPage } from './NotFoundPage'

/** A text dataset's settings: the New job steps, filled in as the dataset stands. */
export function DatasetSettingsPage() {
  const { id = '' } = useParams()
  const [job, setJob] = useState<JobWithoutPages | null>(null)
  const [error, setError] = useState<{ missing: boolean; message: string } | null>(null)

  useEffect(() => {
    setJob(null)
    getJob(id, { pages: false })
      .then(setJob)
      .catch((e: Error) => setError({ missing: e instanceof ApiError && e.status === 404, message: e.message }))
  }, [id])

  if (error?.missing) return <NotFoundPage />
  if (error) return <div className={pageShell}><p className="text-sm text-danger">{error.message}</p></div>
  if (!job) return <div className={pageShell}><p className="text-sm text-ink-subtle">Loading…</p></div>
  return <NewJobPage key={job.id} edit={job} />
}
