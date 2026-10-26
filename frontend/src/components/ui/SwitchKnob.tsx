/** The sliding knob of a pill-shaped switch, in the colour of what being on means. */
export function SwitchKnob({ on, onColor }: { on: boolean; onColor: string }) {
  return (
    <span className={`relative h-3 w-5 rounded-full transition-colors ${on ? onColor : 'bg-line-strong'}`}>
      <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-surface transition-[left] ${on ? 'left-2.5' : 'left-0.5'}`} />
    </span>
  )
}
