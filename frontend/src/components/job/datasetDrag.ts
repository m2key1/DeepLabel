import { useState } from 'react'
import type { DragEvent } from 'react'

import type { Folder } from '../../api'

/** Their own types, so a file dragged in from the desktop or a link dragged off the page is
 *  never taken for datasets or a folder. */
const DATASETS_MIME = 'application/x-deeplabel-datasets'
const FOLDER_MIME = 'application/x-deeplabel-folder'

/** Where datasets can be dropped: a workspace or a Sandbox, or one of a workspace's folders. */
export type DropTarget = { groupId: number; folderId?: number | null; name: string }

/** A folder on the move, and the folders it cannot go into: itself and those below it. */
export type DraggedFolder = { folder: Folder; groupId: number; within: Set<number> }

export interface DropZone {
  lit: boolean
  hint: string | null
  props: {
    'data-drop-target': string
    'data-drop-active'?: ''
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

export const DROP_LIT = 'bg-accent-wash text-accent-ink outline outline-2 -outline-offset-2 outline-accent'

const carrying = (e: DragEvent, type: string) => e.dataTransfer.types.includes(type)

const keyOf = (target: DropTarget) =>
  target.folderId ? `${target.groupId}/${target.folderId}` : String(target.groupId)

export function dropHint(count: number, target: DropTarget): string {
  const datasets = `${count} dataset${count === 1 ? '' : 's'}`
  return `Move ${datasets} to ${target.name}`
}

export function folderDropHint(folder: Folder, target: DropTarget): string {
  return target.folderId ? `Move ${folder.name} into ${target.name}` : `Move ${folder.name} to the top of ${target.name}`
}

/** A folder goes only within its workspace, never into itself, and not to where it already is. */
const takes = (target: DropTarget, dragged: DraggedFolder) => {
  const into = target.folderId ?? null
  return target.groupId === dragged.groupId && into !== dragged.folder.parent_id
    && (into === null || !dragged.within.has(into))
}

/** Dragging a ticked dataset carries the selection with it, the way the bulk bar acts on
 *  it; an unticked one goes alone. Only a dataset `canMove` allows is picked up. A workspace's
 *  Managers drag its folders too. */
export function useDatasetDrag(
  selected: Set<string>, canMove: (jobId: string) => boolean,
  onMove: (ids: string[], target: DropTarget) => void,
  onMoveFolder: (folder: Folder, target: DropTarget) => void,
) {
  const [dragging, setDragging] = useState<string[] | null>(null)
  const [draggingFolder, setDraggingFolder] = useState<DraggedFolder | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const end = () => {
    setDragging(null)
    setDraggingFolder(null)
    setOver(null)
  }

  const dragSource = (jobId: string) => ({
    draggable: canMove(jobId),
    onDragStart: (e: DragEvent) => {
      if (!canMove(jobId)) return
      const ids = selected.has(jobId) ? [...selected] : [jobId]
      e.dataTransfer.setData(DATASETS_MIME, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = 'move'
      setDragging(ids)
    },
    onDragEnd: end,
  })

  const folderSource = (dragged: DraggedFolder) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(FOLDER_MIME, String(dragged.folder.id))
      e.dataTransfer.effectAllowed = 'move'
      setDraggingFolder(dragged)
    },
    onDragEnd: end,
  })

  const accepts = (e: DragEvent, target: DropTarget) =>
    carrying(e, DATASETS_MIME) || (carrying(e, FOLDER_MIME) && !!draggingFolder && takes(target, draggingFolder))

  const dropZone = (target: DropTarget): DropZone => {
    const key = keyOf(target)
    const hint = over !== key ? null
      : dragging ? dropHint(dragging.length, target)
      : draggingFolder && takes(target, draggingFolder) ? folderDropHint(draggingFolder.folder, target)
      : null
    const lit = hint !== null
    return {
      lit,
      hint,
      props: {
        'data-drop-target': key,
        ...(lit ? { 'data-drop-active': '' as const } : {}),
        onDragOver: (e) => {
          if (!accepts(e, target)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setOver(key)
        },
        onDragLeave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setOver((prev) => (prev === key ? null : prev))
          }
        },
        onDrop: (e) => {
          if (!accepts(e, target)) return
          e.preventDefault()
          const folder = draggingFolder?.folder
          const ids = carrying(e, DATASETS_MIME)
            ? JSON.parse(e.dataTransfer.getData(DATASETS_MIME)) as string[] : []
          end()
          if (ids.length) onMove(ids, target)
          else if (folder) onMoveFolder(folder, target)
        },
      },
    }
  }

  return { dragSource, folderSource, dropZone }
}
