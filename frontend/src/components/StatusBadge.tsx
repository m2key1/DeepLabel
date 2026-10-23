import type { JobStatus } from '../api'
import { STATUS_TONE } from '../util'
import { Badge } from './ui/Badge'

export function StatusBadge({ status }: { status: JobStatus }) {
  // A row already carries the pipeline as chips; the status is one more of the same
  // kind rather than a second kind of label beside them.
  return (
    <Badge data-testid="status-badge" variant="chip" tone={STATUS_TONE[status]}>
      {status}
    </Badge>
  )
}
