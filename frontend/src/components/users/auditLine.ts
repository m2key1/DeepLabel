import type { UserAuditEntry } from '../../api'
import { capabilityLabel } from './capabilities'

const FIELD_LABEL: Record<string, string> = {
  role: 'role',
  active: 'status',
  slurm_account: 'SLURM account',
  sessions: 'sessions',
  username: 'username',
}

// The Training column and the matrix write the same grant, logged under the column's name.
const GRANT_COLUMN_CAPABILITY: Record<string, string> = {
  train_local: 'train.local',
  train_cluster: 'train.cluster',
}

const quoted = (cap: string) => `"${capabilityLabel(cap)}"`

function auditValue(field: string, value: string): string {
  if (field === 'active') return value === '1' ? 'active' : 'disabled'
  if (field === 'slurm_account') return value || 'the cluster default'
  return value
}

function clearedExceptions(stored: string): string {
  const exceptions = Object.entries(JSON.parse(stored) as Record<string, boolean>)
  return exceptions.map(([cap, granted]) => `${quoted(cap)} ${granted ? 'granted' : 'taken'}`).join(', ')
}

/** One history entry as a sentence about the person whose history it is. */
export function auditLine(entry: UserAuditEntry, username: string): string {
  if (entry.field === 'sessions') {
    return `signed out of ${entry.old_value} session${entry.old_value === '1' ? '' : 's'}`
  }
  if (entry.field === 'password_link') return 'password link created'
  if (entry.field === 'exceptions') {
    return `the role change cleared the exceptions for ${username}: ${clearedExceptions(entry.old_value)}`
  }
  if (entry.field === 'dormant_grants') {
    return `the role change dropped the grants stored for ${username} that the old role ignored: ${clearedExceptions(entry.old_value)}`
  }
  const capability = GRANT_COLUMN_CAPABILITY[entry.field] ?? (entry.field.includes('.') ? entry.field : null)
  if (capability) {
    return entry.new_value === '1'
      ? `granted ${quoted(capability)} to ${username}`
      : `took ${quoted(capability)} from ${username}`
  }
  const label = FIELD_LABEL[entry.field] ?? entry.field
  return `${label}: ${auditValue(entry.field, entry.old_value)} → ${auditValue(entry.field, entry.new_value)}`
}
