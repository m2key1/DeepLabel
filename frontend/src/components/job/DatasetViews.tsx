import { Link } from 'react-router-dom'

export type DatasetView = 'pages' | 'transcript' | 'corpus'

const VIEWS: { view: DatasetView; label: string; path: string; title: string }[] = [
  { view: 'pages', label: 'Pages', path: '', title: 'The pages, their state and the scans' },
  { view: 'transcript', label: 'Transcript', path: '/transcript',
    title: 'Read the recognized text in order - reviewed lines in full ink' },
  { view: 'corpus', label: 'Corpus', path: '/corpus',
    title: 'Cut a transcribed corpus across the pages and read them against it' },
]

/** The three ways into a text dataset, as tabs under its header. They are pages of their
 *  own, so they are links, and each of the three shows the same strip. */
export function DatasetViews({ jobId, active, className = '' }: {
  jobId: string
  active: DatasetView
  className?: string
}) {
  return (
    <nav aria-label="Dataset views" data-testid="dataset-views" className={`flex gap-5 text-sm ${className}`.trim()}>
      {VIEWS.map(({ view, label, path, title }) => (
        <Link key={view} to={`/jobs/${jobId}${path}`} title={title} data-view={view}
              data-testid={view === 'corpus' ? 'corpus-open' : undefined}
              aria-current={view === active ? 'page' : undefined}
              className={`py-1.5 ${view === active
                ? 'font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-accent)]'
                : 'text-ink-muted hover:text-ink'}`}>
          {label}
        </Link>
      ))}
    </nav>
  )
}
