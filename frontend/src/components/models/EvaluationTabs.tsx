import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getEvaluation, getEvaluationSummary } from '../../api'
import type { EvalSummary, Evaluation, EvaluationDetail } from '../../api'
import { ErrorsTab } from '../evaluation/ErrorsTab'
import { LinesTab } from '../evaluation/LinesTab'
import { decodeName } from '../evaluation/score'
import { Select } from '../ui/Field'
import { materialOf } from './runFacts'

/** The lines or the errors of one of the model's evaluations, chosen by what it was scored
 *  on; the headline material is the one shown first. */
export function EvaluationTabs({ tab, evaluations, shownFirst, materialName, canSend }: {
  tab: 'lines' | 'errors'
  evaluations: Evaluation[]
  shownFirst: number
  materialName: (key: string) => string
  canSend: boolean
}) {
  const [params, setParams] = useSearchParams()
  const asked = Number(params.get('eval'))
  const chosen = evaluations.some((ev) => ev.id === asked) ? asked : shownFirst
  const [detail, setDetail] = useState<EvaluationDetail | null>(null)
  const [summary, setSummary] = useState<EvalSummary | null>(null)

  useEffect(() => {
    let live = true
    setDetail(null)
    setSummary(null)
    getEvaluation(chosen).then((d) => live && setDetail(d)).catch(() => {})
    if (tab === 'errors') getEvaluationSummary(chosen).then((s) => live && setSummary(s)).catch(() => {})
    return () => { live = false }
  }, [chosen, tab])

  const choose = (id: string) => {
    const next = new URLSearchParams()
    next.set('tab', tab)
    next.set('eval', id)
    setParams(next, { replace: true })
  }

  return (
    <div>
      {evaluations.length > 1 && (
        <label className="mb-3 flex items-center gap-2 text-xs text-ink-muted">
          Scored on
          <Select size="xs" data-testid="scored-on" value={String(chosen)} className="w-72"
                  onChange={(e) => choose(e.target.value)}>
            {evaluations.map((ev) => (
              <option key={ev.id} value={ev.id}>{materialName(materialOf(ev))} · {decodeName(ev)}</option>
            ))}
          </Select>
        </label>
      )}
      {tab === 'lines' && detail && <LinesTab key={detail.id} evaluation={detail} canEdit={canSend} />}
      {tab === 'errors' && (summary ? <ErrorsTab summary={summary} /> : <p className="text-sm text-ink-subtle">Loading...</p>)}
    </div>
  )
}
