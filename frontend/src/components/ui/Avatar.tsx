import { useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'

import { classColor } from '../../util'
import { avatarFor, subscribeAvatars } from '../../avatars'
import { profilePath } from '../../people'

const SIZES = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  xl: 'h-24 w-24 text-3xl',
}

interface AvatarProps {
  name: string
  displayName?: string
  size?: keyof typeof SIZES
  title?: string
  className?: string
}

// The two letters that stand for a person everywhere: initials of the display name
// when the provider reports one, otherwise the start of the username. The colour is
// derived from the username so the same person looks the same on every page.
export function initials(name: string, displayName?: string): string {
  const words = (displayName ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/** Where this person's picture is, kept current as pictures change. */
export function usePicture(name: string): string | undefined {
  return useSyncExternalStore(subscribeAvatars, () => avatarFor(name))
}

export function Avatar({ name, displayName, size = 'md', title, className = '' }: AvatarProps) {
  // Every avatar in the app reads one shared map, fetched once. An account with no
  // picture falls through to its initials rather than to a broken image.
  const picture = usePicture(name)
  return (
    <span
      title={title ?? (displayName || name)}
      aria-label={name}
      style={picture ? undefined : { backgroundColor: classColor(name) }}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white ${SIZES[size]} ${className}`}
    >
      {picture
        ? <img src={picture} alt="" className="h-full w-full object-cover" />
        : initials(name, displayName)}
    </span>
  )
}

/** A person's avatar that opens their profile. The click stays with the link, so a row
 *  that answers clicks of its own does not also act on it. */
export function AvatarLink({ className = '', onClick, ...props }: AvatarProps & { onClick?: () => void }) {
  return (
    <Link
      to={profilePath(props.name)}
      data-testid="person-link"
      data-username={props.name}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      className={`inline-flex shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
    >
      <Avatar {...props} />
    </Link>
  )
}
