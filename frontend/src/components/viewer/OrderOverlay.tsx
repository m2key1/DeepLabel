// Drawn in page-pixel space so the arrowheads stay square; the image box has
// the same aspect, making the viewBox scale uniform.
export function OrderOverlay({ width, height, centers }: {
  width: number
  height: number
  centers: [number, number][]
}) {
  if (centers.length < 2) return null
  const pts = centers.map(([x, y]) => [x * width, y * height] as const)
  const unit = Math.max(width, height)
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <defs>
        <marker
          id="ro-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="var(--ui-warn)" />
        </marker>
      </defs>
      {pts.slice(1).map(([x, y], i) => (
        <line
          key={i}
          x1={pts[i][0]}
          y1={pts[i][1]}
          x2={x}
          y2={y}
          stroke="var(--ui-warn)"
          strokeWidth={unit / 500}
          strokeOpacity={0.8}
          markerEnd="url(#ro-arrow)"
        />
      ))}
      <circle cx={pts[0][0]} cy={pts[0][1]} r={unit / 160} fill="var(--ui-warn)" />
    </svg>
  )
}
