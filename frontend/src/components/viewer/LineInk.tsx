import { useId } from 'react'

/** The line being read, drawn on the scan by taking the rest of the page down rather than
 *  by colouring the line in: a hole in a dimmed sheet reads as "look here", where a tinted
 *  box reads as a form field.
 *
 *  The polygons are page-normalised and the viewBox is the page's own size, so the scan
 *  (object-contain) and this (preserveAspectRatio, which is the same rule) letterbox
 *  identically inside the same box - and where the box lands cannot disagree with where the
 *  ink is. */
export function LineInk({ size, polygon, testId }: {
  size: [number, number]
  polygon: number[][]
  testId?: string
}) {
  const [w, h] = size
  return (
    // Positioned, because a scan beneath it may carry a drop shadow: a filter makes its own
    // stacking context, which paints over every plain sibling whatever the order of them.
    <svg viewBox={`0 0 ${w} ${h}`}
         className="pointer-events-none absolute inset-0 h-full w-full">
      <InkMarks size={size} polygon={polygon} testId={testId} />
    </svg>
  )
}

/** The same marks, for an svg of the page's size that draws the scan itself. */
export function InkMarks({ size, polygon, testId, outlined = true }: {
  size: [number, number]
  polygon: number[][]
  testId?: string
  /** Whether the line also gets a stroke round it, as well as the hole. */
  outlined?: boolean
}) {
  const mask = `ink-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [w, h] = size
  const points = polygon.map(([x, y]) => `${x},${y}`).join(' ')
  return (
    <>
      <defs>
        <mask id={mask}>
          <rect width={w} height={h} fill="white" />
          <g transform={`scale(${w} ${h})`}>
            <polygon points={points} fill="black" />
          </g>
        </mask>
      </defs>
      <rect width={w} height={h} fill="rgb(9 9 11)" opacity="0.45" mask={`url(#${mask})`} />
      {outlined && (
        <g transform={`scale(${w} ${h})`} data-testid={testId}>
          <polygon points={points} fill="none" stroke="rgb(129 140 248)" strokeWidth="1.5"
                   vectorEffect="non-scaling-stroke" />
        </g>
      )}
    </>
  )
}
