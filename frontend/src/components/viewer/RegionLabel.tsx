import { classColor, classInk } from '../../util'

/** A box's class name, tagged above its top-left corner - or with `end`, its top-right one.
 *  Never catches a press, so it cannot steal a click meant for a handle or the start of a
 *  drawing. */
export function RegionLabel({ className, x, y, container = false, end = false }:
  { className: string; x: number; y: number; container?: boolean; end?: boolean }) {
  return (
    <span
      data-testid="region-label"
      className={`pointer-events-none absolute rounded-t-sm px-1 text-[9px] font-medium leading-3${
        container ? ' italic' : ''}`}
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: end ? 'translate(-100%, -100%)' : 'translateY(-100%)',
        backgroundColor: classColor(className),
        color: classInk(className),
      }}
    >
      {className}
    </span>
  )
}
