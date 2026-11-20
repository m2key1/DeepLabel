import type { Group, Job } from '../../api'

/** Every dataset in the group the caller can reach - what a group-wide action changes,
 *  whatever the list in front of them is filtered to. */
export function groupSize(group: Group, jobs: Job[]): number {
  return group.count ?? jobs.filter((j) => j.group_id === group.id).length
}

export type WorkspaceKind = 'own-sandbox' | 'workspace' | 'other-sandbox'

export function workspaceKind(group: Group, viewer: string): WorkspaceKind {
  if (!group.sandbox_of) return 'workspace'
  return group.sandbox_of === viewer ? 'own-sandbox' : 'other-sandbox'
}

const RANK: Record<WorkspaceKind, number> = { 'own-sandbox': 0, workspace: 1, 'other-sandbox': 2 }

/** Your Sandbox first, then the workspaces, then - for an admin - everyone else's Sandboxes,
 *  each part in the order the server sorted it. */
export function inListOrder(groups: Group[], viewer: string): Group[] {
  return [...groups].sort((a, b) => RANK[workspaceKind(a, viewer)] - RANK[workspaceKind(b, viewer)])
}

/** Where someone may make or move datasets: their own Sandbox, and the workspaces they
 *  belong to - any, for an admin. Never someone else's Sandbox. */
export function takesNewDatasets(group: Group, viewer: string, isAdmin: boolean): boolean {
  if (group.sandbox_of) return group.sandbox_of === viewer
  return isAdmin || group.shared_with.includes(viewer)
}

/** The wizard link that makes a dataset in this workspace. */
export const newDatasetIn = (group: Group) => `/new?workspace=${group.id}`

export function newDatasetTitle(group: Group, viewer: string): string {
  return group.sandbox_of === viewer ? 'New dataset in your Sandbox' : `New dataset in ${group.name}`
}

/** The wizard's value for "your Sandbox", which sends no workspace at all. */
export const SANDBOX = ''

/** Where the wizard starts: the workspace it was opened from, else the one holding the
 *  person's newest dataset, else their Sandbox - and only ever one they may make datasets in. */
export function startingWorkspace(asked: number, groups: Group[], choices: Group[]): string {
  if (groups.some((g) => g.id === asked && g.sandbox_of)) return SANDBOX
  const start = choices.find((g) => g.id === asked) ?? choices.find((g) => g.last_used)
  return start ? String(start.id) : SANDBOX
}
