import { useState } from 'react'
import type { DragEvent } from 'react'

/** Its own type, so a file dragged in from the desktop or a link dragged off the page is
 *  never taken for datasets. */
const DATASETS_MIME = 'application/x-deeplabel-datasets'

/** Where datasets can be dropped: a group, or Ungrouped, which takes them out. */
export type DropTarget = { groupId: number; name: string } | { groupId: null }

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

const carrying =(e: DragEvent) => e.dataTransfer.types.includes(DATASETS_MIME)

const keyOf = (target: DropTarget) => (target.groupId === null ? 'ungrouped' : String(target.groupId))

export function dropHint(count: number, target: DropTarget): string {
  const datasets = `${count} dataset${count === 1 ? '' : 's'}`
  return target.groupId === null
    ? `Remove ${datasets} from ${count === 1 ? 'its group' : 'their groups'}`
    : `Move ${datasets} to ${target.name}`
}

/** Dragging a ticked dataset carries the selection with it, the way the bulk bar acts on
 *  it; an unticked one goes alone. */
export function useDatasetDrag(
  selected: Set<string>, canDrag: boolean,
  onMove: (ids: string[], groupId: number | null) => void,
) {
  const [dragging, setDragging] = useState<string[] | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const end = () => {
    setDragging(null)
    setOver(null)
  }

  const dragSource = (jobId: string) => ({
    draggable: canDrag,
    onDragStart: (e: DragEvent) => {
      if (!canDrag) return
      const ids = selected.has(jobId) ? [...selected] : [jobId]
      e.dataTransfer.setData(DATASETS_MIME, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = 'move'
      setDragging(ids)
    },
    onDragEnd: end,
  })

  const dropZone = (target: DropTarget): DropZone => {
    const key = keyOf(target)
    const lit = dragging !== null && over === key
    return {
      lit,
      hint: lit ? dropHint(dragging.length, target) : null,
      props: {
        'data-drop-target': key,
        ...(lit ? { 'data-drop-active': '' as const } : {}),
        onDragOver: (e) => {
          if (!carrying(e)) return
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
          if (!carrying(e)) return
          e.preventDefault()
          const ids = JSON.parse(e.dataTransfer.getData(DATASETS_MIME)) as string[]
          end()
          if (ids.length) onMove(ids, target.groupId)
        },
      },
    }
  }

  return { dragging: dragging !== null, dragSource, dropZone }
}
