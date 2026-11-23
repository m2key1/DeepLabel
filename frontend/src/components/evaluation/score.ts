import type { Evaluation, LayoutScores, LineScores } from '../../api'
import { DECODE_NAMES } from '../job/processing'

/** A layout model's evaluation scores its boxes; a line model's counts its lines. */
export const isLayoutScores = (metrics: LineScores | LayoutScores): metrics is LayoutScores => 'mAP_50' in metrics

/** A line model's evaluation counts its lines against checked outlines; an OCR model's
 *  scores what it read. */
export const countsLines = (ev: Evaluation): boolean => ev.metrics != null && !isLayoutScores(ev.metrics)

/** The one number an evaluation stands for, overall or on one dataset of several: an OCR
 *  model's character error rate, lower is better; a line model's F1, higher is better. */
export function scoreOf(ev: Evaluation, job: string | null = null): number | null {
  if (ev.metrics && isLayoutScores(ev.metrics)) return job === null ? ev.metrics.mAP_50 : null
  const lines = countsLines(ev)
  if (job === null) return lines ? (ev.metrics as LineScores).f1 : ev.cer
  const row = ev.breakdown?.find((r) => r.job_id === job)
  return (lines ? row?.f1 : row?.cer) ?? null
}

/** How an OCR model's evaluation decoded; a line model's has no decoding. */
export const decodeName = (ev: Evaluation): string | null => (ev.decode ? DECODE_NAMES[ev.decode] : null)

export const SCORE_MEANING = {
  ocr: 'character error rate in Automatic decoding, lower is better',
  lines: 'F1 of the found lines against the checked outlines, higher is better',
  layout: 'mAP50 of the found boxes against the checked boxes, higher is better',
} as const
