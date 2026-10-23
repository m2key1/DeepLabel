import type { Tunable, TunableValue } from '../../api'

/** A knob's value as its field holds it: a switch reads on or off, everything else as typed. */
export function fieldValue(value: TunableValue): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value)
}

/** The typed values of every knob the user filled in; blank ones stay the trainer's own. */
export function tunedValues(tunables: Tunable[], fields: Record<string, string>): Record<string, TunableValue> {
  const values: Record<string, TunableValue> = {}
  for (const knob of tunables) {
    const raw = (fields[knob.key] ?? '').trim()
    if (raw === '') continue
    values[knob.key] = knob.kind === 'bool' ? raw === 'on' : knob.kind === 'choice' ? raw : Number(raw)
  }
  return values
}
