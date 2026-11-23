import { useState } from 'react'
import type { MetadataEntry } from '../api'
import { Button } from './ui/Button'
import { Input } from './ui/Field'

/** Free key and value pairs - a date, a folio, a shelfmark - read as a list and edited in place
 *  by whoever may. Rows left empty are dropped on saving. */
export function MetadataEditor({ entries, canEdit, onSave, testId }: {
  entries: MetadataEntry[]
  canEdit: boolean
  onSave: (entries: MetadataEntry[]) => Promise<MetadataEntry[]>
  testId: string
}) {
  const [draft, setDraft] = useState<MetadataEntry[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = () => {
    if (!draft) return
    setSaving(true)
    setError(null)
    onSave(draft.map((e) => ({ key: e.key.trim(), value: e.value.trim() })).filter((e) => e.key || e.value))
      .then(() => setDraft(null))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false))
  }
  const put = (index: number, entry: Partial<MetadataEntry>) =>
    setDraft((rows) => rows && rows.map((row, i) => (i === index ? { ...row, ...entry } : row)))

  if (draft) {
    return (
      <div data-testid={testId} data-editing="true" className="space-y-1.5">
        {draft.map((entry, i) => (
          <div key={i} className="flex items-center gap-1.5" data-testid="metadata-draft-row">
            <Input size="xs" className="w-24 shrink-0" aria-label={`Field ${i + 1}`} placeholder="Field"
                   value={entry.key} onChange={(e) => put(i, { key: e.target.value })} />
            <Input size="xs" className="min-w-0 flex-1" aria-label={`Value ${i + 1}`} placeholder="Value"
                   value={entry.value} onChange={(e) => put(i, { value: e.target.value })} />
            <Button size="xs" variant="ghost" aria-label={`Remove field ${i + 1}`}
                    onClick={() => setDraft(draft.filter((_, j) => j !== i))}>×</Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button size="xs" variant="ghost" data-testid="metadata-add"
                  onClick={() => setDraft([...draft, { key: '', value: '' }])}>+ Field</Button>
          <span className="ml-auto flex gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => { setDraft(null); setError(null) }}>Cancel</Button>
            <Button size="xs" variant="primary" data-testid="metadata-save" disabled={saving} onClick={save}>Save</Button>
          </span>
        </div>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    )
  }

  return (
    <div data-testid={testId}>
      {entries.length > 0 ? (
        <dl className="space-y-0.5">
          {entries.map((entry) => (
            <div key={entry.key} className="flex gap-2" data-testid="metadata-row" data-key={entry.key}>
              <dt className="w-24 shrink-0 truncate text-ink-muted" title={entry.key}>{entry.key}</dt>
              <dd className="min-w-0 flex-1 break-words text-ink">{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-ink-subtle">None yet</p>
      )}
      {canEdit && (
        <Button size="xs" variant="ghost" className="mt-1 -ml-1.5" data-testid="metadata-edit"
                onClick={() => setDraft(entries.length > 0 ? entries : [{ key: '', value: '' }])}>
          {entries.length > 0 ? 'Edit' : 'Add'}
        </Button>
      )}
    </div>
  )
}
