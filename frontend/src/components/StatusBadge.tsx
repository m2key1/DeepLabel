import type { JobStatus } from '../api'
import { STATUS_TONE } from '../util'
import { Badge } from './ui/Badge'

const STATUS_LABEL: Record<JobStatus, string> = {
  uploading: 'Uploading',
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
}

export function StatusBadge({ status }: { status: JobStatus }) {
  // A row already carries the pipeline as chips; the status is one more of the same
  // kind rather than a second kind of label beside them.
  return (
    <Badge data-testid="status-badge" data-status={status} tone={STATUS_TONE[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}
