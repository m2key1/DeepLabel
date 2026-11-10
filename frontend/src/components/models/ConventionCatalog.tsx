import { useEffect, useState } from 'react'
import { addConventionFlag, listConventionFlags, updateConventionFlag } from '../../api'
import type { ConventionFlag } from '../../api'
import { ConventionExample } from '../ConventionExample'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Field'
import { SwitchKnob } from '../ui/SwitchKnob'
import { tableCell, tableHeadRow } from '../ui/Table'

interface Draft {
  name: string
  label: string
  description: string
  example_on: string
  example_off: string
  /** A flag being added, whose name is still being typed. */
  adding: boolean
}

/** The transcription-convention flags with what they mean: everyone reads the ones on offer,
 *  an admin writes the labels and descriptions every flag list in the app shows, and decides
 *  which flags are offered at all. */
export function ConventionCatalog({ canManage, onError }: { canManage: boolean; onError: (message: string) => void }) {
  const [flags, setFlags] = useState<ConventionFlag[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    listConventionFlags().then((r) => setFlags(r.flags)).catch((e: Error) => onError(e.message))
  }, [onError])

  const replaced = (saved: ConventionFlag) =>
    setFlags((all) => [...(all ?? []).filter((f) => f.name !== saved.name), saved]
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })))

  const setOffered = (name: string, offered: boolean) =>
    updateConventionFlag(name, { offered }).then(replaced).catch((e: Error) => onError(e.message))

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const body = { label: draft.label, description: draft.description,
                     example_on: draft.example_on, example_off: draft.example_off }
      const saved = draft.adding
        ? await addConventionFlag({ name: draft.name, ...body })
        : await updateConventionFlag(draft.name, body)
      replaced(saved)
      setDraft(null)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const shown = canManage ? flags : flags?.filter((f) => f.offered) ?? null
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
      <fieldset>
        <legend className={fieldLabel}>Example</legend>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">With the flag</span>
            <Input aria-label="Example with the flag" placeholder="Waſſer" value={draft.example_on}
                   onChange={(e) => setDraft({ ...draft, example_on: e.target.value })} className="w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">Without it</span>
            <Input aria-label="Example without the flag" placeholder="Wasser" value={draft.example_off}
                   onChange={(e) => setDraft({ ...draft, example_off: e.target.value })} className="w-full" />
          </label>
        </div>
        <span className="mt-1 block text-xs text-ink-subtle">One word as it is transcribed with the flag on, and with it off.</span>
      </fieldset>
      <div className="flex gap-2">
        <Button variant="primary" disabled={saving || !draft.label.trim() || !draft.name}
                onClick={() => void save()}>Save</Button>
        <Button onClick={() => setDraft(null)}>Cancel</Button>
      </div>
    </div>
  )

  return (
    <div data-testid="convention-catalog">
      {shown !== null && shown.length === 0 && !draft && (
        <p className="mb-3 text-xs text-ink-subtle">No convention flags yet.</p>
      )}
      {shown !== null && shown.length > 0 && (
        <div className="relative overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className={tableHeadRow}>
                <th className={`${tableCell} py-1.5`}>Flag</th>
                <th className={`${tableCell} text-right`}>Models that read it</th>
                <th className={`${tableCell} text-right`}>Datasets that ask for it</th>
                {canManage && <th className={`${tableCell} text-center`}>Offered</th>}
                {canManage && <th className={tableCell} />}
              </tr>
            </thead>
            <tbody>
              {shown.map((flag) => draft && !draft.adding && draft.name === flag.name ? (
                <tr key={flag.name} className="border-b border-line/60 bg-raised">
                  <td colSpan={5} className={`${tableCell} py-3`}>{form}</td>
                </tr>
              ) : (
                <tr key={flag.name} data-testid="convention-row" data-flag={flag.name} data-offered={flag.offered}
                    className="border-b border-line/60 align-top">
                  <td className={`${tableCell} py-2`}>
                    <span className={`font-medium ${flag.offered ? 'text-ink' : 'text-ink-muted'}`}>{flag.label}</span>
                    {flag.label !== flag.name && (
                      <span className="ml-1.5 font-mono text-[11px] text-ink-subtle">{flag.name}</span>
                    )}
                    <span className="ml-2"><ConventionExample on={flag.example_on} off={flag.example_off} /></span>
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
                    <td className={`${tableCell} py-2 text-center`}>
                      <label data-testid="convention-offer" className="inline-flex cursor-pointer"
                             title={flag.offered ? 'Offered wherever a flag can be picked' : 'Not offered: reads send it as off'}>
                        <input type="checkbox" role="switch" data-testid="convention-offered" className="peer sr-only"
                               aria-label={`Offer ${flag.label}`} checked={flag.offered}
                               onChange={(e) => void setOffered(flag.name, e.target.checked)} />
                        <span className="mt-1 flex rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
                          <SwitchKnob on={flag.offered} onColor="bg-accent" />
                        </span>
                      </label>
                    </td>
                  )}
                  {canManage && (
                    <td className={`${tableCell} py-2 text-right`}>
                      <button type="button" data-testid="convention-edit"
                              onClick={() => setDraft({ name: flag.name, label: flag.label, description: flag.description,
                                                        example_on: flag.example_on, example_off: flag.example_off,
                                                        adding: false })}
                              className="text-xs text-ink-subtle hover:text-accent-ink">
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && (draft?.adding ? (
        <div className="mt-3 rounded-md border border-line bg-raised p-4">{form}</div>
      ) : (
        <Button size="xs" className="mt-3" data-testid="convention-add"
                onClick={() => setDraft({ name: '', label: '', description: '', example_on: '', example_off: '',
                                          adding: true })}>
          + Add flag
        </Button>
      ))}
    </div>
  )
}
