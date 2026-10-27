import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  conflictOf, createJobClass, createRegion, deleteJobClass, deleteRegion, detectRegions, getEdgeMethods,
  getJob, getJobMapClasses, getPage, isUncounted, patchJobClass, patchRegion, reorderJobClasses, setLineWidth,
  tilesUrl, setPageLayoutChecked,
} from '../api'
import type {
  EditSpan, EdgeMethod, JobDetail, MapClass, PageDetail, Region, RevertResult, Ring,
} from '../api'
import { useAuth } from '../auth'
import { clamp01, midpoints, simplifyPolyline } from '../lib/geometry/core'
import {
  clampShift, closeRun, closestEdge, contourBetween, cornersOf, countVertices, cutPolyline, deleteVertices, eraseFromGeom, extendPolyline, isClosedRun, joinPolylines, moveVertices, redrawRun, redrawStretch, regionAreaPx, simplifyRegionGeometry, subtractRegions, toPoly, translateRegion, unionRegions, vertexCount, verticesInBox, withRing,
} from '../lib/geometry/region'
import type { EdgeHit } from '../lib/geometry/region'
import { useImageSurface } from '../hooks/useImageSurface'
import { usePointerDrag } from '../hooks/usePointerDrag'
import { spanOf, useEditHistory } from '../editor/useEditHistory'
import { useGuardedSave } from '../editor/guardedSave'
import { usePageLiveFeed } from '../editor/usePageLiveFeed'
import { comboLabel, eventCombo, useSettings } from '../settings'
import { PresenceBanner } from '../components/presence/PresenceBanner'
import { usePresence, usePresenceLocation } from '../presence'
import { AddClassDialog, RemoveClassDialog } from '../components/tile/ClassDialogs'
import { Button } from '../components/ui/Button'
import { Check, Select } from '../components/ui/Field'
import { Segmented } from '../components/ui/Segmented'
import { EditorShell } from '../editor/EditorShell'
import { ObjectList } from '../editor/ObjectList'
import { BRUSH_MAX_PX, BRUSH_MIN_PX, BrushPanel, brushOnGlass, stepBrush } from '../editor/BrushPanel'
import { PenPanel } from '../editor/PenPanel'
import { SelectionPanel } from '../editor/SelectionPanel'
import { ToolPalette } from '../editor/ToolPalette'
import type { Tool } from '../editor/types'
import { ShortcutSheet } from '../editor/ShortcutSheet'
import { StatusBar } from '../editor/StatusBar'
import { useZoomReadout } from '../editor/useZoomReadout'
import { hexToRgb, rgbToHex } from '../lib/color'
import { useAutoClear } from '../messages'

// How the detect tool's area is picked: outlined vertex by vertex, or dragged as a box.
type AreaShape = 'polygon' | 'rect'
type Pt = [number, number]

const rgb = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`
const CLOSE_SNAP_PX = 12 // click within this of the first vertex closes the ring
// How near an existing outline a drawn point is pulled onto it. Screen px, like every
// other hit radius here, so zooming in is how you place a point that must *not* snap.
const SNAP_PX = 12
// Below this a marquee drag is a stray click, not a box worth detecting in.
const MIN_MARQUEE_PX = 6
// A press in the draw tool that travels less than this (screen px) is a click that places
// one vertex; further than this it becomes a freehand stroke.
const CLICK_SLOP_PX = 4
// A stroke records a point every so many screen px, and on release keeps only the ones
// that bend the outline by more than FREEHAND_TOLERANCE_PX - so a straight sweep ends up
// as its two ends, however slowly it was drawn.
const FREEHAND_STEP_PX = 3
const FREEHAND_TOLERANCE_PX = 2

function readStored(key: string, fallback: number, min = 0, max = 1): number {
  const s = localStorage.getItem(key)
  if (s === null) return fallback
  const v = Number(s)
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

const isLine = (r: Region) => r.kind === 'polyline'
// A traced line brought back to where it began. It stores that point twice - the only
// mark of its closure - while the editor shows one corner there and keeps the two in step.
const isClosedTrace = (r: Region) => isLine(r) && isClosedRun(r.points)
const LINE_HIT_PX = 8 // click within this of a traced line selects it
// Adding a vertex is a deliberate gesture aimed at an outline that is already selected, so
// it accepts a far looser aim than selection does. A polygon still has to be hit near one of
// its edges (a double-click in open space must not deform it); a selected traced line takes
// the click from anywhere on the tile — see insertVertexAtCursor.
const INSERT_HIT_PX = LINE_HIT_PX * 3
const VERTEX_R = 5 // vertex handle radius, as drawn
const MIDPOINT_R = 3.5 // midpoint (insert) handle radius, as drawn
// What a handle catches is wider than what it draws. A drawn dot is a few pixels across
// and the pointer's hotspot sits at the fingertip, so aiming at the dot itself fails more
// often than it lands; the hit circle is what the aim really has to meet. For a vertex it
// must beat LINE_HIT_PX: the line's hit stroke runs straight through every corner, so a
// press inside this radius that missed the handle would land on the line and drag the
// whole trace instead of one point. A midpoint stays below LINE_HIT_PX on purpose - the
// middle of a line is where a hand grabs it to move it, and a wide insert target there
// would take that grip away.
const VERTEX_HIT_PX = 10
const MIDPOINT_HIT_PX = 6
// How long a click that hit nothing waits before deselecting, so the second half of a
// double-click can cancel it. Comfortably above a system double-click interval.
const DESELECT_DELAY_MS = 350

// The eraser brush's radius, in *screen* pixels - like every other hit radius here it is
// constant on screen, so zooming in is how you get precision.


interface VertexRef {
  regionId: number
  ringIdx: number
  index: number
}

// A vertex picked with a box drag (or Shift-click) in the select tool, with the point it
// was picked at. The point is how a pick knows it is still good: see livePicks.
interface PickedVertex extends VertexRef {
  pt: Pt
}
const pickKey = (regionId: number, ringIdx: number, index: number) => `${regionId}:${ringIdx}:${index}`

interface Draft {
  pts: Ring
  holeFor: number | null // region id when drawing a hole, else a new region
  // Set while a stretch of an existing outline is being redrawn: the ring, and the vertex
  // the new points lead away from. Ended by clicking another vertex of that ring.
  redraw?: { regionId: number; ringIdx: number; start: number }
  // The existing vertex the last point snapped onto, if any: the start of a contour the
  // next snapped point may continue along.
  lastSnap?: VertexRef | null
}

// One held eraser stroke. Geometry lives in `regions` the whole time (so the canvas shows
// vertices going as they are swept); this tracks what the stroke has to undo and persist
// when the button comes up, so the release never has to read `regions` back.
interface EraseStroke {
  touched: Set<number> // every region the brush has reached
  after: Map<number, Region> // latest geometry of every region hit
  deletedIds: Set<number> // regions that fell below their floor mid-stroke
  last: Pt // previous cursor position, so each move erases along a segment, not a dot
}

export function TileEditorPage() {
  const { id: jobId, pageId: pageIdParam } = useParams()
  const pageId = Number(pageIdParam)
  const navigate = useNavigate()
  const { isAdmin, role } = useAuth()
  const readOnly = role === 'viewer'
  const { hotkeys } = useSettings()

  const [job, setJob] = useState<JobDetail | null>(null)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [classes, setClasses] = useState<MapClass[]>([])
  const [regions, setRegions] = useState<Region[]>([])
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  // Line-tracing jobs draw open polylines; polygon jobs draw filled rings. Only the
  // *new* geometry's kind comes from the job — everything else branches per region on
  // r.kind, so a job holding both kinds already renders and edits correctly.
  const lineJob = job?.task === 'map_lines'
  const drawKind: Region['kind'] = lineJob ? 'polyline' : 'polygon'

  const [tool, setTool] = useState<Tool>('draw')
  // Space or Alt held over any tool is the hand: the pane pans and nothing draws or
  // selects. Held, not switched - `tool` itself never moves, so letting go always puts
  // the real tool back and a keyup that goes missing cannot strand the editor.
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const handHeld = spaceHeld || altHeld
  const panning = tool === 'hand' || handHeld
  const [activeClassId, setActiveClassId] = useState(1)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [cursor, setCursor] = useState<Pt | null>(null)
  // How many of the draft's points were placed before a freehand stroke began, so the
  // stroke itself is a line rather than a rash of dots while the hand is still moving.
  const [strokeFrom, setStrokeFrom] = useState<number | null>(null)

  const { onPage } = usePresence()
  usePresenceLocation(page && jobId
    ? { job_id: jobId, page_id: page.id, editing: !readOnly,
        target: selectedId !== null ? { kind: 'region', id: selectedId } : null }
    : jobId ? { job_id: jobId } : null)
  const [busy, setBusy] = useState(false)
  // Select tool: shapes gathered with Shift-click for a merge, and the armed scissors.
  const [mergeSet, setMergeSet] = useState<Set<number>>(new Set())
  const [cutArmed, setCutArmed] = useState(false)

  // View controls (opacity persisted; show-only is session-scoped).
  const [fillOpacity, setFillOpacity] = useState(() => readStored('deeplabel.map.fillOpacity', 0.3))
  const [handleOpacity, setHandleOpacity] = useState(() => readStored('deeplabel.map.handleOpacity', 1))
  // A traced line is the annotation *and* the thing it covers on the scan, so fading it is
  // the only way to check a trace against the ink underneath. Fill does that job for
  // polygons, hence line jobs only.
  const [lineOpacity, setLineOpacity] = useState(() => readStored('deeplabel.map.lineOpacity', 1))
  const [showOnly, setShowOnly] = useState(false)
  // Export preview: draw saved traces at the width the mask export will stroke them, so a
  // width is chosen by looking at the map rather than by exporting and opening a PNG.
  // Session-scoped on purpose - unlike the sliders above it previews *job* data, and a
  // localStorage key is per user across every job, so it would carry one job's width into
  // the next. The width is seeded from the job each time the toggle goes on.
  const [exportPreview, setExportPreview] = useState(false)
  const [previewWidth, setPreviewWidth] = useState(3)
  const [savingWidth, setSavingWidth] = useState(false)
  const [tolerance, setTolerance] = useState(1)
  // Snapping is sticky per user like the view controls, and on by default: overshooting a
  // line you meant to meet is the common failure, not the rare one. `snapped` is only the
  // cursor's indicator — whether the point under it was pulled onto an outline.
  const [snapLines, setSnapLines] = useState(() => readStored('deeplabel.map.lineSnap', 1) === 1)
  const [snapped, setSnapped] = useState(false)
  const [brushRadius, setBrushRadius] = useState(() =>
    readStored('deeplabel.map.brushRadius', 20, BRUSH_MIN_PX, BRUSH_MAX_PX),
  )
  // Area-detect: the shape being selected, and the detectors the server offers. `edgeInfo`
  // is fetched the first time the tool is opened — a job that never uses it never asks.
  const [areaShape, setAreaShape] = useState<AreaShape>('polygon')
  const [areaDraft, setAreaDraft] = useState<Ring | null>(null)
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null)
  // Select tool: vertices picked to be moved or removed together, across shapes.
  const [picks, setPicks] = useState<PickedVertex[]>([])
  const [edgeInfo, setEdgeInfo] = useState<{ configured: boolean; methods: EdgeMethod[] } | null>(null)
  const [edgeMethod, setEdgeMethod] = useState('')
  const [edgeMethodsFailed, setEdgeMethodsFailed] = useState(false)
  const [uncovered, setUncovered] = useState<number | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const noticeTimer = useRef<number | null>(null)
  // Class editing.
  const [addOpen, setAddOpen] = useState(false)
  const [removeClass, setRemoveClass] = useState<MapClass | null>(null)
  const colorTimers = useRef<Map<number, number>>(new Map())

  const paneRef = useRef<HTMLDivElement>(null)
  // How big the tile is drawn, in pixels of screen. Every hit radius here is measured in
  // those - a vertex is grabbed within twelve pixels of the pointer however far in the
  // view is - and the geometry is drawn at that size, so this is what the page works in
  // rather than a zoom factor.
  const [drawn, setDrawn] = useState({ w: 0, h: 0, zoom: 1 })
  const onSize = useCallback((w: number, h: number, zoom: number) => setDrawn({ w, h, zoom }), [])
  const scan = useMemo(
    () => (page?.width && page?.height
      ? { tiles: tilesUrl(page.id, page.rotation), width: page.width, height: page.height }
      : null),
    [page?.id, page?.rotation, page?.width, page?.height],
  )
  // Shift+wheel over the tile sizes the eraser's brush, so the hand never has to leave the
  // tile for the slider. With any other tool in hand the turn stays the surface's.
  const onShiftWheel = (notch: 1 | -1) => {
    if (tool !== 'erase' || handHeld) return false
    setBrushRadius((px) => stepBrush(px, notch))
    return true
  }
  // The whole tile, to start: a map tile is square and small, and every corner of it has
  // to be reachable without panning to it first.
  const { setScale, toPage, register, onPanStart, onPanMove, onPanEnd } =
    useImageSurface(scan, { min: 0.25, max: 12, frame: 'whole', onSize, grab: panning, onShiftWheel })
  const tileRefs = register('tile')
  const svgRef = useRef<SVGSVGElement>(null)
  // Every drag on the canvas - a vertex, an eraser stroke, a detect box - goes through
  // this one capture, so the pointer may leave the tile and the window mid-gesture.
  const drag = usePointerDrag(svgRef)
  const swallowNextClick = useRef(false)
  // A shape's save is out for a moment after the gesture that finished it, and the
  // gestures that follow in that moment - the dblclick behind the click that closed it -
  // still hold the shape. One save at a time: a second request for it is dropped.
  const committing = useRef(false)
  // A click that misses everything deselects, but it may also be the first half of a
  // double-click meant to add a vertex to the selected line - so the deselect waits.
  const deselectTimer = useRef<number | null>(null)

  // --- local state mutation helpers -----------------------------------------

  // The footer line. `setError` is for what makes the page unusable - it replaces the whole
  // editor - so anything a user can simply try again flashes here instead.
  const flash = useCallback((msg: string, tone: 'info' | 'error' = 'info') => {
    setNotice({ text: msg, tone })
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3000)
  }, [])
  const flashError = useCallback((msg: string) => flash(msg, 'error'), [flash])

  const upsertLocal = useCallback((r: Region) => {
    setRegions((rs) => {
      const i = rs.findIndex((x) => x.id === r.id)
      if (i === -1) return [...rs, r]
      const copy = rs.slice()
      copy[i] = r
      return copy
    })
  }, [])

  const removeLocal = useCallback((id: number) => {
    setRegions((rs) => rs.filter((r) => r.id !== id))
  }, [])

  const applyRevert = useCallback((result: RevertResult) => {
    result.regions.forEach(upsertLocal)
    result.removed_regions.forEach(removeLocal)
    setSelectedId((cur) => (cur !== null && result.removed_regions.includes(cur) ? null : cur))
  }, [upsertLocal, removeLocal])
  const { record: recordEdit, undo, redo, reset: resetHistory } = useEditHistory(page?.id, applyRevert, flashError)

  const classById = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes])
  const drawable = useMemo(() => classes.filter((c) => c.id !== 0), [classes])
  const ranked = useMemo(() => [...drawable].sort((a, b) => a.priority - b.priority || a.id - b.id), [drawable])
  const colorFor = useCallback(
    (cid: number): [number, number, number] => classById.get(cid)?.color ?? [128, 128, 128],
    [classById],
  )

  // What the canvas draws — and, by the same token, what the eraser may touch and what
  // snapping may pull towards: an outline you cannot see must not move your cursor.
  const visibleRegions = useMemo(
    () => (showOnly && selectedId !== null ? regions.filter((r) => r.id === selectedId) : regions),
    [regions, showOnly, selectedId],
  )

  // A pick names its vertex by position in a ring, and positions shift under it - an undo,
  // an inserted vertex, a colleague's edit arriving live. So a pick holds only while the
  // corner it names is still the point it was picked at; one that is not is dropped rather
  // than left aiming at a neighbour, which a Delete would then remove instead.
  const livePicks = useMemo(() => {
    if (!picks.length) return picks
    const byId = new Map(regions.map((r) => [r.id, r]))
    const held = picks.filter((p) => {
      const r = byId.get(p.regionId)
      const c = r && cornersOf(r, p.ringIdx, isLine(r))[p.index]
      return !!c && Math.abs(c[0] - p.pt[0]) < 1e-9 && Math.abs(c[1] - p.pt[1]) < 1e-9
    })
    return held.length === picks.length ? picks : held
  }, [picks, regions])
  const pickedKeys = useMemo(
    () => new Set(livePicks.map((p) => pickKey(p.regionId, p.ringIdx, p.index))),
    [livePicks],
  )

  const tileW = page?.width || 512
  const tileH = page?.height || 512
  const displayW = drawn.w || tileW
  const displayH = drawn.h || tileH
  // The readout and its buttons still speak in multiples of the tile's own pixels, which
  // is what 100% has always meant on this page.
  const zoom = displayW / tileW
  const { readoutRef, publish: publishZoom } = useZoomReadout()
  useEffect(() => publishZoom(zoom), [zoom, publishZoom])
  // The brush is measured against the fitted tile, so it keeps its place on the tile as
  // the view zooms.
  const brushPx = brushOnGlass(brushRadius, drawn.zoom)

  const reloadClasses = useCallback((): Promise<MapClass[] | null> => {
    if (!jobId) return Promise.resolve(null)
    return getJobMapClasses(jobId)
      .then((fresh) => { setClasses(fresh); return fresh })
      .catch((e: Error) => { setError(e.message); return null })
  }, [jobId])

  useEffect(() => {
    void reloadClasses()
  }, [reloadClasses])

  // activeClassId defaults to 1, which may not exist once classes are edited.
  useEffect(() => {
    if (drawable.length && !drawable.some((c) => c.id === activeClassId)) setActiveClassId(drawable[0].id)
  }, [drawable, activeClassId])

  useEffect(() => {
    if (jobId) getJob(jobId).then(setJob).catch((e: Error) => setError(e.message))
  }, [jobId])

  // A tile that answers after the editor has moved on to another is not shown over it.
  const routePageId = useRef(pageId)
  routePageId.current = pageId
  const showTile = useCallback((p: PageDetail) => {
    if (p.id !== routePageId.current) return
    setPage(p)
    setRegions(p.regions ?? [])
  }, [])

  useEffect(() => {
    setPage(null)
    setRegions([])
    setSelectedId(null)
    setDraft(null)
    setCursor(null)
    setError(null)
    if (!jobId || !pageId) return
    getPage(jobId, pageId)
      .then(showTile)
      .catch((e: Error) => { if (routePageId.current === pageId) setError(e.message) })
  }, [jobId, pageId, showTile])

  // Another person's shapes arrive as they draw them, and refresh the tile in place.
  const livePageId = page?.id
  const reloadTile = useCallback(() => {
    if (livePageId === undefined || !jobId) return
    getPage(jobId, livePageId)
      .then(showTile)
      .catch((e: Error) => flash(e.message, 'error'))
  }, [livePageId, jobId, showTile, flash])
  usePageLiveFeed(livePageId, page?.job_revision ?? 0, reloadTile)

  // A colleague's change since the tile loaded is not saved over: it is shown instead.
  const guardedSave = useGuardedSave((message) => {
    flash(message, 'error')
    reloadTile()
  })
  // A gesture whose writes stopped part-way: what did save stays one step back, and the
  // tile is shown as the server now has it. A refusal has already said so and reloaded.
  const editFailed = useCallback((e: unknown, saved: EditSpan[]) => {
    if (saved.length) recordEdit(spanOf(...saved))
    if (conflictOf(e)) return
    flash((e as Error).message, 'error')
    reloadTile()
  }, [recordEdit, flash, reloadTile])
  const saveRegion = useCallback(
    (r: Region, body: Omit<Parameters<typeof patchRegion>[1], 'revision'>) =>
      guardedSave('region', r, (revision) => patchRegion(r.id, { ...body, revision })),
    [guardedSave],
  )

  // Ordered live tiles, for prev/next navigation and the header count. A duplicate or an
  // unreadable scan was never rendered, so there is nothing to step onto.
  const tiles = useMemo(
    () => (job?.pages ?? []).filter((p) => !p.deleted && !isUncounted(p)),
    [job],
  )
  const tileIdx = tiles.findIndex((p) => p.id === pageId)
  const gotoTile = useCallback(
    (delta: number) => {
      const next = tiles[tileIdx + delta]
      if (next) navigate(`/jobs/${jobId}/tiles/${next.id}`)
    },
    [tiles, tileIdx, jobId, navigate],
  )

  useEffect(() => {
    localStorage.setItem('deeplabel.map.fillOpacity', String(fillOpacity))
  }, [fillOpacity])
  useEffect(() => {
    localStorage.setItem('deeplabel.map.handleOpacity', String(handleOpacity))
  }, [handleOpacity])
  useEffect(() => {
    localStorage.setItem('deeplabel.map.lineOpacity', String(lineOpacity))
  }, [lineOpacity])
  useEffect(() => {
    localStorage.setItem('deeplabel.map.brushRadius', String(brushRadius))
  }, [brushRadius])
  useEffect(() => {
    localStorage.setItem('deeplabel.map.lineSnap', snapLines ? '1' : '0')
  }, [snapLines])

  // A new shape is filed under the active class, so with every class removed there is
  // nothing to file it under and the backend would refuse it once it was finished.
  const refuseWithoutClass = useCallback(() => {
    if (drawable.length) return false
    flash('There is no class to draw with. Add one first.', 'error')
    return true
  }, [drawable, flash])

  // The one job-level write in this editor. A failed save flashes rather than replacing the
  // page: the preview is still on screen and the button is still there to try again.
  const saveExportWidth = useCallback(() => {
    if (!jobId || savingWidth) return
    setSavingWidth(true)
    setLineWidth(jobId, previewWidth)
      .then((res) => {
        setJob((j) => (j ? { ...j, line_width: res.line_width } : j))
        flash(`Export width set to ${res.line_width}px`)
      })
      .catch((e: Error) => flash(e.message, 'error'))
      .finally(() => setSavingWidth(false))
  }, [jobId, previewWidth, savingWidth, flash])

  const classCounts = useMemo(() => {
    const m = new Map<number, number>()
    for (const r of regions) m.set(r.class_id, (m.get(r.class_id) ?? 0) + 1)
    return m
  }, [regions])

  // Uncovered-background %: rasterize the regions into a small offscreen canvas and count
  // untouched pixels. Debounced so rapid edits don't thrash getImageData. A line job has
  // no coverage panel to feed, and strokes cover no area, so it never rasterizes at all.
  useEffect(() => {
    if (lineJob) return
    const t = window.setTimeout(() => {
      const W = Math.min(tileW, 512)
      const H = Math.min(tileH, 512)
      if (W <= 0 || H <= 0) return setUncovered(null)
      const cv = document.createElement('canvas')
      cv.width = W
      cv.height = H
      const ctx = cv.getContext('2d')
      if (!ctx) return
      for (const r of regions) {
        if (isLine(r)) continue // a stroke covers no area
        const path = new Path2D()
        for (const ring of [r.points, ...r.holes]) {
          ring.forEach((p, i) => {
            const x = p[0] * W
            const y = p[1] * H
            if (i === 0) path.moveTo(x, y)
            else path.lineTo(x, y)
          })
          path.closePath()
        }
        ctx.fill(path, 'evenodd')
      }
      const data = ctx.getImageData(0, 0, W, H).data
      let empty = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] === 0) empty++
      setUncovered((100 * empty) / (W * H))
    }, 300)
    return () => clearTimeout(t)
  }, [regions, tileW, tileH, lineJob])

  // --- pointer coordinate conversion ----------------------------------------

  // Asked of the surface, not measured off the svg: the surface sizes the box the svg
  // fills on every frame of a gesture, while the svg's own numbers come from React state
  // a render behind it - so measuring the svg reads the size it had a moment ago.
  const toNorm = useCallback((clientX: number, clientY: number): Pt => {
    const at = toPage(clientX, clientY)
    return at ? [clamp01(at[0]), clamp01(at[1])] : [0, 0]
  }, [toPage])

  // Nearest edge of a region to a point. A traced line's outer ring is open, so it has no
  // wraparound edge; holes and polygon rings are closed.
  const edgeHitOf = useCallback(
    (r: Region, pt: Pt) =>
      closestEdge(
        toPoly(r).map((points, i) => ({ points, closed: !(isLine(r) && i === 0) })),
        pt, displayW, displayH,
      ),
    [displayW, displayH],
  )

  // --- line snapping ---------------------------------------------------------

  // A shape drawn towards an outline it is meant to meet should land *on* it, not a pixel
  // short or a pixel past. Within SNAP_PX the point is pulled onto the nearest outline; an
  // existing vertex inside the same radius wins over the segment it belongs to, so two
  // shapes join at one shared point instead of a T a hair away from the corner. `exclude`
  // keeps a dragged vertex from snapping to its own region's adjacent segments. The vertex
  // landed on, if any, comes back too, so consecutive snaps can follow the outline between.
  const snapTarget = useCallback(
    (pt: Pt, exclude?: number | ReadonlySet<number>): { point: Pt; vertex: VertexRef | null } => {
      if (!snapLines) return { point: pt, vertex: null }
      let best: { hit: EdgeHit; regionId: number } | null = null
      for (const r of visibleRegions) {
        if (typeof exclude === 'number' ? r.id === exclude : exclude?.has(r.id)) continue
        const hit = edgeHitOf(r, pt)
        if (hit && (!best || hit.distPx < best.hit.distPx)) best = { hit, regionId: r.id }
      }
      if (!best || best.hit.distPx > SNAP_PX) return { point: pt, vertex: null }
      if (best.hit.vertexDistPx > SNAP_PX) return { point: best.hit.point, vertex: null }
      return {
        point: best.hit.vertex,
        vertex: { regionId: best.regionId, ringIdx: best.hit.ringIdx, index: best.hit.vertexIndex },
      }
    },
    [snapLines, visibleRegions, edgeHitOf],
  )

  const snapPoint = useCallback(
    (pt: Pt, exclude?: number | ReadonlySet<number>): Pt => snapTarget(pt, exclude).point,
    [snapTarget],
  )

  // The outline between two vertices snapped onto in a row, when both sit on the same ring.
  const contourFrom = useCallback(
    (from: VertexRef | null | undefined, to: VertexRef | null): Ring => {
      if (!from || !to || from.regionId !== to.regionId || from.ringIdx !== to.ringIdx) return []
      const r = regions.find((x) => x.id === to.regionId)
      if (!r) return []
      const closed = !(isLine(r) && to.ringIdx === 0)
      return contourBetween(toPoly(r)[to.ringIdx], from.index, to.index, closed, displayW, displayH)
    },
    [regions, displayW, displayH],
  )

  // Every cursor update runs through here, so the rubber band ends exactly where the next
  // click would put a vertex — a snap you cannot see before committing to it is a surprise.
  const setCursorAt = useCallback(
    (clientX: number, clientY: number) => {
      const raw = toNorm(clientX, clientY)
      const pt = tool === 'draw' || draft?.redraw ? snapPoint(raw) : raw
      setCursor(pt)
      setSnapped(pt[0] !== raw[0] || pt[1] !== raw[1])
    },
    [tool, draft, toNorm, snapPoint],
  )

  const cancelDeselect = useCallback(() => {
    if (deselectTimer.current !== null) {
      clearTimeout(deselectTimer.current)
      deselectTimer.current = null
    }
  }, [])

  const scheduleDeselect = useCallback(() => {
    cancelDeselect()
    deselectTimer.current = window.setTimeout(() => {
      deselectTimer.current = null
      setSelectedId(null)
    }, DESELECT_DELAY_MS)
  }, [cancelDeselect])

  useEffect(() => cancelDeselect, [cancelDeselect])

  // --- area detect ----------------------------------------------------------

  // Asked before the tool is opened, not when it is: the button has to know whether the
  // server can detect at all, or it offers a dead end. The client caches the answer, so
  // this is one request per session rather than per tile.
  useEffect(() => {
    if (!lineJob || readOnly) return
    let live = true
    setEdgeMethodsFailed(false)
    getEdgeMethods()
      .then((info) => {
        if (!live) return
        setEdgeInfo(info)
        const first = info.methods.find((m) => m.available) ?? info.methods[0]
        if (first) setEdgeMethod((cur) => cur || first.id)
      })
      // A failure here only costs the button's disabled state; the tool's panel says what
      // went wrong, which is not worth taking the page down for.
      .catch(() => { if (live) setEdgeMethodsFailed(true) })
    return () => { live = false }
  }, [lineJob, readOnly])

  // Known to be unusable — no detector configured, or nothing in the registry. Unknown
  // (still loading, or the lookup failed) leaves the tool available: trying it then says
  // what is wrong, which beats a button that is dead for no visible reason.
  const detectUnavailable = edgeInfo !== null && (!edgeInfo.configured || edgeInfo.methods.length === 0)

  const runDetect = useCallback(
    async (area: Ring) => {
      // Without a method there is nothing to run, so the outline stays for when there is.
      if (!edgeMethod) {
        flash(edgeMethodsFailed ? 'The detection methods could not be loaded' : 'The detection methods are still loading', 'error')
        return
      }
      setAreaDraft(null)
      setMarquee(null)
      setCursor(null)
      if (!page || readOnly || busy || area.length < 3) return
      setBusy(true)
      try {
        const { regions: created, span } = await detectRegions(page.id, { method: edgeMethod, area, class_id: activeClassId })
        created.forEach(upsertLocal)
        // One span for the whole run: a detection you did not want is one undo away,
        // however many lines it produced.
        recordEdit(span)
        flash(created.length
          ? `Detected ${created.length} line${created.length === 1 ? '' : 's'}`
          : 'No edges found in that area')
      } catch (e) {
        // A detector that is missing, slow or unhappy with one selection is something to
        // try again or work around, not a reason to throw the annotator out of the tile.
        flash((e as Error).message, 'error')
      } finally {
        setBusy(false)
      }
    },
    [page, readOnly, busy, edgeMethod, edgeMethodsFailed, activeClassId, upsertLocal, recordEdit, flash],
  )

  // --- drawing --------------------------------------------------------------

  // A ring encloses an area; a traced line is a run of points. Holes are rings even in a
  // line job. Both are closed by their first point - a line keeps that point rather than
  // implying it - so this says what is being drawn, not whether it can be closed.
  const isRingDraft = useCallback((d: Draft) => d.holeFor !== null || !lineJob, [lineJob])

  // A shape can be closed once it encloses something: three corners, and no redraw in
  // hand (that one ends on a vertex of the outline it is redrawing).
  const canClose = useCallback((d: Draft) => !d.redraw && d.pts.length >= 3, [])

  // Writes one ring of a region back as an undoable edit, refusing to leave a ring below a
  // triangle or a traced line below a segment.
  const replaceRing = useCallback(
    async (r: Region, ringIdx: number, ring: Ring) => {
      const floor = isLine(r) && ringIdx === 0 ? 2 : 3
      if (ring.length < floor) {
        flash(`That would leave fewer than ${floor} points`, 'error')
        return
      }
      const next = withRing(r, ringIdx, ring)
      const updated = await saveRegion(r, { points: next.points, holes: next.holes })
      upsertLocal(updated)
      recordEdit(updated.span)
    },
    [flash, saveRegion, upsertLocal, recordEdit],
  )

  // Ends a redraw at vertex `end`: the stretch between the two vertices becomes the drawn
  // points.
  const finishRedraw = useCallback(
    async (d: Draft, end: number) => {
      const redraw = d.redraw
      const target = redraw ? regions.find((r) => r.id === redraw.regionId) : undefined
      setDraft(null)
      setCursor(null)
      if (!redraw || !target) return
      const ring = toPoly(target)[redraw.ringIdx]
      const redrawn = isLine(target) && redraw.ringIdx === 0
        ? redrawRun(ring, redraw.start, end, d.pts, displayW, displayH)
        : redrawStretch(ring, redraw.start, end, d.pts, true, displayW, displayH)
      await replaceRing(target, redraw.ringIdx, redrawn)
    },
    [regions, replaceRing, displayW, displayH],
  )

  // Confirming a redraw without a second vertex only means something at the end of an open
  // traced line, where it grows the line by the drawn points. A closed one has no end: its
  // seam is a corner like the rest.
  const extendFromRedraw = useCallback(
    async (d: Draft) => {
      const redraw = d.redraw
      const target = redraw ? regions.find((r) => r.id === redraw.regionId) : undefined
      if (!redraw || !target) {
        setDraft(null)
        return
      }
      const last = target.points.length - 1
      const atLineEnd = isLine(target) && redraw.ringIdx === 0 && !isClosedTrace(target)
        && (redraw.start === 0 || redraw.start === last)
      if (!atLineEnd || d.pts.length === 0) {
        flash('Click another dot of the outline to finish the redraw')
        return
      }
      setDraft(null)
      setCursor(null)
      await replaceRing(target, 0, extendPolyline(target.points, redraw.start, d.pts))
    },
    [regions, replaceRing, flash],
  )

  const saveDraft = useCallback(async (d: Draft, closing = false) => {
    if (d.redraw) {
      await extendFromRedraw(d)
      return
    }
    // A traced line is complete at two points; a ring needs a triangle.
    const minPts = isRingDraft(d) ? 3 : 2
    if (d.pts.length < minPts || !page) {
      setDraft(null)
      return
    }
    // A ring's closing edge is implied; a line's is a point like any other, so closing one
    // writes the first point again at the end. That repetition is what makes it closed.
    const pts = closing && !isRingDraft(d) && d.pts.length >= 3 ? closeRun(d.pts) : d.pts
    try {
      if (d.holeFor !== null) {
        const target = regions.find((r) => r.id === d.holeFor)
        if (target) {
          const updated = await saveRegion(target, { holes: [...target.holes, pts] })
          upsertLocal(updated)
          recordEdit(updated.span)
        }
      } else {
        const created = await createRegion(page.id, activeClassId, pts, [], drawKind)
        upsertLocal(created)
        setSelectedId(created.id)
        recordEdit(created.span)
      }
    } catch (e) {
      // The shape stays in hand, so a save the server refused can be finished again.
      flash((e as Error).message, 'error')
      return
    }
    setDraft(null)
    setCursor(null)
  }, [page, regions, activeClassId, drawKind, isRingDraft, extendFromRedraw, saveRegion, upsertLocal, recordEdit, flash])

  // Persists a finished shape. Takes the draft explicitly, so a stroke can commit the
  // shape it just completed without waiting for the state to come round.
  const commitDraft = useCallback(async (d: Draft, closing = false) => {
    if (committing.current) return
    committing.current = true
    try {
      await saveDraft(d, closing)
    } finally {
      committing.current = false
    }
  }, [saveDraft])

  // The first point taken as the way out. A ring's closing edge is implied; a traced line
  // is written back to that point, which is what makes it a closed one.
  const closeDraft = useCallback(() => {
    if (draft) void commitDraft(draft, true)
  }, [draft, commitDraft])

  // One placed vertex, wherever the click came from — the tile, the blank pane around it,
  // or (mid-shape) the page chrome. `toNorm` clamps to the tile, so a click past the edge
  // of the image lands on the nearest point of that edge: putting a vertex *on* the border
  // becomes the easiest aim on the canvas instead of a pixel-perfect one. The second click
  // of a double-click places nothing: the dblclick behind it finishes the shape at the
  // corner the first click put down, and must not find that corner doubled.
  const placeVertex = useCallback(
    ({ clientX, clientY, detail }: { clientX: number; clientY: number; detail: number }) => {
      if (readOnly || !svgRef.current || detail > 1) return
      const pt = toNorm(clientX, clientY)
      // Screen-space distance between a point and a draft's first vertex, for the
      // closing snap.
      const nearFirst = (first: Pt, p: Pt) => {
        const box = svgRef.current!.getBoundingClientRect()
        const dx = (first[0] - p[0]) * box.width
        const dy = (first[1] - p[1]) * box.height
        return Math.hypot(dx, dy) < CLOSE_SNAP_PX
      }
      if (tool === 'detect') {
        // Outlining an area: the same gestures as drawing a polygon, but what it produces
        // is a query, not a region.
        if (areaShape !== 'polygon' || refuseWithoutClass()) return
        setAreaDraft((ring) => {
          if (!ring) return [pt]
          if (ring.length >= 3 && nearFirst(ring[0], pt)) {
            void runDetect(ring)
            return ring
          }
          return [...ring, pt]
        })
        return
      }
      if (tool !== 'draw' && !draft?.redraw) return
      // A hole or a redraw belongs to a region that already has its class.
      if (!draft?.redraw && (draft?.holeFor ?? null) === null && refuseWithoutClass()) return
      // Drawn geometry snaps to what is already on the tile; the detect tool's outline
      // above does not, because it only says where to look and joins nothing.
      const { point: at, vertex } = snapTarget(pt)
      setDraft((d) => {
        if (!d) return { pts: [at], holeFor: null, lastSnap: vertex }
        // Back on the first vertex: that closes the shape, a traced line included - a
        // line that ends where it began is exactly what closing one means.
        if (canClose(d) && nearFirst(d.pts[0], at)) {
          void closeDraft()
          return d
        }
        // Two snapped vertices in a row on one outline bring the outline between them
        // along, so a shared border is exact rather than a chord across the neighbour.
        return { ...d, pts: [...d.pts, ...contourFrom(d.lastSnap, vertex), at], lastSnap: vertex }
      })
    },
    [tool, draft, readOnly, areaShape, canClose, toNorm, snapTarget, contourFrom, runDetect, closeDraft,
     refuseWithoutClass],
  )

  // Held down and moved, the draw tool streams points along the pointer's path: a freehand
  // stroke, appended to whatever the shape already has. A press that stays put is left to
  // the click handler, which places single vertices. Only the stroke's two ends snap - its
  // start joins what it begins on and its end what it reaches - while the points between
  // follow the hand and are then thinned to the ones that bend the line.
  const onDrawDown = (e: React.PointerEvent) => {
    if (tool !== 'draw' || handHeld || readOnly || busy || e.button !== 0 || e.altKey) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const base: Draft = draft ?? { pts: [], holeFor: null }
    if (base.holeFor === null && refuseWithoutClass()) return
    const pressed: Pt = [e.clientX, e.clientY]
    const placed = base.pts.length
    const start = toNorm(e.clientX, e.clientY)
    let run: Ring | null = null
    const show = (pts: Ring) => setDraft({ pts: [...base.pts, ...pts], holeFor: base.holeFor })
    drag.begin(e, {
      onMove: (ev) => {
        if (!run) {
          if (Math.hypot(ev.clientX - pressed[0], ev.clientY - pressed[1]) < CLICK_SLOP_PX) return
          run = [snapPoint(start)]
          setStrokeFrom(placed)
        }
        const pt = toNorm(ev.clientX, ev.clientY)
        const last = run[run.length - 1]
        if (Math.hypot((pt[0] - last[0]) * displayW, (pt[1] - last[1]) * displayH) < FREEHAND_STEP_PX) return
        run.push(pt)
        show(run)
      },
      onEnd: () => {
        setStrokeFrom(null)
        if (!run) return
        swallowNextClick.current = true // the click that follows the release must not add a vertex
        run[run.length - 1] = snapPoint(run[run.length - 1])
        const pts = [...base.pts, ...simplifyPolyline(run, FREEHAND_TOLERANCE_PX / zoom, tileW, tileH)]
        const next: Draft = { pts, holeFor: base.holeFor }
        // A stroke that comes back to where the shape started closes it, like a click there.
        const first = pts[0], end = pts[pts.length - 1]
        const closes = pts.length > 3 &&
          Math.hypot((first[0] - end[0]) * displayW, (first[1] - end[1]) * displayH) < CLOSE_SNAP_PX
        if (closes) void commitDraft({ ...next, pts: pts.slice(0, -1) }, true)
        else show(pts.slice(base.pts.length))
      },
      onCancel: () => {
        setStrokeFrom(null)
        setDraft(base.pts.length ? base : null)
      },
    })
  }

  // Confirming whatever is in hand (right-click, double-click, Enter). Shared, because a
  // shape whose last vertex was placed off the tile must be finishable from out there too.
  // Enter, right-click and double-click all mean "that is the shape" wherever the pointer
  // happens to be, so a traced line ends where it was left rather than being closed.
  const finishDraft = useCallback(() => {
    if (areaDraft) void runDetect(areaDraft)
    else if (draft) void commitDraft(draft)
  }, [areaDraft, draft, runDetect, commitDraft])

  // m: one shape out of the gathered ones. Polygons become their union, so they have to
  // touch or overlap; traced lines are joined end to end. The first gathered shape keeps
  // its id and class, the others are deleted, all in one undo step.
  const mergeGathered = useCallback(async () => {
    const picked = [...mergeSet].map((id) => regions.find((r) => r.id === id)).filter((r): r is Region => !!r)
    if (picked.length < 2) return
    const lines = picked.filter(isLine)
    if (lines.length !== 0 && lines.length !== picked.length) {
      flash('Lines and polygons cannot be merged with each other', 'error')
      return
    }
    let geom: { points: Ring; holes: Ring[] }
    if (lines.length) {
      const points = picked.slice(1).reduce((acc, r) => joinPolylines(acc, r.points, tileW, tileH), picked[0].points)
      geom = { points, holes: [] }
    } else {
      const parts = unionRegions(picked, tileW, tileH)
      if (parts.length !== 1) {
        flash('Polygons have to touch or overlap to merge', 'error')
        return
      }
      geom = parts[0]
    }
    const [keep, ...drop] = picked
    const spans: EditSpan[] = []
    try {
      const updated = await saveRegion(keep, geom)
      spans.push(updated.span)
      for (const r of drop) spans.push((await deleteRegion(r.id)).span)
      drop.forEach((r) => removeLocal(r.id))
      upsertLocal(updated)
      recordEdit(spanOf(...spans))
      setMergeSet(new Set())
      setSelectedId(keep.id)
    } catch (e) {
      editFailed(e, spans)
    }
  }, [mergeSet, regions, tileW, tileH, flash, removeLocal, saveRegion, upsertLocal, recordEdit, editFailed])

  // s arms the scissors on the selected traced line; the next click on the line cuts it.
  const toggleCut = useCallback(() => {
    const sel = regions.find((r) => r.id === selectedId)
    if (!sel) return
    if (!isLine(sel)) {
      flash('Cutting applies to traced lines', 'error')
      return
    }
    setCutArmed((v) => !v)
  }, [regions, selectedId, flash])

  const cutSelectedAt = useCallback(
    async (pt: Pt) => {
      setCutArmed(false)
      const sel = regions.find((r) => r.id === selectedId)
      if (!sel || !isLine(sel) || !page) return
      const halves = cutPolyline(sel.points, pt, displayW, displayH, INSERT_HIT_PX)
      if (!halves) {
        flash('Click on the line where it should be cut', 'error')
        return
      }
      const spans: EditSpan[] = []
      try {
        const first = await saveRegion(sel, { points: halves[0] })
        spans.push(first.span)
        const second = await createRegion(page.id, sel.class_id, halves[1], [], 'polyline')
        upsertLocal(first)
        upsertLocal(second)
        recordEdit(spanOf(first.span, second.span))
      } catch (e) {
        editFailed(e, spans)
      }
    },
    [regions, selectedId, page, displayW, displayH, flash, saveRegion, upsertLocal, recordEdit, editFailed],
  )

  const onSvgClick = useCallback(
    (e: React.MouseEvent) => {
      if (swallowNextClick.current) {
        swallowNextClick.current = false
        return
      }
      if (e.altKey || e.button !== 0 || panning) return
      if (tool === 'erase') return // the eraser works on drag; a click must not select
      if (tool === 'draw' || tool === 'detect') {
        placeVertex(e)
        return
      }
      const pt = toNorm(e.clientX, e.clientY)
      if (cutArmed) {
        void cutSelectedAt(pt)
        return
      }
      if (draft?.redraw) {
        placeVertex(e)
        return
      }
      // A press on a shape is handled on the shape itself; a click that reaches the canvas
      // missed every one of them.
      if (mergeSet.size) setMergeSet(new Set())
      if (picks.length) setPicks([])
      const sel = regions.find((r) => r.id === selectedId)
      // A selected traced line takes a vertex insert from anywhere, so any miss may be the
      // first click of a double-click aimed at it: defer the deselect long enough for the
      // double-click to cancel it, instead of dropping the selection it needs.
      if (sel && isLine(sel)) return scheduleDeselect()
      // A near miss on a selected polygon keeps it selected. Without this a loosely-aimed
      // double-click would deselect on its first click and have nothing left to add a
      // vertex to — the insert radius could never exceed this one.
      const near = sel ? edgeHitOf(sel, pt) : null
      if (near && near.distPx <= INSERT_HIT_PX) return
      setSelectedId(null)
    },
    [tool, regions, selectedId, draft, cutArmed, mergeSet, picks, toNorm, placeVertex, cutSelectedAt, edgeHitOf, scheduleDeselect],
  )

  const onSvgMove = useCallback(
    (e: React.PointerEvent) => {
      // `cursor` is the draw tool's rubber-band end, the eraser's brush-circle centre, and
      // the area outline's rubber band. The draw tool tracks it before the first click too,
      // with nothing to draw yet: that is what shows the snap the first vertex would take.
      if (draft || areaDraft || tool === 'draw' || tool === 'erase') setCursorAt(e.clientX, e.clientY)
    },
    [draft, areaDraft, tool, setCursorAt],
  )

  // --- the pane around the tile ---------------------------------------------

  // The svg covers the image exactly, so anything that reaches the pane itself is a
  // gesture in the blank space around the tile — which is a drawing surface too, clamped
  // to the nearest edge. Events that bubbled up from the canvas were handled there.
  const fromCanvas = (t: EventTarget | null) => !!svgRef.current?.contains(t as Node)

  const onPaneMove = (e: React.PointerEvent<HTMLDivElement>) => {
    onPanMove(e)
    if (fromCanvas(e.target) || !svgRef.current) return
    // The rubber band and the brush circle keep following the pointer out here, pinned to
    // the edge, instead of freezing where it left the image.
    if (draft || areaDraft || tool === 'draw' || tool === 'erase') setCursorAt(e.clientX, e.clientY)
  }

  const onPaneClick = (e: React.MouseEvent) => {
    if (fromCanvas(e.target)) return
    if (swallowNextClick.current) {
      swallowNextClick.current = false
      return
    }
    if (e.altKey || e.button !== 0) return // alt-drag pans; the click that ends it is not a vertex
    placeVertex(e)
  }

  const onPaneContextMenu = (e: React.MouseEvent) => {
    // With nothing in hand the browser menu is left alone, as it is over the canvas.
    if (fromCanvas(e.target) || (!draft && !areaDraft)) return
    e.preventDefault()
    finishDraft()
  }

  // A shape is "in hand" once it has a point. An empty hole draft is not: its first point
  // still has to come off the canvas, which keeps the palette and toolbar clickable while
  // the tool is merely armed.
  const drawingAnchored =
    (draft?.pts.length ?? 0) > 0 || draft?.redraw !== undefined || (areaDraft?.length ?? 0) > 0

  // Mid-shape the whole window becomes that drawing surface, chrome included. At any real
  // working zoom the tile fills the pane, so the sidebar and header are the only "outside"
  // there is — and a vertex on the image edge is exactly what a click out there means.
  // Capture phase: the control under the pointer never sees the click, because a stray
  // vertex is one undo away while a class silently switched mid-shape is not. Nothing is
  // captured while no shape is being drawn, so every control behaves normally.
  useEffect(() => {
    if (!drawingAnchored) return
    const outside = (t: EventTarget | null) => !paneRef.current?.contains(t as Node)
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.altKey || !outside(e.target)) return
      // preventDefault as well as stopPropagation: a router <Link> navigates natively once
      // its own handler is cut off, which would take the whole draft down with the page.
      e.preventDefault()
      e.stopPropagation()
      // The mousedown that preceded this focused whatever it hit; a focused input eats
      // Escape and every other hotkey, leaving the draft with no way out.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      placeVertex(e)
    }
    // Both confirming gestures reach out here too. The dblclick arrives after its two
    // clicks, of which only the first placed a vertex - the same sequence a double-click
    // on the canvas produces.
    const onFinish = (e: MouseEvent) => {
      if (!outside(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      finishDraft()
    }
    const onMove = (e: MouseEvent) => {
      if (!outside(e.target)) return
      setCursorAt(e.clientX, e.clientY)
    }
    window.addEventListener('click', onClick, true)
    window.addEventListener('dblclick', onFinish, true)
    window.addEventListener('contextmenu', onFinish, true)
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('dblclick', onFinish, true)
      window.removeEventListener('contextmenu', onFinish, true)
      window.removeEventListener('mousemove', onMove)
    }
  }, [drawingAnchored, placeVertex, finishDraft, setCursorAt])

  // Dragging a box: the ring is built on release, so both shapes reach runDetect the
  // same way.
  const onDetectDown = (e: React.PointerEvent) => {
    if (tool !== 'detect' || handHeld || areaShape !== 'rect' || readOnly || busy) return
    if (e.button !== 0 || e.altKey) return // alt/middle still pan
    if (refuseWithoutClass()) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    e.preventDefault()
    const box = { a: toNorm(e.clientX, e.clientY), b: toNorm(e.clientX, e.clientY) }
    setMarquee({ ...box })
    drag.begin(e, {
      onMove: (ev) => {
        box.b = toNorm(ev.clientX, ev.clientY)
        setMarquee({ ...box })
      },
      onEnd: () => {
        const [x0, x1] = [Math.min(box.a[0], box.b[0]), Math.max(box.a[0], box.b[0])]
        const [y0, y1] = [Math.min(box.a[1], box.b[1]), Math.max(box.a[1], box.b[1])]
        // A click that barely moved is not a box — treat it as a miss rather than running a
        // detection over a sliver.
        if ((x1 - x0) * displayW < MIN_MARQUEE_PX || (y1 - y0) * displayH < MIN_MARQUEE_PX) {
          setMarquee(null)
          return
        }
        void runDetect([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
      },
      onCancel: () => setMarquee(null),
    })
  }

  // A box dragged from empty space in the select tool picks every visible vertex inside it,
  // across shapes: a junction several traces share moves as one point only if all of their
  // ends move together. Shift adds to the picks. A press that barely moves is a click and
  // is left to onSvgClick, where it deselects - or opens a double-click insert.
  const onPickDown = (e: React.PointerEvent) => {
    if (tool !== 'select' || handHeld || readOnly || busy) return
    if (e.button !== 0 || e.altKey || cutArmed || draft) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    e.preventDefault()
    const shift = e.shiftKey
    const box = { a: toNorm(e.clientX, e.clientY), b: toNorm(e.clientX, e.clientY) }
    let shown = false
    drag.begin(e, {
      onMove: (ev) => {
        box.b = toNorm(ev.clientX, ev.clientY)
        const far = Math.hypot((box.b[0] - box.a[0]) * displayW, (box.b[1] - box.a[1]) * displayH)
        if (!shown && far < MIN_MARQUEE_PX) return
        shown = true
        setMarquee({ ...box })
      },
      onEnd: () => {
        if (!shown) return
        setMarquee(null)
        swallowNextClick.current = true // the click this release makes must not deselect
        cancelDeselect()
        const caught: PickedVertex[] = []
        for (const r of visibleRegions) {
          const line = isLine(r)
          for (const v of verticesInBox(r, line, box.a, box.b)) {
            caught.push({ regionId: r.id, ...v, pt: cornersOf(r, v.ringIdx, line)[v.index] })
          }
        }
        const next = shift
          ? [...livePicks, ...caught.filter((c) => !pickedKeys.has(pickKey(c.regionId, c.ringIdx, c.index)))]
          : caught
        setPicks(next)
        setMergeSet(new Set())
        // Picks on one shape select it, so its other dots show; picks spread over several
        // select none of them, since the class menu and Delete act on a single selection.
        const ids = new Set(next.map((p) => p.regionId))
        if (ids.size === 1) setSelectedId([...ids][0])
        else if (ids.size > 1 || !shift) setSelectedId(null)
      },
      onCancel: () => setMarquee(null),
    })
  }

  // Whatever is in hand belongs to the tool that started it: a shape left behind would keep
  // the window captured for a tool that can no longer place or finish it. Every way of
  // switching comes through here, so none of them strands one.
  const chooseTool = useCallback((next: Tool) => {
    if (next === tool) return
    setDraft(null)
    setCursor(null)
    setTool(next)
  }, [tool])

  // Leaving the tool drops a half-made selection; so does switching shape, since an
  // outline in progress means nothing to the box gesture. The select tool's gathered
  // shapes and armed scissors go the same way.
  useEffect(() => {
    setMergeSet(new Set())
    setCutArmed(false)
    setAreaDraft(null)
    setMarquee(null)
    setPicks([])
  }, [tool, areaShape])

  // --- eraser brush ---------------------------------------------------------

  // One brush pass: erase along the segment prev→cur across every region the brush can
  // reach. Local only — the stroke is persisted in one go on release.
  const applyBrush = useCallback(
    (s: EraseStroke, a: Pt, b: Pt) => {
      setRegions((rs) => {
        // Mirror the canvas' visibility filter: what you cannot see, you cannot erase.
        const only = showOnly && selectedId !== null ? selectedId : null
        let changed = false
        const next: Region[] = []
        for (const r of rs) {
          if (only !== null && r.id !== only) {
            next.push(r)
            continue
          }
          const res = eraseFromGeom(r, a, b, brushPx, displayW, displayH, isLine(r) ? 2 : 3)
          if (!res.changed) {
            next.push(r)
            continue
          }
          changed = true
          s.touched.add(r.id)
          if (res.geom === null) {
            // Dropped from `regions`, so the rest of the stroke no longer sees it.
            s.deletedIds.add(r.id)
            s.after.delete(r.id)
            continue
          }
          const erased = { ...r, points: res.geom.points, holes: res.geom.holes }
          s.after.set(r.id, erased)
          next.push(erased)
        }
        return changed ? next : rs
      })
    },
    [brushPx, showOnly, selectedId, displayW, displayH],
  )

  const persistStroke = useCallback(
    async (s: EraseStroke) => {
      if (s.touched.size === 0) return // swept empty space
      const spans: EditSpan[] = []
      try {
        for (const id of s.touched) {
          if (s.deletedIds.has(id)) {
            spans.push((await deleteRegion(id)).span) // soft, so undo resurrects it
            continue
          }
          const geom = s.after.get(id)
          if (!geom) continue
          const updated = await saveRegion(geom, { points: geom.points, holes: geom.holes })
          upsertLocal(updated)
          spans.push(updated.span)
        }
        // One span for the whole stroke: a sweep undoes in a single step.
        if (spans.length) recordEdit(spanOf(...spans))
        if (selectedId !== null && s.deletedIds.has(selectedId)) setSelectedId(null)
      } catch (e) {
        editFailed(e, spans)
      }
    },
    [selectedId, saveRegion, upsertLocal, recordEdit, editFailed],
  )

  const onEraseDown = (e: React.PointerEvent) => {
    // Alt/middle-button belong to the pan gesture, which must keep working in this tool.
    if (tool !== 'erase' || handHeld || readOnly || busy || e.button !== 0 || e.altKey) return
    // preventDefault keeps the drag from selecting the page, but it also freezes focus:
    // without this the radius input stays focused and goes on eating Ctrl+Z and the
    // other hotkeys, which the keydown handler ignores while an input has focus.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    e.preventDefault()
    const pt = toNorm(e.clientX, e.clientY)
    const stroke: EraseStroke = { touched: new Set(), after: new Map(), deletedIds: new Set(), last: pt }
    applyBrush(stroke, pt, pt)
    drag.begin(e, {
      onMove: (ev) => {
        const cur = toNorm(ev.clientX, ev.clientY)
        setCursor(cur)
        applyBrush(stroke, stroke.last, cur)
        stroke.last = cur
      },
      onEnd: () => void persistStroke(stroke),
      onCancel: () => void persistStroke(stroke),
    })
  }

  // --- vertex dragging ------------------------------------------------------

  // A drag that could not be saved shows the shape as the server still has it, and says
  // why. A refused one is already being replaced by the colleague's version.
  const putBack = (r: Region) => (e: Error) => {
    if (!conflictOf(e)) {
      flash(e.message, 'error')
      upsertLocal(r)
    }
    return null
  }

  // The drag owns the ring it is reshaping: `regions` mirrors it for display, and the
  // release persists from the drag's copy rather than reading `regions` back.
  const startVertexDrag = (e: React.PointerEvent, r: Region, ringIdx: number, index: number) => {
    if (readOnly || handHeld || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const ring = toPoly(r)[ringIdx].slice()
    // The seam of a closed trace is stored at both ends of the run; dragging it moves the
    // corner, not one of its two copies.
    const seam = ringIdx === 0 && index === 0 && isClosedTrace(r)
    let moved = false
    drag.begin(e, {
      onMove: (ev) => {
        moved = true
        // Dragging an endpoint onto another line joins them, the same way drawing one does.
        // Its own region is excluded, or a vertex would stick to its neighbouring segments.
        ring[index] = snapPoint(toNorm(ev.clientX, ev.clientY), r.id)
        if (seam) ring[ring.length - 1] = ring[0]
        const reshaped = withRing(r, ringIdx, ring.slice())
        setRegions((rs) => rs.map((x) => (x.id === r.id ? reshaped : x)))
      },
      onEnd: async () => {
        swallowNextClick.current = true // the click that follows must neither select nor place a point
        if (!moved) {
          clickVertex(r, ringIdx, index)
          return
        }
        const reshaped = withRing(r, ringIdx, ring)
        const updated = await saveRegion(r, { points: reshaped.points, holes: reshaped.holes })
          .catch(putBack(r))
        if (updated) {
          upsertLocal(updated)
          recordEdit(updated.span)
        }
      },
      onCancel: () => upsertLocal(r),
    })
  }

  // Shift-click on a dot adds it to the picks or takes it back out.
  const togglePick = (r: Region, ringIdx: number, index: number) => {
    const key = pickKey(r.id, ringIdx, index)
    if (pickedKeys.has(key)) {
      setPicks(livePicks.filter((p) => pickKey(p.regionId, p.ringIdx, p.index) !== key))
      return
    }
    const pt = cornersOf(r, ringIdx, isLine(r))[index]
    if (pt) setPicks([...livePicks, { regionId: r.id, ringIdx, index, pt }])
  }

  // Dragging any picked dot carries every pick with it, keeping their offsets: the grabbed
  // one snaps the way a single dragged vertex does (the shapes being reshaped excluded, or
  // a dot would stick to its own neighbours) and the group follows that snap. The whole
  // group stops at the tile border rather than being squashed against it. All shapes it
  // touched are saved as one undo step.
  const startGroupDrag = (e: React.PointerEvent, r: Region, ringIdx: number, index: number) => {
    e.stopPropagation()
    e.preventDefault()
    const group = livePicks
    const ids = new Set(group.map((p) => p.regionId))
    const before = regions.filter((x) => ids.has(x.id))
    const grabbed = cornersOf(r, ringIdx, isLine(r))[index]
    const from = toNorm(e.clientX, e.clientY)
    const pts = group.map((p) => p.pt)
    let shift: [number, number] | null = null
    const shifted = (dx: number, dy: number) =>
      before.map((x) => moveVertices(x, isLine(x), group.filter((p) => p.regionId === x.id), dx, dy))
    drag.begin(e, {
      onMove: (ev) => {
        const pt = toNorm(ev.clientX, ev.clientY)
        // A hand that only twitched has not moved several vertices a hair each.
        if (!shift && Math.hypot((pt[0] - from[0]) * displayW, (pt[1] - from[1]) * displayH) < CLICK_SLOP_PX) return
        const target = snapPoint([grabbed[0] + pt[0] - from[0], grabbed[1] + pt[1] - from[1]], ids)
        const [dx, dy] = clampShift(pts, target[0] - grabbed[0], target[1] - grabbed[1])
        shift = [dx, dy]
        const byId = new Map(shifted(dx, dy).map((x) => [x.id, x]))
        setRegions((rs) => rs.map((x) => byId.get(x.id) ?? x))
        setPicks(group.map((p) => ({ ...p, pt: [p.pt[0] + dx, p.pt[1] + dy] as Pt })))
      },
      onEnd: async () => {
        swallowNextClick.current = true // the click that follows must neither select nor place a point
        if (!shift) {
          // A lone pick clicked in place is an ordinary dot click: start a redraw from it.
          if (group.length === 1) {
            setPicks([])
            clickVertex(r, ringIdx, index)
          }
          return
        }
        const spans: EditSpan[] = []
        try {
          for (const x of shifted(...shift)) {
            const orig = before.find((b) => b.id === x.id)
            if (!orig) continue
            const updated = await saveRegion(orig, { points: x.points, holes: x.holes })
            upsertLocal(updated)
            spans.push(updated.span)
          }
          if (spans.length) recordEdit(spanOf(...spans))
        } catch (err) {
          editFailed(err, spans)
        }
      },
      onCancel: () => {
        before.forEach(upsertLocal)
        setPicks(group)
      },
    })
  }

  // A press on a dot: Shift toggles its pick; on a picked dot it moves the picks; on any
  // other dot the picks are let go and that one vertex is dragged as it always was.
  const onHandleDown = (e: React.PointerEvent, r: Region, ringIdx: number, index: number) => {
    if (readOnly || handHeld || e.button !== 0) return
    if (e.shiftKey) {
      e.stopPropagation()
      e.preventDefault()
      swallowNextClick.current = true // its click would reach the canvas and drop the picks
      togglePick(r, ringIdx, index)
      return
    }
    if (pickedKeys.has(pickKey(r.id, ringIdx, index))) {
      startGroupDrag(e, r, ringIdx, index)
      return
    }
    if (picks.length) setPicks([])
    startVertexDrag(e, r, ringIdx, index)
  }

  // Delete with dots picked removes those dots, never the shape they sit on - unless one is
  // left too short to be a shape, exactly as removing them one by one would. One undo step.
  const deletePicked = useCallback(async () => {
    if (readOnly || !livePicks.length) return
    const group = livePicks
    setPicks([])
    const spans: EditSpan[] = []
    try {
      for (const id of new Set(group.map((p) => p.regionId))) {
        const r = regions.find((x) => x.id === id)
        if (!r) continue
        const next = deleteVertices(r, isLine(r), group.filter((p) => p.regionId === id))
        if (next === null) {
          spans.push((await deleteRegion(id)).span) // soft, so undo resurrects it
          removeLocal(id)
          if (selectedId === id) setSelectedId(null)
          continue
        }
        const updated = await saveRegion(r, { points: next.points, holes: next.holes })
        upsertLocal(updated)
        spans.push(updated.span)
      }
      if (spans.length) recordEdit(spanOf(...spans))
    } catch (e) {
      editFailed(e, spans)
    }
  }, [readOnly, livePicks, regions, selectedId, saveRegion, upsertLocal, removeLocal, recordEdit, editFailed])

  // A click on a vertex of the selected outline starts redrawing from it; a click on a
  // second vertex of the same ring ends the redraw there, and one on the start vertex again
  // calls it off.
  const clickVertex = (r: Region, ringIdx: number, index: number) => {
    if (readOnly) return
    if (!draft) {
      setDraft({ pts: [], holeFor: null, redraw: { regionId: r.id, ringIdx, start: index } })
      return
    }
    if (!draft.redraw || draft.redraw.regionId !== r.id || draft.redraw.ringIdx !== ringIdx) return
    if (draft.redraw.start === index) {
      setDraft(null)
      setCursor(null)
      return
    }
    void finishRedraw(draft, index)
  }

  // Shift-click gathers shapes to merge. A fresh set starts from the current selection, so
  // the shape clicked first without Shift is part of the merge too.
  const toggleGathered = (id: number) => {
    setMergeSet((prev) => {
      const next = new Set(prev.size ? prev : selectedId !== null ? [selectedId] : [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // A press on a shape's body: released in place it is a click - select it, or with Shift
  // gather it for a merge - and dragged it moves the whole shape.
  const startRegionDrag = (e: React.PointerEvent, r: Region) => {
    const shift = e.shiftKey
    const from = toNorm(e.clientX, e.clientY)
    let moved: Region | null = null
    drag.begin(e, {
      onMove: (ev) => {
        if (readOnly) return
        const pt = toNorm(ev.clientX, ev.clientY)
        const farEnough = Math.hypot((pt[0] - from[0]) * displayW, (pt[1] - from[1]) * displayH) >= CLICK_SLOP_PX
        if (!moved && !farEnough) return
        const shown = translateRegion(r, pt[0] - from[0], pt[1] - from[1])
        moved = shown
        setRegions((rs) => rs.map((x) => (x.id === r.id ? shown : x)))
      },
      onEnd: async () => {
        swallowNextClick.current = true
        cancelDeselect()
        if (!moved) {
          if (shift) toggleGathered(r.id)
          else setSelectedId(r.id)
          return
        }
        const updated = await saveRegion(r, { points: moved.points, holes: moved.holes }).catch(putBack(r))
        if (!updated) return
        upsertLocal(updated)
        recordEdit(updated.span)
      },
      onCancel: () => upsertLocal(r),
    })
  }

  const deleteVertex = async (e: React.MouseEvent, r: Region, ringIdx: number, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    if (readOnly) return
    // A closed trace is edited by its corners, the seam counted once - so it takes a
    // triangle like any other ring, and removing the corner it closes at opens it.
    const closed = ringIdx === 0 && isClosedTrace(r)
    const ring = closed ? r.points.slice(0, -1) : toPoly(r)[ringIdx]
    // A ring cannot drop below a triangle; an open traced line cannot drop below a segment.
    // (ringIdx > 0 is always a hole, so always a ring.)
    const floor = isLine(r) && ringIdx === 0 && !closed ? 2 : 3
    if (ring.length <= floor) {
      if (ringIdx === 0) {
        const gone = await deleteRegion(r.id)
        removeLocal(r.id)
        recordEdit(gone.span)
      } else {
        const holes = r.holes.filter((_, i) => i !== ringIdx - 1)
        const updated = await saveRegion(r, { holes })
        upsertLocal(updated)
        recordEdit(updated.span)
      }
      return
    }
    const dropped = ring.filter((_, i) => i !== index)
    const next = closed && index !== 0 ? closeRun(dropped) : dropped
    const updated = await saveRegion(r, ringIdx === 0 ? { points: next } : { holes: withRing(r, ringIdx, next).holes })
    upsertLocal(updated)
    recordEdit(updated.span)
  }

  // `at` places the new vertex explicitly (double-click on the outline); without it the
  // edge's midpoint is used (the midpoint handles).
  const insertVertex = async (e: React.MouseEvent, r: Region, ringIdx: number, edgeIndex: number, at?: Pt) => {
    e.stopPropagation()
    if (readOnly) return
    const ring = toPoly(r)[ringIdx]
    const a = ring[edgeIndex]
    // Only a closed ring has a wraparound edge; midpoints() never offers one for a line.
    const b = ring[(edgeIndex + 1) % ring.length]
    const mid: Pt = at ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const next = [...ring.slice(0, edgeIndex + 1), mid, ...ring.slice(edgeIndex + 1)]
    const updatedRegion = withRing(r, ringIdx, next)
    const updated = await saveRegion(r, { points: updatedRegion.points, holes: updatedRegion.holes })
    upsertLocal(updated)
    recordEdit(updated.span)
  }

  // Double-click to add a vertex to the selected outline, rather than only at the
  // precomputed midpoints. The vertex goes exactly where the cursor was — the nearest edge
  // only decides which two existing points it is threaded between, so the line bends to
  // meet the click instead of the click sliding onto the line.
  // For a traced line the click may land anywhere on the tile: there is one open outline to
  // bend, so the intended target is never ambiguous, and pulling a vertex out to a distant
  // spot is exactly the fiddly drag this gesture replaces. A polygon keeps the radius —
  // sight-unseen, a double-click in open space should not reshape it.
  const insertVertexAtCursor = async (e: React.MouseEvent) => {
    const r = regions.find((x) => x.id === selectedId)
    if (readOnly || tool !== 'select' || !r) return
    const at = toNorm(e.clientX, e.clientY)
    const hit = edgeHitOf(r, at)
    if (!hit || (!isLine(r) && hit.distPx > INSERT_HIT_PX)) return
    // Double-clicking an existing vertex must not stack a duplicate on top of it - and
    // "on" a vertex means inside what its handle catches, not only inside the drawn dot.
    if (hit.vertexDistPx < VERTEX_HIT_PX) return
    await insertVertex(e, r, hit.ringIdx, hit.edgeIndex, at)
  }

  // --- region-level actions -------------------------------------------------

  const reassignClass = useCallback(
    async (regionId: number, classId: number) => {
      const r = regions.find((x) => x.id === regionId)
      if (!r || r.class_id === classId) return
      const updated = await saveRegion(r, { class_id: classId })
      upsertLocal(updated)
      recordEdit(updated.span)
    },
    [regions, saveRegion, upsertLocal, recordEdit],
  )

  const removeRegion = useCallback(
    async (regionId: number) => {
      const r = regions.find((x) => x.id === regionId)
      if (!r) return
      const gone = await deleteRegion(regionId)
      removeLocal(regionId)
      if (selectedId === regionId) setSelectedId(null)
      recordEdit(gone.span)
    },
    [regions, selectedId, removeLocal, recordEdit],
  )

  // --- batch geometry operations (client-side, one compound history entry) ---

  const reduceAll = useCallback(async () => {
    if (readOnly || busy || regions.length === 0) return
    setBusy(true)
    const spans: EditSpan[] = []
    try {
      const vBefore = countVertices(regions)
      let vAfter = 0
      for (const r of regions) {
        const simplified = isLine(r)
          ? (() => {
              const points = simplifyPolyline(r.points, tolerance, tileW, tileH)
              return points.length >= 2 ? { points, holes: [] as Ring[] } : null
            })()
          : simplifyRegionGeometry(r, tolerance, tileW, tileH)
        if (simplified === null) {
          spans.push((await deleteRegion(r.id)).span)
          removeLocal(r.id)
          continue
        }
        if (vertexCount(simplified) === vertexCount(r)) {
          vAfter += vertexCount(r) // unchanged — keep original coords, no round-trip
          continue
        }
        const updated = await saveRegion(r, { points: simplified.points, holes: simplified.holes })
        upsertLocal(updated)
        spans.push(updated.span)
        vAfter += vertexCount(simplified)
      }
      if (spans.length) recordEdit(spanOf(...spans))
      flash(`Reduced ${vBefore} → ${vAfter} vertices`)
    } catch (e) {
      editFailed(e, spans)
    } finally {
      setBusy(false)
    }
  }, [readOnly, busy, regions, tolerance, tileW, tileH, removeLocal, saveRegion, upsertLocal, recordEdit, flash, editFailed])

  const resolveOverlaps = useCallback(async () => {
    if (readOnly || busy || regions.length === 0 || !page) return
    setBusy(true)
    const spans: EditSpan[] = []
    try {
      const prio = (r: Region) => classById.get(r.class_id)?.priority ?? Number.MAX_SAFE_INTEGER
      // Area subtraction is meaningless for zero-area strokes: a traced line neither
      // clips a polygon nor gets clipped by one.
      const snapshot = regions.filter((r) => !isLine(r)) // winners from original geometry
      let modified = 0
      for (const r of snapshot) {
        const winners = snapshot.filter((o) => o.id !== r.id && prio(o) < prio(r))
        if (winners.length === 0) continue
        const parts = subtractRegions(r, winners, tileW, tileH)
        // No actual overlap leaves the total area unchanged (a half-clipped quad is still
        // a quad, so vertex count can't tell) — skip to avoid a needless re-tessellation.
        const origArea = regionAreaPx(r, tileW, tileH)
        const newArea = parts.reduce((s, p) => s + regionAreaPx(p, tileW, tileH), 0)
        if (Math.abs(origArea - newArea) < 0.5) continue
        modified++
        if (parts.length === 0) {
          spans.push((await deleteRegion(r.id)).span)
          removeLocal(r.id)
          continue
        }
        const updated = await saveRegion(r, { points: parts[0].points, holes: parts[0].holes })
        upsertLocal(updated)
        spans.push(updated.span)
        for (let k = 1; k < parts.length; k++) {
          const created = await createRegion(page.id, r.class_id, parts[k].points, parts[k].holes)
          upsertLocal(created)
          spans.push(created.span)
        }
      }
      if (spans.length) recordEdit(spanOf(...spans))
      flash(modified === 0 ? 'No overlaps to resolve' : `Resolved overlaps: ${modified} region(s) modified`)
    } catch (e) {
      editFailed(e, spans)
    } finally {
      setBusy(false)
    }
  }, [readOnly, busy, regions, page, classById, tileW, tileH, removeLocal, saveRegion, upsertLocal, recordEdit, flash, editFailed])

  const toggleReviewed = async () => {
    if (!page) return
    const next = !page.layout_checked
    await setPageLayoutChecked(page.id, next)
    setPage({ ...page, layout_checked: next })
  }

  // --- class vocabulary editing ---------------------------------------------

  const changeClassColor = useCallback((cid: number, hex: string) => {
    const color = hexToRgb(hex)
    setClasses((cs) => cs.map((c) => (c.id === cid ? { ...c, color } : c))) // optimistic
    const timers = colorTimers.current
    const pending = timers.get(cid)
    if (pending) clearTimeout(pending)
    timers.set(cid, window.setTimeout(() => {
      timers.delete(cid)
      if (!jobId) return
      patchJobClass(jobId, cid, { color })
        .then((u) => setClasses((cs) => cs.map((c) => (c.id === u.id ? { ...c, ...u } : c))))
        .catch((e: Error) => { setError(e.message); void reloadClasses() })
    }, 400))
  }, [jobId, reloadClasses])

  const moveClassRank = useCallback((cid: number, step: -1 | 1) => {
    const from = ranked.findIndex((c) => c.id === cid)
    const to = from + step
    if (!jobId || from < 0 || to < 0 || to >= ranked.length) return
    const order = ranked.map((c) => c.id)
    order.splice(to, 0, ...order.splice(from, 1))
    const rankOf = new Map(order.map((id, rank) => [id, rank]))
    setClasses((cs) => cs.map((c) => (rankOf.has(c.id) ? { ...c, priority: rankOf.get(c.id)! } : c))) // optimistic
    reorderJobClasses(jobId, order).catch((e: Error) => { setError(e.message); void reloadClasses() })
  }, [jobId, ranked, reloadClasses])

  const addClass = useCallback(async (name: string, color: [number, number, number]) => {
    if (!jobId) return
    try {
      const created = await createJobClass(jobId, name, color)
      setClasses((cs) => [...cs, created])
      setActiveClassId(created.id)
      setAddOpen(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [jobId])

  // The count the dialog shows is the last guard before an irreversible delete, so it is
  // read from the server as the dialog opens: the palette loaded with the editor, and every
  // shape drawn, erased or reassigned since - on this tile or by someone else on another
  // one - has moved the numbers it came with.
  const askRemoveClass = useCallback(async (cid: number) => {
    const fresh = await reloadClasses()
    const cls = fresh?.find((c) => c.id === cid)
    if (cls) setRemoveClass(cls)
  }, [reloadClasses])

  const removeJobClass = useCallback(async (cid: number, mode: 'delete' | 'merge', into?: number) => {
    if (!jobId) return
    try {
      const res = await deleteJobClass(jobId, cid, mode, into)
      setRemoveClass(null)
      setSelectedId(null)
      resetHistory() // an earlier span may want the removed class back
      await reloadClasses()
      const p = await getPage(jobId, pageId) // regions were deleted/merged server-side
      setPage(p)
      setRegions(p.regions ?? [])
      flash(mode === 'merge'
        ? `Merged ${res.regions_affected} region(s)`
        : `Removed class + ${res.regions_affected} region(s)`)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [jobId, pageId, reloadClasses, flash, resetHistory])

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === ' ') {
        e.preventDefault() // the page must not scroll under the hand
        if (!e.repeat) setSpaceHeld(true)
        return
      }
      if (e.key === 'Alt') {
        if (!e.repeat) setAltHeld(true)
        return
      }
      const combo = eventCombo(e)
      // '' is a bare modifier press, and also what an unbound command holds.
      if (!combo) return
      if (e.key === '?') {
        e.preventDefault()
        setSheetOpen((v) => !v)
        return
      }
      if (combo === 'ctrl+shift+z' || combo === 'meta+shift+z' || combo === 'ctrl+y') {
        e.preventDefault()
        void redo()
        return
      }
      if (combo === 'ctrl+z' || combo === 'meta+z') {
        e.preventDefault()
        void undo()
        return
      }
      if (e.key === 'Escape') {
        drag.cancel()
        setDraft(null)
        setAreaDraft(null)
        setCursor(null)
        setSelectedId(null)
        setMergeSet(new Set())
        setPicks([])
        setCutArmed(false)
        if (tool === 'hand') chooseTool('select')
        return
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !draft && !areaDraft) {
        e.preventDefault()
        gotoTile(e.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      // Backspace takes back the last point of whatever is in hand; an armed hole keeps
      // waiting for its first point rather than dropping the hole altogether.
      if (e.key === 'Backspace' && (areaDraft?.length || draft?.pts.length)) {
        e.preventDefault()
        if (areaDraft) setAreaDraft(areaDraft.length > 1 ? areaDraft.slice(0, -1) : null)
        else if (draft) {
          const pts = draft.pts.slice(0, -1)
          setDraft(pts.length || draft.holeFor !== null || draft.redraw ? { ...draft, pts, lastSnap: null } : null)
        }
        return
      }
      // An area outline confirms like a shape does. It is checked first because the two
      // drafts are mutually exclusive — the detect tool never opens a drawing draft.
      if (e.key === 'Enter' && areaDraft) {
        e.preventDefault()
        void runDetect(areaDraft)
        return
      }
      if (e.key === 'Enter' && draft) {
        e.preventDefault()
        void commitDraft(draft)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && livePicks.length && !draft) {
        e.preventDefault()
        void deletePicked()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId !== null && !draft) {
        e.preventDefault()
        void removeRegion(selectedId)
        return
      }
      // Digits 1..9 pick / reassign class by palette position (ids may be sparse).
      if (/^[1-9]$/.test(e.key)) {
        const cls = drawable[Number(e.key) - 1]
        if (cls) {
          setActiveClassId(cls.id)
          if (selectedId !== null) void reassignClass(selectedId, cls.id)
        }
        return
      }
      if (combo === hotkeys.toolDraw) chooseTool('draw')
      else if (combo === hotkeys.toolSelect) chooseTool('select')
      else if (combo === hotkeys.toolHand) chooseTool('hand')
      else if (combo === hotkeys.toolErase && !readOnly) chooseTool('erase')
      else if (combo === hotkeys.toolDetect && !readOnly && lineJob && !detectUnavailable) chooseTool('detect')
      else if (combo === hotkeys.hole && selectedId !== null) {
        // A traced line has no interior to punch a hole in.
        const target = regions.find((r) => r.id === selectedId)
        if (target && !isLine(target)) {
          chooseTool('draw')
          setDraft({ pts: [], holeFor: selectedId })
        }
      } else if (combo === hotkeys.mapReduce) void reduceAll()
      else if (combo === hotkeys.mapResolve && !lineJob) void resolveOverlaps()
      else if (combo === hotkeys.merge && tool === 'select') void mergeGathered()
      else if (combo === hotkeys.split && tool === 'select' && selectedId !== null) toggleCut()
      else if (combo === hotkeys.prevPage) gotoTile(-1)
      else if (combo === hotkeys.nextPage) gotoTile(1)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false)
      if (e.key === 'Alt') setAltHeld(false)
    }
    const onBlur = () => {
      setSpaceHeld(false)
      setAltHeld(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [hotkeys, tool, draft, areaDraft, selectedId, regions, drawable, readOnly, lineJob, detectUnavailable, chooseTool, commitDraft, runDetect, removeRegion, reassignClass, undo, redo, reduceAll, resolveOverlaps, mergeGathered, toggleCut, gotoTile, drag, livePicks, deletePicked])

  // --- rendering ------------------------------------------------------------

  const px = (p: Pt): string => `${p[0] * displayW},${p[1] * displayH}`
  const ringPath = (ring: Ring) => 'M' + ring.map(px).join('L') + 'Z'
  const linePath = (pts: Ring) => 'M' + pts.map(px).join('L') // open: no closing Z
  const regionPath = (r: Region) =>
    isLine(r) ? linePath(r.points) : [r.points, ...r.holes].map(ringPath).join(' ')

  // Marching-ants dash for the brush, held at roughly a dozen segments around the ring
  // whatever the radius: a fixed length gives the smallest brush two dashes and the
  // largest a hundred. Clamped so the ants never shrink to specks or stretch to arcs.
  const brushDash = Math.min(10, Math.max(2.5, (Math.PI * brushPx) / 14))

  // Near enough to the first point that a click, or letting go of a stroke, closes there.
  const closeArmed = !!draft && canClose(draft) && !!cursor &&
    Math.hypot((draft.pts[0][0] - cursor[0]) * displayW, (draft.pts[0][1] - cursor[1]) * displayH) < CLOSE_SNAP_PX

  // A shape in progress wears the class it will be filed under: the region it belongs to
  // for a hole or a redraw, the active class for anything new.
  const draftOwner = draft?.redraw?.regionId ?? draft?.holeFor ?? null
  const draftColor = rgbToHex(colorFor(
    regions.find((r) => r.id === draftOwner)?.class_id ?? activeClassId))

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-danger">{error}</p>
        <Link to={`/jobs/${jobId}`} className="text-sm text-accent-ink hover:underline">
          Back to job
        </Link>
      </div>
    )
  }

  const selected = regions.find((r) => r.id === selectedId) ?? null
  const draftAnchor: Pt | null = (() => {
    const redraw = draft?.redraw
    if (!redraw) return null
    const r = regions.find((x) => x.id === redraw.regionId)
    return r ? toPoly(r)[redraw.ringIdx]?.[redraw.start] ?? null : null
  })()
  // h-full, not h-screen: the shell already reserves the nav bar's height, so a full
  // viewport here would overflow by exactly that and put a scrollbar over the canvas edge.
  const key = (combo: string) => comboLabel(combo)
  const shortcutGroups = [
    { title: 'Tools', rows: [
      [key(hotkeys.toolDraw), lineJob ? 'Trace' : 'Draw'], [key(hotkeys.toolSelect), 'Select'],
      [hotkeys.toolHand ? key(hotkeys.toolHand) : 'Space (hold)', 'Hand'],
      ...(readOnly ? [] : [[key(hotkeys.toolErase), 'Erase vertices with the brush'] as [string, string]]),
      ...(lineJob && !readOnly ? [[key(hotkeys.toolDetect), 'Detect edges in an area'] as [string, string]] : []),
      ...(lineJob ? [] : [[key(hotkeys.hole), 'Cut a hole in the selected polygon'] as [string, string]]),
      [key(hotkeys.mapReduce), lineJob ? 'Reduce lines' : 'Reduce polygons'],
      ...(lineJob ? [] : [[key(hotkeys.mapResolve), 'Resolve overlaps'] as [string, string]]),
    ] as [string, string][] },
    { title: 'Drawing', rows: [
      ['click', 'add a point'], ['drag', 'draw freehand'], ['Backspace', 'take the last point back'],
      ['Enter · right-click · double-click', lineJob ? 'finish the line where it is' : 'close the shape'],
      ['click the first point', lineJob ? 'close the line there' : 'close the shape'],
      ['Esc', 'cancel'],
    ] as [string, string][] },
    { title: 'Selecting', rows: [
      ['click', 'select'], ['drag', 'move the shape'], ['drag a dot', 'move a vertex'],
      ['drag on empty space', 'pick the dots in the box (Shift adds)'], ['Shift+click a dot', 'pick or unpick it'],
      ['drag a picked dot', 'move all picked dots'],
      ['dot, then dot', 'redraw the stretch between them'],
      ...(lineJob ? [['Enter', 'extend the line from its end dot'] as [string, string]]
                  : [['double-click an edge', 'add a dot'] as [string, string]]),
      ['right-click a dot', 'remove it'], ['Shift+click', 'gather for a merge'],
      [key(hotkeys.merge), 'merge the gathered'], ...(lineJob ? [[key(hotkeys.split), 'cut the line where clicked'] as [string, string]] : []),
      ['Delete', 'delete the picked dots, else the selection'], ['1-9', 'pick a class, or reclass the selection'],
    ] as [string, string][] },
    { title: 'View', rows: [
      ['Ctrl+wheel', 'zoom'], ['Shift+wheel', 'size the eraser\'s brush'],
      ['Space+drag · Alt-drag · middle-drag', 'pan'], ['← · →', 'previous · next tile'],
      ['Ctrl+Z · Ctrl+Shift+Z', 'undo · redo'],
      [`${key(hotkeys.prevPage)} · ${key(hotkeys.nextPage)}`, 'previous · next tile'], ['?', 'this sheet'],
    ] as [string, string][] },
  ]
  const sentence = tool === 'hand'
    ? 'Hand - drag to move the tile; holding Space does the same in any tool'
    : tool === 'detect'
            ? areaShape === 'polygon'
              ? 'Detect - click to outline an area, right-click/Enter/double-click to trace its edges, Esc to cancel'
              : 'Detect - drag a box over the area to trace its edges'
            : tool === 'erase'
            ? `Erase - hold the left button and sweep over vertices; a ${lineJob ? 'line' : 'shape'} left too small is removed`
            : tool === 'draw'
            ? draft?.holeFor != null
              ? 'Cutting a hole - click or drag to add points, Backspace takes one back, right-click/Enter/double-click to close'
              : lineJob
                ? 'Trace - click to add points or drag to draw freehand, click the first point to close it, Backspace takes one back, right-click/Enter/double-click to finish, Esc to cancel'
                : 'Draw - click to add points or drag to draw freehand, Backspace takes one back, right-click or Enter to close (or click the first point), Esc to cancel'
            : cutArmed
            ? 'Cut - click on the selected line where it should be cut, Esc to cancel'
            : draft?.redraw
            ? `Redrawing - click to add points, click another dot of the outline to finish${lineJob ? ', Enter extends a line from its end' : ''}, Esc to cancel`
            : mergeSet.size
            ? `${mergeSet.size} gathered - m merges them, Esc clears`
            : lineJob
              ? 'Select - click a line, drag it to move it, drag a dot, drag on empty space to pick dots (Delete removes them), click a dot then another to redraw between them, ⇧click gathers for m, s cuts, right-click a dot to remove it'
              : 'Select - click a region, drag it to move it, drag a dot, drag on empty space to pick dots (Delete removes them), click a dot then another to redraw between them, ⇧click gathers for m, double-click an edge to add a dot, right-click a dot to remove it'
  return (
    <>
    <EditorShell
      header={{
        left: (<>
          <Link to={`/jobs/${jobId}`} className="text-sm text-ink-muted hover:text-accent-ink">
            ← {job?.name ?? 'Job'}
          </Link>
          <span className="text-sm font-medium text-ink">{page?.filename}</span>
          {page && <PresenceBanner entries={onPage(page.id)} what="tile" />}
          {tiles.length > 0 && (
            <span className="text-xs text-ink-subtle">
              tile {tileIdx + 1} / {tiles.length}
            </span>
          )}
        </>),
        actions: (<>
          <Button variant="ghost" onClick={() => gotoTile(-1)} disabled={tileIdx <= 0}>
            ← Prev
          </Button>
          <Button variant="ghost" onClick={() => gotoTile(1)} disabled={tileIdx < 0 || tileIdx >= tiles.length - 1}>
            Next →
          </Button>
          <label className="ml-2 flex items-center gap-1.5 text-sm text-ink">
            <Check data-testid="tile-reviewed" checked={!!page?.layout_checked}
                   onChange={toggleReviewed} disabled={readOnly} />
            Reviewed
          </label>
        </>),
      }}
      rail={<>
          <ToolPalette
            tool={panning ? 'hand' : tool}
            onTool={chooseTool}
            capabilities={{ erase: true, detect: !!lineJob }}
            bindings={{
              select: hotkeys.toolSelect, hand: hotkeys.toolHand, draw: hotkeys.toolDraw,
              erase: hotkeys.toolErase, detect: hotkeys.toolDetect,
            }}
            detectDisabled={detectUnavailable}
            readOnly={readOnly}
          />
          {tool === 'erase' && (
            <div>
              <BrushPanel radius={brushRadius} onRadius={setBrushRadius} />
            </div>
          )}
          {tool === 'detect' && !readOnly && (
            <div data-testid="detect-panel">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">
                Detect edges
              </p>
              <Segmented
                value={areaShape}
                options={[{ value: 'polygon', label: 'Outline' }, { value: 'rect', label: 'Box' }]}
                onChange={setAreaShape}
              />
              <div className="mt-1.5">
                {edgeMethodsFailed ? (
                  <p data-testid="detect-error" role="alert" className="text-xs text-danger">
                    The detection methods could not be loaded. Reload the page to try again.
                  </p>
                ) : edgeInfo === null ? (
                  <p className="text-xs text-ink-subtle">Loading methods…</p>
                ) : !edgeInfo.configured ? (
                  <p className="text-xs text-ink-muted">
                    Edge detection is not configured on this server.
                  </p>
                ) : edgeInfo.methods.length === 0 ? (
                  <p className="text-xs text-ink-muted">No methods in the registry.</p>
                ) : (
                  <Select
                    size="xs"
                    data-testid="detect-method"
                    value={edgeMethod}
                    onChange={(e) => setEdgeMethod(e.target.value)}
                    // min-w-0: a select is as wide as its longest option unless told
                    // otherwise, which would push the whole rail past its width.
                    className="w-full min-w-0"
                  >
                    {edgeInfo.methods.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.available}>
                        {m.label}{m.available ? '' : ' (checkpoint missing)'}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            </div>
          )}
          {/* Snapping joins a new shape to the outlines already there: a line meets the
              line it was aimed at, a polygon shares its neighbour's border. Only drawing and
              dragging vertices snap - the eraser and the detect tool's area never do - so
              the toggle shows only where it does something. */}
          {!readOnly && (tool === 'draw' || tool === 'select') && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">Drawing</p>
              <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                <input
                  data-testid="snap-toggle"
                  type="checkbox"
                  checked={snapLines}
                  onChange={(e) => setSnapLines(e.target.checked)}
                />
                Snap to outlines
              </label>
            </div>
          )}
          <PenPanel
            pens={drawable.map((c, i) => ({
              key: c.id, label: c.name, color: rgbToHex(c.color), digit: i < 9 ? i + 1 : null,
            }))}
            active={activeClassId}
            onPick={(key) => {
              setActiveClassId(Number(key))
              if (selectedId !== null) void reassignClass(selectedId, Number(key))
            }}
            editable={readOnly ? undefined : {
              onRecolor: (key, hex) => changeClassColor(Number(key), hex),
              onRemove: (pen) => void askRemoveClass(Number(pen.key)),
              onAdd: () => setAddOpen(true),
            }}
            ranking={lineJob ? undefined : {
              rankOf: (key) => ranked.findIndex((c) => c.id === key) + 1,
              onMove: readOnly ? undefined : (key, step) => moveClassRank(Number(key), step),
            }}
          />
          {selected && (
            <SelectionPanel title="Selected">
              <Select
                size="xs"
                aria-label="Class of the selected shape"
                value={selected.class_id}
                disabled={readOnly}
                onChange={(e) => void reassignClass(selected.id, Number(e.target.value))}
                className="w-full"
              >
                {drawable.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </SelectionPanel>
          )}
          {!readOnly && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">Operations</p>
              <div className="space-y-1.5">
                {/* "Simplify" said nothing about what it changes. It removes *vertices* -
                    the geometry keeps its shape, there are just fewer points to drag. */}
                <Button onClick={() => void reduceAll()} disabled={busy || regions.length === 0} className="w-full"
                        title={'Remove vertices every '
                          + (lineJob ? 'traced line' : 'polygon')
                          + ' can do without: drops any point lying within Tolerance px of the '
                          + (lineJob ? 'line' : 'edge')
                          + ' between its neighbours, so the shape stays and the point count drops'
                          + ` (${hotkeys.mapReduce})`}>
                  {lineJob ? 'Reduce lines' : 'Reduce polygons'}
                </Button>
                <label className="flex items-center gap-1.5 text-xs text-ink-muted"
                       title={`How far reducing may move the ${lineJob ? 'line' : 'outline'}. `
                         + 'Higher removes more vertices and follows the original less closely; '
                         + '0 removes none.'}>
                  Tolerance
                  <input
                    type="number" min={0} step={0.5} value={tolerance}
                    onChange={(e) => setTolerance(Math.max(0, Number(e.target.value)))}
                    className="w-16 rounded border border-line-strong bg-surface px-1 py-0.5 text-right"
                  />
                  px
                </label>
                {/* Overlap clipping is an area operation — nothing to do in a line job. */}
                {!lineJob && (
                  <Button onClick={() => void resolveOverlaps()} disabled={busy || regions.length === 0} className="w-full"
                          title={'Clip each polygon under the higher-ranked ones it overlaps - higher rank wins: '
                            + `${ranked.map((c) => c.name).join(' over ')} (${hotkeys.mapResolve})`}>
                    Resolve overlaps
                  </Button>
                )}
              </div>
            </div>
          )}
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">View</p>
            {/* Polylines are stroked, never filled — the slider steers nothing in a line job,
                where the stroke one below takes its place. */}
            {!lineJob && (
              <label className="mb-1 block text-xs text-ink-muted">
                Fill {Math.round(fillOpacity * 100)}%
                <input
                  type="range" min={0} max={1} step={0.05} value={fillOpacity}
                  onChange={(e) => setFillOpacity(Number(e.target.value))}
                  onMouseUp={(e) => e.currentTarget.blur()}
                  className="w-full accent-accent"
                />
              </label>
            )}
            {lineJob && (
              <label className="mb-1 block text-xs text-ink-muted">
                Lines {Math.round(lineOpacity * 100)}%
                <input
                  data-testid="line-opacity"
                  type="range" min={0} max={1} step={0.05} value={lineOpacity}
                  onChange={(e) => setLineOpacity(Number(e.target.value))}
                  onMouseUp={(e) => e.currentTarget.blur()}
                  className="w-full accent-accent"
                />
              </label>
            )}
            <label className="mb-1 block text-xs text-ink-muted">
              Handles {Math.round(handleOpacity * 100)}%
              <input
                data-testid="handle-opacity"
                type="range" min={0} max={1} step={0.05} value={handleOpacity}
                onChange={(e) => setHandleOpacity(Number(e.target.value))}
                onMouseUp={(e) => e.currentTarget.blur()}
                className="w-full accent-accent"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              <input type="checkbox" checked={showOnly} onChange={(e) => setShowOnly(e.target.checked)} />
              Show only selected
            </label>
          </div>
          {/* Only a stroked kind has a width to preview. Viewers see the whole section - it
              is reading - but not the save button, which writes the job. */}
          {lineJob && job && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">
                Export preview
              </p>
              <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                <input
                  data-testid="export-preview-toggle"
                  type="checkbox"
                  checked={exportPreview}
                  onChange={(e) => {
                    setExportPreview(e.target.checked)
                    // Always re-seed from the job: the slider is a scratch value, and
                    // reopening the preview should start from what would be exported.
                    if (e.target.checked) setPreviewWidth(job.line_width)
                  }}
                />
                Show export thickness
              </label>
              {exportPreview && (
                <>
                  <label className="mb-1 mt-2 block text-xs text-ink-muted">
                    <span className="flex items-center justify-between gap-2">
                      <span>Width {previewWidth}px</span>
                      {/* The marker doubles as the way back: no remembering, no retyping. */}
                      <button
                        data-testid="export-width-saved"
                        onClick={() => setPreviewWidth(job.line_width)}
                        title="The width this job exports at - click to go back to it"
                        className={`rounded px-1 py-0.5 text-[10px] ${
                          previewWidth === job.line_width
                            ? 'bg-accent-wash text-accent-ink'
                            : 'text-ink-subtle hover:text-accent-ink'
                        }`}
                      >
                        saved {job.line_width}
                      </button>
                    </span>
                    <input
                      data-testid="export-width"
                      type="range" min={1} max={25} step={1} value={previewWidth}
                      list="export-width-ticks"
                      onChange={(e) => setPreviewWidth(Number(e.target.value))}
                      onMouseUp={(e) => e.currentTarget.blur()}
                      className="w-full accent-accent"
                    />
                    <datalist id="export-width-ticks">
                      <option value={job.line_width} />
                    </datalist>
                  </label>
                  {!readOnly && previewWidth !== job.line_width && (
                    <Button
                      data-testid="export-width-save"
                      onClick={saveExportWidth}
                      disabled={savingWidth}
                      className="mt-1 w-full"
                    >
                      {savingWidth ? 'Saving…' : 'Set as export width'}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
          {/* The list is the one part of the rail that grows without bound, so it is the
              one part that scrolls: min-h-0 lets it shrink below its content, and the ul
              takes the overflow. Without that the ul spills out of its box and paints over
              whatever follows it - the coverage panel and the export hint. */}
          <ObjectList
            heading={`${lineJob ? 'Lines' : 'Regions'} (${regions.length})`}
            items={regions.map((r) => ({
              id: r.id,
              label: r.class_name,
              color: rgb(colorFor(r.class_id)),
              // No per-shape review box: a map is reviewed per tile (the header's Reviewed
              // flag), which is the only thing mask export and re-predict read. A
              // region's `checked` is still written - predictions 0, hand-drawn 1 - but
              // nothing asks anyone to tick it.
            }))}
            selectedId={selectedId}
            hoveredId={hoveredId}
            onHover={setHoveredId}
            onSelect={(id) => {
              chooseTool('select')
              setSelectedId(id)
            }}
            empty={lineJob ? 'No lines on this tile yet.' : 'No regions on this tile yet.'}
          />
          {/* Coverage is about area: what each class covers and what nothing does. A line
              job's classes cover none, and its one class already has its count in the list
              above, so the whole block is noise there - as is the export hint under it. */}
          {!lineJob && (
          <div className="shrink-0">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">Coverage</p>
            <ul className="space-y-0.5 text-xs text-ink-muted">
              {drawable
                .filter((c) => (classCounts.get(c.id) ?? 0) > 0)
                .map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: rgb(c.color) }} />
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="tabular-nums">{classCounts.get(c.id)}</span>
                  </li>
                ))}
              <li className="flex items-center gap-2 border-t border-line pt-0.5">
                <span className="flex-1">Uncovered</span>
                <span className="tabular-nums">{uncovered === null ? '-' : `${uncovered.toFixed(1)}%`}</span>
              </li>
            </ul>
          </div>
          )}
          {isAdmin && !lineJob && (
            <p className="shrink-0 text-xs text-ink-subtle">
              Export masks from the job page.
            </p>
          )}
      </>}
      canvas={
        <div
          ref={paneRef}
          onPointerDown={(e) => {
            onPanStart(e)
            // The blank space around the tile starts a box too: it is the only place to
            // begin one that must take in dots sitting on the tile's own border.
            if (!fromCanvas(e.target)) onPickDown(e)
          }}
          onPointerMove={onPaneMove}
          onPointerUp={onPanEnd}
          onPointerCancel={onPanEnd}
          onClick={onPaneClick}
          onDoubleClick={(e) => {
            if (!fromCanvas(e.target)) finishDraft()
          }}
          onContextMenu={onPaneContextMenu}
          className="no-scrollbar relative min-w-0 flex-1 overflow-hidden bg-ground"
        >
          <div ref={tileRefs.host} className="absolute inset-0" />
          {page && (
            <div
              ref={tileRefs.box}
              data-testid="tile-canvas"
              className="absolute left-0 top-0 z-10 origin-top-left invisible"
            >
              <svg
                ref={svgRef}
                width="100%"
                height="100%"
                viewBox={`0 0 ${displayW} ${displayH}`}
                className="absolute inset-0"
                // The brush circle stands in for the pointer while erasing. A finger or pen
                // in a drawing tool must draw rather than scroll the pane; in select mode the
                // handles carry that rule themselves, so touch can still pan the tile.
                style={{
                  cursor: panning ? 'grab'
                    : tool === 'draw' || tool === 'detect' ? 'crosshair'
                    : tool === 'erase' ? 'none' : 'default',
                  touchAction: tool === 'select' || panning ? 'auto' : 'none',
                }}
                onClick={onSvgClick}
                onPointerDown={(e) => {
                  onDrawDown(e)
                  onEraseDown(e)
                  onDetectDown(e)
                  onPickDown(e)
                }}
                onPointerMove={onSvgMove}
                onPointerLeave={() => {
                  if (tool === 'erase' && !drag.isDragging()) setCursor(null)
                }}
                onDoubleClick={(e) => {
                  // While drawing, a double-click finishes the shape; otherwise it adds a
                  // vertex to the selected outline — the deselect the first click armed is
                  // cancelled, since this click proves the selection was still wanted.
                  cancelDeselect()
                  if (areaDraft || draft) finishDraft()
                  else void insertVertexAtCursor(e)
                }}
                onContextMenu={(e) => {
                  // Right-click finishes whatever is in hand — a shape, or an area to detect
                  // in — so a drawing hand never has to leave the mouse. With nothing in
                  // hand the browser menu is left alone, as is the right-click that removes
                  // a vertex in select mode (its handler stops propagation first).
                  if (!areaDraft && !draft) return
                  e.preventDefault()
                  finishDraft()
                }}
              >
                {/* Click surface (also lets draw clicks land off any shape). */}
                <rect x={0} y={0} width={displayW} height={displayH} fill="transparent" />
                {visibleRegions.map((r) => {
                  const color = rgb(colorFor(r.class_id))
                  const isSel = r.id === selectedId
                  const lit = isSel || r.id === hoveredId
                  const line = isLine(r)
                  const d = regionPath(r)
                  // Per region, never on lineJob: a job holding both kinds must keep its
                  // polygons' thin outlines while its traces preview at export width.
                  const preview = exportPreview && line
                  // The fidelity contract with map_export.rasterize: the svg's viewBox is
                  // tile*zoom, so `width * zoom` user units *are* `width` image pixels.
                  const previewPx = previewWidth * zoom
                  const gathered = mergeSet.has(r.id)
                  // A press on the shape: a click selects (Shift gathers), a drag moves it.
                  // With the scissors armed or a redraw in hand the press goes to the canvas
                  // instead, where it cuts or places a point.
                  const onRegionDown = (e: React.PointerEvent) => {
                    if (tool !== 'select' || handHeld || e.button !== 0 || e.altKey || cutArmed || draft?.redraw) return
                    e.stopPropagation()
                    if (picks.length) setPicks([])
                    startRegionDrag(e, r)
                  }
                  const events = tool === 'select' && !handHeld ? 'auto' : 'none'
                  return (
                    <g
                      key={r.id}
                      data-testid="map-region"
                      data-region-id={r.id}
                      data-class-id={r.class_id}
                      data-kind={r.kind}
                      data-selected={isSel}
                      data-hovered={(r.id === hoveredId) || undefined}
                      data-gathered={gathered || undefined}
                    >
                      {/* A stroke is too thin to click: a transparent fat twin carries the
                          pointer events that a polygon's fill would. */}
                      {line && (
                        <path
                          d={d}
                          fill="none"
                          stroke="transparent"
                          // A preview stroke can be wider than the twin, and a click on the
                          // part sticking out would then miss the line it visibly hit.
                          strokeWidth={preview ? Math.max(LINE_HIT_PX * 2, previewPx) : LINE_HIT_PX * 2}
                          style={{ pointerEvents: tool === 'select' ? 'stroke' : 'none', cursor: 'pointer' }}
                          onPointerDown={onRegionDown}
                        />
                      )}
                      {/* Selection is a heavier stroke everywhere else, but in preview the
                          width is the message - so the selected trace gets a halo under it
                          instead, and the stroke keeps telling the truth about the export. */}
                      {preview && isSel && (
                        <path
                          d={d}
                          fill="none"
                          stroke="var(--ui-accent)"
                          strokeWidth={previewPx + 4}
                          strokeLinejoin="round"
                          strokeLinecap="butt"
                          style={{ pointerEvents: 'none' }}
                        />
                      )}
                      <path
                        d={d}
                        fillRule="evenodd"
                        fill={line ? 'none' : gathered ? 'var(--ui-warn)' : color}
                        fillOpacity={line ? undefined : lit || gathered ? Math.min(1, fillOpacity + 0.12) : fillOpacity}
                        stroke={gathered ? 'var(--ui-warn)' : color}
                        // Literal: 0% hides the trace completely, since seeing the bare ink
                        // is the point. The selected line stays findable by its own handles
                        // and its heavier stroke, so it takes no opacity bump the way a
                        // selected fill does. Only a line job can reach the slider, so only
                        // it honours the value - a leftover in localStorage must not dim a
                        // polygon job's outlines with no control in sight.
                        strokeOpacity={line && lineJob ? lineOpacity : undefined}
                        strokeWidth={preview ? previewPx : line ? (lit || gathered ? 3.5 : 2.5) : lit || gathered ? 2.5 : 1.5}
                        strokeLinejoin="round"
                        // Butt caps in preview, round otherwise: PIL's joint='curve' rounds
                        // joins but leaves endpoints square, so this is what the exported
                        // mask actually looks like (backend/app/map_export.py).
                        strokeLinecap={preview ? 'butt' : 'round'}
                        style={{ pointerEvents: line ? 'none' : events, cursor: 'pointer' }}
                        onPointerDown={line ? undefined : onRegionDown}
                      />
                    </g>
                  )
                })}

                {/* Draft polyline + rubber band, led from the vertex a redraw started at. */}
                {draft && (draft.pts.length > 0 || draftAnchor) && (
                  <>
                    <polyline
                      data-testid="draft-line"
                      points={[...(draftAnchor ? [draftAnchor] : []), ...draft.pts, ...(cursor ? [cursor] : [])]
                        .map(px).join(' ')}
                      fill="none"
                      stroke={draftColor}
                      strokeWidth={2}
                      strokeDasharray="4 3"
                    />
                    {draftAnchor && (
                      <circle data-testid="redraw-anchor" cx={draftAnchor[0] * displayW} cy={draftAnchor[1] * displayH}
                              r={7} fill="none" stroke={draftColor} strokeWidth={2} style={{ pointerEvents: 'none' }} />
                    )}
                    {/* A stroke samples a point every few px, so dotting them all buries the
                        outline being drawn under its own handles. What stays is the points
                        placed by hand and the one the stroke set out from - which is also
                        where it has to come back to if it is to close. */}
                    {(strokeFrom === null ? draft.pts : draft.pts.slice(0, strokeFrom + 1)).map((p, i) => (
                      <circle key={i} data-testid="draft-dot"
                              cx={p[0] * displayW} cy={p[1] * displayH} r={4} fill={draftColor} />
                    ))}
                  </>
                )}

                {/* The way out: the first point, which says so when the pointer comes near
                    enough that letting go there would close the shape. */}
                {draft && canClose(draft) && (
                  <circle
                    data-testid="draft-close"
                    data-armed={closeArmed || undefined}
                    cx={draft.pts[0][0] * displayW}
                    cy={draft.pts[0][1] * displayH}
                    r={closeArmed ? 9 : 6}
                    fill={closeArmed ? draftColor : 'none'}
                    stroke={draftColor}
                    strokeWidth={2}
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* The cursor is on an existing outline: the next click joins it there.
                    Shown before the first vertex too, so a line starts attached as
                    deliberately as it ends. */}
                {snapped && cursor && tool === 'draw' && (
                  <circle
                    data-testid="snap-marker"
                    cx={cursor[0] * displayW}
                    cy={cursor[1] * displayH}
                    r={6}
                    fill="none"
                    stroke="var(--ui-ok)"
                    strokeWidth={2}
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* The area to detect in. Amber and filled, so it never reads as geometry
                    being drawn — nothing here becomes a region, it only says where to look. */}
                {areaDraft && areaDraft.length > 0 && (
                  <>
                    <polygon
                      points={[...areaDraft, ...(cursor ? [cursor] : [])].map(px).join(' ')}
                      fill="color-mix(in srgb, var(--ui-warn) 10%, transparent)"
                      stroke="var(--ui-warn)"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                    />
                    {areaDraft.map((p, i) => (
                      <circle key={i} cx={p[0] * displayW} cy={p[1] * displayH} r={4} fill="var(--ui-warn)" />
                    ))}
                  </>
                )}
                {marquee && (
                  <rect
                    x={Math.min(marquee.a[0], marquee.b[0]) * displayW}
                    y={Math.min(marquee.a[1], marquee.b[1]) * displayH}
                    width={Math.abs(marquee.b[0] - marquee.a[0]) * displayW}
                    height={Math.abs(marquee.b[1] - marquee.a[1]) * displayH}
                    data-testid={tool === 'select' ? 'pick-marquee' : undefined}
                    fill={tool === 'select'
                      ? 'color-mix(in srgb, var(--ui-accent) 10%, transparent)'
                      : 'color-mix(in srgb, var(--ui-warn) 10%, transparent)'}
                    stroke={tool === 'select' ? 'var(--ui-accent)' : 'var(--ui-warn)'}
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Erasing shows every vertex on every visible region, not just the selected
                    one's: the brush takes whatever it covers, so what it can take has to be
                    on screen. They are inert — a handle that caught the mousedown the way the
                    select-mode ones do would swallow the start of the stroke. */}
                {tool === 'erase' &&
                  visibleRegions.map((r) =>
                    toPoly(r).map((ring, ringIdx) => (
                      <g key={`${r.id}:${ringIdx}`} opacity={handleOpacity} style={{ pointerEvents: 'none' }}>
                        {ring.map((p, i) => (
                          <circle
                            key={i}
                            cx={p[0] * displayW}
                            cy={p[1] * displayH}
                            r={3}
                            fill={ringIdx === 0 ? 'var(--ui-accent)' : 'var(--ui-warn)'}
                            stroke="white"
                            strokeWidth={1}
                          />
                        ))}
                      </g>
                    )),
                  )}

                {/* Eraser brush. r is screen px: one SVG unit is one CSS px here. A single
                    colour vanishes over some part of every scan, so the outline is drawn
                    twice — a solid dark ring with white dashes over it — leaving alternating
                    black/white segments that keep their edge on any background. */}
                {tool === 'erase' && !handHeld && cursor && (
                  <g data-testid="erase-brush" style={{ pointerEvents: 'none' }}>
                    <circle
                      cx={cursor[0] * displayW}
                      cy={cursor[1] * displayH}
                      r={brushPx}
                      fill="rgba(255, 255, 255, 0.12)"
                      stroke="#000"
                      strokeWidth={2}
                    />
                    <circle
                      cx={cursor[0] * displayW}
                      cy={cursor[1] * displayH}
                      r={brushPx}
                      fill="none"
                      stroke="#fff"
                      strokeWidth={2}
                      strokeDasharray={`${brushDash} ${brushDash}`}
                    />
                  </g>
                )}

                {/* Selected region: vertex + midpoint handles. Shown in export preview too -
                    the preview is a way to *work* at export thickness, not a locked-out view,
                    and the Handles slider already hides them for a clean look at the stroke. */}
                {selected &&
                  tool === 'select' &&
                  toPoly(selected).map((ring, ringIdx) => (
                    <g key={ringIdx} opacity={handleOpacity}>
                      {/* Every handle is two circles: the dot that is drawn, which takes no
                          events, and a wider transparent one over it that catches the press
                          (VERTEX_HIT_PX / MIDPOINT_HIT_PX). Fragments, not groups, so the
                          handle's parent stays this <g> and its opacity. */}
                      {midpoints(ring, !(isLine(selected) && ringIdx === 0)).map((m, i) => (
                        <Fragment key={`m${i}`}>
                          <circle
                            cx={m[0] * displayW}
                            cy={m[1] * displayH}
                            r={MIDPOINT_R}
                            fill="white"
                            stroke="var(--ui-accent)"
                            strokeWidth={1.5}
                            style={{ pointerEvents: 'none' }}
                          />
                          <circle
                            data-testid="midpoint-handle"
                            cx={m[0] * displayW}
                            cy={m[1] * displayH}
                            r={MIDPOINT_HIT_PX}
                            fill="transparent"
                            // Armed scissors cut wherever the line is clicked, and a redraw takes
                            // its points from the canvas: neither wants a dot to insert a vertex.
                            style={{ cursor: 'copy', pointerEvents: cutArmed || draft?.redraw ? 'none' : 'all' }}
                            // A press here is the dot's, as on a vertex: a box pick from the canvas
                            // would capture the pointer and take the click away from it.
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => void insertVertex(e, selected, ringIdx, i)}
                          />
                        </Fragment>
                      ))}
                      {/* The repeated point a closed trace ends on is the same corner as
                          the one it starts at: one handle, which moves and removes both. */}
                      {(ringIdx === 0 && isClosedTrace(selected) ? ring.slice(0, -1) : ring).map((p, i) => (
                        <Fragment key={`v${i}`}>
                          {pickedKeys.has(pickKey(selected.id, ringIdx, i)) && (
                            <circle
                              data-testid="picked-vertex"
                              cx={p[0] * displayW}
                              cy={p[1] * displayH}
                              r={VERTEX_R + 3.5}
                              fill="none"
                              stroke="var(--ui-warn)"
                              strokeWidth={2}
                              style={{ pointerEvents: 'none' }}
                            />
                          )}
                          <circle
                            cx={p[0] * displayW}
                            cy={p[1] * displayH}
                            r={VERTEX_R}
                            fill={ringIdx === 0 ? 'var(--ui-accent)' : 'var(--ui-warn)'}
                            stroke="white"
                            strokeWidth={1.5}
                            style={{ pointerEvents: 'none' }}
                          />
                          <circle
                            data-testid="vertex-handle"
                            cx={p[0] * displayW}
                            cy={p[1] * displayH}
                            r={VERTEX_HIT_PX}
                            fill="transparent"
                            style={{ cursor: 'grab', touchAction: 'none', pointerEvents: cutArmed ? 'none' : 'all' }}
                            onPointerDown={(e) => onHandleDown(e, selected, ringIdx, i)}
                            onContextMenu={(e) => void deleteVertex(e, selected, ringIdx, i)}
                          />
                        </Fragment>
                      ))}
                    </g>
                  ))}

                {/* Picks spread over several shapes: their dots show on every shape, not
                    only a selected one, and any of them drags the lot. */}
                {tool === 'select' && livePicks.some((p) => p.regionId !== selectedId) && (
                  <g opacity={handleOpacity}>
                    {livePicks.filter((p) => p.regionId !== selectedId).map((p) => {
                      const r = regions.find((x) => x.id === p.regionId)
                      if (!r) return null
                      return (
                        <Fragment key={pickKey(p.regionId, p.ringIdx, p.index)}>
                          <circle
                            data-testid="picked-vertex"
                            cx={p.pt[0] * displayW}
                            cy={p.pt[1] * displayH}
                            r={VERTEX_R + 3.5}
                            fill="none"
                            stroke="var(--ui-warn)"
                            strokeWidth={2}
                            style={{ pointerEvents: 'none' }}
                          />
                          <circle
                            cx={p.pt[0] * displayW}
                            cy={p.pt[1] * displayH}
                            r={VERTEX_R}
                            fill={p.ringIdx === 0 ? 'var(--ui-accent)' : 'var(--ui-warn)'}
                            stroke="white"
                            strokeWidth={1.5}
                            style={{ pointerEvents: 'none' }}
                          />
                          <circle
                            data-testid="vertex-handle"
                            cx={p.pt[0] * displayW}
                            cy={p.pt[1] * displayH}
                            r={VERTEX_HIT_PX}
                            fill="transparent"
                            style={{ cursor: 'grab', touchAction: 'none', pointerEvents: cutArmed ? 'none' : 'all' }}
                            onPointerDown={(e) => onHandleDown(e, r, p.ringIdx, p.index)}
                            onContextMenu={(e) => void deleteVertex(e, r, p.ringIdx, p.index)}
                          />
                        </Fragment>
                      )
                    })}
                  </g>
                )}
              </svg>
            </div>
          )}
        </div>
      }
      status={
        <StatusBar
          zoom={{
            out: () => setScale(Math.max(0.25, zoom / 1.25)),
            in: () => setScale(Math.min(12, zoom * 1.25)),
            reset: () => setScale(1),
            readoutRef,
          }}
          sentence={sentence}
          notice={notice}
          keys="Ctrl+Z undo · Ctrl+Shift+Z redo · Alt/middle-drag pans · Ctrl+wheel zooms · Shift+wheel sizes the eraser"
          onShortcuts={() => setSheetOpen(true)}
        />
      }
    />

      {addOpen && (
        <AddClassDialog onAdd={(name, color) => void addClass(name, color)} onClose={() => setAddOpen(false)} />
      )}

      {removeClass && (
        <RemoveClassDialog
          target={removeClass}
          others={drawable.filter((c) => c.id !== removeClass.id)}
          onRemove={(mode, into) => void removeJobClass(removeClass.id, mode, into)}
          onClose={() => setRemoveClass(null)}
        />
      )}
      {sheetOpen && <ShortcutSheet groups={shortcutGroups} onClose={() => setSheetOpen(false)} />}
    </>
  )
}
