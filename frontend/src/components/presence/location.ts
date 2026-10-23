import { isTileTask, type PresenceEntry } from '../../api'

// One person may have several tabs open; show them once, at their most specific tab.
export function distinctPeople(entries: PresenceEntry[]): PresenceEntry[] {
  const byName = new Map<string, PresenceEntry>()
  for (const entry of entries) {
    const known = byName.get(entry.username)
    if (!known || specificity(entry) > specificity(known)) byName.set(entry.username, entry)
  }
  return [...byName.values()].sort((a, b) => a.username.localeCompare(b.username))
}

function specificity(entry: PresenceEntry): number {
  if (entry.target) return 3
  if (entry.page_id !== null) return 2
  if (entry.job_id !== null) return 1
  return 0
}

export function describeLocation(entry: PresenceEntry): string {
  if (!entry.accessible) return 'in a dataset you cannot open'
  if (entry.job_name === null) return 'browsing'
  if (entry.page_idx === null) return `in ${entry.job_name}`
  const verb = entry.editing ? 'editing' : 'viewing'
  return `${verb} ${isTileTask(entry.job_task!) ? 'tile' : 'page'} ${entry.page_idx + 1} of ${entry.job_name}`
}

export function locationPath(entry: PresenceEntry): string | null {
  if (!entry.accessible || entry.job_id === null) return null
  if (entry.page_id === null) return `/jobs/${entry.job_id}`
  const editor = isTileTask(entry.job_task!) ? 'tiles' : 'pages'
  return `/jobs/${entry.job_id}/${editor}/${entry.page_id}`
}
