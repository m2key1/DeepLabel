import { batchRegions } from '../api'
import type { Region, RegionKind, Ring } from '../api'
import { isTemporary } from './editQueue'
import type { Edit } from './editQueue'
import type { RevisionBook } from './guardedSave'
import type { LocalSteps } from './useEditHistory'

/** Shapes of one tile drawn, changed and deleted together: one request, one undo step. */
export interface TileChange {
  create?: { temp: number; class_id: number; points: Ring; holes?: Ring[]; kind?: RegionKind }[]
  patch?: { region: Pick<Region, 'id' | 'revision'>; points?: Ring; holes?: Ring[]; class_id?: number }[]
  delete?: Pick<Region, 'id' | 'revision'>[]
}

type ShapeChange = NonNullable<TileChange['patch']>[number]
type Saved = Awaited<ReturnType<typeof batchRegions>>

export interface TileEditDeps {
  pageId: number
  book: RevisionBook
  className(classId: number): string
}

export function tileEdit(d: TileEditDeps, change: TileChange, label: string): Edit<Region[], Saved> {
  const creates = change.create ?? []
  const patches = change.patch ?? []
  const deletes = change.delete ?? []
  const touched = [...patches.map((p) => p.region.id), ...deletes.map((r) => r.id)]
  const fields = (p: ShapeChange) => ({
    ...(p.points ? { points: p.points } : {}),
    ...(p.holes ? { holes: p.holes } : {}),
    ...(p.class_id !== undefined ? { class_id: p.class_id, class_name: d.className(p.class_id) } : {}),
  })
  return {
    label,
    scope: d.pageId,
    creates: creates.map((c) => c.temp),
    needs: touched.some(isTemporary) ? touched.filter(isTemporary) : undefined,
    apply: (regions, ctx) => {
      const gone = new Set(deletes.map((r) => ctx.id(r.id)))
      const changed = new Map(patches.map((p) => [ctx.id(p.region.id), fields(p)]))
      const kept = regions.filter((r) => !gone.has(r.id)).map((r) => (changed.has(r.id) ? { ...r, ...changed.get(r.id) } : r))
      const present = new Set(kept.map((r) => r.id))
      const drawn = creates.filter((c) => !present.has(ctx.id(c.temp))).map((c, i): Region => ({
        id: ctx.id(c.temp), order_idx: kept.length + i, class_id: c.class_id, class_name: d.className(c.class_id),
        points: c.points, holes: c.holes ?? [], kind: c.kind ?? 'polygon', checked: true, revision: 0,
      }))
      return drawn.length ? [...kept, ...drawn] : kept
    },
    send: async (ctx) => {
      const at = (r: Pick<Region, 'id' | 'revision'>) => ({ id: ctx.id(r.id), revision: d.book.of('region', ctx.id(r.id), r.revision) })
      const saved = await batchRegions(d.pageId, {
        create: creates.map((c) => ({ key: String(c.temp), class_id: c.class_id, points: c.points, holes: c.holes ?? [], kind: c.kind })),
        patch: patches.map((p) => ({ ...at(p.region), points: p.points, holes: p.holes, class_id: p.class_id })),
        delete: deletes.map(at),
      })
      ;[...saved.regions, ...Object.values(saved.created)].forEach((r) => d.book.note('region', r.id, r.revision))
      return saved
    },
    settles: (saved) => creates.map((c) => [c.temp, saved.created[String(c.temp)].id]),
  }
}

/** How an edit changed the tile, as the steps that take it back and do it again before
 *  the server has. */
export function regionSteps(before: Region[], after: Region[], realId: (id: number) => number): LocalSteps<Region[]> {
  const index = (rs: Region[]) => new Map(rs.map((r) => [r.id, r]))
  const [was, now] = [index(before), index(after)]
  const touched = [...new Set([...was.keys(), ...now.keys()])].filter((id) => was.get(id) !== now.get(id))
  const toward = (target: Map<number, Region>) => (regions: Region[]): Region[] => {
    const ids = new Set(touched.map(realId))
    const restored = touched.map((id) => target.get(id)).filter((r): r is Region => !!r).map((r) => ({ ...r, id: realId(r.id) }))
    return [...regions.filter((r) => !ids.has(r.id)), ...restored]
  }
  return { undo: toward(was), redo: toward(now) }
}
