import { useEffect, useState } from 'react'
import { listGroups, type Group } from '../../api'
import { CaretIcon } from '../icons'
import { Button } from '../ui/Button'
import { popoverChrome } from '../ui/Card'
import { useDropPlacement } from '../ui/dropPlacement'
import { useDismiss } from '../ui/menu'

/** The workspaces someone is put into at once (#134), for an admin inviting or approving them: a
 *  button naming what is ticked, over the list to tick. A Sandbox is nobody else's, so none is
 *  offered. */
export function WorkspacePicker({ chosen, onChange, disabled = false, testId }: {
  chosen: number[]
  onChange: (ids: number[]) => void
  disabled?: boolean
  testId: string
}) {
  const [open, setOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Group[] | null>(null)
  const placement = useDropPlacement(open)
  useDismiss(open, () => setOpen(false))
  useEffect(() => {
    listGroups()
      .then((all) => setWorkspaces(all.filter((g) => g.sandbox_of === null)
        .sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setWorkspaces([]))
  }, [])
  const names = (workspaces ?? []).filter((w) => chosen.includes(w.id)).map((w) => w.name)
  const shown = names.length === 0 ? 'None' : names.join(', ')
  const toggle = (id: number, on: boolean) => onChange(on ? [...chosen, id] : chosen.filter((c) => c !== id))

  return (
    <span className="relative inline-flex">
      <Button size="md" variant="outline" data-testid={testId} disabled={disabled || workspaces?.length === 0}
              aria-haspopup="true" aria-expanded={open} title={names.join(', ') || 'Put them into workspaces at once'}
              onClick={(e) => {
                e.stopPropagation()
                setOpen((v) => !v)
              }}>
        <span className="text-ink-muted">Workspaces</span>
        <span className="max-w-48 truncate">{shown}</span>
        <CaretIcon />
      </Button>
      {open && (
        <div ref={placement.ref} onClick={(e) => e.stopPropagation()}
             className={`${placement.className} left-0 z-20 max-h-72 w-64 overflow-y-auto ${popoverChrome} p-1`}>
          {workspaces === null && <p className="px-2 py-1 text-sm text-ink-subtle">Loading…</p>}
          {workspaces?.map((w) => (
            <label key={w.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-raised">
              <input type="checkbox" className="cursor-pointer accent-accent" checked={chosen.includes(w.id)}
                     onChange={(e) => toggle(w.id, e.target.checked)} />
              <span className="truncate">{w.name}</span>
            </label>
          ))}
        </div>
      )}
    </span>
  )
}
