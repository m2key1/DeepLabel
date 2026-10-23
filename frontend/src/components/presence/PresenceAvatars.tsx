import type { PresenceEntry } from '../../api'
import { AvatarLink } from '../ui/Avatar'
import { describeLocation, distinctPeople } from './location'

const MAX_SHOWN = 4

interface PresenceAvatarsProps {
  entries: PresenceEntry[]
  size?: 'xs' | 'sm'
  className?: string
}

// A stack of the people inside something - a dataset card, a page row, a line. Renders
// nothing when nobody is there, so it can sit in a layout unconditionally.
export function PresenceAvatars({ entries, size = 'xs', className = '' }: PresenceAvatarsProps) {
  const people = distinctPeople(entries)
  if (people.length === 0) return null
  const shown = people.slice(0, MAX_SHOWN)
  const rest = people.length - shown.length
  return (
    <span data-testid="presence-avatars" className={`inline-flex items-center -space-x-1 ${className}`}>
      {shown.map((p) => (
        <AvatarLink
          key={p.username}
          name={p.username}
          size={size}
          title={`${p.username} · ${describeLocation(p)}`}
          className="ring-2 ring-surface"
        />
      ))}
      {rest > 0 && (
        <span className="ml-1.5 text-[10px] text-ink-muted" title={people.slice(MAX_SHOWN).map((p) => p.username).join(', ')}>
          +{rest}
        </span>
      )}
    </span>
  )
}
