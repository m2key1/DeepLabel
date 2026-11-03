import type { LayoutShape, LayoutShapeChanges, LineMode, OcrDecode } from '../../api'

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
  ['box', 'Aligned', 'Straight boxes with edges parallel to the page. Simplest; right for upright scans.'],
  ['rotated', 'Rotated', 'Straight boxes, or boxes turned to match a slanted block on a skewed or tilted scan.'],
  ['polygon', 'Polygons', 'Boxes, turned boxes or an outline of any shape, for blocks that are not rectangles.'],
]

const SHAPE_LEVEL: Record<LayoutShape, number> = { box: 0, rotated: 1, polygon: 2 }

export const lowersShape = (to: LayoutShape, from: LayoutShape) => SHAPE_LEVEL[to] < SHAPE_LEVEL[from]

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What lowering a dataset's layout shape does to the elements above it, in one sentence,
 *  or null when nothing on its pages goes beyond the new level. */
export function shapeChangesText(changes: LayoutShapeChanges, to: LayoutShape): string | null {
  const parts = [
    changes.polygon > 0 && counted(changes.polygon, 'polygon', 'polygons'),
    changes.rotated > 0 && counted(changes.rotated, 'rotated box', 'rotated boxes'),
  ].filter(Boolean)
  if (parts.length === 0) return null
  const total = changes.polygon + changes.rotated
  const into = to === 'box' ? (total === 1 ? 'an upright box' : 'upright boxes') : (total === 1 ? 'a rotated box' : 'rotated boxes')
  return `${parts.join(' and ')} ${total === 1 ? 'becomes' : 'become'} ${into} around ${total === 1 ? 'it' : 'them'}`
}

export const NEEDS_LAYOUT = 'Needs layout detection'

/** How the OCR head turns its output into text, worded once for every dialog that offers it. */
export const DECODE_CHOICES: readonly (readonly [OcrDecode, string])[] = [
  ['beam', "Beam search with the model's language model"],
  ['rescored', 'Beam search reranked by the decoder head (no language model)'],
  ['greedy', 'Fast - raw greedy CTC output'],
]
