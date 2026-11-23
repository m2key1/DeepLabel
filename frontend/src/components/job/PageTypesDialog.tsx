import { useCallback, useEffect, useState } from 'react'
import { listPageTypes, patchPageType } from '../../api'
import type { PageType } from '../../api'
import { useAutoClear } from '../../messages'
import { Modal, modalBtn } from '../Modal'
import { Input } from '../ui/Field'

const STEPS = [
  { key: 'run_layout', label: 'Find layout' },
  { key: 'run_lines', label: 'Find lines' },
  { key: 'run_ocr', label: 'Read text' },
] as const

/** A dataset's own page types: each renamed in place, and the steps of a run it leaves on for
 *  its pages. A change applies at once, and to the next run. */
export function PageTypesDialog({ jobId, canEdit, onClose, onChanged }: {
  jobId: string
  canEdit: boolean
  onClose: () => void
  onChanged?: () => void
}) {
  const [types, setTypes] = useState<PageType[]>([])
  const [names, setNames] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const load = useCallback(() => listPageTypes(jobId).then((found) => {
    setTypes(found.types)
    setNames(Object.fromEntries(found.types.map((t) => [t.id, t.name])))
  }).catch((e: Error) => setError(e.message)), [jobId])
  useEffect(() => { load() }, [load])

  const change = (type: PageType, body: Parameters<typeof patchPageType>[2]) => {
    setBusy(true)
    setTypes((now) => now.map((t) => (t.id === type.id ? { ...t, ...body } : t)))
    patchPageType(jobId, type.id, body)
      .then(() => onChanged?.())
      .catch((e: Error) => setError(e.message))
      .finally(() => { setBusy(false); load() })
  }
  const rename = (type: PageType) => {
    const next = (names[type.id] ?? '').trim()
    if (next && next !== type.name) change(type, { name: next })
  }

  return (
    <Modal title="Page types" width="lg" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        This dataset's own page types. A page without one is text. Each type says which steps a run takes
        on its pages; a change applies from the next run on.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="page-types">
          <thead className="text-left text-xs text-ink-subtle">
            <tr>
              <th className="py-1 pr-2 font-normal">Type</th>
              {STEPS.map((step) => <th key={step.key} className="px-2 py-1 text-center font-normal">{step.label}</th>)}
              <th className="py-1 pl-2 text-right font-normal">Pages</th>
            </tr>
          </thead>
          <tbody>
            {types.map((type) => (
              <tr key={type.id} data-testid="page-type" data-type-id={type.id} className="border-t border-line">
                <td className="py-1.5 pr-2">
                  <Input size="xs" className="w-full min-w-24 max-w-40" aria-label={`Name of ${type.name}`} value={names[type.id] ?? type.name}
                         disabled={!canEdit || busy}
                         onChange={(e) => setNames({ ...names, [type.id]: e.target.value })}
                         onBlur={() => rename(type)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
                </td>
                {STEPS.map((step) => (
                  <td key={step.key} className="px-2 py-1.5 text-center">
                    <input type="checkbox" aria-label={`${step.label} on ${type.name} pages`} data-step={step.key}
                           checked={type[step.key]} disabled={!canEdit || busy}
                           onChange={(e) => change(type, { [step.key]: e.target.checked })}
                           className="cursor-pointer accent-accent disabled:cursor-default" />
                  </td>
                ))}
                <td className="py-1.5 pl-2 text-right tabular-nums text-ink-muted" data-testid="page-type-pages">
                  {type.pages}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      <div className="mt-3 flex justify-end">
        <button onClick={onClose} className={modalBtn}>Close</button>
      </div>
    </Modal>
  )
}
