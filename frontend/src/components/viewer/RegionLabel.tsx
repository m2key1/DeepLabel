import { classColor } from '../../util'

/** A box's class name, tagged above its top-left corner. Never catches a press, so it
 *  cannot steal a click meant for a handle or the start of a drawing. */
export function RegionLabel({ className, x, y, container = false }:
  { className: string; x: number; y: number; container?: boolean }) {
  return (
    <span
      data-testid="region-label"
      className={`pointer-events-none absolute rounded-t-sm px-1 text-[9px] font-medium leading-3 text-white${
        container ? ' italic opacity-70' : ''}`}
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: 'translateY(-100%)',
        backgroundColor: classColor(className),
      }}
    >
      {className}
    </span>
  )
}
