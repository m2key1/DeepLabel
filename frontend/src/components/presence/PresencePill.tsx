import { useState } from 'react'
import { Link } from 'react-router-dom'
import { usePresence } from '../../presence'
import { AvatarLink } from '../ui/Avatar'
import { describeLocation, distinctPeople, locationPath } from './location'
import { popoverChrome } from '../ui/Card'
import { menuTrigger, useDismiss } from '../ui/menu'

// "3 online" in the nav bar, opening into who is where. Absent when nobody else is
// around, so an empty deployment does not advertise a feature with nothing to show.
export function PresencePill() {
  const { others } = usePresence()
  const [open, setOpen] = useState(false)
  const people = distinctPeople(others)

  useDismiss(open, () => setOpen(false))

  if (people.length === 0) return null

  return (
    <div className="relative">
      <button
        data-testid="presence-pill"
        {...menuTrigger(open)}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted hover:border-accent hover:text-accent-ink"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        {people.length} online
      </button>
      {open && (
        <ul
          data-testid="presence-list"
          className={`absolute left-0 top-full z-20 mt-1.5 w-72 overflow-hidden ${popoverChrome} py-1`}
        >
          {people.map((p) => {
            const where = describeLocation(p)
            const path = locationPath(p)
            const body = (
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.username}</span>
                <span className="block truncate text-xs text-ink-muted">{where}</span>
              </span>
            )
            const itemClass = 'min-w-0 flex-1 py-0.5'
            return (
              <li key={p.username} className="flex items-center gap-2 px-3 py-1 hover:bg-accent-wash">
                <AvatarLink name={p.username} size="sm" onClick={() => setOpen(false)} />
                {path ? (
                  <Link to={path} onClick={() => setOpen(false)} className={itemClass}>
                    {body}
                  </Link>
                ) : (
                  <span className={itemClass}>{body}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
