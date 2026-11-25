import type { Folder, Group, Job } from '../../api'

export interface FolderNode {
  folder: Folder
  depth: number
  children: FolderNode[]
}

/** The folders under `parent`, each with its own below it, in the order the server sorted them. */
export function folderTree(folders: Folder[], parent: number | null = null, depth = 0): FolderNode[] {
  return folders.filter((f) => f.parent_id === parent)
    .map((folder) => ({ folder, depth, children: folderTree(folders, folder.id, depth + 1) }))
}

/** Top to bottom, each folder followed by the ones inside it, as a menu or a select lists them. */
export function flatten(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

/** A folder and every folder below it. */
export function itselfAndBelow(folders: Folder[], id: number): Set<number> {
  const found = new Set([id])
  for (const node of flatten(folderTree(folders, id))) found.add(node.folder.id)
  return found
}

/** The folders from the top of the workspace down to this one. */
export function ancestry(folders: Folder[], id: number): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const chain: Folder[] = []
  for (let at = byId.get(id); at; at = at.parent_id === null ? undefined : byId.get(at.parent_id)) chain.unshift(at)
  return chain
}

export const folderPath = (folders: Folder[], id: number) => ancestry(folders, id).map((f) => f.name).join(' / ')

/** Where a dataset sits as the list draws it: a folder its workspace still has, else the top. */
export function filedIn(job: Job, group: Group | undefined): number | null {
  const id = job.folder_id ?? null
  return id !== null && group?.folders?.some((f) => f.id === id) ? id : null
}

/** The datasets in a folder or anywhere below it. */
export function datasetsBelow(jobs: Job[], group: Group, id: number): Job[] {
  const within = itselfAndBelow(group.folders ?? [], id)
  return jobs.filter((j) => j.group_id === group.id && within.has(filedIn(j, group) ?? -1))
}
