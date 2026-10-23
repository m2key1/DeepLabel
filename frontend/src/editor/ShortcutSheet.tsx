import { useEffect } from 'react'
import { Modal, modalBtn } from '../components/Modal'

export interface ShortcutGroup {
  title: string
  rows: [keys: string, does: string][]
}

/** The keys and gestures of an editor, on demand. Replaces the legend that used to sit
 *  in the rail for good: what is read once is looked up, not read past every time. */
export function ShortcutSheet({ groups, onClose }: { groups: ShortcutGroup[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    // Capture, so the editor behind never sees the Escape that closes the sheet.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <Modal title="Keyboard shortcuts">
      <div data-testid="shortcut-sheet" className="grid gap-4 sm:grid-cols-2">
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="mb-1 text-xs font-semibold text-ink-muted">{group.title}</h3>
            <dl className="space-y-0.5 text-xs">
              {group.rows.map(([keys, does]) => (
                <div key={keys + does} data-testid="shortcut-row" data-does={does} className="flex gap-2">
                  <dt className="w-24 shrink-0 font-mono text-[11px] text-ink">{keys}</dt>
                  <dd className="min-w-0 text-ink-muted">{does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button className={modalBtn} onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}
