import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { PageProvenance, ProvenanceModel } from '../../api'
import { popoverChrome } from '../ui/Card'
import { menuTrigger, useDismiss } from '../ui/menu'
import { plural } from '../../util'

const tag = (model: ProvenanceModel | null) => (model ? model.hash ?? `#${model.id}` : '-')

const day = (at: string | null) => at?.slice(0, 10) ?? ''

function ModelName({ model }: { model: ProvenanceModel | null }) {
  if (!model) return <span className="text-ink-muted">not from a model</span>
  return (
    <Link to={`/models/${model.id}`} className="truncate text-accent-ink hover:underline">
      {model.name ?? `Model #${model.id} (deleted)`}
    </Link>
  )
}

function Row({ stage, label, model, at, lines, note }: {
  stage: string
  label: string
  model: ProvenanceModel | null
  at: string | null
  lines?: number
  note?: ReactNode
}) {
  return (
    <tr data-testid="provenance-row" data-stage={stage} data-model-id={model?.id ?? ''}
        data-lines={lines ?? ''} className="align-top">
      <td className="pr-3 font-medium text-ink">{label}</td>
      <td className="max-w-48 pr-3"><ModelName model={model} /></td>
      <td className="pr-3 font-mono tabular-nums">{model ? tag(model) : ''}</td>
      <td className="pr-3 tabular-nums">{day(at)}</td>
      <td className="whitespace-nowrap">
        {lines !== undefined && plural(lines, 'line')}
        {note}
      </td>
    </tr>
  )
}

/** The footer chip saying which models produced the page, opening to the details. */
export function ModelProvenance({ provenance }: { provenance: PageProvenance }) {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false))
  const { layout, lines, ocr } = provenance
  const ocrTag = ocr.length === 0 ? '-' : `${tag(ocr[0].model)}${ocr.length > 1 ? ` +${ocr.length - 1}` : ''}`

  return (
    <span className="relative">
      <button
        type="button"
        data-testid="model-provenance"
        {...menuTrigger(open)}
        title="Which models produced this page"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="whitespace-nowrap rounded px-1.5 py-0.5 font-mono tabular-nums hover:bg-raised"
      >
        L {tag(layout)} · S {tag(lines)} · O {ocrTag}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          data-testid="provenance-popover"
          className={`absolute bottom-full right-0 z-30 mb-1 ${popoverChrome} p-2.5 text-xs text-ink-muted`}
        >
          <table>
            <tbody>
              <Row stage="layout" label="Layout" model={layout} at={layout?.at ?? null} />
              <Row stage="lines" label="Lines" model={lines} at={lines?.at ?? null}
                   lines={provenance.lines_total}
                   note={provenance.lines_by_hand > 0 && ` (${provenance.lines_by_hand} by hand)`} />
              {ocr.length === 0 && <Row stage="ocr" label="OCR" model={null} at={null} />}
              {ocr.map((reader, i) => (
                <Row key={reader.model?.id ?? 'none'} stage="ocr" label={i === 0 ? 'OCR' : ''}
                     model={reader.model} at={reader.at} lines={reader.lines} />
              ))}
            </tbody>
          </table>
          {provenance.ocr_corrected > 0 && (
            <p data-testid="provenance-corrected" className="mt-1.5 border-t border-line pt-1.5">
              {plural(provenance.ocr_corrected, 'line')} corrected by hand.
            </p>
          )}
        </div>
      )}
    </span>
  )
}
