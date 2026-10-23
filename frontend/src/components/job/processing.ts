import type { LayoutShape, LineMode, OcrDecode } from '../../api'

/** The text pipeline's phases as a person picks them, in the order they run. One list so
 *  creating a dataset and changing one afterwards describe the same thing. */
export const PHASE_CHOICES = [
  ['layout', 'Layout detection', 'Detect page regions (paragraphs, headers, tables, …)'],
  ['lines', 'Line segmentation', 'Detect the text-line polygons'],
  ['ocr', 'OCR', 'Read the text from each line'],
] as const

export const LINE_MODE_CHOICES: readonly (readonly [LineMode, string, string])[] = [
  ['per_crop', 'Per crop', 'Detect lines inside each layout element - cleaner separation'],
  ['per_page', 'Per page', 'Detect lines on the whole page once, then assign - faster'],
]

export const LAYOUT_SHAPE_CHOICES: readonly (readonly [LayoutShape, string, string])[] = [
  ['box', 'Boxes', 'Each layout element is a rectangle'],
  ['polygon', 'Polygons', 'Each element is an outline, reshaped like a text line; lines are found inside it'],
]

export const NEEDS_LAYOUT = 'Needs layout detection'

/** How the OCR head turns its output into text, worded once for every dialog that offers it. */
export const DECODE_CHOICES: readonly (readonly [OcrDecode, string])[] = [
  ['beam', "Beam search with the model's language model"],
  ['rescored', 'Beam search reranked by the decoder head (no language model)'],
  ['greedy', 'Fast - raw greedy CTC output'],
]
