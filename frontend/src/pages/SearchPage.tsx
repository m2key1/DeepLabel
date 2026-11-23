import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listGroups, searchCorpus } from '../api'
import type { CorpusSearch, Group } from '../api'
import { useCrumb } from '../components/NavBar'
import { SEARCH_MODES, marked } from '../components/search/searchControls'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { CheckField, Input, Select } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'
import { Segmented } from '../components/ui/Segmented'
import { pageShell } from '../components/ui/page'
import type { SearchMode } from '../lib/fuzzy'
import { displayed } from '../lib/text'
import { plural } from '../util'

type Answer = CorpusSearch & { asking: string; error?: string }

const MODES = new Set(SEARCH_MODES.map((m) => m.value))

/** One search over every dataset the reader can open. What is asked lives in the address,
 *  so a search can be sent to a colleague and the back button undoes a narrowing. */
export function SearchPage() {
  useCrumb('Search')
  const [params, setParams] = useSearchParams()
  const needle = params.get('q') ?? ''
  const mode = (MODES.has(params.get('mode') as SearchMode) ? params.get('mode') : 'fuzzy') as SearchMode
  const group = params.get('group')
  const job = params.get('job')
  const checked = params.get('checked') === '1'
  const [query, setQuery] = useState(needle)
  const [groups, setGroups] = useState<Group[]>([])
  const [answer, setAnswer] = useState<Answer | null>(null)
  // The datasets the search found before one of them was picked, so the others stay on
  // offer while it is narrowed to one.
  const [found, setFound] = useState<CorpusSearch['datasets']>([])
  const [more, setMore] = useState(false)

  const change = (next: Record<string, string | null>) => setParams((p) => {
    const out = new URLSearchParams(p)
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '') out.delete(key)
      else out.set(key, value)
    }
    return out
  }, { replace: 'q' in next })

  useEffect(() => {
    listGroups().then(setGroups).catch(() => setGroups([]))
  }, [])

  // Back and forward change what is asked under the box; the box follows.
  useEffect(() => setQuery((typed) => typed.trim() === needle ? typed : needle), [needle])

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (query.trim() !== needle) change({ q: query.trim(), job: null })
    }, 300)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const asking = [needle, mode, group, job, checked].join('\u0000')
  useEffect(() => {
    if (!needle) return
    const abort = new AbortController()
    searchCorpus({ q: needle, mode, group, job, checked }, 0, abort.signal)
      .then((result) => {
        setAnswer({ ...result, asking })
        if (!job) setFound(result.datasets)
      })
      .catch((e: Error) => {
        if (!abort.signal.aborted) {
          setAnswer({ usable: true, too_short: false, total: 0, datasets: [], hits: [], asking, error: e.message })
        }
      })
    return () => abort.abort()
  }, [needle, mode, group, job, checked, asking])

  const current = needle && answer?.asking === asking ? answer : null
  const showMore = () => {
    if (!current) return
    setMore(true)
    searchCorpus({ q: needle, mode, group, job, checked }, current.hits.length)
      .then((next) => setAnswer((a) => a && a.asking === asking ? { ...a, hits: [...a.hits, ...next.hits] } : a))
      .catch((e: Error) => setAnswer((a) => a && { ...a, error: e.message }))
      .finally(() => setMore(false))
  }

  const byDataset = useMemo(() => {
    const grouped: { id: string; name: string; hits: CorpusSearch['hits'] }[] = []
    for (const hit of current?.hits ?? []) {
      const last = grouped[grouped.length - 1]
      if (last?.id === hit.job_id) last.hits.push(hit)
      else grouped.push({ id: hit.job_id, name: hit.job_name, hits: [hit] })
    }
    return grouped
  }, [current])
  const totals = Object.fromEntries((current?.datasets ?? []).map((d) => [d.id, d.hits]))
  const workspaces = groups.filter((g) => g.sandbox_of === null || (g.count ?? 1) > 0)

  return (
    <div className={pageShell}>
      <PageHeader title="Search">
        Every line of every dataset you can open. Near spellings count by default, and umlauts
        written out find the same names: Mueller finds Müller.
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
               data-testid="search-input" aria-label="Search every dataset"
               placeholder="A name, a word or a phrase" className="w-full sm:w-96" />
        <Segmented value={mode} onChange={(m) => change({ mode: m === 'fuzzy' ? null : m })} options={SEARCH_MODES} />
        <Select data-testid="search-workspace" aria-label="Workspace" value={group ?? ''}
                onChange={(e) => change({ group: e.target.value || null, job: null })} className="w-full sm:w-56">
          <option value="">Every workspace</option>
          {workspaces.map((g) => (
            <option key={g.id} value={g.id}>{g.sandbox_of ? 'My Sandbox' : g.name}</option>
          ))}
        </Select>
        <CheckField data-testid="search-checked" label="Checked lines only" checked={checked}
                    onChange={(on) => change({ checked: on ? '1' : null })} />
      </div>

      {!needle ? (
        <EmptyState>Type a name, a word or a phrase to look for it in every dataset at once.</EmptyState>
      ) : !current ? (
        <p data-testid="search-summary" aria-live="polite" className="text-sm text-ink-muted">Searching…</p>
      ) : current.error ? (
        <p data-testid="search-summary" role="alert" className="text-sm text-danger">{current.error}</p>
      ) : current.too_short ? (
        <p data-testid="search-summary" aria-live="polite" className="text-sm text-ink-muted">
          Type at least three letters.
        </p>
      ) : !current.usable ? (
        <p data-testid="search-summary" aria-live="polite" className="text-sm text-ink-muted">Not a pattern yet.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p data-testid="search-summary" aria-live="polite" className="text-sm text-ink-muted">
              {current.total === 0 ? 'No line reads like that.'
                : `${plural(current.total, 'line')} in ${plural(current.datasets.length, 'dataset')}`}
            </p>
            {(found.length > 1 || job) && (
              <Select data-testid="search-dataset" aria-label="Dataset" value={job ?? ''} size="sm"
                      onChange={(e) => change({ job: e.target.value || null })} className="w-full sm:w-72">
                <option value="">Every dataset it was found in</option>
                {found.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.hits})</option>)}
              </Select>
            )}
          </div>
          <div className="space-y-6">
            {byDataset.map((dataset) => (
              <section key={dataset.id} data-testid="search-group" data-job={dataset.id}>
                <h2 className="mb-2 flex items-baseline gap-2 border-b border-line pb-1">
                  <Link to={`/jobs/${dataset.id}`} className="font-medium hover:text-accent-ink">{dataset.name}</Link>
                  <span className="text-xs text-ink-subtle">{plural(totals[dataset.id] ?? dataset.hits.length, 'line')}</span>
                </h2>
                <ol className="space-y-1">
                  {dataset.hits.map((hit) => (
                    <li key={hit.line_id}>
                      <Link to={`/jobs/${hit.job_id}/pages/${hit.page_id}?line=${hit.line_id}`}
                            data-testid="search-hit" data-line={hit.line_id}
                            className="group grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded px-2 py-1.5 hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        <span className="pt-0.5 text-xs tabular-nums text-ink-subtle">p. {hit.page_idx + 1}</span>
                        <span className="text-sm">{marked(displayed(hit.text), hit.words, 'search-match')}</span>
                        <img src={hit.crop} alt="" loading="lazy" decoding="async"
                             className="col-start-2 h-8 max-w-full justify-self-start object-contain object-left opacity-90 group-hover:opacity-100" />
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
          {current.hits.length < current.total && (
            <div className="mt-4">
              <Button data-testid="search-more" onClick={showMore} disabled={more}>
                {more ? 'Loading…' : `Show more - ${current.hits.length} of ${current.total}`}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
