import type { Evaluation } from '../../api'
import { DECODE_NAMES } from '../job/processing'

/** A line model's evaluation counts its lines against checked outlines; an OCR model's
 *  scores what it read. */
export const countsLines = (ev: Evaluation): boolean => ev.metrics != null

/** The one number an evaluation stands for, overall or on one dataset of several: an OCR
 *  model's character error rate, lower is better; a line model's F1, higher is better. */
export function scoreOf(ev: Evaluation, job: string | null = null): number | null {
  const lines = countsLines(ev)
  if (job === null) return lines ? ev.metrics!.f1 : ev.cer
  const row = ev.breakdown?.find((r) => r.job_id === job)
  return (lines ? row?.f1 : row?.cer) ?? null
}

/** How an OCR model's evaluation decoded; a line model's has no decoding. */
export const decodeName = (ev: Evaluation): string | null => (ev.decode ? DECODE_NAMES[ev.decode] : null)

export const SCORE_MEANING = {
  ocr: 'character error rate in Automatic decoding, lower is better',
  lines: 'F1 of the found lines against the checked outlines, higher is better',
} as const
