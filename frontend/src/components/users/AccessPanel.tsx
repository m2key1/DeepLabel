import { Link } from 'react-router-dom'
import { isTileTask, type ContributorAccess, type DatasetAccess } from '../../api'
import { Badge } from '../ui/Badge'

const DATASET_GROUPS: { access: DatasetAccess; label: string }[] = [
  { access: 'owner', label: 'Owns' },
  { access: 'shared', label: 'Shared directly' },
  { access: 'group', label: 'Through a group' },
]

interface AccessPanelProps {
  access: ContributorAccess
  isAdmin: boolean
}

export function AccessPanel({ access, isAdmin }: AccessPanelProps) {
  const groups = DATASET_GROUPS
    .map((g) => ({ ...g, datasets: access.datasets.filter((d) => d.access === g.access) }))
    .filter((g) => g.datasets.length > 0)

  return (
    <div data-testid="user-access" className="space-y-3 text-sm">
      {isAdmin && (
        <p className="text-xs text-ink-muted">
          Admins reach every dataset. Listed here is what this one owns or was given explicitly.
        </p>
      )}
      {groups.length === 0 && !isAdmin && (
        <p className="text-ink-muted">
          Reaches no datasets yet. Share one from its menu on the Jobs page.
        </p>
      )}
      {groups.map((g) => (
        <div key={g.access}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            {g.label} <span className="font-normal">({g.datasets.length})</span>
          </h4>
          <ul className="space-y-0.5">
            {g.datasets.map((d) => (
              <li key={d.id} className="flex items-center gap-1.5">
                <Link to={`/jobs/${d.id}`} className="truncate hover:text-accent-ink hover:underline">
                  {d.name}
                </Link>
                {isTileTask(d.task) && (
                  <Badge variant="chip" className="uppercase">map</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {access.groups.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Groups
          </h4>
          <ul className="space-y-0.5">
            {access.groups.map((g) => (
              <li key={g.id} className="flex items-center gap-1.5">
                <span className="truncate">{g.name}</span>
                <span className="text-xs text-ink-subtle">{g.access === 'owner' ? 'owner' : 'shared'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
