/** Where someone's profile is; on your own, `section` opens one of your settings tabs. */
export function profilePath(username: string, section?: string): string {
  const path = `/people/${encodeURIComponent(username)}`
  return section ? `${path}?section=${encodeURIComponent(section)}` : path
}
