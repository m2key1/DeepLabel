import type { Role } from '../api'

/** Highest first, as the admin page lists them. Each role may do everything the ones after it may. */
export const ROLES: Role[] = ['admin', 'manager', 'reviewer', 'annotator', 'viewer']

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  reviewer: 'Reviewer',
  annotator: 'Annotator',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTION: Record<Role, string> = {
  admin: 'Everything, everywhere, including people and settings',
  manager: 'A Reviewer who also runs models, changes settings, exports, deletes and adds people',
  reviewer: 'An Annotator who also marks lines and pages checked',
  annotator: 'Corrects text, lines and regions, and adds pages and datasets',
  viewer: 'Opens pages, text and results, and changes nothing',
}

/** Whether someone with `role` may do what `least` may. */
export function reaches(role: Role | undefined, least: Role): boolean {
  return role !== undefined && ROLES.indexOf(role) <= ROLES.indexOf(least)
}
