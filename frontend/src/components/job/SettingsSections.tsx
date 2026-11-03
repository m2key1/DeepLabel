import type { LayoutShape, LayoutShapeChanges, LlmModel } from '../../api'
import { KeptOutModels, keptOut } from './DataUseSwitches'
import { LAYOUT_SHAPE_CHOICES, lowersShape, shapeChangesText } from './processing'

const choiceCard = (chosen: boolean) =>
  `flex flex-1 flex-col justify-start rounded border px-3 py-2 text-left text-sm ${chosen ? 'border-accent bg-accent-wash' : 'border-line-strong'}`

/** How free a dataset's layout elements may be. Raising it changes nothing drawn; lowering
 *  it turns what goes beyond the new level into the tightest allowed shape, so the note
 *  says how many before anything is saved. */
export function LayoutShapeChoice({ value, saved, changes, onChange }: {
  value: LayoutShape
  saved: LayoutShape
  /** For a lower level than the saved one: what it would change, or null while counting. */
  changes?: LayoutShapeChanges | null
  onChange: (shape: LayoutShape) => void
}) {
  const lowering = lowersShape(value, saved)
  const note = value === saved ? null
    : !lowering ? (saved === 'box'
      ? 'Saving gives every box its four corners, so each can be turned or reshaped up to this level.'
      : 'Saving allows the new shapes; nothing already drawn changes.')
    : changes == null ? 'Counting what this changes…'
    : shapeChangesText(changes, value)?.concat('. The revision history keeps the old shapes.')
      ?? 'Nothing on the pages goes beyond this level, so nothing changes.'
  return (
    <div data-testid="processing-layout-shape">
      <span className="mb-1 block text-sm font-medium text-ink">Layout element shapes</span>
      <div className="flex gap-2">
        {LAYOUT_SHAPE_CHOICES.map(([shape, label, hint]) => (
          <button key={shape} type="button" data-testid="processing-layout-shape-option" data-shape={shape}
                  aria-pressed={value === shape} onClick={() => onChange(shape)} className={choiceCard(value === shape)}>
            <span className="block font-medium text-ink">{label}</span>
            <span className="block text-xs text-ink-muted">{hint}</span>
          </button>
        ))}
      </div>
      {note && (
        <p className={`mt-1.5 text-xs ${lowering && changes && shapeChangesText(changes, value) ? 'text-warn' : 'text-ink-muted'}`}
           data-testid="processing-layout-shape-note">
          {note}
        </p>
      )}
    </div>
  )
}

/** How the dataset's transcriptions are matched to its lines on the next Alignment run. */
export function AlignmentChoice({ autocheck, ordered, onAutocheck, onOrdered }: {
  autocheck: boolean
  ordered: boolean
  onAutocheck: (on: boolean) => void
  onOrdered: (on: boolean) => void
}) {
  return (
    <div data-testid="processing-alignment">
      <span className="mb-1 block text-sm font-medium text-ink">Transcription matching</span>
      <p className="mb-1.5 text-xs text-ink-muted">
        Re-run Alignment from the Run menu to match the transcriptions again under these settings.
        Lines already checked stay checked.
      </p>
      <label className="flex items-center gap-1.5 text-sm text-ink">
        <input type="checkbox" data-testid="processing-gt-autocheck" checked={autocheck}
               onChange={(e) => onAutocheck(e.target.checked)} className="cursor-pointer accent-accent" />
        Mark near-exact matches as reviewed right away
      </label>
      {autocheck && (
        <label className="mt-1.5 ml-5 flex items-start gap-1.5 text-sm text-ink">
          <input type="checkbox" data-testid="processing-gt-ordered" checked={ordered}
                 onChange={(e) => onOrdered(e.target.checked)} className="mt-1 cursor-pointer accent-accent" />
          <span>
            The transcription lists every line, in reading order
            <span className="mt-0.5 block text-xs text-ink-muted">
              Then a match that follows that order is reviewed too, however poorly the page was read.
            </span>
          </span>
        </label>
      )}
    </div>
  )
}

/** The language models that read this dataset's pages: those its data use allows, with
 *  the rest named beneath. */
export function LlmReaders({ readers, chosen, keptInHouse, onChange }: {
  readers: (LlmModel & { self_hosted: boolean })[]
  chosen: number[]
  keptInHouse: boolean
  onChange: (ids: number[]) => void
}) {
  return (
    <div data-testid="pick-llm-models">
      <span className="mb-1 block text-sm font-medium text-ink">Language models</span>
      <p className="mb-1 text-xs text-ink-muted">
        Which models read this dataset's pages, here and from the page viewer. Reading is still
        started deliberately - this only says who does it.
      </p>
      <div className="space-y-1">
        {readers.filter((m) => !keptOut(keptInHouse, m)).map((model) => (
          <label key={model.id} data-testid="llm-model-pin" data-label={model.label}
                 className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={chosen.includes(model.id)}
                   onChange={() => onChange(chosen.includes(model.id)
                     ? chosen.filter((id) => id !== model.id) : [...chosen, model.id])}
                   className="cursor-pointer accent-accent" />
            <span className="min-w-0 truncate">{model.label}</span>
          </label>
        ))}
        <KeptOutModels names={readers.filter((m) => keptOut(keptInHouse, m)).map((m) => m.label)} />
      </div>
    </div>
  )
}
