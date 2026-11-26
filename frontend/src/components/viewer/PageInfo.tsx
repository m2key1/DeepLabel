import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { conflictOf, listPageTypes, putPageMetadata, setPagesType, TEXT_PAGE_TYPE } from '../../api'
import type { MetadataEntry, PageType } from '../../api'
import { InfoIcon } from '../icons'
import { MetadataEditor } from '../MetadataEditor'
import { popoverChrome } from '../ui/Card'
import { Select } from '../ui/Field'
import { useDismiss, useHangingBelow } from '../ui/menu'

function stepsOf(type: PageType): string {
  const takes = [type.run_layout && 'finds its layout', type.run_lines && 'finds its lines', type.run_ocr && 'reads its text']
    .filter((step): step is string => !!step)
  if (takes.length === 0) return 'A run passes it by.'
  return `A run ${takes.length === 1 ? takes[0] : `${takes.slice(0, -1).join(', ')} and ${takes.at(-1)}`}.`
}

/** A page's own facts beside its scan: its type, which decides the steps a run takes on it,
 *  and its metadata. */
export function PageInfo({ jobId, pageId, filename, pageType, metadata, canEdit, canManage, onChange }: {
  jobId: string
  pageId: number
  /** Shown as the way in: the page's name opens what is known about it. */
  filename: string
  pageType: number | null
  metadata: MetadataEntry[]
  canEdit: boolean
  canManage: boolean
  onChange: (next: { page_type?: number | null; metadata?: MetadataEntry[] }) => void
}) {
  const [open, setOpen] = useState(false)
  const [types, setTypes] = useState<PageType[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) listPageTypes(jobId).then((found) => setTypes(found.types)).catch((e: Error) => setError(e.message))
  }, [open, jobId])

  useDismiss(open, () => setOpen(false))
  const anchor = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const at = useHangingBelow(open, anchor, panel)
  const typeId = pageType ?? TEXT_PAGE_TYPE
  const shown = types.find((type) => type.id === typeId)

  const retype = (next: number) => {
    setError(null)
    setPagesType(jobId, [pageId], next).then(() => onChange({ page_type: next })).catch((e: Error) => setError(e.message))
  }

  // The icon leads, so a narrowing header takes the name first; the type is set from the page table too.
  return (
    <div ref={anchor} className="min-w-0 shrink-[8]">
      <button type="button" data-testid="page-info" title={`${filename}: its type and metadata`}
              aria-label={`Page info: ${filename}`} aria-haspopup="dialog" aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
              className="flex min-w-0 max-w-full items-center gap-1 rounded text-xs text-ink-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:min-h-11">
        <span className="shrink-0"><InfoIcon /></span>
        <span className="truncate">{filename}</span>
      </button>
      {open && createPortal(
        <div ref={panel} onClick={(e) => e.stopPropagation()} data-testid="page-info-panel" style={at}
             className={`fixed z-30 w-80 ${popoverChrome} space-y-3 p-3 text-xs`}>
          <section>
            <h3 className="mb-1 font-medium text-ink">Type</h3>
            {canManage ? (
              <Select size="xs" data-testid="page-info-type" aria-label="Page type" value={typeId}
                      disabled={types.length === 0} onChange={(e) => retype(Number(e.target.value))}>
                {types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </Select>
            ) : (
              <p className="text-ink">{shown?.name ?? '-'}</p>
            )}
            {shown && <p className="mt-1 text-ink-muted" data-testid="page-info-steps">{stepsOf(shown)}</p>}
          </section>
          <section className="border-t border-line pt-2">
            <h3 className="mb-1 font-medium text-ink">Metadata</h3>
            <MetadataEditor entries={metadata} canEdit={canEdit} testId="page-metadata"
                            onSave={(entries) => putPageMetadata(pageId, entries, metadata).then(({ metadata: saved }) => {
                              onChange({ metadata: saved })
                              return saved
                            }, (e: unknown) => {
                              const conflict = conflictOf<MetadataEntry[]>(e)
                              if (conflict) onChange({ metadata: conflict.current })
                              throw e
                            })} />
          </section>
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>,
        document.body,
      )}
    </div>
  )
}
