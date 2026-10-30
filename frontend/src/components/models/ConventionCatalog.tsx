import { useEffect, useState } from 'react'
import { addConventionFlag, listConventionFlags, updateConventionFlag } from '../../api'
import type { ConventionFlag } from '../../api'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Field'
import { tableCell, tableHeadRow } from '../ui/Table'

interface Draft {
  name: string
  label: string
  description: string
  /** A flag being added, whose name is still being typed. */
  adding: boolean
}

/** The transcription-convention flags with what they mean: everyone reads them, an admin
 *  writes the labels and descriptions every flag list in the app shows. */
export function ConventionCatalog({ canManage, onError }: { canManage: boolean; onError: (message: string) => void }) {
  const [flags, setFlags] = useState<ConventionFlag[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    listConventionFlags().then((r) => setFlags(r.flags)).catch((e: Error) => onError(e.message))
  }, [onError])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const body = { label: draft.label, description: draft.description }
      const saved = draft.adding
        ? await addConventionFlag({ name: draft.name, ...body })
        : await updateConventionFlag(draft.name, body)
      setFlags((all) => [...(all ?? []).filter((f) => f.name !== saved.name), saved]
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })))
      setDraft(null)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const fieldLabel = 'mb-1 block text-xs font-medium text-ink'
  const form = draft && (
    <div data-testid="convention-form" className={`max-w-2xl space-y-3 ${draft.adding ? '' : 'py-1'}`}>
      {draft.adding ? (
        <label className="block">
          <span className={fieldLabel}>Name</span>
          <Input aria-label="Flag name" placeholder="name_as_models_use_it" value={draft.name} autoFocus
                 onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full font-mono" />
          <span className="mt-1 block text-xs text-ink-subtle">Exactly as the models name it - it cannot be changed later.</span>
        </label>
      ) : (
        <div className="text-xs text-ink-muted">Editing <code className="font-mono text-ink">{draft.name}</code></div>
      )}
      <label className="block">
        <span className={fieldLabel}>Label</span>
        <Input aria-label="Label" placeholder="Keep long s" value={draft.label} autoFocus={!draft.adding}
               onChange={(e) => setDraft({ ...draft, label: e.target.value })} className="w-full" />
      </label>
      <label className="block">
        <span className={fieldLabel}>Description</span>
        <Textarea aria-label="Description" rows={3}
                  placeholder="What the rule asks for, with an example: ſ is transcribed as ſ, not s."
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  className="w-full resize-y" />
        <span className="mt-1 block text-xs text-ink-subtle">Shown wherever the flag can be picked.</span>
      </label>
      <div className="flex gap-2">
        <Button variant="primary" disabled={saving || !draft.label.trim() || !draft.name}
                onClick={() => void save()}>Save</Button>
        <Button onClick={() => setDraft(null)}>Cancel</Button>
      </div>
    </div>
  )

  return (
    <div data-testid="convention-catalog">
      {flags !== null && flags.length === 0 && !draft && (
        <p className="mb-3 text-xs text-ink-subtle">No convention flags yet.</p>
      )}
      {flags !== null && flags.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className={tableHeadRow}>
              <th className={`${tableCell} py-1.5`}>Flag</th>
              <th className={`${tableCell} text-right`}>Models that read it</th>
              <th className={`${tableCell} text-right`}>Datasets that ask for it</th>
              {canManage && <th className={tableCell} />}
            </tr>
          </thead>
          <tbody>
            {flags.map((flag) => draft && !draft.adding && draft.name === flag.name ? (
              <tr key={flag.name} className="border-b border-line/60 bg-raised">
                <td colSpan={4} className={`${tableCell} py-3`}>{form}</td>
              </tr>
            ) : (
              <tr key={flag.name} data-testid="convention-row" data-flag={flag.name}
                  className="border-b border-line/60 align-top">
                <td className={`${tableCell} py-2`}>
                  <span className="font-medium text-ink">{flag.label}</span>
                  {flag.label !== flag.name && (
                    <span className="ml-1.5 font-mono text-[11px] text-ink-subtle">{flag.name}</span>
                  )}
                  {!flag.description && <Badge tone="warn" className="ml-1.5">not described yet</Badge>}
                  {flag.description ? (
                    <p className="mt-0.5 text-xs text-ink-muted">{flag.description}</p>
                  ) : flag.added_from && (
                    <p className="mt-0.5 text-xs text-ink-subtle">Added from {flag.added_from}.</p>
                  )}
                </td>
                <td className={`${tableCell} py-2 text-right tabular-nums text-ink-muted`}>{flag.models}</td>
                <td className={`${tableCell} py-2 text-right tabular-nums text-ink-muted`}>{flag.datasets}</td>
                {canManage && (
                  <td className={`${tableCell} py-2 text-right`}>
                    <button type="button" data-testid="convention-edit"
                            onClick={() => setDraft({ name: flag.name, label: flag.label,
                                                      description: flag.description, adding: false })}
                            className="text-xs text-ink-subtle hover:text-accent-ink">
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canManage && (draft?.adding ? (
        <div className="mt-3 rounded-md border border-line bg-raised p-4">{form}</div>
      ) : (
        <Button size="xs" className="mt-3" data-testid="convention-add"
                onClick={() => setDraft({ name: '', label: '', description: '', adding: true })}>
          + Add flag
        </Button>
      ))}
    </div>
  )
}
