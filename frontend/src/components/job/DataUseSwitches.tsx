import type { ReactNode } from 'react'
import type { DataUse } from '../../api'
import { Badge } from '../ui/Badge'
import { LeftOutNote } from '../ui/LeftOutNote'
import { SwitchKnob } from '../ui/SwitchKnob'

type Use = keyof DataUse

export const USES: { use: Use; label: string; hint: string; off: string }[] = [
  { use: 'training', label: 'Training', hint: 'May be used to train or validate a model.', off: 'no training' },
  { use: 'test', label: 'Test set', hint: 'May be used to score models.', off: 'no scoring' },
  { use: 'external_llm', label: 'External LLM providers',
    hint: "Pages may be sent to LLM providers an admin hasn't marked as self-hosted.", off: 'no external LLMs' },
  { use: 'export', label: 'Export by others', hint: 'People it is shared with may export it. The owner always can.',
    off: 'no export' },
]

/** The owner's switches for what a dataset may be used for, each with what it means and,
 *  where given, what switching it off leaves behind. */
export function DataUseSwitches({ value, onChange, notes = {} }: {
  value: DataUse
  onChange: (next: DataUse) => void
  notes?: Partial<Record<Use, ReactNode>>
}) {
  return (
    <div data-testid="data-use-switches" className="divide-y divide-line">
      {USES.map(({ use, label, hint }) => (
        <div key={use} className="py-2.5">
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" role="switch" className="peer sr-only" checked={value[use]} data-use={use}
                   onChange={(e) => onChange({ ...value, [use]: e.target.checked })} />
            <span className="mt-1 flex shrink-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
              <SwitchKnob on={value[use]} onColor="bg-accent" />
            </span>
            <span>
              <span className="block text-sm font-medium text-ink">{label}</span>
              <span className="block text-xs text-ink-muted">{hint}</span>
            </span>
          </label>
          {notes[use] && <div className="ml-8 mt-2">{notes[use]}</div>}
        </div>
      ))}
    </div>
  )
}

/** One chip per use the owner has switched off; nothing for a dataset that allows all. */
export function DataUseChips({ value }: { value: DataUse | undefined }) {
  if (!value) return null
  return (
    <>
      {USES.filter(({ use }) => !value[use]).map(({ use, off }) => (
        <Badge key={use} tone="warn" data-testid="data-use-chip" data-use={use}>{off}</Badge>
      ))}
    </>
  )
}

export function dataUseSummary(value: DataUse): string {
  const off = USES.filter(({ use }) => !value[use]).map(({ off }) => off)
  return off.length ? off.join(', ') : 'everything allowed'
}

/** A model a dataset kept from external providers may not be read with: one on a
 *  connection no admin has marked self-hosted. */
export function keptOut(keptInHouse: boolean, model: { self_hosted: boolean }): boolean {
  return keptInHouse && !model.self_hosted
}

/** Beneath a model list for a dataset kept in the house: the models it leaves out. */
export function KeptOutModels({ names }: { names: string[] }) {
  if (names.length === 0) return null
  return (
    <LeftOutNote data-testid="llm-kept-out" className="mt-1.5" names={names}
                 reason="as this dataset's owner keeps its pages from providers an admin hasn't marked self-hosted" />
  )
}
