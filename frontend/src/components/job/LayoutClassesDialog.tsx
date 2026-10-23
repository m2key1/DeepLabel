import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  addJobLayoutClass, changeJobLayoutClass, getJobLayoutClasses, removeJobLayoutClass, reorderJobLayoutClasses,
  saveLayoutTemplate,
} from '../../api'
import type { DatasetLayoutClass, LayoutReads, LayoutRole } from '../../api'
import { useAutoClear } from '../../messages'
import { classHex } from '../../util'
import { RoleSelect } from '../layout/ClassListEditor'
import { Modal, modalBtn } from '../Modal'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Field'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A dataset's own layout classes, edited in place: every change applies at once, and the
 *  elements of a renamed, retyped or removed class follow it. */
export function LayoutClassesDialog({ jobId, canEdit, onClose, onChanged }: {
  jobId: string
  canEdit: boolean
  onClose: () => void
  onChanged?: () => void
}) {
  const [classes, setClasses] = useState<DatasetLayoutClass[]>([])
  const [schematismus, setSchematismus] = useState(false)
  const [names, setNames] = useState<Record<number, string>>({})
  const [removing, setRemoving] = useState<DatasetLayoutClass | null>(null)
  const [mergeInto, setMergeInto] = useState<number | ''>('')
  const [adding, setAdding] = useState<{ name: string; role: LayoutRole; reads: LayoutReads | null }>(
    { name: '', role: 'content', reads: null })
  const [templateName, setTemplateName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  useAutoClear(notice, setNotice)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [busy, setBusy] = useState(false)

  const load = () => getJobLayoutClasses(jobId).then((found) => {
    setClasses(found.classes)
    setSchematismus(found.schematismus)
    setNames(Object.fromEntries(found.classes.map((c) => [c.id, c.name])))
  }).catch((e: Error) => setError(e.message))
  useEffect(() => { load() }, [jobId])

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    try {
      const said = await action()
      await load()
      if (said) setNotice(said)
      onChanged?.()
    } catch (e) {
      setError((e as Error).message)
      await load()
    } finally {
      setBusy(false)
    }
  }
  const change = (c: DatasetLayoutClass, body: Parameters<typeof changeJobLayoutClass>[2]) =>
    run(async () => {
      const done = await changeJobLayoutClass(jobId, c.id, body)
      return done.elements_changed ? `${plural(done.elements_changed, 'box', 'boxes')} of ${c.name} changed with it.` : null
    })
  const rename = (c: DatasetLayoutClass) => {
    const next = (names[c.id] ?? '').trim()
    if (next && next !== c.name) change(c, { name: next })
  }
  const move = (index: number, by: number) => {
    const order = classes.map((c) => c.id)
    const [taken] = order.splice(index, 1)
    order.splice(index + by, 0, taken)
    run(async () => { await reorderJobLayoutClasses(jobId, order); return null })
  }
  const remove = (c: DatasetLayoutClass) => run(async () => {
    const into = mergeInto === '' ? undefined : mergeInto
    const done = await removeJobLayoutClass(jobId, c.id, into)
    setRemoving(null)
    const target = classes.find((k) => k.id === into)?.name
    const n = done.elements_affected
    return n === 0 ? `Removed ${c.name}.`
      : target ? `Removed ${c.name}; ${n === 1 ? 'its box is' : `its ${n} boxes are`} now ${target}.`
        : `Removed ${c.name} and its ${plural(n, 'box', 'boxes')}.`
  })

  return (
    <Modal title="Layout classes" width="lg" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        This dataset's own classes. Content holds text; a container groups the boxes inside it and reads
        them top to bottom or left to right. A change applies at once, and the boxes of a class follow it.
        {schematismus && ' The Schematismus classes can be recoloured; to change them, save these classes as a new template.'}
      </p>
      <div className="max-h-[55vh] space-y-1 overflow-y-auto" data-testid="dataset-classes">
        {classes.map((c, i) => (
          <div key={c.id} className="flex flex-wrap items-center gap-2" data-testid="dataset-class"
               data-class-name={c.name}>
            <input
              type="color"
              aria-label={`Colour of ${c.name}`}
              value={classHex(c.stored_as, c.color)}
              disabled={!canEdit || busy}
              onChange={(e) => change(c, { color: e.target.value })}
              className="h-7 w-8 cursor-pointer rounded border border-line-strong disabled:cursor-default"
            />
            <Input size="xs" className="w-44" aria-label={`Name of ${c.name}`} value={names[c.id] ?? c.name}
                   disabled={!canEdit || c.builtin || busy}
                   onChange={(e) => setNames({ ...names, [c.id]: e.target.value })}
                   onBlur={() => rename(c)} onKeyDown={(e) => e.key === 'Enter' && rename(c)} />
            <RoleSelect role={c.role} reads={c.reads} disabled={!canEdit || c.builtin || busy}
                        label={`Role of ${c.name}`} onChange={(role, reads) => change(c, { role, reads })} />
            <span className="w-20 text-xs text-ink-muted" data-testid="class-elements">{plural(c.elements, 'box', 'boxes')}</span>
            {c.builtin && <Badge variant="chip" className="uppercase">Schematismus</Badge>}
            {canEdit && (
              <span className="ml-auto flex gap-0.5">
                <Button variant="ghost" size="xs" aria-label={`Move ${c.name} up`} disabled={busy || i === 0}
                        onClick={() => move(i, -1)}>↑</Button>
                <Button variant="ghost" size="xs" aria-label={`Move ${c.name} down`}
                        disabled={busy || i === classes.length - 1} onClick={() => move(i, 1)}>↓</Button>
                {!c.builtin && (
                  <Button variant="ghost" size="xs" aria-label={`Remove ${c.name}`} disabled={busy}
                          onClick={() => { setRemoving(c); setMergeInto('') }}>Remove</Button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
      {removing && (
        <div className="mt-3 rounded border border-line p-2 text-sm" data-testid="remove-class">
          <p className="mb-2">
            {removing.elements === 0 ? `No box uses ${removing.name}.`
              : `${plural(removing.elements, 'box', 'boxes')} use ${removing.name}. Delete them, or make them another class:`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {removing.elements > 0 && (
              <Select size="xs" aria-label="Merge into" value={mergeInto}
                      onChange={(e) => setMergeInto(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">Delete the boxes</option>
                {classes.filter((k) => k.id !== removing.id).map((k) => (
                  <option key={k.id} value={k.id}>Make them {k.name}</option>
                ))}
              </Select>
            )}
            <Button variant="danger" size="xs" data-testid="confirm-remove-class" disabled={busy}
                    onClick={() => remove(removing)}>Remove {removing.name}</Button>
            <Button variant="ghost" size="xs" onClick={() => setRemoving(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Input size="xs" className="w-44" aria-label="New class name" placeholder="New class" value={adding.name}
                 onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          <RoleSelect role={adding.role} reads={adding.reads} label="Role of the new class"
                      onChange={(role, reads) => setAdding({ ...adding, role, reads })} />
          <Button size="xs" data-testid="add-dataset-class" disabled={busy || !adding.name.trim()}
                  onClick={() => run(async () => {
                    await addJobLayoutClass(jobId, { ...adding, name: adding.name.trim(), color: null })
                    setAdding({ name: '', role: 'content', reads: null })
                    return `Added ${adding.name.trim()}.`
                  })}>
            Add class
          </Button>
        </div>
      )}
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Input size="xs" className="w-44" aria-label="Template name" placeholder="Template name"
                 value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
          <Button size="xs" data-testid="save-as-template" disabled={busy || !templateName.trim()}
                  onClick={() => run(async () => {
                    const saved = await saveLayoutTemplate(templateName.trim(), jobId)
                    setTemplateName('')
                    return `Saved as the template "${saved.name}".`
                  })}>
            Save as template
          </Button>
          <Link to="/templates" className="text-xs text-accent-ink hover:underline">Layout templates</Link>
        </div>
      )}
      {notice && <p className="mt-2 text-sm text-ok" role="status">{notice}</p>}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      <div className="mt-3 flex justify-end">
        <button onClick={onClose} className={modalBtn}>Close</button>
      </div>
    </Modal>
  )
}
