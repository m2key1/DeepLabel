import { getAvatars } from './api'

/** Who has a picture, by the name the rest of the app knows them as.
 *
 *  Everything that draws a person - a dataset's owner, who is in a dataset right now, the
 *  people a line was checked by - has only a username to go on, and there are six hundred
 *  rows on the list. So this is fetched once for the whole app and shared, rather than a
 *  request per avatar. A name nobody has, which ninety-two datasets on this deployment
 *  are owned by, simply has no entry and draws its initials.
 */
let pictures: Map<string, string> = new Map()
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function announce() {
  for (const listener of listeners) listener()
}

/** Ask once. A second caller while the first is in the air waits on the same request. */
function load(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = getAvatars()
    .then(({ avatars }) => {
      pictures = new Map(Object.entries(avatars))
      announce()
    })
    .catch(() => {
      // Nobody gets a picture and everybody gets initials, which is the same page with
      // less in it. Not worth an error where a face would have been.
    })
  return inFlight
}

/** After someone changes their own picture, so the copies of it on screen follow. */
export function refreshAvatars(): Promise<void> {
  inFlight = null
  return load()
}

export function subscribeAvatars(listener: () => void): () => void {
  listeners.add(listener)
  void load()
  return () => {
    listeners.delete(listener)
  }
}

export function avatarFor(username: string): string | undefined {
  return pictures.get(username)
}
