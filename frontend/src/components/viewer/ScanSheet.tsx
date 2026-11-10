import { useMemo, useState } from 'react'
import { renditionUrl, tilesUrl } from '../../api'
import { useImageSurface } from '../../hooks/useImageSurface'
import { Modal, modalBtn } from '../Modal'
import { InkMarks, LineInk } from './LineInk'

export interface SheetPage {
  id: number
  width: number | null
  height: number | null
  rotation: number
}

type Polygon = number[][]

/** How much of the page shows round the lines in the crop, as a share of its width. */
const MARGIN = 0.02

/** A line's scan on a phone, where the page and its text no longer fit side by side: the
 *  line magnified with the lines above and below it for context, and on asking the whole
 *  page with the line outlined, to pan and pinch. */
export function ScanSheet({ page, line, title, above, below, onClose }: {
  page: SheetPage
  line: Polygon
  title: string
  above?: Polygon
  below?: Polygon
  onClose: () => void
}) {
  const [whole, setWhole] = useState(false)
  const size: [number, number] = [page.width || 2000, page.height || 3000]
  return (
    <Modal title={title} width="lg" onClose={onClose}>
      {whole ? <WholePage page={page} size={size} line={line} />
        : <LineCrop page={page} size={size} lines={[above, line, below]} line={line} />}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={modalBtn} onClick={() => setWhole((w) => !w)}>
          {whole ? 'Line' : 'Whole page'}
        </button>
        <button type="button" className={modalBtn} onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}

function LineCrop({ page, size, lines, line }: {
  page: SheetPage
  size: [number, number]
  lines: (Polygon | undefined)[]
  line: Polygon
}) {
  const [w, h] = size
  const points = lines.flatMap((l) => l ?? [])
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const [left, top] = [Math.max(0, Math.min(...xs) - MARGIN), Math.max(0, Math.min(...ys) - MARGIN)]
  const [right, bottom] = [Math.min(1, Math.max(...xs) + MARGIN), Math.min(1, Math.max(...ys) + MARGIN)]
  const view = `${left * w} ${top * h} ${(right - left) * w} ${(bottom - top) * h}`
  return (
    <div className="overflow-hidden rounded bg-raised">
      <svg data-testid="scan-sheet-crop" viewBox={view} className="block h-auto w-full">
        <image href={renditionUrl(page.id, 'full', page.rotation)} width={w} height={h} preserveAspectRatio="none" />
        <InkMarks size={size} polygon={line} outlined={false} />
      </svg>
    </div>
  )
}

function WholePage({ page, size, line }: { page: SheetPage; size: [number, number]; line: Polygon }) {
  const scan = useMemo(
    () => (page.width && page.height
      ? { tiles: tilesUrl(page.id, page.rotation), width: page.width, height: page.height }
      : null),
    [page.id, page.rotation, page.width, page.height],
  )
  const { register, onPanStart, onPanMove, onPanEnd } = useImageSurface(scan, { grab: true, frame: 'whole', max: 8 })
  const refs = register('sheet')
  return (
    <div data-testid="scan-sheet-page"
         onPointerDown={onPanStart} onPointerMove={onPanMove} onPointerUp={onPanEnd} onPointerCancel={onPanEnd}
         className="relative h-[65vh] w-full touch-none overflow-hidden rounded bg-raised">
      <div ref={refs.host} className="absolute inset-0" />
      <div ref={refs.box} className="invisible absolute left-0 top-0 z-10 origin-top-left">
        <LineInk size={size} polygon={line} testId="scan-sheet-line" />
      </div>
    </div>
  )
}
