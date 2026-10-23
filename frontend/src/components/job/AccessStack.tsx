import type { Group, Job } from '../../api'
import { AvatarLink } from '../ui/Avatar'

const MAX_SHOWN = 3

export interface Reach {
  username: string
  why: 'owner' | 'dataset' | 'group'
  /** A share written on the dataset that the group already covers, so it grants nothing. */
  redundant?: boolean
}

/** Everyone who reaches a dataset, and on what grounds. The order is the argument: the
 *  owner, then shares written on the dataset itself, then the ones it inherits from its
 *  group. Admins reach everything and are not listed - naming them on every row would say
 *  nothing about this row. */
export function reachOf(job: Job, group: Group | undefined): Reach[] {
  const out: Reach[] = [{ username: job.owner, why: 'owner' }]
  for (const username of job.shared_with) {
    if (!out.some((r) => r.username === username)) out.push({ username, why: 'dataset' })
  }
  for (const username of group?.shared_with ?? []) {
    const seen = out.find((r) => r.username === username)
    if (seen) {
      if (seen.why === 'dataset') seen.redundant = true
      continue
    }
    out.push({ username, why: 'group' })
  }
  return out
}

function says(reach: Reach, groupName?: string): string {
  if (reach.why === 'owner') return `${reach.username} - owner`
  if (reach.why === 'group') return `${reach.username} - through the group ${groupName}`
  return reach.redundant
    ? `${reach.username} - shared on this dataset, which the group already covers`
    : `${reach.username} - shared on this dataset`
}

export function AccessStack({ job, group }: { job: Job; group?: Group }) {
  const reach = reachOf(job, group)
  const shown = reach.slice(0, MAX_SHOWN)
  const rest = reach.length - shown.length
  return (
    <span data-testid="access-stack"
          title={reach.map((r) => says(r, group?.name)).join('\n')}
          className="inline-flex items-center -space-x-1">
      {shown.map((r) => (
        <AvatarLink
          key={r.username}
          name={r.username}
          size="xs"
          title={says(r, group?.name)}
          className={r.why === 'owner'
            ? 'ring-2 ring-accent'
            : `ring-2 ring-surface ${r.why === 'group' ? 'opacity-70' : ''}`}
        />
      ))}
      {rest > 0 && (
        <span className="ml-1.5 font-mono text-[10px] text-ink-subtle">+{rest}</span>
      )}
    </span>
  )
}
