import { useState } from 'react'
import type { MapClass } from '../../api'
import { hexToRgb } from '../../lib/color'
import { Modal, modalBtn, modalDangerBtn, modalPrimaryBtn } from '../Modal'
import { Check, Input, Select } from '../ui/Field'

// The two class-vocabulary dialogs for the tile editor. Each owns its own form state:
// the editor only decides which one is open and what to do with the result.

interface AddClassDialogProps {
  onAdd: (name: string, color: [number, number, number]) => void
  onClose: () => void
}

export function AddClassDialog({ onAdd, onClose }: AddClassDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#ff8800')
  const submit = () => name.trim() && onAdd(name.trim(), hexToRgb(color))

  return (
    <Modal title="Add class" onClose={onClose}>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input
          type="color"
          aria-label="Class colour"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded border border-line-strong"
        />
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Class name"
          aria-label="Class name"
          size="md"
          className="flex-1"
        />
      </label>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button onClick={submit} disabled={!name.trim()}
                className={`${modalPrimaryBtn} disabled:opacity-40`}>Add</button>
      </div>
    </Modal>
  )
}

interface RemoveClassDialogProps {
  target: MapClass
  /** The other drawable classes, i.e. the classes its regions could be merged into. */
  others: MapClass[]
  onRemove: (mode: 'delete' | 'merge', into?: number) => void
  onClose: () => void
}

export function RemoveClassDialog({ target, others, onRemove, onClose }: RemoveClassDialogProps) {
  const [mode, setMode] = useState<'delete' | 'merge'>('delete')
  const [into, setInto] = useState<number | null>(others[0]?.id ?? null)
  const merging = mode === 'merge' && into !== null
  const n = target.regions ?? 0

  return (
    <Modal title={`Remove class "${target.name}"`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        {n === 0
          ? 'No regions across the job use this class.'
          : `${n} region(s) across the job use this class. Choose what happens to them:`}
      </p>
      {n > 0 && (
        <div className="mb-3 space-y-1.5 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <Check type="radio" checked={mode === 'delete'} onChange={() => setMode('delete')} />
            Delete all {n} region(s)
          </label>
          {others.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2">
              <Check type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} />
              Reassign to
              <Select
                size="xs"
                value={into ?? ''}
                onChange={(e) => { setInto(Number(e.target.value)); setMode('merge') }}
              >
                {others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </label>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button
          onClick={() => onRemove(merging ? 'merge' : 'delete', into ?? undefined)}
          className={modalDangerBtn}
        >
          {merging ? 'Merge & remove' : 'Remove'}
        </button>
      </div>
    </Modal>
  )
}
