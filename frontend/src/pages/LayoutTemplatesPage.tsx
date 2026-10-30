import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createLayoutTemplate, deleteLayoutTemplate, getLayoutTemplates, makeDefaultLayoutTemplate, updateLayoutTemplate,
} from '../api'
import type { LayoutClassDraft, LayoutTemplate, OutsideOrder } from '../api'
import { useAuth } from '../auth'
import { ClassListEditor } from '../components/layout/ClassListEditor'
import { useCrumb } from '../components/NavBar'
import { Badge } from '../components/ui/Badge'
import { Button, buttonClass } from '../components/ui/Button'
import { controlClass } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'
import { useAutoClear } from '../messages'

const inputClass = controlClass('md', 'w-full')

const drafts = (template: LayoutTemplate): LayoutClassDraft[] =>
  template.classes.map(({ id, name, role, reads, color }) => ({ id, name, role, reads, color }))

export function LayoutTemplatesPage() {
  useCrumb('Layout templates')
  const { canEdit, isAdmin, user } = useAuth()
  const [templates, setTemplates] = useState<LayoutTemplate[]>([])
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null)
  const [name, setName] = useState('')
  const [classes, setClasses] = useState<LayoutClassDraft[]>([])
  const [outside, setOutside] = useState<OutsideOrder>('from_page')
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [notice, setNotice] = useState<string | null>(null)
  useAutoClear(notice, setNotice)
  const [busy, setBusy] = useState(false)

  const refresh = () => getLayoutTemplates().then(setTemplates).catch((e: Error) => setError(e.message))
  useEffect(() => { refresh() }, [])

  const selected = useMemo(
    () => (typeof selectedId === 'number' ? templates.find((t) => t.id === selectedId) ?? null : null),
    [templates, selectedId])
  const editable = selectedId === 'new'
    || (!!selected && !selected.builtin && (isAdmin || selected.owner === user))

  const open = (template: LayoutTemplate) => {
    setSelectedId(template.id)
    setName(template.name)
    setClasses(drafts(template))
    setOutside(template.outside_order)
  }
  const startNew = (from?: LayoutTemplate) => {
    setSelectedId('new')
    setName(from ? `${from.name} copy` : '')
    // A copy is a new template: its classes start again from id 1.
    setClasses(from ? drafts(from).map(({ id: _id, ...rest }) => rest)
      : [{ name: '', role: 'content', reads: null, color: null }])
    setOutside(from?.outside_order ?? 'from_page')
  }
  const act = async (action: () => Promise<LayoutTemplate | void>, done: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      await refresh()
      if (result) open(result)
      setNotice(done)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = () => act(
    () => (selectedId === 'new' ? createLayoutTemplate(name.trim(), classes, outside)
      : updateLayoutTemplate(selectedId as number, { name: name.trim(), classes, outside_order: outside })),
    `Saved "${name.trim()}". Datasets made from it before keep their own classes.`)

  return (
    <div className="w-full px-6 py-6">
      <PageHeader title="Layout templates"
                  actions={<Link to="/new" className={buttonClass()}>New dataset</Link>}>
        The layout classes a new dataset starts with. Each class is content, which holds text, or a
        container, which groups the boxes inside it and reads them top to bottom or left to right. A dataset gets its own
        copy of its template's classes, so changing a template leaves existing datasets as they are. A layout model
        belongs to a template, and the datasets it reads follow that template's reading order.
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div>
          <div className="space-y-1 rounded border border-line p-1">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                data-testid="template-row"
                aria-current={template.id === selectedId ? 'true' : undefined}
                onClick={() => open(template)}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm ${
                  template.id === selectedId ? 'bg-accent-wash' : 'hover:bg-raised'}`}
              >
                <span className="min-w-0 flex-1 truncate">{template.name}</span>
                {template.is_default && <Badge tone="accent">Default</Badge>}
                {template.builtin
                  ? <span className="text-[10px] uppercase text-ink-subtle">built in</span>
                  : <span className="text-[10px] uppercase text-ink-subtle">{template.owner}</span>}
              </button>
            ))}
          </div>
          {canEdit && (
            <Button variant="ghost" size="xs" className="mt-2" data-testid="new-template" onClick={() => startNew()}>
              + New template
            </Button>
          )}
        </div>
        <div>
          {selectedId === null ? (
            <p className="text-sm text-ink-muted">Select a template to see its classes, or make a new one.</p>
          ) : (
            <>
              <div className="mb-3 max-w-md">
                <label className="mb-1 block text-sm font-medium text-ink" htmlFor="template-name">Name</label>
                <input id="template-name" value={name} disabled={!editable}
                       onChange={(e) => setName(e.target.value)} className={`${inputClass} disabled:opacity-60`} />
              </div>
              <div className="mb-3 max-w-md">
                <label className="mb-1 block text-sm font-medium text-ink" htmlFor="template-outside">
                  Outside containers, read
                </label>
                <select id="template-outside" data-testid="template-outside" value={outside} disabled={!editable}
                        onChange={(e) => setOutside(e.target.value as OutsideOrder)}
                        className={`${inputClass} disabled:opacity-60`}>
                  <option value="top_to_bottom">top to bottom, as the Schematismus pipeline does</option>
                  <option value="from_page">by the page's leaves and columns, worked out or as the dataset says</option>
                </select>
              </div>
              {selected?.builtin && (
                <p className="mb-2 text-xs text-ink-muted">
                  Schematismus is built in: its reading rules and the Schematismus models know its classes by
                  name. Copy it to make a template of your own.
                </p>
              )}
              <ClassListEditor classes={classes} onChange={setClasses} disabled={!editable} />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {editable && (
                  <Button variant="primary" size="sm" data-testid="save-template"
                          disabled={busy || !name.trim() || classes.some((c) => !c.name.trim())} onClick={save}>
                    Save
                  </Button>
                )}
                {selected && canEdit && (
                  <Button size="sm" data-testid="copy-template" disabled={busy} onClick={() => startNew(selected)}>
                    Copy
                  </Button>
                )}
                {selected && isAdmin && !selected.is_default && (
                  <Button size="sm" data-testid="make-default" disabled={busy}
                          onClick={() => act(() => makeDefaultLayoutTemplate(selected.id),
                                             `New datasets now start with "${selected.name}".`)}>
                    Make default
                  </Button>
                )}
                {selected && editable && !selected.is_default && (
                  <Button variant="danger" size="sm" data-testid="delete-template" disabled={busy}
                          onClick={() => act(async () => {
                            await deleteLayoutTemplate(selected.id)
                            setSelectedId(null)
                          }, `Deleted "${selected.name}".`)}>
                    Delete
                  </Button>
                )}
              </div>
              {notice && <p className="mt-2 text-sm text-ok" role="status">{notice}</p>}
              {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
