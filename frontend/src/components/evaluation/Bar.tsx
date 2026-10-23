/** A figure with a thin bar of one hue behind it, scaled to the column's largest. The
 *  number is always written out, so the bar only ever repeats it. */
export function Bar({ value, peak, label }: { value: number; peak: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 flex-1 rounded-sm bg-line">
        <div className="h-full rounded-sm bg-accent" style={{ width: `${peak > 0 ? (value / peak) * 100 : 0}%` }} />
      </div>
      <span className="w-16 text-right font-mono text-xs tabular-nums">{label}</span>
    </div>
  )
}
