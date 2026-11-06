import {
  createElement, createLine, deleteSet, mergeElements, mergeLines, patchElement, patchLinePolygon,
  setPageLayoutChecked, setPageLinesChecked, splitElement, splitLine,
} from '../api'
import type { Bbox, EditSpan, Line, PageDetail, PageElement, Ring, Spanned } from '../api'
import { clipByLine } from '../lib/geometry/core'
import type { Pt } from '../lib/geometry/core'
import { hull, minAreaQuad } from '../lib/geometry/quad'
import { isTemporary } from './editQueue'
import type { RevisionBook } from './guardedSave'
import type { Edit, EditContext } from './editQueue'

export interface PageEditDeps {
  pageId: number
  book: RevisionBook
  aspect: number
}

type PageEdit<R extends { span: EditSpan } = { span: EditSpan }> = Edit<PageDetail, R>

const center = (poly: Ring): Pt =>
  [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length]

const ringBounds = (ring: Ring): Bbox => {
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const boxRing = ([x0, y0, x1, y1]: Bbox): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

const needing = (ids: number[]) => {
  const temps = ids.filter(isTemporary)
  return temps.length ? temps : undefined
}

function withElements(page: PageDetail, f: (els: PageElement[]) => PageElement[]): PageDetail {
  return { ...page, elements: f(page.elements) }
}

function findLine(page: PageDetail, id: number): Line | undefined {
  for (const el of page.elements) {
    const line = el.lines.find((l) => l.id === id)
    if (line) return line
  }
  return undefined
}

const blankLine = (id: number, polygon: Ring): Line => ({
  id, order_idx: 1 << 30, polygon, text: null, corrected_text: null, corrected_by: null, confidence: null,
  conf_profile: null, orientation: 0, needs_ocr: true, checked: false, check_source: null, text_author: '',
  revision: 0,
} as unknown as Line)

const cleared = (line: Line, polygon: Ring): Line => ({
  ...line, polygon, text: null, corrected_text: null, corrected_by: null, confidence: null, conf_profile: null,
  checked: false, check_source: null,
})

/** The smallest content box around the point, as the server files lines. */
function smallestContentAt(els: PageElement[], [cx, cy]: Pt): PageElement | undefined {
  let best: PageElement | undefined
  let bestArea = Infinity
  for (const el of els) {
    if (el.kind !== 'content') continue
    const [x0, y0, x1, y1] = el.bbox
    if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue
    const area = (x1 - x0) * (y1 - y0)
    if (area < bestArea) [best, bestArea] = [el, area]
  }
  return best
}

/** Every line, or only those given, put into the smallest content box around its centre
 *  or else Unassigned - what the server does after a box or line edit (#71), shown before
 *  it has. A page with no Unassigned bucket gets one under `bucketId`. */
export function refile(page: PageDetail, bucketId: number, only?: Set<number>): PageDetail {
  const moves = new Map<number, Line[]>()
  const staying = page.elements.map((el) => ({
    ...el,
    lines: el.lines.filter((line) => {
      if (only && !only.has(line.id)) return true
      const home = smallestContentAt(page.elements, center(line.polygon))
      const target = home?.id ?? (el.kind === 'orphan' ? el.id : null)
      if (target === el.id) return true
      const key = target ?? bucketId
      moves.set(key, [...(moves.get(key) ?? []), line])
      return false
    }),
  }))
  if (moves.size === 0) return page
  const homeless = moves.get(bucketId)
  const orphan = staying.find((el) => el.kind === 'orphan')
  if (homeless && orphan && orphan.id !== bucketId) {
    moves.delete(bucketId)
    moves.set(orphan.id, [...(moves.get(orphan.id) ?? []), ...homeless])
  }
  const elements = staying.map((el) => (moves.has(el.id) ? { ...el, lines: [...el.lines, ...moves.get(el.id)!] } : el))
  if (moves.has(bucketId) && !elements.some((el) => el.id === bucketId)) {
    const lines = moves.get(bucketId)!
    elements.push({
      id: bucketId, order_idx: elements.length, class_name: 'Unassigned', raw_class_name: null,
      bbox: ringBounds(lines.flatMap((l) => l.polygon)), conf: null, kind: 'orphan', checked: false,
      polygon: null, lines, revision: 0,
    })
  }
  return { ...page, elements }
}

const without = (page: PageDetail, elementIds: Set<number>, lineIds: Set<number>): PageDetail =>
  withElements(page, (els) => els
    .filter((el) => !elementIds.has(el.id))
    .map((el) => (el.lines.some((l) => lineIds.has(l.id)) ? { ...el, lines: el.lines.filter((l) => !lineIds.has(l.id)) } : el)))

/** A gathered set, or a single box or line, deleted in one request. A box's lines stay,
 *  filed where they lie. */
export function deleteRows(d: PageEditDeps, page: PageDetail, rows: { elements: number[]; lines: number[] }): PageEdit {
  const bucket = -1_000_000 - d.pageId
  const loadedBox = new Map(page.elements.map((el) => [el.id, el.revision]))
  const loadedLine = new Map(page.elements.flatMap((el) => el.lines.map((l) => [l.id, l.revision] as const)))
  const count = rows.elements.length + rows.lines.length
  const noun = rows.elements.length === 0 ? (count === 1 ? 'line' : 'lines')
    : rows.lines.length === 0 ? (count === 1 ? 'box' : 'boxes') : 'items'
  const orphanedLines = (state: PageDetail, ctx: EditContext) => new Set(state.elements
    .filter((el) => rows.elements.some((id) => ctx.id(id) === el.id))
    .flatMap((el) => el.lines.map((l) => l.id)))
  return {
    label: count === 1 ? `Delete ${noun}` : `Delete ${count} ${noun}`,
    scope: d.pageId,
    needs: needing([...rows.elements, ...rows.lines]),
    apply: (state, ctx) => {
      const freed = orphanedLines(state, ctx)
      const boxes = new Set(rows.elements.map(ctx.id))
      const kept = state.elements.filter((el) => boxes.has(el.id)).flatMap((el) => el.lines)
      const gone = without(state, boxes, new Set(rows.lines.map(ctx.id)))
      const placed = kept.filter((l) => !rows.lines.some((id) => ctx.id(id) === l.id))
      if (!placed.length) return gone
      const withBucket = gone.elements.some((el) => el.kind === 'orphan') ? gone : withElements(gone, (els) => [...els, {
        id: bucket, order_idx: els.length, class_name: 'Unassigned', raw_class_name: null, bbox: [0, 0, 1, 1],
        conf: null, kind: 'orphan', checked: false, polygon: null, lines: [], revision: 0,
      }])
      const orphan = withBucket.elements.find((el) => el.kind === 'orphan')!
      const parked = withElements(withBucket, (els) => els.map((el) => (el === orphan ? { ...el, lines: [...el.lines, ...placed] } : el)))
      return refile(parked, bucket, freed)
    },
    send: (ctx) => deleteSet(d.pageId, {
      elements: rows.elements.map((id) => ({ id: ctx.id(id), revision: d.book.of('box', ctx.id(id), loadedBox.get(id)) })),
      lines: rows.lines.map((id) => ({ id: ctx.id(id), revision: d.book.of('line', ctx.id(id), loadedLine.get(id)) })),
    }),
  }
}

/** A box moved, reshaped or reclassed. Its lines and its neighbours' are filed again. */
export function patchBox(
  d: PageEditDeps, el: PageElement,
  change: { bbox?: Bbox; polygon?: Ring; class_name?: string; kind?: PageElement['kind'] },
  label: string,
): PageEdit {
  const fields = {
    ...change,
    ...(change.polygon ? { bbox: ringBounds(change.polygon) } : {}),
    ...(change.class_name ? { raw_class_name: change.class_name } : {}),
  }
  return {
    label,
    scope: d.pageId,
    needs: needing([el.id]),
    apply: (state, ctx) => refile(
      withElements(state, (els) => els.map((e) => (e.id === ctx.id(el.id) ? { ...e, ...fields } : e))),
      -1_000_000 - d.pageId),
    send: async (ctx) => {
      const id = ctx.id(el.id)
      const { kind: _kind, ...body } = change
      const saved = await patchElement(id, { ...body, revision: d.book.of('box', id, el.revision) })
      d.book.noteElement(saved)
      return saved
    },
  }
}

/** A line moved or reshaped; it is filed where it now lies. */
export function moveLine(d: PageEditDeps, line: Line, polygon: Ring): PageEdit {
  return {
    label: 'Move line',
    scope: d.pageId,
    needs: needing([line.id]),
    apply: (state, ctx) => {
      const id = ctx.id(line.id)
      const moved = withElements(state, (els) => els.map((el) => (el.lines.some((l) => l.id === id)
        ? { ...el, lines: el.lines.map((l) => (l.id === id ? { ...l, polygon } : l)) } : el)))
      return refile(moved, -1_000_000 - d.pageId, new Set([id]))
    },
    send: async (ctx) => {
      const id = ctx.id(line.id)
      const saved = await patchLinePolygon(id, polygon, d.book.of('line', id, line.revision))
      d.book.note('line', id, saved.revision)
      return saved
    },
  }
}

/** A box drawn by hand, under a temporary id until the server gives it its own. */
export function drawBox(
  d: PageEditDeps, temp: number, className: string, kind: PageElement['kind'], shape: { bbox: Bbox } | { polygon: Ring },
): PageEdit<Spanned<PageElement>> {
  const polygon = 'polygon' in shape ? shape.polygon : null
  const bbox = 'polygon' in shape ? ringBounds(shape.polygon) : shape.bbox
  return {
    label: 'Draw box',
    scope: d.pageId,
    creates: [temp],
    apply: (state, ctx) => {
      const id = ctx.id(temp)
      if (state.elements.some((el) => el.id === id)) return state
      const drawn: PageElement = {
        id, order_idx: state.elements.length, class_name: className, raw_class_name: className, bbox, conf: null,
        kind, checked: true, polygon, lines: [], revision: 0,
      }
      return refile(withElements(state, (els) => [...els, drawn]), -1_000_000 - d.pageId)
    },
    send: async () => {
      const saved = await createElement(d.pageId, className, shape)
      d.book.noteElement(saved)
      return saved
    },
    settles: (saved) => [[temp, saved.id]],
  }
}

/** A line drawn by hand, filed into the box it lies in. */
export function drawLine(d: PageEditDeps, temp: number, polygon: Ring): PageEdit<Spanned<Line>> {
  const bucket = -1_000_000 - d.pageId
  return {
    label: 'Draw line',
    scope: d.pageId,
    creates: [temp],
    apply: (state, ctx) => {
      const id = ctx.id(temp)
      if (findLine(state, id)) return state
      const host = smallestContentAt(state.elements, center(polygon))
        ?? state.elements.find((el) => el.kind === 'orphan')
      if (host) {
        return withElements(state, (els) => els.map((el) => (el === host ? { ...el, lines: [...el.lines, blankLine(id, polygon)] } : el)))
      }
      return withElements(state, (els) => [...els, {
        id: bucket, order_idx: els.length, class_name: 'Unassigned', raw_class_name: null, bbox: ringBounds(polygon),
        conf: null, kind: 'orphan', checked: false, polygon: null, lines: [blankLine(id, polygon)], revision: 0,
      }])
    },
    send: async () => {
      const saved = await createLine(d.pageId, polygon)
      d.book.note('line', saved.id, saved.revision)
      return saved
    },
    settles: (saved) => [[temp, saved.id]],
  }
}

/** Boxes merged into the first of them in reading order: their union, and all their lines. */
export function mergeBoxes(d: PageEditDeps, page: PageDetail, ids: number[]): PageEdit<Spanned<PageElement>> {
  const loaded = new Map(page.elements.map((el) => [el.id, el.revision]))
  return {
    label: 'Merge boxes',
    scope: d.pageId,
    needs: needing(ids),
    apply: (state, ctx) => {
      const real = new Set(ids.map(ctx.id))
      const picked = state.elements.filter((el) => real.has(el.id))
      if (picked.length < 2) return state
      const keep = picked.reduce((a, b) => (b.order_idx < a.order_idx ? b : a))
      const rings = picked.map((el) => el.polygon ?? boxRing(el.bbox))
      const outlined = picked.some((el) => el.polygon)
      const merged: PageElement = {
        ...keep,
        bbox: ringBounds(rings.flat()),
        polygon: outlined ? hull(rings.flat()) : null,
        lines: picked.flatMap((el) => el.lines),
      }
      return withElements(state, (els) => els.filter((el) => el === keep || !real.has(el.id)).map((el) => (el === keep ? merged : el)))
    },
    send: async (ctx) => {
      const real = ids.map(ctx.id)
      const saved = await mergeElements(real, Object.fromEntries(
        ids.map((id) => [ctx.id(id), d.book.of('box', ctx.id(id), loaded.get(id))])))
      d.book.noteElement(saved)
      return saved
    },
  }
}

/** Lines merged into the topmost: one box fitted around all of them, its readings gone. */
export function mergeLinesEdit(d: PageEditDeps, page: PageDetail, ids: number[]): PageEdit<Spanned<Line>> {
  const loaded = new Map(ids.map((id) => [id, findLine(page, id)?.revision ?? 0]))
  return {
    label: 'Merge lines',
    scope: d.pageId,
    needs: needing(ids),
    apply: (state, ctx) => {
      const real = new Set(ids.map(ctx.id))
      const picked = ids.map((id) => findLine(state, ctx.id(id))).filter((l): l is Line => !!l)
      if (picked.length < 2) return state
      const keep = picked.reduce((a, b) => {
        const [, ay] = center(a.polygon)
        const [, by] = center(b.polygon)
        return by < ay ? b : a
      })
      const merged = cleared(keep, minAreaQuad(picked.flatMap((l) => l.polygon), d.aspect))
      return withElements(state, (els) => els.map((el) => (el.lines.some((l) => real.has(l.id))
        ? { ...el, lines: el.lines.filter((l) => l === keep || !real.has(l.id)).map((l) => (l === keep ? merged : l)) }
        : el)))
    },
    send: async (ctx) => {
      const saved = await mergeLines(ids.map(ctx.id), Object.fromEntries(
        ids.map((id) => [ctx.id(id), d.book.of('line', ctx.id(id), loaded.get(id))])))
      d.book.note('line', saved.id, saved.revision)
      return saved
    },
  }
}

/** A box cut in two along one axis; the first half keeps its id and each line goes to the
 *  half its centre is in. */
export function splitBox(d: PageEditDeps, el: PageElement, cut: { cut_x: number } | { cut_y: number }, temp: number):
  PageEdit<{ elements: PageElement[]; span: EditSpan }> {
  const axis = 'cut_x' in cut ? 0 : 1
  const at = 'cut_x' in cut ? cut.cut_x : cut.cut_y
  const line: [Pt, Pt] = axis === 0 ? [[at, 0], [at, 1]] : [[1, at], [0, at]]
  return {
    label: 'Split box',
    scope: d.pageId,
    creates: [temp],
    needs: needing([el.id]),
    apply: (state, ctx) => {
      const id = ctx.id(el.id)
      const other = ctx.id(temp)
      const current = state.elements.find((e) => e.id === id)
      if (!current || state.elements.some((e) => e.id === other)) return state
      const ring = current.polygon ?? boxRing(current.bbox)
      const [a, b] = [clipByLine(ring, line[0], line[1], true), clipByLine(ring, line[0], line[1], false)]
      if (a.length < 3 || b.length < 3) return state
      const inB = (l: Line) => center(l.polygon)[axis] >= at
      const first = { ...current, bbox: ringBounds(a), polygon: current.polygon ? a : null, lines: current.lines.filter((l) => !inB(l)) }
      const second = { ...current, id: other, order_idx: current.order_idx + 0.5, bbox: ringBounds(b),
                       polygon: current.polygon ? b : null, lines: current.lines.filter(inB), revision: 0 }
      return withElements(state, (els) => els.flatMap((e) => (e === current ? [first, second] : [e])))
    },
    send: async (ctx) => {
      const id = ctx.id(el.id)
      const saved = await splitElement(id, cut, d.book.of('box', id, el.revision))
      saved.elements.forEach((e) => d.book.noteElement(e))
      return saved
    },
    settles: (saved) => [[temp, saved.elements[1].id]],
  }
}

/** A line cut along a drawn stroke; the piece holding its first corner keeps its id. */
export function splitLineEdit(d: PageEditDeps, line: Line, cut: [Pt, Pt], temp: number): PageEdit<{ lines: Line[]; span: EditSpan }> {
  return {
    label: 'Split line',
    scope: d.pageId,
    creates: [temp],
    needs: needing([line.id]),
    apply: (state, ctx) => {
      const id = ctx.id(line.id)
      const other = ctx.id(temp)
      const current = findLine(state, id)
      if (!current || findLine(state, other)) return state
      const sides = [clipByLine(current.polygon, cut[0], cut[1], true), clipByLine(current.polygon, cut[0], cut[1], false)]
      if (sides.some((s) => s.length < 3)) return state
      const corner = current.polygon[0]
      const holdsFirst = (s: Ring) => s.some((p) => p[0] === corner[0] && p[1] === corner[1])
      const [first, second] = holdsFirst(sides[0]) ? sides : [sides[1], sides[0]]
      return withElements(state, (els) => els.map((el) => (el.lines.includes(current)
        ? { ...el, lines: el.lines.flatMap((l) => (l === current ? [cleared(l, first), blankLine(other, second)] : [l])) }
        : el)))
    },
    send: async (ctx) => {
      const id = ctx.id(line.id)
      const saved = await splitLine(id, { cut_line: cut as [[number, number], [number, number]] }, d.book.of('line', id, line.revision))
      saved.lines.forEach((l) => d.book.note('line', l.id, l.revision))
      return saved
    },
    settles: (saved) => [[temp, saved.lines[1].id]],
  }
}

/** Layout complete or Lines complete switched for the page. */
export function setPageFlag(d: PageEditDeps, page: PageDetail, flag: 'layout_checked' | 'lines_checked', value: boolean): PageEdit {
  return {
    label: flag === 'layout_checked' ? 'Layout complete' : 'Lines complete',
    scope: d.pageId,
    apply: (state) => ({ ...state, [flag]: value }),
    send: async () => {
      const revision = d.book.of('page', d.pageId, page.revision)
      const saved = flag === 'layout_checked'
        ? await setPageLayoutChecked(d.pageId, value, revision)
        : await setPageLinesChecked(d.pageId, value, revision)
      d.book.note('page', d.pageId, saved.revision)
      return saved
    },
  }
}

/** How an edit changed the page, as the steps that take it back and do it again before the
 *  server has: every box it touched is put back as it stood, the page's switches with them. */
export function localSteps(before: PageDetail, after: PageDetail, realId: (id: number) => number) {
  const index = (page: PageDetail) => new Map(page.elements.map((el) => [el.id, el]))
  const [was, now] = [index(before), index(after)]
  const touched = [...new Set([...was.keys(), ...now.keys()])].filter((id) => was.get(id) !== now.get(id))
  const flags = (['layout_checked', 'lines_checked'] as const).filter((f) => before[f] !== after[f])
  const toward = (target: Map<number, PageElement>, page: PageDetail) => (state: PageDetail): PageDetail => {
    const ids = new Set(touched.map(realId))
    const restored = touched.map((id) => target.get(id)).filter((el): el is PageElement => !!el)
      .map((el) => ({ ...el, id: realId(el.id), lines: el.lines.map((l) => ({ ...l, id: realId(l.id) })) }))
    const restoredLines = new Set(restored.flatMap((el) => el.lines.map((l) => l.id)))
    const kept = state.elements.filter((el) => !ids.has(el.id))
      .map((el) => (el.lines.some((l) => restoredLines.has(l.id)) ? { ...el, lines: el.lines.filter((l) => !restoredLines.has(l.id)) } : el))
    return { ...state, ...Object.fromEntries(flags.map((f) => [f, page[f]])), elements: [...kept, ...restored] }
  }
  return { undo: toward(was, before), redo: toward(now, after) }
}
