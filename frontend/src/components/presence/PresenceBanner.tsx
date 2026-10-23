import type { PresenceEntry } from '../../api'
import { distinctPeople } from './location'

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// Shown in an editor's header while someone else has the same page open. Edits are
// last-write-wins, so this is the moment to coordinate, not after.
export function PresenceBanner({ entries, what = 'page' }: { entries: PresenceEntry[]; what?: 'page' | 'tile' }) {
  const people = distinctPeople(entries)
  if (people.length === 0) return null
  const editing = people.filter((p) => p.editing)
  const names = listNames(people.map((p) => p.username))
  const verb = editing.length === people.length ? (people.length === 1 ? 'is editing' : 'are editing')
    : people.length === 1 ? 'has' : 'have'
  const object = verb.endsWith('editing') ? `this ${what}` : `this ${what} open`
  return (
    <span
      data-testid="presence-banner"
      role="status"
      className="flex items-center gap-1.5 rounded bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
      {names} {verb} {object}
    </span>
  )
}
