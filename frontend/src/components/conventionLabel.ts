import type { ConventionFlag } from '../api'

/** What a flag is called where people read it: the label an admin wrote, or until there
 *  is one its name in words. */
export function conventionLabel(name: string, catalog?: ConventionFlag[] | null): string {
  const flag = catalog?.find((f) => f.name === name)
  if (flag && flag.label !== flag.name) return flag.label
  const words = name.replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
