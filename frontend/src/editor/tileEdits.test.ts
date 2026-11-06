import { describe, expect, it } from 'vitest'
import type { Region, Ring } from '../api'
import type { EditContext } from './editQueue'
import { RevisionBook } from './guardedSave'
import { regionSteps, tileEdit } from './tileEdits'

const tri = (x: number): Ring => [[x, 0.1], [x + 0.1, 0.1], [x + 0.1, 0.2]]
const region = (id: number, x: number): Region =>
  ({ id, order_idx: id, class_id: 1, class_name: 'water', points: tri(x), holes: [], kind: 'polygon', checked: true, revision: 0 })
const deps = { pageId: 3, book: new RevisionBook(), className: (id: number) => (id === 2 ? 'road' : 'water') }
const same: EditContext = { id: (id) => id }
const tile = () => [region(1, 0.1), region(2, 0.5)]

describe('the tile editor\'s edits, as shown before the server answers', () => {
  it('draws, changes and deletes in one go', () => {
    const shown = tileEdit(deps, {
      create: [{ temp: -4, class_id: 2, points: tri(0.7) }],
      patch: [{ region: tile()[0], class_id: 2 }],
      delete: [tile()[1]],
    }, 'Merge').apply(tile(), same)
    expect(shown.map((r) => [r.id, r.class_name])).toEqual([[1, 'road'], [-4, 'road']])
  })

  it('shows a drawn shape under its real id once the server gave it one, and only once', () => {
    const edit = tileEdit(deps, { create: [{ temp: -4, class_id: 1, points: tri(0.7) }] }, 'Draw')
    const real: EditContext = { id: (id) => (id === -4 ? 40 : id) }
    const once = edit.apply(tile(), real)
    expect(once.map((r) => r.id)).toEqual([1, 2, 40])
    expect(edit.apply(once, real)).toEqual(once)
  })

  it('takes an edit back and does it again from how it changed the tile', () => {
    const before = tile()
    const after = tileEdit(deps, { delete: [before[0]], patch: [{ region: before[1], points: tri(0.6) }] }, 'Erase')
      .apply(before, same)
    const steps = regionSteps(before, after, (id) => id)
    const undone = steps.undo(after)
    expect(undone.map((r) => [r.id, r.points[0][0]]).sort()).toEqual([[1, 0.1], [2, 0.5]])
    expect(steps.redo(undone).map((r) => [r.id, r.points[0][0]])).toEqual([[2, 0.6]])
  })
})
