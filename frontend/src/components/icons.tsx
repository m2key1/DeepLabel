// Maximize / minimize the editor by collapsing or restoring the OCR panel.
export function PanelIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {collapsed ? (
        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
      ) : (
        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
      )}
    </svg>
  )
}

export function KebabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  )
}

// Theme mode indicator: sun, moon, or a half-filled circle for "follow system".
export function ThemeIcon({ mode }: { mode: 'system' | 'light' | 'dark' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {mode === 'light' && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
        </>
      )}
      {mode === 'dark' && <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />}
      {mode === 'system' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}

// Monochrome eye / eye-off (feather-style), inheriting the button's text colour.
export function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}

export function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
    </svg>
  )
}

// The pointer that picks things up: the select tool, where the pen is put down.
export function CursorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l6.5 16 2.3-6.2L20 10.5z" />
    </svg>
  )
}

// A line's two shapes, told apart at 16px by what they are rather than by how many sides
// they have: four corners square to each other, against an outline that bends where it
// likes and carries a handle on every corner.
export function TurnedBoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8.5l17-4.5 3 11-17 4.5z" />
    </svg>
  )
}

export function PolygonIcon() {
  const corners: [number, number][] = [[3, 9], [9, 3], [17, 4], [21, 11], [16, 20], [6, 18]]
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={`M${corners.map(([x, y]) => `${x} ${y}`).join('L')}z`} />
      {corners.map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r="2.4" fill="currentColor" stroke="none" />
      ))}
    </svg>
  )
}

// The hand that moves the page under you, rather than drawing on it.
export function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11m0-.5V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V6a1.5 1.5 0 0 1 3 0v6" />
      <path d="M8 11V9a1.5 1.5 0 0 0-3 0v5a7 7 0 0 0 7 7h1a6 6 0 0 0 6-6v-3" />
    </svg>
  )
}

export function BoxZoomIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="13" height="13" rx="1" strokeDasharray="3 2.5" />
      <path d="M14 14l7 7" />
    </svg>
  )
}

export function ChevronIcon({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
}

// The volume as a row of plates, for the strip that shows them all at once.
export function PagesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="5" height="12" rx="1" />
      <rect x="9.5" y="4" width="5" height="16" rx="1" />
      <rect x="16.5" y="6" width="5" height="12" rx="1" />
    </svg>
  )
}

export function ExpandIcon({ shrink }: { shrink: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {shrink
        ? <path d="M9 3v6H3m18 0h-6V3M3 15h6v6m6 0v-6h6" />
        : <path d="M3 9V3h6M21 9V3h-6M3 15v6h6m12-6v6h-6" />}
    </svg>
  )
}

// The five tools both editors share, told apart at 16px: an arrow, a hand, a pen, a
// block eraser and a wand with its sparks.
export function PenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20l4-1 11-11-3-3L5 16z" />
      <path d="M13 8l3 3" />
    </svg>
  )
}

export function EraserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15l8-8 6 6-6 6H8z" />
      <path d="M8 19h12" />
      <path d="M9 12l6 6" />
    </svg>
  )
}

export function WandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20l11-11" />
      <path d="M15 9l2-2" />
      <path d="M18 3v2M18 9v2M15 6h2M21 6h2" />
    </svg>
  )
}
