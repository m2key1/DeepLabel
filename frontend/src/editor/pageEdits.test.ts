import { describe, expect, it } from 'vitest'
import type { Line, PageDetail, PageElement } from '../api'
import type { Ring } from '../lib/geometry/core'
import type { EditContext } from './editQueue'
import { RevisionBook } from './guardedSave'
import {
  deleteRows, drawBox, localSteps, mergeBoxes, moveLine, patchBox, refile, setPageFlag, splitBox,
} from './pageEdits'

const quad = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
const line = (id: number, poly: Ring): Line => ({ id, polygon: poly, revision: 0 } as unknown as Line)
const box = (id: number, bbox: [number, number, number, number], lines: Line[], kind: PageElement['kind'] = 'content'): PageElement => ({
  id, order_idx: id, class_name: kind === 'orphan' ? 'Unassigned' : 'Paragraph', raw_class_name: null, bbox, conf: null,
  kind, checked: false, polygon: null, lines, revision: 0,
})

// Two boxes one above the other, a line in each, and one line outside both.
const page = (): PageDetail => ({
  id: 7, layout_checked: false, lines_checked: false,
  elements: [
    box(1, [0, 0, 1, 0.4], [line(10, quad(0.1, 0.1, 0.9, 0.2))]),
    box(2, [0, 0.5, 1, 0.8], [line(20, quad(0.1, 0.6, 0.9, 0.7))]),
    box(3, [0, 0.85, 1, 0.95], [line(30, quad(0.1, 0.86, 0.9, 0.94))], 'orphan'),
  ],
} as unknown as PageDetail)

const deps = { pageId: 7, book: new RevisionBook(), aspect: 1 }
const same: EditContext = { id: (id) => id }
const homes = (p: PageDetail) => Object.fromEntries(p.elements.flatMap((el) => el.lines.map((l) => [l.id, el.id])))

describe('the page editor\'s edits, as shown before the server answers', () => {
  it('a deleted box leaves its lines, filed where they lie', () => {
    const shown = deleteRows(deps, page(), { elements: [1], lines: [] }).apply(page(), same)
    expect(shown.elements.map((el) => el.id)).toEqual([2, 3])
    expect(homes(shown)).toEqual({ 10: 3, 20: 2, 30: 3 })
  })

  it('a deleted line is gone, and nothing else moves', () => {
    const shown = deleteRows(deps, page(), { elements: [], lines: [20] }).apply(page(), same)
    expect(homes(shown)).toEqual({ 10: 1, 30: 3 })
  })

  it('a box moved over an unassigned line takes it in', () => {
    const el = page().elements[1]
    const shown = patchBox(deps, el, { bbox: [0, 0.5, 1, 1] }, 'Move box').apply(page(), same)
    expect(homes(shown)).toEqual({ 10: 1, 20: 2, 30: 2 })
  })

  it('a box reclassed as a container gives its lines up', () => {
    const el = page().elements[0]
    const shown = patchBox(deps, el, { class_name: 'Column', kind: 'container' }, 'Change class').apply(page(), same)
    expect(shown.elements[0].class_name).toBe('Column')
    expect(homes(shown)).toEqual({ 10: 3, 20: 2, 30: 3 })
  })

  it('a drawn box shows under its temporary id, then under the one the server gave it', () => {
    const edit = drawBox(deps, -5, 'Header', 'content', { bbox: [0, 0.82, 1, 1] })
    const before = edit.apply(page(), same)
    expect(before.elements.find((el) => el.id === -5)?.lines.map((l) => l.id)).toEqual([30])
    const after = edit.apply(page(), { id: (id) => (id === -5 ? 99 : id) })
    expect(after.elements.find((el) => el.id === 99)?.class_name).toBe('Header')
    expect(edit.apply(after, { id: (id) => (id === -5 ? 99 : id) })).toEqual(after)
  })

  it('a moved line is filed into the box it now lies in', () => {
    const l = page().elements[0].lines[0]
    const shown = moveLine(deps, l, quad(0.1, 0.6, 0.9, 0.65)).apply(page(), same)
    expect(homes(shown)[10]).toBe(2)
  })

  it('a split box keeps its id for the first half and sends each line to the half it sits in', () => {
    const p = page()
    p.elements[0].lines.push(line(11, quad(0.6, 0.25, 0.9, 0.35)))
    const shown = splitBox(deps, p.elements[0], { cut_y: 0.22 }, -8).apply(p, same)
    const [a, b] = [shown.elements.find((el) => el.id === 1)!, shown.elements.find((el) => el.id === -8)!]
    a.bbox.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 1, 0.22][i]))
    b.bbox.forEach((v, i) => expect(v).toBeCloseTo([0, 0.22, 1, 0.4][i]))
    expect([a.lines.map((l) => l.id), b.lines.map((l) => l.id)]).toEqual([[10], [11]])
  })

  it('merged boxes become the first in reading order, around all of them', () => {
    const shown = mergeBoxes(deps, page(), [2, 1]).apply(page(), same)
    const merged = shown.elements.find((el) => el.id === 1)!
    expect(merged.bbox).toEqual([0, 0, 1, 0.8])
    expect(merged.lines.map((l) => l.id)).toEqual([10, 20])
    expect(shown.elements.some((el) => el.id === 2)).toBe(false)
  })

  it('a page switch flips at once', () => {
    expect(setPageFlag(deps, page(), 'layout_checked', true).apply(page(), same).layout_checked).toBe(true)
  })

  it('takes an edit back and does it again from how it changed the page', () => {
    const before = page()
    const after = deleteRows(deps, before, { elements: [1], lines: [] }).apply(before, same)
    const steps = localSteps(before, after, (id) => id)
    const undone = steps.undo(after)
    expect(homes(undone)).toEqual(homes(before))
    expect(undone.elements.map((el) => el.id).sort()).toEqual([1, 2, 3])
    expect(homes(steps.redo(undone))).toEqual(homes(after))
  })

  it('files lines into a new Unassigned bucket when the page has none', () => {
    const p = page()
    p.elements = p.elements.slice(0, 2)
    const shown = refile({ ...p, elements: [p.elements[1]] }, -77)
    expect(homes(shown)).toEqual({ 20: 2 })
    const lost = refile({ ...p, elements: [{ ...p.elements[0], kind: 'container' }, p.elements[1]] }, -77)
    expect(homes(lost)).toEqual({ 10: -77, 20: 2 })
  })
})
