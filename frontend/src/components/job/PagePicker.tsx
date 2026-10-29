import { useEffect, useMemo } from 'react'

const PREVIEWABLE = /\.(jpe?g|png|bmp|webp)$/i

/** The scans picked for a new dataset as thumbnails, each ticked unless left out. A PDF
 *  is split into pages only once it is uploaded, so it is a single tile, taken whole. */
export function PagePicker({ files, excluded, onToggle, onAll }: {
  files: File[]
  excluded: Set<File>
  onToggle: (file: File) => void
  onAll: (included: boolean) => void
}) {
  const previews = useMemo(
    () => new Map(files.filter((f) => PREVIEWABLE.test(f.name)).map((f) => [f, URL.createObjectURL(f)])),
    [files])
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews])
  const included = files.filter((f) => !excluded.has(f)).length

  return (
    <div data-testid="page-picker">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span data-testid="page-picker-count">{included} of {files.length} file{files.length === 1 ? '' : 's'} included</span>
        <button type="button" onClick={() => onAll(true)} className="text-accent-ink hover:underline">select all</button>
        <button type="button" onClick={() => onAll(false)} className="text-accent-ink hover:underline">select none</button>
        {files.some((f) => /\.pdf$/i.test(f.name)) && (
          <span className="ml-auto">A PDF's pages are split once it is uploaded, so it is taken whole here.</span>
        )}
      </div>
      {/* Its own scroller, so a long volume leaves the count above and Back and Next below on screen. */}
      <div data-testid="page-picker-grid"
           className="grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5 overflow-y-auto rounded-md border border-line bg-ground p-2.5">
        {files.map((file, i) => {
          const on = !excluded.has(file)
          const preview = previews.get(file)
          return (
            <label key={`${file.name}-${i}`} data-testid="page-pick" data-file={file.name} data-included={on}
                   className={`relative cursor-pointer rounded-md border border-line bg-surface p-1.5 ${on ? '' : 'opacity-45'}`}>
              <input type="checkbox" checked={on} onChange={() => onToggle(file)} aria-label={file.name}
                     className="absolute left-3 top-3 cursor-pointer accent-accent" />
              {preview ? (
                <img src={preview} alt="" className="h-32 w-full rounded-sm bg-raised object-contain" />
              ) : (
                <div className="grid h-32 place-items-center rounded-sm bg-raised font-mono text-xs uppercase text-ink-muted">
                  {file.name.split('.').pop()}
                </div>
              )}
              <span className="mt-1 block truncate text-[11px] text-ink-muted" title={file.name}>{file.name}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
