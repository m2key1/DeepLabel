import { useState } from 'react'
import type { FormEvent } from 'react'

import { changeFolder, createFolder, deleteFolder } from '../../api'
import type { Folder, Group } from '../../api'
import { Modal, modalBtn, modalDangerBtn, modalPrimaryBtn } from '../Modal'
import { Input, Select } from '../ui/Field'
import { flatten, folderTree, itselfAndBelow } from './folders'

/** What a folder dialog is about: a new folder in a workspace or a folder, or one already there. */
export type FolderAction =
  | { kind: 'new'; group: Group; parent: Folder | null }
  | { kind: 'rename' | 'move' | 'delete'; group: Group; folder: Folder }

const TOP = ''

function useSaving(onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** Folders only sort a workspace's datasets (#133): making, moving or deleting one changes
 *  nobody's access, so none of these dialogs has anything to warn about but names. */
export function FolderDialog({ action, datasetsIn, onClose, onDone }: {
  action: FolderAction
  /** How many datasets the caller sees directly in a folder, for the delete's summary. */
  datasetsIn: (folder: Folder) => number
  onClose: () => void
  onDone: () => void
}) {
  if (action.kind === 'new' || action.kind === 'rename') {
    return <NameDialog action={action} onClose={onClose} onDone={onDone} />
  }
  if (action.kind === 'move') return <MoveDialog group={action.group} folder={action.folder} onClose={onClose} onDone={onDone} />
  return <DeleteDialog group={action.group} folder={action.folder} datasets={datasetsIn(action.folder)}
                       onClose={onClose} onDone={onDone} />
}

function NameDialog({ action, onClose, onDone }: {
  action: FolderAction
  onClose: () => void
  onDone: () => void
}) {
  const renaming = action.kind === 'rename' ? action.folder : null
  const [name, setName] = useState(renaming?.name ?? '')
  const { busy, error, run } = useSaving(onDone)
  const where = action.kind === 'new' ? (action.parent?.name ?? action.group.name) : ''

  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(() => renaming
      ? changeFolder(renaming.id, { name })
      : createFolder(action.group.id, name, action.kind === 'new' ? action.parent?.id ?? null : null))
  }

  return (
    <Modal title={renaming ? `Rename folder "${renaming.name}"` : `New folder in "${where}"`} onClose={onClose}>
      <form onSubmit={save}>
        <label className="mb-3 flex flex-col gap-1 text-xs text-ink-muted">
          Name
          <Input size="md" autoFocus value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={modalBtn}>Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className={modalPrimaryBtn}>
            {renaming ? 'Rename' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function MoveDialog({ group, folder, onClose, onDone }: {
  group: Group
  folder: Folder
  onClose: () => void
  onDone: () => void
}) {
  const folders = group.folders ?? []
  const barred = itselfAndBelow(folders, folder.id)
  const places = flatten(folderTree(folders)).filter((node) => !barred.has(node.folder.id))
  const [into, setInto] = useState(folder.parent_id === null ? TOP : String(folder.parent_id))
  const { busy, error, run } = useSaving(onDone)
  const unchanged = into === (folder.parent_id === null ? TOP : String(folder.parent_id))

  return (
    <Modal title={`Move folder "${folder.name}"`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        The folder and everything in it move within {group.name}. Who sees its datasets stays the same.
      </p>
      <label className="mb-3 flex flex-col gap-1 text-xs text-ink-muted">
        Into
        <Select size="md" aria-label="Into" value={into} disabled={busy} onChange={(e) => setInto(e.target.value)}>
          <option value={TOP}>The top of {group.name}</option>
          {places.map(({ folder: place, depth }) => (
            <option key={place.id} value={place.id}>{'  '.repeat(depth)}{place.name}</option>
          ))}
        </Select>
      </label>
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button disabled={busy || unchanged} className={modalPrimaryBtn}
                onClick={() => void run(() => changeFolder(folder.id, { parent_id: into === TOP ? null : Number(into) }))}>
          Move
        </button>
      </div>
    </Modal>
  )
}

const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

function DeleteDialog({ group, folder, datasets, onClose, onDone }: {
  group: Group
  folder: Folder
  datasets: number
  onClose: () => void
  onDone: () => void
}) {
  const folders = (group.folders ?? []).filter((f) => f.parent_id === folder.id).length
  const above = (group.folders ?? []).find((f) => f.id === folder.parent_id)
  const { busy, error, run } = useSaving(onDone)
  const held = [datasets > 0 && counted(datasets, 'dataset'), folders > 0 && counted(folders, 'folder')]
    .filter(Boolean).join(' and ')

  return (
    <Modal title={`Delete folder "${folder.name}"`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        {held
          ? `The ${held} in it move to ${above ? above.name : `the top of ${group.name}`}. Nothing is deleted but the folder.`
          : 'It is empty.'}
      </p>
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button disabled={busy} className={modalDangerBtn} onClick={() => void run(() => deleteFolder(folder.id))}>
          Delete
        </button>
      </div>
    </Modal>
  )
}
