import { useState } from 'react'
import { exportUrl } from '../../api'
import type { ExportFormat } from '../../api'

const GROUPS: { title: string; formats: { format: ExportFormat; label: string; hint: string }[] }[] = [
  {
    title: 'Standard formats, with the scans',
    formats: [
      { format: 'page', label: 'PAGE XML', hint: 'Transkribus, eScriptorium, OCR-D' },
      { format: 'alto', label: 'ALTO', hint: 'libraries, eScriptorium' },
      { format: 'hocr', label: 'hOCR', hint: 'Tesseract, Kraken, OCRopus' },
      { format: 'tei', label: 'TEI', hint: 'editions, text linked to the scans' },
    ],
  },
  {
    title: 'DeepLabel',
    formats: [
      { format: 'zip', label: 'DeepLabel zip', hint: 'everything, with scans - imports into DeepLabel' },
      { format: 'json', label: 'JSON', hint: 'everything, as data' },
      { format: 'md', label: 'Markdown', hint: 'text by page and region' },
      { format: 'txt', label: 'Plain text', hint: 'text in reading order' },
    ],
  },
]

/** The download formats of a dataset, the standard ones first, with the choice of taking
 *  only what was reviewed. Rendered inside the dataset page's and the list's menus. */
export function ExportMenu({ jobId, onPicked }: { jobId: string; onPicked: () => void }) {
  const [reviewed, setReviewed] = useState(false)
  return (
    <div data-testid="export-menu" className="w-72 py-1" onClick={(e) => e.stopPropagation()}>
      <label className="flex cursor-pointer items-center gap-2 border-b border-line px-2.5 pb-2 pt-1 text-xs text-ink">
        <input type="checkbox" data-testid="export-reviewed" checked={reviewed}
               onChange={(e) => setReviewed(e.target.checked)} className="accent-accent" />
        Reviewed lines only
      </label>
      {GROUPS.map((group) => (
        <div key={group.title}>
          <div className="px-2.5 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-ink-subtle">{group.title}</div>
          {group.formats.map(({ format, label, hint }) => (
            <a key={format} data-testid="export-format" data-format={format} aria-label={label}
               href={exportUrl(jobId, format, reviewed)} target="_blank" rel="noreferrer" onClick={onPicked}
               className="flex items-baseline justify-between gap-3 px-2.5 py-1.5 text-xs text-ink hover:bg-accent-wash hover:text-accent-ink">
              <span className="font-medium">{label}</span>
              <span className="truncate text-[11px] text-ink-subtle">{hint}</span>
            </a>
          ))}
        </div>
      ))}
    </div>
  )
}
