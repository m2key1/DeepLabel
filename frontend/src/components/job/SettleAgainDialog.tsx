import { useEffect, useState } from 'react'
import { getLlmSettlePreview, settleLlmAgain } from '../../api'
import type { LlmSettlePreview, LlmSettleResult } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface SettleAgainDialogProps {
  jobId: string
  consensusMin: number
  autocheck: boolean
  consensusWithOcr: boolean
  onClose: () => void
  onSettled: () => void
  onError: (message: string) => void
}

const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`

function wouldChange(preview: LlmSettlePreview): string {
  if (preview.lines === 0) return 'Nothing to touch: the current settings already hold for every line read.'
  const ways = [
    preview.fill > 0 && `${preview.fill} would take the LLM reading`,
    preview.clear > 0 && `${preview.clear} put back to the OCR text`,
  ].filter(Boolean)
  return `${lines(preview.lines)} would change: ${ways.join(', ')}.`
}

/** The dataset's agreement rules in plain words, so what re-applying them means is on
 *  the screen rather than in the button's name. */
export function agreementRules(consensusMin: number, autocheck: boolean, consensusWithOcr: boolean): string {
  const voices = consensusWithOcr ? ", Deep OCR's own reading counting as one of them" : ''
  const check = autocheck ? 'and is checked off' : 'and stays unchecked for review'
  return `A line takes the language models' reading when at least ${consensusMin} of them read it the `
    + `same way${voices}, ${check}. A line whose agreement no longer holds goes back to its OCR text.`
}

export function SettleAgainDialog({
  jobId, consensusMin, autocheck, consensusWithOcr, onClose, onSettled, onError,
}: SettleAgainDialogProps) {
  const [preview, setPreview] = useState<LlmSettlePreview | null>(null)
  const [result, setResult] = useState<LlmSettleResult | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    getLlmSettlePreview(jobId).then(setPreview).catch((e: Error) => onError(e.message))
  }, [jobId, onError])

  const run = () => {
    setRunning(true)
    settleLlmAgain(jobId)
      .then((r) => {
        setResult(r)
        onSettled()
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setRunning(false))
  }

  return (
    <Modal title="Re-apply LLM agreement" onClose={onClose}>
      <p className="mb-2 text-sm text-ink" data-testid="llm-settle-again-rules">
        {agreementRules(consensusMin, autocheck, consensusWithOcr)}
      </p>
      <p className="mb-3 text-sm text-ink-muted">
        New readings follow these rules as they arrive. Re-apply them after changing the rules,
        to match the readings already on file again. No model is asked, and nothing a person
        checked or typed is touched.
      </p>
      {preview === null ? (
        <p className="mb-3 text-sm text-ink-muted">Counting what this would touch…</p>
      ) : (
        <p className="mb-3 text-sm" data-testid="llm-settle-again-count">{wouldChange(preview)}</p>
      )}
      {result && (
        <p className="mb-3 text-sm text-ok" data-testid="llm-settle-again-result">
          {lines(result.filled)} took the LLM reading, {lines(result.cleared)} went back to the OCR text.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Close
        </button>
        <button data-testid="llm-settle-again-confirm" onClick={run}
                disabled={!preview?.lines || result !== null || running}
                className={`${modalPrimaryBtn} disabled:opacity-40`}>
          Re-apply
        </button>
      </div>
    </Modal>
  )
}
