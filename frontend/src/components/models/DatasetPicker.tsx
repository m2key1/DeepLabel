import { useMemo, useState } from 'react'
import type { Group, Job } from '../../api'
import { Badge } from '../ui/Badge'
import { Input } from '../ui/Field'

interface DatasetPickerProps {
  jobs: Job[] | null
  groups: Group[]
  /** Eligible items per dataset. A dataset with none is left out of the list. */
  counts: Record<string, number>
  chosen: Set<string>
  onToggle: (jobId: string) => void
  onSetMany: (jobIds: string[], on: boolean) => void
}

export interface DatasetSection {
  key: number | 'ungrouped' | 'all'
  label: string
  jobs: Job[]
}

/** Datasets in the sections the Jobs page shows, so a dataset is where its project put it.
 *  One definition, because the training form groups its test-set dropdown the same way and
 *  two rules that are meant to agree eventually stop agreeing. */
export function datasetSections(jobs: Job[] | null, groups: Group[]): DatasetSection[] {
  const byGroup = new Map<number | null, Job[]>()
  for (const job of jobs ?? []) {
    const key = job.group_id ?? null
    byGroup.set(key, [...(byGroup.get(key) ?? []), job])
  }
  const named: DatasetSection[] = groups
    .map((group) => ({ key: group.id, label: group.name, jobs: byGroup.get(group.id) ?? [] }))
    .filter((s) => s.jobs.length > 0)
  const loose = byGroup.get(null) ?? []
  return loose.length && named.length
    ? [...named, { key: 'ungrouped', label: 'Ungrouped', jobs: loose }]
    : named.length ? named : [{ key: 'all', label: '', jobs: loose }]
}

/** The datasets to run something over. Shared by training and evaluation: both pick datasets
 *  by the same rules, and a list that groups in one dialog and not the other reads as two
 *  different sets of datasets. A dataset with nothing to use is left out rather than listed
 *  dimmed, a group folds until it holds a pick or a search reaches into it, and the picks
 *  stand above the list so a long one never hides what was chosen. */
export function DatasetPicker({ jobs, groups, counts, chosen, onToggle, onSetMany }: DatasetPickerProps) {
  const sections = useMemo(() => datasetSections(jobs, groups), [jobs, groups])
  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState<Partial<Record<DatasetSection['key'], boolean>>>({})

  const needle = query.trim().toLowerCase()
  // A dataset whose count has not arrived yet stays listed; one known to hold nothing goes.
  const usable = (job: Job) => counts[job.id] !== 0
  const matches = (job: Job) => usable(job) && (!needle || job.name.toLowerCase().includes(needle))
  const hidden = (jobs ?? []).filter((job) => !usable(job)).length
  const picks = (jobs ?? []).filter((job) => chosen.has(job.id))
  // What a search shows is what Select all means, so a filtered list can be taken whole.
  const selectable = (jobs ?? []).filter((job) => matches(job) && counts[job.id] !== undefined)
  const allChosen = selectable.length > 0 && selectable.every((job) => chosen.has(job.id))

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-2">
        <Input
          size="sm"
          type="search"
          aria-label="Search datasets"
          placeholder="Search datasets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1"
        />
        {selectable.length > 1 && (
          <button type="button" data-testid="datasets-select-all"
                  onClick={() => onSetMany(selectable.map((j) => j.id), !allChosen)}
                  className="shrink-0 text-xs font-medium text-accent-ink hover:underline">
            {allChosen ? 'Clear all' : needle ? `Select all ${selectable.length}` : 'Select all'}
          </button>
        )}
        {hidden > 0 && (
          <span data-testid="datasets-hidden" className="shrink-0 text-[11px] text-ink-subtle">
            {hidden} hidden: nothing to use
          </span>
        )}
      </div>
      {picks.length > 0 && (
        <div data-testid="dataset-picks" className="mb-1 flex flex-wrap gap-1">
          {picks.map((job) => (
            <Badge key={job.id} tone="accent" data-testid="dataset-pick" className="inline-flex items-center gap-1">
              <span className="max-w-48 truncate">{job.name}</span>
              <button type="button" aria-label={`Remove ${job.name}`} onClick={() => onToggle(job.id)}
                      className="hover:text-ink">
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="max-h-80 space-y-1 overflow-auto rounded border border-line p-2">
        {jobs === null && <p className="text-sm text-ink-muted">Loading…</p>}
        {sections.map((section) => {
          const listed = section.jobs.filter(matches)
          if (listed.length === 0) return null
          const picked = section.jobs.filter((j) => usable(j) && chosen.has(j.id)).length
          const eligible = section.jobs.filter(usable).length
          const pickedHere = listed.filter((j) => chosen.has(j.id)).length
          const open = !section.label || !!needle || !(folded[section.key] ?? picked === 0)
          return (
            <div key={section.key} data-testid="dataset-group" data-group={section.label || undefined}>
              {section.label && (
                <div className="flex items-baseline gap-2 px-1 pt-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setFolded((prev) => ({ ...prev, [section.key]: open }))}
                    className="flex min-w-0 items-baseline gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
                  >
                    <span className="text-[10px]">{open ? '▾' : '▸'}</span>
                    <span className="truncate">{section.label}</span>
                  </button>
                  <span className="text-[11px] text-ink-subtle">
                    {picked}/{eligible}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSetMany(listed.map((j) => j.id), pickedHere !== listed.length)}
                    className="text-[11px] text-ink-muted hover:text-accent-ink"
                  >
                    {pickedHere === listed.length ? 'Clear' : 'Add all'}
                  </button>
                </div>
              )}
              {open && listed.map((job) => (
                <label
                  key={job.id}
                  data-testid="dataset-option"
                  className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-raised ${
                    section.label ? 'pl-3' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={counts[job.id] === undefined}
                    checked={chosen.has(job.id)}
                    onChange={() => onToggle(job.id)}
                    className="cursor-pointer accent-accent"
                  />
                  <span className="min-w-0 flex-1 truncate">{job.name}</span>
                  <span className="text-xs text-ink-muted">{counts[job.id] ?? ''}</span>
                </label>
              ))}
            </div>
          )
        })}
        {jobs?.length === 0 && <p className="text-sm text-ink-muted">No datasets.</p>}
        {jobs !== null && jobs.length > 0 && !jobs.some(matches) && (
          <p className="text-sm text-ink-muted">{needle ? 'No dataset matches.' : 'No dataset has anything to use.'}</p>
        )}
      </div>
    </div>
  )
}
