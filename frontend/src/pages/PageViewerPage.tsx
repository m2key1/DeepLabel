import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  createElement,
  createLine,
  deleteLine,
  mergeElements,
  mergeLines,
  patchLineOrientation,
  turnPage,
  patchLinePolygon,
  reocrLine,
  splitElement,
  splitLine,
  deleteElement,
  getJob,
  getJobLayoutClasses,
  conflictOf,
  getPage,
  getJobCharacters,
  cancelLlmRead, getLlmReadStatus, removeCandidate,
  getPageCandidates,
  attachCandidate,
  runPagePhase,
  getReviewQueue,
  patchElement,
  patchLine,
  listModels,
  renditionUrl,
  setElementChecked,
  setLineChecked,
  READING_ORDERS,
  READING_ORDER_LABEL,
  setPageLayoutChecked,
  markTestPages,
  setPageNote,
  setPageLinesChecked,
  setPageReadingOrder,
  tilesUrl,
  isUncounted,
} from '../api'
import type {
  Bbox, EditSpan, JobDetail, Line, LineCandidate, LlmReadStatus, PageDetail, PageElement,
  PagePhase, RegistryModel, ReviewQueue, RevertResult,
} from '../api'
import { NoteTag } from '../components/NoteTag'
import { TestDataChip, TestPageSwitch } from '../components/TestPage'
import { useSetCrumbs } from '../components/NavBar'
import { PresenceAvatars } from '../components/presence/PresenceAvatars'
import { PresenceBanner } from '../components/presence/PresenceBanner'
import { LineConflict, type Conflict } from '../components/viewer/LineConflict'
import { usePresence, usePresenceLocation } from '../presence'
import type { Crumb } from '../components/NavBar'
import { BarDivider, Button, ButtonGroup, GroupButton, Toggle } from '../components/ui/Button'
import { Select } from '../components/ui/Field'
import { Segmented } from '../components/ui/Segmented'
import { KeyboardIcon, PanelIcon, PenIcon, PolygonIcon, RotateIcon, TurnedBoxIcon } from '../components/icons'
import { boxChrome } from '../components/chrome'
import { Splitter } from '../components/ui/Splitter'
import { LineLoupe } from '../components/viewer/LineLoupe'
import { LineCandidates, MACHINE_ID, offeredReadings } from '../components/viewer/LineCandidates'
import { LineReadings } from '../components/viewer/LineReadings'
import { UnmatchedReadings } from '../components/viewer/UnmatchedReadings'
import { isMachineAuthor, readerName } from '../components/viewer/readers'
import type { Reading } from '../components/viewer/LineReadings'
import { RunMenu } from '../components/viewer/RunMenu'
import { LlmReadDialog } from '../components/job/LlmReadDialog'
import { CopyImageButton } from '../components/CopyImageButton'
import { OrderOverlay } from '../components/viewer/OrderOverlay'
import { EditorShell } from '../editor/EditorShell'
import { ObjectList } from '../editor/ObjectList'
import type { ObjectGrouping } from '../editor/ObjectList'
import { PenPanel } from '../editor/PenPanel'
import { ToolPalette } from '../editor/ToolPalette'
import { BrushPanel, brushOnGlass, clampBrush, stepBrush } from '../editor/BrushPanel'
import type { Tool } from '../editor/types'
import { ShortcutSheet } from '../editor/ShortcutSheet'
import { StatusBar } from '../editor/StatusBar'
import { ModelProvenance } from '../components/viewer/ModelProvenance'
import type { Notice } from '../editor/StatusBar'
import { useZoomReadout } from '../editor/useZoomReadout'
import { useImageSurface } from '../hooks/useImageSurface'
import { usePointerDrag } from '../hooks/usePointerDrag'
import { spanOf, useEditHistory } from '../editor/useEditHistory'
import { useGuardedSave } from '../editor/guardedSave'
import { usePageLiveFeed } from '../editor/usePageLiveFeed'
import { simplifyPolyline } from '../lib/geometry/core'
import { eraseFromGeom } from '../lib/geometry/region'
import {
  REVIEW_THRESHOLDS, classColor, confBadgeClass, getHiddenClasses, setClassColors, getLinePenShape, getOcrFrac,
  getPenClass, clampKeyboardSize, clampLoupeHeight, getKeyboardPlace, getKeyboardSize, getLoupeHeight,
  getReadingsFrac, setHiddenClasses, setLoupeHeight,
  setKeyboardPlace, setKeyboardSize, setLinePenShape, setOcrFrac, setPenClass, setReadingsFrac, setReviewConf,
} from '../util'
import type { LinePenShape } from '../util'
import { clamp01, polyCenter, polyMaxX, polyMinX } from '../lib/geometry/core'
import type { Ring } from '../lib/geometry/core'
import {
  acrossQuad, angleAround, angledQuad, bigEnough, containingStack, cropAxis, cropPlan, dropVertex, lineBox, linesAt, minAreaQuad, moveBbox, moveEdge, moveEdgeFree, movePoly, orderBbox, pagePoints, polyBigEnough, polygonCrossing, quadAngle, quadCrossing, resizeBbox, resizeQuadCorner, rotateHandleAnchor, rotatePoly, splitLongSides, splitSide,
} from '../lib/geometry/quad'
import { confStroke, elMinConf, profileStops } from '../lib/confidence'
import { errorRates, percent } from '../lib/errorRate'
import { DECORATIVE, LINE_CLASS, isEditable } from '../lib/layoutClasses'
import { composedEdit, displayed, sameText } from '../lib/text'
import { useAuth } from '../auth'
import { useCommand } from '../commands'
import { comboLabel, eventCombo, useSettings } from '../settings'
import { beyondPlain, orderByGroups } from '../palette'
import { useAutoClear } from '../messages'

const HANDLES: [string, number, number][] = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5],
  ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
]

type Pt = [number, number]

// What an outline being reshaped belongs to: a text line, or a layout element in a
// dataset that draws its elements as outlines.
type Outlined = 'line' | 'element'

type Drag =
  | { mode: 'move'; id: number; from: Pt; origin: Bbox; bbox: Bbox }
  | { mode: 'resize'; id: number; corner: string; bbox: Bbox }
  | { mode: 'new'; from: Pt; bbox: Bbox }
  | { mode: 'lvertex'; of: Outlined; id: number; vi: number; origin: Ring; poly: Ring }
  | { mode: 'ledge'; of: Outlined; id: number; ei: number; from: Pt; origin: Ring; poly: Ring }
  | { mode: 'lmove'; of: Outlined; id: number; from: Pt; origin: Ring; poly: Ring }
  | { mode: 'lrotate'; of: Outlined; id: number; origin: Ring; center: Pt; from: number; poly: Ring }
  | { mode: 'lside'; from: Pt; to: Pt }
  | { mode: 'cut'; from: Pt; to: Pt }
  // Shift-drag over the page. A press that never moved is a shift-click on whatever is
  // under it, so both gestures start the same way and part at the end.
  | { mode: 'lasso'; from: Pt; to: Pt }

// A line being drawn with the Line pen: one side first (two clicks, or one drag), then
// a click for the height. It outlives a single drag, so it is not part of `Drag`.
interface LineDraft {
  a: Pt
  b: Pt | null
}

// Modifier keys are read live during a drag: Ctrl (or Cmd) switches a corner or edge drag
// between rigid and free, Shift snaps a turn. They are re-read on every pointer move and
// on the key itself, so pressing Ctrl halfway through a drag takes effect at once.
interface Modifiers {
  shift: boolean
  ctrl: boolean
}
const modifiersOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): Modifiers =>
  ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift'])

// A press that travels less than this (screen px) before release is a click.
const CLICK_SLOP_PX = 6
// How near the first corner counts as clicking it. Wider than the click slop above: this
// is aiming at a 10px marker, not telling a click from a drag.
const CLOSE_SLOP_PX = 12
// A freehand stroke records a point every so many screen px, and on release keeps only
// the ones that bend the line by more than the tolerance - so a slow straight sweep ends
// up as its two ends. The tile editor draws by the same numbers.
const FREEHAND_STEP_PX = 3
const FREEHAND_TOLERANCE_PX = 2
const BRUSH_KEY = 'deeplabel.viewer.brushRadius'
// What the brush has reached during one sweep, so the whole sweep persists at once and
// undoes in one step.
interface EraseStroke {
  touched: Set<number>
  after: Map<number, Ring>
  deletedIds: Set<number>
  spared: Set<number> // checked or corrected lines the brush passed over and left alone
  last: Pt
}

const TURN_STEP_DEG = 1
const TURN_SNAP_DEG = 5
// How far outside the top side the rotate handle sits, in screen px.
const ROTATE_HANDLE_PX = 24

type Stage = 'enter' | 'page' | 'element'
type SortMode = 'reading' | 'confidence'

// The share of the strip each splitter may give its pane.
const OCR_FRAC = { least: 0, most: 0.7 }
const READINGS_FRAC = { least: 0.1, most: 0.8 }
const clampOcrFrac = (f: number) => Math.min(OCR_FRAC.most, Math.max(OCR_FRAC.least, f))
const clampReadingsFrac = (f: number) => Math.min(READINGS_FRAC.most, Math.max(READINGS_FRAC.least, f))

// How close to the bottom edge a dragged keyboard's lower edge must come to dock again.
const KEYBOARD_SNAP_PX = 48

export function PageViewerPage() {
  const { user, isAdmin, canEdit, can } = useAuth()
  const canReread = canEdit && can('pipeline.ocr')
  const { hotkeys: hk, keyboard: vkbd, keyboardMode, keyboardSource, pageOverlays,
          save: saveSettings } = useSettings()
  const { id, pageId } = useParams<{ id: string; pageId: string }>()
  const jobId = id!
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const reviewParam = searchParams.get('review')
  const reviewMode = reviewParam !== null
  const maxConf = Number(reviewParam) || 0.85
  const [queue, setQueue] = useState<ReviewQueue | null>(null)
  const pendingLine = useRef<number | null>(null)
  const armedFor = useRef<string | null>(null)
  // Page whose first line should be focused as soon as its lines arrive. Holds the page
  // id rather than a flag, so a page with nothing on it cannot leave it armed for the next.
  const pendingFirstLine = useRef<number | null>(null)
  const [job, setJob] = useState<JobDetail | null>(null)
  // What the OCR model resizes a line to, for the loupe. Null until a run has recorded it.
  const [ocrModel, setOcrModel] = useState<RegistryModel | null>(null)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [candidates, setCandidates] = useState<LineCandidate[]>([])
  // Which of the active line's readings the arrows are on, if any.
  const [readingCursor, setReadingCursor] = useState<number | null>(null)

  const candidatesByLine = useMemo(() => {
    const byLine = new Map<number, LineCandidate[]>()
    for (const candidate of candidates) {
      if (candidate.line_id === null || candidate.dismissed) continue
      const held = byLine.get(candidate.line_id)
      if (held) held.push(candidate)
      else byLine.set(candidate.line_id, [candidate])
    }
    return byLine
  }, [candidates])
  // What every reader made of one line, anchored to the badge that opened it. Held in
  // state rather than looked up on render: the list scrolls, the panel does not.
  const [readings, setReadings] = useState<
    { rows: Reading[]; top: number; right: number; pinned?: boolean; removable?: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [stage, setStage] = useState<Stage>('enter')
  const [showLayout, setShowLayout] = useState(pageOverlays.layout)
  const [showLinePolys, setShowLinePolys] = useState(pageOverlays.lines)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [hoveredEl, setHoveredEl] = useState<number | null>(null)
  // Per-region visibility, unlike `hidden` which switches a whole class. Ids are
  // page-scoped, so this resets with the page rather than persisting.
  const [hiddenEls, setHiddenEls] = useState<Set<number>>(new Set())
  const [grouping, setGrouping] = useState<ObjectGrouping>('order')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const [activeLine, setActiveLine] = useState<number | null>(null)
  const [showLabels, setShowLabels] = useState(pageOverlays.labels)
  const [showConfidence, setShowConfidence] = useState(pageOverlays.confidence)
  const [showOrder, setShowOrder] = useState(pageOverlays.order)
  const [sortMode, setSortMode] = useState<SortMode>('reading')
  const [lineSort, setLineSort] = useState<'reading' | 'line' | 'min' | 'avg'>('reading')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  // The revision the current edit started from. A live reload may refresh the line
  // underneath the draft; the save still has to be judged against what was read.
  const [editBase, setEditBase] = useState(0)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [resolving, setResolving] = useState(false)
  // Manual rotations not yet persisted; kept frontend-side and saved when the line is checked.
  const [pendingOrient, setPendingOrient] = useState<Map<number, number>>(new Map())
  const [editing, setEditing] = useState(false)
  // Which of selectedId / activeLine the one editor is currently acting on.
  const [selKind, setSelKind] = useState<'element' | 'line'>('element')
  const [mergeSet, setMergeSet] = useState<Set<number>>(new Set())
  const mergeKind = useRef<'element' | 'line'>('element')
  // The scissors: armed with s, they cut the selection along a drawn stroke, or straight
  // across it at a click. `cutPos` is the hovering pointer, for the preview.
  const [cutArmed, setCutArmed] = useState(false)
  const [cutPos, setCutPos] = useState<Pt | null>(null)
  const [lineDraft, setLineDraft] = useState<LineDraft | null>(null)
  const [boxDraft, setBoxDraft] = useState<Pt | null>(null)
  const [linePenShape, setLinePen] = useState<LinePenShape>(getLinePenShape)
  // Not remembered across a reload, unlike the pen class: the editor opens in Select, where
  // a click picks what it lands on, because the pen draws wherever it is put down.
  const [tool, setTool] = useState<Tool>('select')
  // Space or Alt held over any tool is the hand: the pane pans and nothing draws or
  // selects. Held, not switched - `tool` itself never moves, so letting go always puts
  // the real tool back and a keyup that goes missing cannot strand the editor.
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const handTool = tool === 'hand' || spaceHeld || altHeld
  // The corners clicked so far, first one first. Closed by clicking that first corner again.
  const [polyDraft, setPolyDraft] = useState<Ring | null>(null)
  // How many corners were clicked before a freehand stroke began: those keep their dots
  // while the stroke itself is drawn as a line.
  const [strokeFrom, setStrokeFrom] = useState<number | null>(null)
  const [drawCursor, setDrawCursor] = useState<Pt | null>(null)
  const [brushRadius, setBrushRadius] = useState(() => clampBrush(Number(localStorage.getItem(BRUSH_KEY)) || 20))
  useEffect(() => {
    localStorage.setItem(BRUSH_KEY, String(brushRadius))
  }, [brushRadius])
  // Where the brush circle sits, in page coordinates. Null when the pointer is off the scan.
  const [brushAt, setBrushAt] = useState<Pt | null>(null)
  // What the last sweep did, in the footer's notice slot: the sentence beside it says
  // what the tool does, this says what it just did.
  const [erasedNotice, setErasedNotice] = useState<Notice | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => getHiddenClasses())
  const [ocrFrac, setOcrFracState] = useState(getOcrFrac)
  const [readingsFrac, setReadingsFracState] = useState(getReadingsFrac)
  const [kbSize, setKbSize] = useState(getKeyboardSize)
  const [kbPlace, setKbPlace] = useState(getKeyboardPlace)
  const [kbSnap, setKbSnap] = useState(false)
  const [loupeH, setLoupeH] = useState(getLoupeHeight)
  const lastFrac = useRef(0.5)
  const contentRef = useRef<HTMLDivElement>(null)
  const [runningJob, setRunningJob] = useState(false)
  const [readOpen, setReadOpen] = useState(false)
  // Progress of a language-model run while one is in flight, so triggering a read from
  // here shows something happening rather than nothing at all.
  const [reading, setReading] = useState<LlmReadStatus | null>(null)
  // The reading a drop or a click is about to give a line, and the line under the pointer
  // while one is being dragged. Held in a ref as well: a drop can land before React has
  // re-rendered the rows that a state-gated handler would live on, and then goes nowhere.
  const [armed, setArmed] = useState<LineCandidate | null>(null)
  const armedRef = useRef<LineCandidate | null>(null)
  const [dropLine, setDropLine] = useState<number | null>(null)
  const [dragView, setDragView] = useState<Drag | null>(null)
  const [penClass, setPen] = useState(getPenClass())
  // The pen says what Draw would draw, and nothing more: it is remembered between
  // visits, so every other tool has to behave the same whichever pen was left loaded.
  const drawingLines = tool === 'draw' && penClass === LINE_CLASS
  // Whether this dataset draws its layout elements as outlines rather than boxes.
  const outlines = job?.layout_shape === 'polygon'
  // A layout pen in a polygon dataset draws a box or, shaped so, an outline a corner a click.
  const [elementPenShape, setElementPenShape] = useState<LinePenShape>('box')
  const drawingOutlines = tool === 'draw' && penClass !== LINE_CLASS && outlines && elementPenShape === 'polygon'
  // What the pen in hand draws in, for its previews.
  const penColour = drawingLines ? LINE_CLASS : penClass
  const [layoutClasses, setLayoutClasses] = useState<string[]>([])
  // The dataset's container classes, which the pen panel lists apart from content.
  const [containerClasses, setContainerClasses] = useState<Set<string>>(new Set())
  const dragRef = useRef<Drag | null>(null)
  const clickCycle = useRef({ x: -1, y: -1, index: 0 })
  const overlayBox = useRef<HTMLDivElement>(null)
  const drag = usePointerDrag(overlayBox)
  const divider = useRef<HTMLDivElement>(null)
  const dividerDrag = usePointerDrag(divider)
  // The keyboard's handles capture the pointer themselves: a capture elsewhere would send
  // their double-clicks there.
  const kbHandle = useRef<HTMLSpanElement | null>(null)
  const kbMoveDrag = usePointerDrag(kbHandle)
  const kbGrip = useRef<HTMLSpanElement | null>(null)
  const kbResizeDrag = usePointerDrag(kbGrip)
  // The panel the readings and the lines share, measured when their divider is dragged.
  const listRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const plainPane = useRef<HTMLDivElement>(null)
  const overlayPane = useRef<HTMLDivElement>(null)
  // The scan the panes draw, as its pyramid: rebuilt only when the page or its way up
  // changes, because a new object here reopens the viewer.
  const scanId = page?.id
  const scanTurn = page?.rotation
  const scanW = page?.width
  const scanH = page?.height
  const scan = useMemo(
    () => (scanId && scanW && scanH
      ? { tiles: tilesUrl(scanId, scanTurn), width: scanW, height: scanH }
      : null),
    [scanId, scanTurn, scanW, scanH],
  )
  const { readoutRef, publish: publishZoom } = useZoomReadout()
  // How many screen pixels one pixel of the scan is drawn at, for the readout and the
  // geometry, and how far the view is from the fitted page, which is what the brush is
  // measured against: 1 with the page at the pane's width, whatever the scan's resolution.
  // Both kept in refs so that zooming re-renders nothing; the brush's one goes into state
  // only while the eraser is in hand, when the circle on the glass has to follow it.
  const scaleRef = useRef(1)
  const fitZoomRef = useRef(1)
  const [brushScale, setBrushScale] = useState(1)
  const onSize = useCallback((w: number, _h: number, zoom: number) => {
    if (!scanW) return
    scaleRef.current = w / scanW
    fitZoomRef.current = zoom
    publishZoom(scaleRef.current)
    if (tool === 'erase') setBrushScale(zoom)
  }, [scanW, publishZoom, tool])
  useEffect(() => {
    if (tool === 'erase') setBrushScale(fitZoomRef.current)
  }, [tool])
  const brushPx = brushOnGlass(brushRadius, brushScale)
  // Shift+wheel over the scan sizes the eraser's brush, so the hand never has to leave the
  // page for the slider. With any other tool in hand the turn stays the surface's.
  const onShiftWheel = (notch: 1 | -1) => {
    if (tool !== 'erase' || handTool) return false
    setBrushRadius((px) => stepBrush(px, notch))
    return true
  }
  const { setZoom, setScale, setRotation, centerOn, toPage, screenDistance: pageDistance, register,
          onPanStart, onPanMove, onPanEnd } =
    useImageSurface(scan, { min: 0.25, max: 8, grab: handTool, rotate: true, onSize, onShiftWheel })
  // Back to the scan at the pane's width, the right way up: the way out of a turn nobody
  // meant to make, and of a zoom they are done with.
  const resetView = useCallback(() => {
    setZoom(1)
    setRotation(0)
  }, [setZoom, setRotation])
  // Double-click is a drawing and selecting gesture while editing - it finishes a polygon,
  // and two clicks in a row are two steps through what is under the cursor. Resetting the
  // view on top of that fights the editor, and a click that misses the scan by a few
  // pixels lands on the pane and refits the page under the hand. The 1x button and the
  // zoom cluster are how the view is reset; they are always there.
  const resetOnDoubleClick = editing ? undefined : resetView
  const plainRefs = register('plain')
  const overlayRefs = register('overlay')
  // The annotated pane's box is both what the surface holds over the scan and what every
  // overlay coordinate is measured against, so the two refs land through one callback.
  const overlayBoxRef = useCallback(
    (el: HTMLDivElement | null) => {
      overlayBox.current = el
      overlayRefs.box(el)
    },
    [overlayRefs],
  )

  useEffect(() => {
    getJob(jobId).then(setJob).catch((e: Error) => setError(e.message))
    listModels()
      .then(({ models }) =>
        setOcrModel(models.find((m) => m.task === 'ocr' && m.is_default) ?? null))
      .catch(() => undefined)
  }, [jobId])

  // A page that answers after the viewer has turned to another is not shown over it.
  const routePageId = useRef(pageId)
  routePageId.current = pageId
  const showPage = useCallback((p: PageDetail) => {
    if (String(p.id) === routePageId.current) setPage(p)
  }, [])

  useEffect(() => {
    setPage(null)
    setCandidates([])
    setSelectedId(null)
    setHoveredEl(null)
    setHiddenEls(new Set())
    setHoveredLine(null)
    setActiveLine(null)
    setEditingId(null)
    let live = true
    getPage(jobId, pageId!).then(showPage).catch((e: Error) => { if (live) setError(e.message) })
    // Every reading this page has ever had, so a line can be chosen from rather than typed.
    getPageCandidates(Number(pageId))
      .then((res) => { if (live) setCandidates(res.candidates) })
      .catch(() => undefined)
    return () => { live = false }
  }, [jobId, pageId, showPage])

  useEffect(() => {
    const t = setTimeout(() => setStage((s) => (s === 'enter' ? 'page' : s)), 50)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!reviewMode) return
    setShowLinePolys(true)
    getReviewQueue(jobId, maxConf).then(setQueue).catch((e: Error) => setError(e.message))
  }, [reviewMode, jobId, maxConf])

  const orderedPages = useMemo(
    () => (job ? job.pages.filter((p) => !p.deleted && !isUncounted(p)).sort((a, b) => a.idx - b.idx) : []),
    [job],
  )
  const elements = useMemo(
    () =>
      page
        ? page.elements
            .filter((e) => e.kind === 'content' && !DECORATIVE.has(e.class_name))
            .sort((a, b) => a.order_idx - b.order_idx)
        : [],
    [page],
  )
  const containers = useMemo(
    () =>
      page
        ? page.elements.filter((e) => e.kind === 'container' || DECORATIVE.has(e.class_name))
        : [],
    [page],
  )
  const pageLines = useMemo(() => {
    if (!page) return []
    // Layout reading order, not geometric: Page.traverse() ordered the elements
    // column by column, so a naive top-to-bottom sort would read across the
    // Schematismus' columns instead of down each one. Lines outside every box sit in
    // orphan buckets the server places between the boxes they stand between.
    return [...page.elements]
      .filter((e) => e.kind !== 'container')
      .sort((a, b) => a.order_idx - b.order_idx)
      .flatMap((e) => [...e.lines].sort((a, b) => a.order_idx - b.order_idx))
  }, [page])
  // How far the OCR fell from what people settled on, over the lines they have checked
  // off - the same set a training snapshot is cut from, so the page says what it is about
  // to contribute. Recomputed from the lines in hand, so a correction moves it at once.
  const accuracy = useMemo(
    () => errorRates(pageLines
      .filter((l) => l.checked && l.check_source !== 'llm' && l.text !== null)
      .map((l) => ({ reference: l.corrected_text ?? l.text ?? '', hypothesis: l.text ?? '' }))),
    [pageLines],
  )
  // In edit mode every non-orphan element is selectable, minus any class the user
  // has hidden. Outside edit mode it stays the read-only content set.
  const selectable = useMemo(
    () =>
      editing
        ? (page?.elements.filter(
            (e) => isEditable(e) && !hidden.has(e.class_name) && !hiddenEls.has(e.id)) ?? [])
        : elements,
    [editing, page, elements, hidden, hiddenEls],
  )
  // Everything the region list shows: hidden entries stay listed (dimmed), which
  // is the only way back from having hidden them.
  const regionElements = useMemo(
    () => (page?.elements.filter(isEditable) ?? []).sort((a, b) => a.order_idx - b.order_idx),
    [page],
  )
  // Numbered by place among the boxes, so the unassigned runs read between them leave no gaps.
  const boxNumber = useMemo(
    () => new Map(regionElements.filter((e) => e.kind === 'content').map((e, i) => [e.id, i + 1])),
    [regionElements],
  )
  const unassignedLines = useMemo(
    () => (page?.elements ?? []).filter((e) => e.kind === 'orphan').reduce((n, e) => n + e.lines.length, 0),
    [page],
  )
  const visibleLines = useMemo(() => {
    if (hidden.has(LINE_CLASS)) return []
    if (hiddenEls.size === 0) return pageLines
    const hiddenLineIds = new Set(
      (page?.elements ?? []).filter((e) => hiddenEls.has(e.id)).flatMap((e) => e.lines.map((l) => l.id)))
    return pageLines.filter((l) => !hiddenLineIds.has(l.id))
  }, [hidden, hiddenEls, page, pageLines])
  // The brush takes exactly what is drawn: a line on the scan can be swept whatever its
  // region's class, and one the eye has taken off cannot.
  const drawnLineIds = useMemo(() => new Set(visibleLines.map((l) => l.id)), [visibleLines])
  // Derived, never stored: a parallel snapshot drifts from `page` the moment
  // geometry is edited, leaving the class label behind the moved rect.
  const selected = useMemo(
    () => (selectedId === null ? null : (selectable.find((e) => e.id === selectedId) ?? null)),
    [selectable, selectedId],
  )
  const selectedLines = useMemo(
    () => (selected ? [...selected.lines].sort((a, b) => a.order_idx - b.order_idx) : []),
    [selected],
  )
  const lineParent = useMemo(() => {
    const m = new Map<number, PageElement>()
    page?.elements.forEach((e) => e.lines.forEach((l) => m.set(l.id, e)))
    return m
  }, [page])
  const reviewLines = useMemo(() => {
    if (!queue || !page) return []
    const byId = new Map<number, Line>()
    page.elements.forEach((e) => e.lines.forEach((l) => byId.set(l.id, l)))
    return queue.lines
      .filter((q) => q.page_id === page.id)
      .map((q) => byId.get(q.id))
      .filter((l): l is Line => l !== undefined)
  }, [queue, page])
  const queuePosition = queue ? queue.lines.findIndex((l) => l.id === activeLine) : -1
  // The line whose text is open in the editor wins over the mouse: otherwise drifting
  // the cursor across the scan swaps the loupe out from under what is being typed.
  const focusLine = useMemo(() => {
    const id = editingId ?? hoveredLine ?? activeLine
    return id === null ? null : (pageLines.find((l) => l.id === id) ?? null)
  }, [editingId, hoveredLine, activeLine, pageLines])
  const listLines = useMemo(
    () =>
      sortMode === 'confidence'
        ? [...selectedLines].sort(
            (a, b) => (a.confidence ?? Number.POSITIVE_INFINITY) - (b.confidence ?? Number.POSITIVE_INFINITY),
          )
        : selectedLines,
    [selectedLines, sortMode],
  )
  // Per-entry confidence aggregates, for sorting the flat list by how shaky an entry is.
  const elemAgg = useMemo(() => {
    const m = new Map<number, { min: number; avg: number }>()
    page?.elements.forEach((e) => {
      const vals = e.lines.map((l) => l.confidence).filter((c): c is number => c !== null)
      m.set(e.id, {
        min: vals.length ? Math.min(...vals) : Number.POSITIVE_INFINITY,
        avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : Number.POSITIVE_INFINITY,
      })
    })
    return m
  }, [page])
  const sortedPageLines = useMemo(() => {
    if (lineSort === 'reading') return pageLines
    if (lineSort === 'line')
      return [...pageLines].sort(
        (a, b) => (a.confidence ?? Number.POSITIVE_INFINITY) - (b.confidence ?? Number.POSITIVE_INFINITY),
      )
    // Group by entry, worst/average first; a stable sort keeps each entry's lines in reading order.
    const agg = (l: Line) => elemAgg.get(lineParent.get(l.id)?.id ?? -1)?.[lineSort] ?? Number.POSITIVE_INFINITY
    return [...pageLines].sort((a, b) => agg(a) - agg(b))
  }, [pageLines, lineSort, elemAgg, lineParent])
  const selectedNo = selected ? elements.findIndex((e) => e.id === selected.id) + 1 : 0

  // While any line is awaiting its batched re-OCR, poll so the fresh read + cleared
  // spinner appear without a manual refresh.
  const anyReprocessing = useMemo(() => pageLines.some((l) => l.needs_ocr), [pageLines])
  useEffect(() => {
    if (!anyReprocessing) return
    const t = setInterval(() => {
      getPage(jobId, pageId!).then(showPage).catch(() => undefined)
    }, 4000)
    return () => clearInterval(t)
  }, [anyReprocessing, jobId, pageId, showPage])

  const showLines = stage !== 'element' && showLinePolys
  // The OCR list is shown in every loaded view now, so line nav and the loupe apply throughout.
  const canLineNav = stage !== 'enter'
  const inElement = stage === 'element'
  const orderCenters = useMemo<[number, number][]>(() => {
    if (showLines) return pageLines.map((l) => polyCenter(l.polygon))
    if (inElement) return selectedLines.map((l) => polyCenter(l.polygon))
    return elements.map((el) => [(el.bbox[0] + el.bbox[2]) / 2, (el.bbox[1] + el.bbox[3]) / 2])
  }, [showLines, inElement, pageLines, selectedLines, elements])
  // The marked-up scan and the OCR list are the two visible panes in every view; the
  // strip no longer slides when toggling Layout/Lines - only the overlay on the scan
  // changes. (The clean-scan pane stays mounted off-screen for the load-in fade.)
  const stripTransform = 'translateX(-33.3333%)'

  const backToPage = () => {
    setStage('page')
    setHoveredLine(null)
    setActiveLine(null)
    setEditingId(null)
  }

  // An element nobody has selected has nothing to list, however the selection went -
  // deleted, undone, or let go of - so the readings are the page's again.
  useEffect(() => {
    if (stage === 'element' && selectedId === null) setStage('page')
  }, [stage, selectedId])

  // Turning the line overlay on inside an element steps back out, so it is visible.
  const toggleLinePolys = () => {
    if (!showLinePolys && stage === 'element') backToPage()
    setShowLinePolys((v) => !v)
  }

  const setCrumbs = useSetCrumbs()
  const backRef = useRef(backToPage)
  backRef.current = backToPage
  const jobName = job?.name
  const pageNo = page ? page.idx + 1 : null
  const inElementCrumb = stage === 'element' && selectedNo > 0
  useEffect(() => {
    const crumbs: Crumb[] = [{ label: jobName ?? 'Dataset', to: `/jobs/${jobId}` }]
    if (pageNo && inElementCrumb) {
      crumbs.push({ label: `Page ${pageNo}`, onClick: () => backRef.current() })
      crumbs.push({ label: `Element ${selectedNo}` })
    } else if (pageNo) {
      crumbs.push({ label: `Page ${pageNo}` })
    }
    setCrumbs(crumbs)
    return () => setCrumbs([])
  }, [setCrumbs, jobName, jobId, pageNo, inElementCrumb, selectedNo])

  const { onPage, onTarget } = usePresence()
  usePresenceLocation(page
    ? { job_id: jobId, page_id: page.id, editing: editing || editingId !== null,
        target: activeLine !== null ? { kind: 'line', id: activeLine } : null }
    : { job_id: jobId })

  const selectElement = (el: PageElement) => {
    setSelectedId(el.id)
    setHoveredLine(null)
    setActiveLine(null)
    setEditingId(null)
    setStage('element')
  }

  const applyLine = (updated: Line) => {
    const patch = (el: PageElement): PageElement =>
      el.lines.some((l) => l.id === updated.id)
        ? { ...el, lines: el.lines.map((l) => (l.id === updated.id ? updated : l)) }
        : el
    setPage((p) => (p ? { ...p, elements: p.elements.map(patch) } : p))
  }

  const applyElement = (updated: PageElement) =>
    setPage((p) => (p ? { ...p, elements: p.elements.map((e) => (e.id === updated.id ? updated : e)) } : p))

  // Manual rotate spins instantly (CSS over the aligned base crop) and triggers no
  // re-OCR, but the turn itself is written straight away: it decides what the model
  // reads and what the training crop looks like, and leaving it in the browser until
  // the line happened to be checked lost it on every page turn.
  const lineOrient = (line: Line) => pendingOrient.get(line.id) ?? line.orientation

  const forgetPending = (lineId: number) =>
    setPendingOrient((m) => {
      const next = new Map(m)
      next.delete(lineId)
      return next
    })

  const rotateLine = async (line: Line | null, dir: 1 | -1 = 1) => {
    if (!line || !canEdit) return
    const turned = ((((lineOrient(line) || 0) + dir * 90) % 360) + 360) % 360
    setPendingOrient((m) => new Map(m).set(line.id, turned))
    try {
      const saved = await patchLineOrientation(line.id, turned)
      applyLine(saved)
      recordEdit(saved.span)
    } catch (e) {
      setError((e as Error).message)
    }
    forgetPending(line.id)
  }

  const reocrOneLine = async (line: Line) => {
    const pend = pendingOrient.get(line.id)
    try {
      // Bake a pending manual rotation into the DB first, so the model re-reads the
      // rotated crop - orientation otherwise only persists when the line is checked.
      if (pend !== undefined && pend !== line.orientation) await patchLineOrientation(line.id, pend)
      applyLine(await reocrLine(line.id))
      if (pend !== undefined) {
        setPendingOrient((m) => {
          const next = new Map(m)
          next.delete(line.id)
          return next
        })
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const toggleLineChecked = async (line: Line, checked: boolean) => {
    const pend = pendingOrient.get(line.id)
    const orientation = checked && pend !== undefined ? pend : undefined // persist rotation on check
    applyLine({ ...line, checked, ...(orientation !== undefined ? { orientation } : {}) })
    try {
      applyLine(await setLineChecked(line.id, checked, orientation))
      if (pend !== undefined) {
        setPendingOrient((m) => {
          const next = new Map(m)
          next.delete(line.id)
          return next
        })
      }
    } catch (e) {
      applyLine(line)
      setError((e as Error).message)
    }
  }

  const toggleElementChecked = async (el: PageElement, checked: boolean) => {
    const mark = (t: PageElement): PageElement =>
      t.id === el.id ? { ...t, checked, lines: t.lines.map((l) => ({ ...l, checked })) } : t
    setPage((p) => (p ? { ...p, elements: p.elements.map(mark) } : p))
    try {
      applyElement(await setElementChecked(el.id, checked))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    if (!id) return
    getJobLayoutClasses(id).then(({ classes }) => {
      setLayoutClasses(classes.map((c) => c.name))
      setContainerClasses(new Set(classes.filter((c) => c.role === 'container').map((c) => c.name)))
      // A box is drawn under its stored name and a pen under the class's, which differ for
      // a few Schematismus classes (PageNumber is stored as Pagenumber): colour both.
      setClassColors(Object.fromEntries(classes.flatMap((c) => (c.color ? [[c.name, c.color], [c.stored_as, c.color]] : []))))
    }).catch(() => undefined)
    return () => setClassColors({})
  }, [id])

  // What a revert hands back replaces the elements it reached wholesale; a line that went
  // drops out of its element's list, one that came back rides in with it.
  const applyRevert = (result: RevertResult) => {
    const removed = new Set(result.removed_elements)
    const byId = new Map(result.elements.map((e) => [e.id, e]))
    setPage((p) => {
      if (!p) return p
      const kept = p.elements.filter((e) => !removed.has(e.id)).map((e) => byId.get(e.id) ?? e)
      const present = new Set(kept.map((e) => e.id))
      return {
        ...p,
        reading_order: result.reading_order,
        elements: [...kept, ...result.elements.filter((e) => !present.has(e.id))],
      }
    })
    const touchedLines = new Set(result.elements.flatMap((e) => e.lines.map((l) => l.id)))
    const wasIn = (lineId: number) =>
      page?.elements.some((e) => (byId.has(e.id) || removed.has(e.id)) && e.lines.some((l) => l.id === lineId))
    setActiveLine((cur) => (cur !== null && wasIn(cur) && !touchedLines.has(cur) ? null : cur))
    setSelectedId((cur) => (cur !== null && removed.has(cur) ? null : cur))
  }
  const { record: recordEdit, undo, redo, canUndo, canRedo } = useEditHistory(page?.id, applyRevert, setError)

  const fail = (e: unknown) => setError((e as Error).message)

  // A colleague's change since the page loaded is not saved over: it is shown instead.
  const guardedSave = useGuardedSave((message) => {
    setError(message)
    void reloadPage()
  })

  // Server-authoritative like saveEdit: validation, order_idx and new ids all
  // live server-side, and during a drag the UI already renders from local state.
  const commitBbox = async (id: number, bbox: Bbox) => {
    const loaded = page?.elements.find((e) => e.id === id)
    if (!loaded) return
    try {
      const el = await guardedSave('box', loaded, (revision) => patchElement(id, { bbox, revision }))
      applyElement(el)
      recordEdit(el.span)
      // A box moved can move the reading order of the boxes around it.
      await reloadPage()
    } catch (e) {
      fail(e)
    }
  }

  const commitElementPoly = async (id: number, polygon: Ring) => {
    const loaded = page?.elements.find((e) => e.id === id)
    if (!loaded) return
    try {
      const el = await guardedSave('box', loaded, (revision) => patchElement(id, { polygon, revision }))
      applyElement(el)
      recordEdit(el.span)
      await reloadPage()
    } catch (e) {
      fail(e)
    }
  }

  const commitClass = async (el: PageElement, className: string) => {
    try {
      const updated = await guardedSave('box', el,
        (revision) => patchElement(el.id, { class_name: className, revision }))
      applyElement(updated)
      recordEdit(updated.span)
      await reloadPage()
    } catch (e) {
      fail(e)
    }
  }

  const commitDelete = async (id: number) => {
    try {
      const gone = await deleteElement(id)
      setPage((p) => (p ? { ...p, elements: p.elements.filter((e) => e.id !== id) } : p))
      setSelectedId((cur) => (cur === id ? null : cur))
      recordEdit(gone.span)
      await reloadPage()
    } catch (e) {
      fail(e)
    }
  }

  const commitCreate = async (bbox: Bbox) => {
    if (!page || tool !== 'draw') return
    try {
      const el = await createElement(page.id, penClass, { bbox })
      setPage((p) => (p ? { ...p, elements: [...p.elements, el] } : p))
      recordEdit(el.span)
      setSelKind('element')
      setActiveLine(null)
      setSelectedId(el.id)
      await reloadPage()
    } catch (e) {
      fail(e)
    }
  }

  // Re-fetch keeps selection: selectedId/activeLine are ids, so `selected`/`selectedLine`
  // recompute against the new page automatically.
  const reloadPage = useCallback(
    () => getPage(jobId, pageId!).then(showPage).catch((e: Error) => setError(e.message)),
    [jobId, pageId, showPage])

  // Turning is done to the scan rather than to the view of it, so everything on the page
  // moved and the whole page is read again.
  const turnScan = async (degrees: number) => {
    if (!page) return
    try {
      await turnPage(page.id, degrees)
      await reloadPage()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  usePageLiveFeed(page?.id, page?.job_revision ?? 0, reloadPage)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // A runner job (re-detect) runs asynchronously; poll until it settles, then refresh
  // the page in place rather than making the user reload.
  const waitForJobThenReload = async () => {
    setRunningJob(true)
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        if (!mounted.current) return
        const j = await getJob(jobId)
        if (j.status === 'queued' || j.status === 'running') continue
        // A phase that died in the runner leaves the page as it found it - emptied, for
        // layout - so saying nothing reads as the run never having happened.
        if (j.status === 'error') setError(j.error ?? 'the run failed')
        break
      }
      await reloadPage()
    } catch (e) {
      fail(e)
    } finally {
      setRunningJob(false)
    }
  }

  const findLine = (id: number) => page?.elements.flatMap((e) => e.lines).find((l) => l.id === id)

  const setLinePolygonLocal = (id: number, polygon: Ring) =>
    setPage((p) =>
      p
        ? { ...p, elements: p.elements.map((el) => ({
            ...el, lines: el.lines.map((l) => (l.id === id ? { ...l, polygon } : l)) })) }
        : p,
    )

  // Reshape/move keeps the existing OCR read and correction - a box tweak is usually
  // over the same characters; the element bbox is unchanged so re-detection is not triggered.
  // The new polygon is shown at once, so a second edit that lands before the reply (two
  // quick key presses) builds on this one instead of on the polygon it replaced.
  const commitLinePoly = async (id: number, poly: Ring, prev?: Ring) => {
    const loaded = findLine(id)
    if (!loaded) return
    setLinePolygonLocal(id, poly)
    try {
      const unassigned = page?.elements.some((e) => e.kind === 'orphan' && e.lines.some((l) => l.id === id))
      const line = await guardedSave('line', loaded, (revision) => patchLinePolygon(id, poly, revision))
      // Moving a line outside every box can move it between the boxes, and its neighbours with it.
      if (unassigned) await reloadPage()
      else applyLine(line)
      recordEdit(line.span)
    } catch (e) {
      if (prev) setLinePolygonLocal(id, prev)
      fail(e)
    }
  }

  // The polygon pen's ring becomes whatever the pen draws: a line, or with a layout class
  // loaded in a polygon dataset, an element of that class.
  const commitRing = (ring: Ring) => (drawingLines ? commitLineCreate(ring) : commitOutlineCreate(ring))

  const commitOutlineCreate = async (polygon: Ring) => {
    if (!page || tool !== 'draw') return
    try {
      const el = await createElement(page.id, penClass, { polygon })
      setPage((p) => (p ? { ...p, elements: [...p.elements, el] } : p))
      recordEdit(el.span)
      setSelKind('element')
      setActiveLine(null)
      setSelectedId(el.id)
      await reloadPage()
    } catch (e) {
      fail(e)
    }
  }

  const commitLineCreate = async (poly: Ring) => {
    if (!page) return
    try {
      const ln = await createLine(page.id, poly)
      // Parent/order_idx are assigned server-side, so reload rather than guess.
      await reloadPage()
      recordEdit(ln.span)
      setSelKind('line')
      setActiveLine(ln.id)
    } catch (e) {
      fail(e)
    }
  }

  // A gathered set, deleted together: one reload at the end rather than one per item,
  // one step back for the lot, and the set is cleared so nothing stays selected that no
  // longer exists.
  const commitSetDelete = async (kind: 'element' | 'line', ids: number[]) => {
    const remove = (id: number) => {
      if (kind === 'element') return deleteElement(id)
      const loaded = findLine(id)
      if (!loaded) return null
      return guardedSave('line', loaded, (revision) => deleteLine(id, revision))
    }
    try {
      const spans: EditSpan[] = []
      for (const id of ids) {
        const gone = await remove(id)
        if (gone) spans.push(gone.span)
      }
      await reloadPage()
      if (spans.length) recordEdit(spanOf(...spans))
      setMergeSet(new Set())
      if (kind === 'line') setActiveLine((cur) => (cur !== null && ids.includes(cur) ? null : cur))
      else setSelectedId((cur) => (cur !== null && ids.includes(cur) ? null : cur))
    } catch (e) {
      fail(e)
    }
  }

  const commitLineDelete = async (id: number) => {
    const loaded = findLine(id)
    if (!loaded) return
    try {
      const gone = await guardedSave('line', loaded, (revision) => deleteLine(id, revision))
      await reloadPage()
      recordEdit(gone.span)
      setActiveLine((cur) => (cur === id ? null : cur))
    } catch (e) {
      fail(e)
    }
  }

  // A line is cut along the stroke itself, tilted or not. A layout box stays axis-aligned,
  // so the stroke's direction picks the axis and its middle the place.
  const commitCut = async (from: Pt, to: Pt) => {
    try {
      let cut: { span: EditSpan } | null = null
      if (selKind === 'line' && activeLine !== null) cut = await splitLine(activeLine, { cut_line: [from, to] })
      else if (selKind === 'element' && selectedId !== null) {
        const upright = Math.abs(to[1] - from[1]) >= Math.abs((to[0] - from[0]) * aspect)
        const mid: Pt = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
        cut = await splitElement(selectedId, upright ? { cut_x: mid[0] } : { cut_y: mid[1] })
      }
      await reloadPage()
      if (cut) recordEdit(cut.span)
    } catch (e) {
      fail(e)
    }
  }

  // The cut a click makes: straight across a line at that spot, down through a box.
  const cutAcross = (at: Pt): [Pt, Pt] =>
    selKind === 'line' && selectedLine ? acrossQuad(selectedLine.polygon, at, aspect) : [[at[0], 0], [at[0], 1]]

  const commitMerge = async (kind: 'element' | 'line', ids: number[]) => {
    if (ids.length < 2) return
    try {
      let merged: { span: EditSpan }
      if (kind === 'line') {
        const line = await mergeLines(ids)
        merged = line
        setSelKind('line')
        setActiveLine(line.id)
      } else {
        const el = await mergeElements(ids)
        merged = el
        setSelKind('element')
        setSelectedId(el.id)
      }
      setMergeSet(new Set())
      await reloadPage()
      recordEdit(merged.span)
    } catch (e) {
      fail(e)
    }
  }

  const toggleLayoutChecked = async () => {
    if (!page) return
    const next = !page.layout_checked
    try {
      await setPageLayoutChecked(page.id, next)
      setPage((p) => (p ? { ...p, layout_checked: next } : p))
      setJob((j) =>
        j ? { ...j, pages: j.pages.map((x) => (x.id === page.id ? { ...x, layout_checked: next } : x)) } : j,
      )
    } catch (e) {
      fail(e)
    }
  }

  const toggleTestPage = async () => {
    if (!page) return
    const next = !page.is_test
    try {
      await markTestPages(jobId, [page.id], next)
      setPage((p) => (p ? { ...p, is_test: next } : p))
    } catch (e) {
      fail(e)
    }
  }

  const toggleLinesChecked = async () => {
    if (!page) return
    const next = !page.lines_checked
    try {
      await setPageLinesChecked(page.id, next)
      setPage((p) => (p ? { ...p, lines_checked: next } : p))
    } catch (e) {
      fail(e)
    }
  }

  // A class loads the pen for the next stroke and nothing else - the selected box is
  // reclassed from its own control. Null is the Select tool.
  const pickClass = (className: string | null) => {
    if (className === null) {
      setTool('select')
      return
    }
    setTool('draw')
    setPen(className)
    setPenClass(className)
  }

  // Choosing a shape is also choosing the Line pen: it is the only thing the shape is for.
  const pickLinePen = (shape: LinePenShape) => {
    setLinePen(shape)
    setLinePenShape(shape)
    if (penClass !== LINE_CLASS || tool !== 'draw') pickClass(LINE_CLASS)
  }

  const toggleHidden = (name: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      setHiddenClasses(next)
      return next
    })
  }

  const toggleHiddenElement = (id: number) => {
    setHiddenEls((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Picking a region in the list selects it on the scan and scrolls it into view,
  // which is the whole point of the list on a page taller than the viewport.
  const selectRegion = (id: number) => {
    const el = regionElements.find((e) => e.id === id)
    if (!el) return
    if (hiddenEls.has(id)) toggleHiddenElement(id)
    setSelKind('element')
    setSelectedId(id)
    centerOn((el.bbox[0] + el.bbox[2]) / 2, (el.bbox[1] + el.bbox[3]) / 2)
  }

  useEffect(() => setOcrFrac(ocrFrac), [ocrFrac])
  useEffect(() => setReadingsFrac(readingsFrac), [readingsFrac])
  useEffect(() => setKeyboardSize(kbSize), [kbSize])
  useEffect(() => setKeyboardPlace(kbPlace), [kbPlace])
  useEffect(() => setLoupeHeight(loupeH), [loupeH])

  useEffect(() => {
    setLineDraft(null)
    setBoxDraft(null)
    setPolyDraft(null)
    setDrawCursor(null)
  }, [penClass, linePenShape, editing, pageId])

  // What the last sweep did is worth reading right after it, not once the tool has moved on.
  useEffect(() => setErasedNotice(null), [tool, pageId])

  // Drag the divider between the scan and the OCR panel; a fraction of the visible
  // width, so it stays put under zoom and the pane widths follow.
  const beginDivider = (e: React.PointerEvent) => {
    e.preventDefault()
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect) return
    dividerDrag.begin(e, {
      onMove: (ev) => setOcrFracState(clampOcrFrac(1 - (ev.clientX - rect.left) / rect.width)),
      onEnd: () => undefined,
    })
  }

  // Drag the divider between the readings that matched nothing and the lines. A fraction
  // of the panel's height, so both keep their share as the window changes.
  const beginReadingsDivider = (e: React.PointerEvent) => {
    e.preventDefault()
    const rect = listRef.current?.getBoundingClientRect()
    if (!rect) return
    dividerDrag.begin(e, {
      onMove: (ev) =>
        setReadingsFracState(clampReadingsFrac((ev.clientY - rect.top) / rect.height)),
      onEnd: () => undefined,
    })
  }

  // Drag the bar under the loupe. It sits below the crop, so pulling it down is the crop
  // growing - the same direction the pointer moves.
  const beginLoupeResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const from = { y: e.clientY, height: loupeH }
    dividerDrag.begin(e, {
      onMove: (ev) => setLoupeH(clampLoupeHeight(from.height + (ev.clientY - from.y))),
      onEnd: () => undefined,
    })
  }

  // Drag the keyboard's corner. Sideways is how much of the window it spans - it is
  // centred, so an edge moving out widens it from both sides at once - and up or down is
  // the size of the keys, which is what shortens it once it already spans the width.
  const beginKeyboardResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const from = { x: e.clientX, y: e.clientY, ...kbSize }
    kbResizeDrag.begin(e, {
      onMove: (ev) => setKbSize(clampKeyboardSize({
        span: from.span + ((from.x - ev.clientX) * 2) / (kbRef.current?.parentElement?.clientWidth ?? window.innerWidth),
        key: from.key + (from.y - ev.clientY) / 5,
      })),
      onEnd: () => undefined,
    })
  }

  // Drag the keyboard by its handle. It is placed by its centre, so resizing it afterwards
  // still grows it from both sides. Let go near the bottom edge, it docks above the footer
  // again - as the Dock button and a double-click on the handle do.
  const beginKeyboardMove = (e: React.PointerEvent) => {
    e.preventDefault()
    const board = kbRef.current?.getBoundingClientRect()
    const area = kbRef.current?.parentElement?.getBoundingClientRect()
    if (!board || !area) return
    const from = {
      x: e.clientX, y: e.clientY,
      cx: board.left + board.width / 2 - area.left, cy: board.top + board.height / 2 - area.top,
    }
    const fraction = (v: number, of: number) => Math.min(1, Math.max(0, v / of))
    let snap = false
    kbMoveDrag.begin(e, {
      onMove: (ev) => {
        const cy = from.cy + ev.clientY - from.y
        snap = area.height - (cy + board.height / 2) < KEYBOARD_SNAP_PX
        setKbSnap(snap)
        setKbPlace({ x: fraction(from.cx + ev.clientX - from.x, area.width), y: fraction(cy, area.height) })
      },
      onEnd: () => {
        setKbSnap(false)
        if (snap) setKbPlace(null)
      },
    })
  }

  // Collapse the OCR panel for a near-full-width scan, or restore the last split.
  const toggleEnlarge = () =>
    setOcrFracState((f) => {
      if (f > 0.03) {
        lastFrac.current = f
        return 0
      }
      return lastFrac.current || 0.5
    })

  // Recomputed every move, never cached: plain-wheel scroll, scrollIntoView and
  // the rendition swap at zoom > 1 all move the box mid-drag.
  // Asked of the surface rather than measured off the overlay's box: once the view is
  // turned, the rectangle around the box is not the box, and every click would land
  // somewhere else on the page.
  const toNorm = (e: { clientX: number; clientY: number }): Pt | null => {
    const at = toPage(e.clientX, e.clientY)
    return at ? [clamp01(at[0]), clamp01(at[1])] : null
  }

  const screenDistance = (p: Pt, q: Pt) => pageDistance(p, q)

  // Rigid line edits need true angles, which normalized page coordinates do not have.
  const aspect = page ? page.width / page.height : 1

  const nextDrag = (d: Drag, [x, y]: Pt, mods: Modifiers): Drag => {
    if (d.mode === 'move') return { ...d, bbox: moveBbox(d.origin, x - d.from[0], y - d.from[1]) }
    if (d.mode === 'resize') return { ...d, bbox: resizeBbox(d.bbox, d.corner, x, y) }
    if (d.mode === 'lvertex') {
      const rigid = !mods.ctrl && d.origin.length === 4
      const poly: Ring = rigid
        ? resizeQuadCorner(d.origin, d.vi, [x, y], aspect)
        : d.origin.map((p, i): Pt => (i === d.vi ? [x, y] : p))
      return { ...d, poly }
    }
    if (d.mode === 'ledge') {
      const poly = mods.ctrl
        ? moveEdgeFree(d.origin, d.ei, x - d.from[0], y - d.from[1])
        : moveEdge(d.origin, d.ei, x - d.from[0], y - d.from[1], aspect)
      return { ...d, poly }
    }
    if (d.mode === 'lmove') return { ...d, poly: movePoly(d.origin, x - d.from[0], y - d.from[1]) }
    if (d.mode === 'lrotate') {
      let turn = angleAround(d.center, [x, y], aspect) - d.from
      if (mods.shift) {
        // Snap the line's resulting angle, not the turn: Shift is how a slanted line is
        // levelled to exactly zero.
        const base = quadAngle(d.origin, aspect)
        turn = Math.round((base + turn) / TURN_SNAP_DEG) * TURN_SNAP_DEG - base
      }
      return { ...d, poly: rotatePoly(d.origin, d.center, turn, aspect) }
    }
    if (d.mode === 'lside' || d.mode === 'cut' || d.mode === 'lasso') return { ...d, to: [x, y] }
    return { ...d, bbox: orderBbox(d.from[0], d.from[1], x, y) }
  }

  const beginDrag = (e: React.PointerEvent, init: Drag) => {
    dragRef.current = init
    setDragView(init)
    let last: Pt | null = null
    const apply = (pt: Pt, mods: Modifiers) => {
      if (!dragRef.current) return
      const next = nextDrag(dragRef.current, pt, mods)
      dragRef.current = next
      setDragView(next)
    }
    const onModifierKey = (ev: KeyboardEvent) => {
      if (last && MODIFIER_KEYS.has(ev.key)) apply(last, modifiersOf(ev))
    }
    window.addEventListener('keydown', onModifierKey)
    window.addEventListener('keyup', onModifierKey)
    const stop = () => {
      window.removeEventListener('keydown', onModifierKey)
      window.removeEventListener('keyup', onModifierKey)
      const d = dragRef.current
      dragRef.current = null
      setDragView(null)
      return d
    }
    const commit = () => {
      const d = stop()
      if (!d) return
      const polyChanged = (a: Ring, b: Ring) => a.some((p, i) => p[0] !== b[i][0] || p[1] !== b[i][1])
      const commitOutline = (of: Outlined, id: number, poly: Ring, origin: Ring) =>
        of === 'element' ? commitElementPoly(id, poly) : commitLinePoly(id, poly, origin)
      if (d.mode === 'lvertex' || d.mode === 'ledge' || d.mode === 'lrotate') {
        if (polyChanged(d.poly, d.origin)) commitOutline(d.of, d.id, d.poly, d.origin)
        // A side of a polygon that is pressed and not dragged gains a corner. Not on a
        // four-corner line, where that handle is the grow control and a fifth corner
        // would be a surprise - the Polygon button is how a box becomes a polygon. An
        // element's outline gains one on any side: it has no grow control to keep.
        else if (d.mode === 'ledge' && (d.origin.length > 4 || d.of === 'element')) {
          commitOutline(d.of, d.id, splitSide(d.origin, d.ei), d.origin)
        }
        // Otherwise the handle was clicked, not dragged - and a selected line's handles
        // cover the line itself, so this is where a second click on the same spot lands.
        // Stepping outward is what clicking the selected thing again has always meant;
        // without it the cycle dies on whatever was selected first. Not `selectAt`: the
        // handle sits a few pixels off the click that selected the line, which would
        // read as a new spot and start the stack over.
        else stepStack(1)
        return
      }
      if (d.mode === 'lside') {
        // A press that stayed put is the pen's first click, so the other end of the side
        // is still to come; a drag laid the whole side down. The height comes next.
        const dragged = screenDistance(d.from, d.to) >= CLICK_SLOP_PX
        setLineDraft({ a: d.from, b: dragged ? d.to : null })
        setDrawCursor(d.to)
        return
      }
      if (d.mode === 'lasso') {
        if (screenDistance(d.from, d.to) < CLICK_SLOP_PX) {
          const hit = combinedStack(d.from)[0]
          if (hit) toggleMerge(hit.kind, hit.id, hit.kind === selKind ? curSelId() : null)
        } else {
          selectWithin(orderBbox(d.from[0], d.from[1], d.to[0], d.to[1]))
        }
        return
      }
      if (d.mode === 'cut') {
        setCutArmed(false)
        setCutPos(null)
        const [from, to] = screenDistance(d.from, d.to) < CLICK_SLOP_PX ? cutAcross(d.from) : [d.from, d.to]
        commitCut(from, to)
        return
      }
      if (d.mode === 'lmove') {
        // A press that never moved is a click: cycle selection instead.
        if (d.poly.every((p, i) => p[0] === d.origin[i][0] && p[1] === d.origin[i][1])) {
          selectAt(d.from)
          return
        }
        commitOutline(d.of, d.id, d.poly, d.origin)
        return
      }
      // Pressing on the selected box arms a move; if it never moved the user was
      // clicking, so cycle outward instead of committing an identical bbox.
      if (d.mode === 'move' && d.bbox.every((v, i) => v === d.origin[i])) {
        selectAt(d.from)
        return
      }
      if (d.mode === 'new' && !bigEnough(d.bbox)) {
        setBoxDraft(d.from)
        setDrawCursor(d.from)
        return
      }
      if (!bigEnough(d.bbox)) return
      if (d.mode === 'new') commitCreate(d.bbox)
      else {
        const el = selectable.find((x) => x.id === d.id)
        if (el) commitBbox(d.id, d.bbox)
      }
    }
    drag.begin(e, {
      onMove: (ev) => {
        const pt = toNorm(ev)
        if (!pt) return
        last = pt
        apply(pt, modifiersOf(ev))
      },
      onEnd: commit,
      onCancel: stop,
    })
  }

  // One containment stack over boxes AND lines at a point, innermost (smallest area)
  // first - so a click on text cycles line, then Paragraph, Column, Table.
  type Hit = { kind: 'element' | 'line'; id: number }
  const combinedStack = ([x, y]: [number, number]): Hit[] => {
    const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1])
    const els = containingStack(selectable, x, y, outlines).map((e) => ({ kind: 'element' as const, id: e.id, a: area(e.bbox) }))
    const lns = linesAt(visibleLines, x, y).map((l) => {
      const ys = l.polygon.map((p) => p[1])
      return { kind: 'line' as const, id: l.id, a: area([polyMinX(l.polygon), Math.min(...ys), polyMaxX(l.polygon), Math.max(...ys)]) }
    })
    return [...els, ...lns].sort((p, q) => p.a - q.a).map(({ kind, id }) => ({ kind, id }))
  }

  const applySel = (hit: Hit) => {
    setSelKind(hit.kind)
    if (hit.kind === 'element') {
      setSelectedId(hit.id)
      setActiveLine(null)
    } else {
      setActiveLine(hit.id)
      // Surface the line's row and its OCR text in the side panel by selecting its parent.
      setSelectedId(lineParent.get(hit.id)?.id ?? null)
      rowRefs.current.get(hit.id)?.scrollIntoView({ block: 'nearest' })
    }
  }

  // Picking a line in the region list selects it on the scan, as picking its region does.
  const selectLine = (id: number) => {
    const parent = lineParent.get(id)
    const line = parent?.lines.find((l) => l.id === id)
    if (!parent || !line) return
    if (hiddenEls.has(parent.id)) toggleHiddenElement(parent.id)
    applySel({ kind: 'line', id })
    centerOn(...polyCenter(line.polygon))
  }

  // With the Line pen only lines are picked: its clicks land inside layout boxes by
  // nature, and every one of them would otherwise select the box instead of drawing.
  const selectAt = ([x, y]: Pt, linesOnly = false) => {
    const all = combinedStack([x, y])
    const stack = linesOnly ? all.filter((h) => h.kind === 'line') : all
    if (stack.length === 0) return false
    const c = clickCycle.current
    // In screen pixels, like every other click in this file: a hundredth of the page is
    // a few of them at the fitted width but tens of them under a zoom, which turned a
    // click plainly somewhere else into another step through the last one's stack.
    const sameSpot = screenDistance([x, y], [c.x, c.y]) < CLICK_SLOP_PX
    const index = sameSpot ? (c.index + 1) % stack.length : 0
    clickCycle.current = { x, y, index }
    applySel(stack[index])
    return true
  }

  // Keyboard equivalent of the click cycle. Anchored to the last click point rather
  // than the selection's centre: a page-wide Table centres on the gutter between its
  // columns, where none of its children sit, which would collapse the stack.
  const stepStack = (outward: number) => {
    const cur = curSelId()
    if (cur === null) return
    const c = clickCycle.current
    const stack = c.x >= 0 && combinedStack([c.x, c.y]).some((h) => h.id === cur && h.kind === selKind)
      ? combinedStack([c.x, c.y])
      : (() => {
          const b = selKind === 'element' ? selected?.bbox : lineBox(selectedLine)
          return b ? combinedStack([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]) : []
        })()
    const at = stack.findIndex((h) => h.id === cur && h.kind === selKind)
    if (at === -1 || stack.length < 2) return
    const next = (at + outward + stack.length) % stack.length
    // The click cycle and this share one cursor, or a click after a step would carry on
    // from where the clicking left off and hand back what is already selected.
    if (c.x >= 0) clickCycle.current = { x: c.x, y: c.y, index: next }
    applySel(stack[next])
  }

  const selectedLine = useMemo(
    () => (activeLine === null ? null : (pageLines.find((l) => l.id === activeLine) ?? null)),
    [activeLine, pageLines],
  )
  // The one item the unified editor is acting on.
  const curSelId = () => (selKind === 'element' ? selectedId : activeLine)
  const curEl = selKind === 'element' ? selected : null
  const curLine = selKind === 'line' ? selectedLine : null
  // A selected element reshaped by its outline rather than its box, in a polygon dataset.
  const curOutlined = outlines && curEl?.polygon ? curEl : null
  // In box-edit mode the loupe follows the selection, otherwise the focused line -
  // except while text is being edited, which focusLine already pins.
  const loupeLine = editing && editingId === null ? curLine : focusLine

  // Shift-click builds a homogeneous merge set (all boxes or all lines). Starting a
  // fresh set seeds it with the current single selection, so the item clicked first
  // (without Shift) is part of the merge too.
  const toggleMerge = (kind: 'element' | 'line', id: number, seed: number | null = null) => {
    setMergeSet((prev) => {
      const fresh = mergeKind.current !== kind || prev.size === 0
      const next = fresh ? new Set<number>() : new Set(prev)
      mergeKind.current = kind
      if (fresh && seed !== null && seed !== id) next.add(seed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Everything the lasso caught: only what is on screen, so a hidden class cannot be
  // swept up and deleted unseen. The set stays homogeneous - the kind already being
  // worked on wins, and the other is taken only when that kind caught nothing.
  const selectWithin = (box: Bbox) => {
    const [x0, y0, x1, y1] = box
    const inside = (bx: number, by: number) => bx >= x0 && bx <= x1 && by >= y0 && by <= y1
    const els = selectable.filter(
      (el) => inside(el.bbox[0], el.bbox[1]) && inside(el.bbox[2], el.bbox[3])).map((el) => el.id)
    const lns = visibleLines.filter(
      (l) => l.polygon.every(([px, py]) => inside(px, py))).map((l) => l.id)
    const [kind, ids] = selKind === 'line'
      ? (lns.length ? ['line', lns] as const : ['element', els] as const)
      : (els.length ? ['element', els] as const : ['line', lns] as const)
    mergeKind.current = kind
    setMergeSet(new Set(ids))
  }

  // The Line pen's later clicks: the second fixes the side, the third the height.
  const advanceLineDraft = (draft: LineDraft, pt: Pt) => {
    if (!draft.b) {
      if (screenDistance(draft.a, pt) >= CLICK_SLOP_PX) setLineDraft({ a: draft.a, b: pt })
      return
    }
    const quad = angledQuad(draft.a, draft.b, pt, aspect)
    setLineDraft(null)
    setDrawCursor(null)
    if (quad && polyBigEnough(quad)) commitLineCreate(quad)
  }

  // Clicking the first corner again closes the polygon; anywhere else adds a corner. A
  // triangle is the least that encloses anything, and the server refuses less.
  const advancePolyDraft = (pt: Pt) => {
    if (!polyDraft) return
    if (polyDraft.length >= 3 && screenDistance(polyDraft[0], pt) <= CLOSE_SLOP_PX) {
      setPolyDraft(null)
      setDrawCursor(null)
      if (polyBigEnough(polyDraft)) commitRing(polyDraft)
      return
    }
    setPolyDraft([...polyDraft, pt])
  }

  // Enter, a right-click or a double-click finish the polygon where it stands, as they do
  // on a tile. A double-click has already put its two clicks down as corners on one spot,
  // so the second of those goes.
  const finishPolyDraft = (afterDoubleClick = false) => {
    if (!polyDraft) return
    const doubled = afterDoubleClick && polyDraft.length >= 2
      && screenDistance(polyDraft[polyDraft.length - 1], polyDraft[polyDraft.length - 2]) <= CLICK_SLOP_PX
    const pts = doubled ? polyDraft.slice(0, -1) : polyDraft
    setPolyDraft(null)
    setDrawCursor(null)
    if (pts.length >= 3 && polyBigEnough(pts)) commitRing(pts)
  }

  // The polygon pen's press: let go where it went down and it places one corner, the way
  // it always has; held and moved it traces the line freehand, as the pen does on a tile.
  // Only the points that bend the line are kept, so a slow hand does not leave hundreds.
  const beginPolyStroke = (e: React.PointerEvent, pt: Pt) => {
    const base = polyDraft
    const pressed = { x: e.clientX, y: e.clientY }
    let run: Ring | null = null
    drag.begin(e, {
      onMove: (ev) => {
        const at = toNorm(ev)
        if (!at) return
        if (!run) {
          if (Math.hypot(ev.clientX - pressed.x, ev.clientY - pressed.y) < CLICK_SLOP_PX) return
          run = [pt]
          setStrokeFrom(base?.length ?? 0)
        }
        if (screenDistance(run[run.length - 1], at) < FREEHAND_STEP_PX) return
        run.push(at)
        setPolyDraft([...(base ?? []), ...run])
        setDrawCursor(at)
      },
      onEnd: () => {
        setStrokeFrom(null)
        if (!run) {
          // Never moved: one corner, or the click on the first that closes the line.
          if (base) advancePolyDraft(pt)
          else {
            setPolyDraft([pt])
            setDrawCursor(pt)
          }
          return
        }
        const scale = scaleRef.current || 1
        const kept = page
          ? simplifyPolyline(run, FREEHAND_TOLERANCE_PX / scale, page.width, page.height)
          : run
        const pts = [...(base ?? []), ...kept]
        // Brought back to where it began, letting go is the close - the same gesture that
        // ends a stroke on a tile, and what the first corner has been offering all along.
        if (pts.length > 3 && screenDistance(pts[0], pts[pts.length - 1]) <= CLOSE_SLOP_PX) {
          setPolyDraft(null)
          setDrawCursor(null)
          const ring = pts.slice(0, -1)
          if (polyBigEnough(ring)) commitRing(ring)
          return
        }
        setPolyDraft(pts)
      },
      onCancel: () => {
        setStrokeFrom(null)
        setPolyDraft(base)
      },
    })
  }

  // The box pen's second click. A press that never moved armed the first corner, so the
  // next click anywhere finishes the box - the same two-click pen the Line class has.
  const finishBoxDraft = (pt: Pt) => {
    if (!boxDraft) return
    const bbox = orderBbox(boxDraft[0], boxDraft[1], pt[0], pt[1])
    setBoxDraft(null)
    setDrawCursor(null)
    if (bigEnough(bbox)) commitCreate(bbox)
  }

  // A line is either a turned box - four corners that stay square to each other - or a
  // free polygon that can follow a baseline. Which one it is, is its number of corners,
  // so switching is a real edit and undoes like one.
  // --- eraser brush ---------------------------------------------------------

  // How big the scan is drawn, in screen pixels: what a brush radius in pixels means for
  // geometry kept in page coordinates.
  const drawnSize = (): [number, number] => {
    const scale = scaleRef.current || 1
    return page ? [page.width * scale, page.height * scale] : [1, 1]
  }

  // Somebody has read a line once a person checked it or typed into it. A correction the
  // models or an alignment filled in is nobody's reading, and goes like any detection. A
  // plain sweep steps over what a person read; Shift takes it too.
  const readByAPerson = (line: Line) =>
    line.checked || (line.corrected_text !== null && !isMachineAuthor(line.corrected_by))

  // One brush pass: sweep the corners along the segment a-b off every drawn line the brush
  // can reach. Local only - the sweep is written back in one go on release. A line whose
  // corners fall below a triangle goes with them, which is how a stray detection is swept
  // away rather than whittled down.
  const applyBrush = (stroke: EraseStroke, a: Pt, b: Pt, takeChecked: boolean) => {
    const [w, h] = drawnSize()
    setPage((p) => {
      if (!p) return p
      let changed = false
      const elements = p.elements.map((el) => {
        const lines: Line[] = []
        for (const line of el.lines) {
          if (!drawnLineIds.has(line.id)) {
            lines.push(line)
            continue
          }
          const res = eraseFromGeom({ points: line.polygon, holes: [] }, a, b, brushPx, w, h, 3)
          if (!res.changed) {
            lines.push(line)
            continue
          }
          // Somebody has read this one. It is left standing and counted, unless the sweep
          // was made with Shift, which says to take it too.
          if (!takeChecked && readByAPerson(line)) {
            stroke.spared.add(line.id)
            lines.push(line)
            continue
          }
          changed = true
          stroke.touched.add(line.id)
          if (res.geom === null) {
            stroke.deletedIds.add(line.id)
            stroke.after.delete(line.id)
            continue
          }
          stroke.after.set(line.id, res.geom.points)
          lines.push({ ...line, polygon: res.geom.points })
        }
        return changed ? { ...el, lines } : el
      })
      return changed ? { ...p, elements } : p
    })
  }

  const persistStroke = async (stroke: EraseStroke) => {
    const kept = stroke.spared.size
    if (stroke.touched.size === 0) {
      setErasedNotice(kept
        ? { text: `${kept} checked ${kept === 1 ? 'line' : 'lines'} left alone - Shift takes those too`, tone: 'info' }
        : null)
      return
    }
    const spans: EditSpan[] = []
    // A line somebody changed since it was loaded - corrected, say, from another tab - is
    // refused by the server and shown as theirs; the brush leaves it alone like a checked
    // one and says so, rather than failing the whole sweep. A line the brush would take
    // whole is judged the same way, so a colleague's reshape is left standing, not erased.
    let gone = 0
    let changedSince = 0
    try {
      for (const id of stroke.touched) {
        const loaded = findLine(id)
        if (!loaded) continue
        try {
          if (stroke.deletedIds.has(id)) {
            // Soft, so one undo brings it back.
            spans.push((await guardedSave('line', loaded, (revision) => deleteLine(id, revision))).span)
            gone += 1
            continue
          }
          const poly = stroke.after.get(id)
          if (!poly) continue
          const line = await guardedSave('line', loaded, (revision) => patchLinePolygon(id, poly, revision))
          applyLine(line)
          spans.push(line.span)
        } catch (e) {
          if (!conflictOf(e)) throw e
          changedSince += 1
        }
      }
      // One span for the whole sweep: it undoes in a single step.
      if (spans.length) recordEdit(spanOf(...spans))
      const reshaped = stroke.touched.size - gone - changedSince
      setErasedNotice({
        text: [gone ? `${gone} ${gone === 1 ? 'line' : 'lines'} erased` : reshaped ? `${reshaped} reshaped` : null,
               kept ? `${kept} checked left alone` : null,
               changedSince ? `${changedSince} changed since ${changedSince === 1 ? 'it was' : 'they were'} loaded - left alone` : null,
        ].filter(Boolean).join(' · '),
        tone: 'info',
      })
      if (gone) await reloadPage()
    } catch (e) {
      fail(e)
    }
  }

  const beginEraseStroke = (e: React.PointerEvent, pt: Pt) => {
    const stroke: EraseStroke = {
      touched: new Set(), after: new Map(), deletedIds: new Set(), spared: new Set(), last: pt,
    }
    const takeChecked = e.shiftKey
    setErasedNotice(null)
    applyBrush(stroke, pt, pt, takeChecked)
    drag.begin(e, {
      onMove: (ev) => {
        const at = toNorm(ev)
        if (!at) return
        setBrushAt(at)
        applyBrush(stroke, stroke.last, at, takeChecked)
        stroke.last = at
      },
      onEnd: () => void persistStroke(stroke),
      onCancel: () => void persistStroke(stroke),
    })
  }

  // A press on the pane beside the scan - the gutter once the view is zoomed out - starts
  // an eraser stroke like a press on the scan would: toNorm puts it on the nearest edge,
  // so a sweep in from the margin takes the corners on it. Everything the eraser does
  // not claim stays the pane's own pan: Alt, the middle button, the hand, a finger or pen.
  const onOverlayPanePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const erasing = editing && tool === 'erase' && !handTool
      && e.pointerType === 'mouse' && e.button === 0 && !e.altKey
    const pt = erasing ? toNorm(e) : null
    if (!pt) {
      onPanStart(e)
      return
    }
    e.preventDefault()
    beginEraseStroke(e, pt)
  }

  const reshapeLine = (poly: Ring) => {
    if (curLine) commitLinePoly(curLine.id, poly, curLine.polygon)
    else if (curOutlined) commitElementPoly(curOutlined.id, poly)
  }

  const turnSelectedLine = (degrees: number) => {
    if (!curLine) return
    const poly = curLine.polygon
    commitLinePoly(curLine.id, rotatePoly(poly, polyCenter(poly), degrees, aspect), poly)
  }

  // One pointerdown handler for the whole editor. `target` describes what was grabbed:
  // an element box handle/body, or a line vertex/edge/rotate handle/body.
  const onEditPointerDown = (
    e: React.PointerEvent,
    target?: { kind: 'element'; id: number; corner?: string; bbox: Bbox }
            | { kind: 'line'; of?: Outlined; id: number; vi?: number; ei?: number; rotate?: boolean; poly: Ring },
  ) => {
    // Alt-drag, middle-drag and the hand tool are all pan: left alone, the press reaches
    // the pane underneath, which is what scrolls.
    if (e.button !== 0 || e.altKey || handTool) return
    e.preventDefault()
    e.stopPropagation()
    const pt = toNorm(e)
    if (!pt) return
    if (tool === 'erase') {
      beginEraseStroke(e, pt)
      return
    }
    // A shape in progress takes every click, wherever it lands - that is what makes it
    // possible to draw over something that is already there.
    if (polyDraft) {
      beginPolyStroke(e, pt)
      return
    }
    if (lineDraft) {
      advanceLineDraft(lineDraft, pt)
      return
    }
    if (boxDraft) {
      finishBoxDraft(pt)
      return
    }
    // Armed scissors: the press starts the cut stroke, wherever it lands.
    if (cutArmed) {
      beginDrag(e, { mode: 'cut', from: pt, to: pt })
      return
    }
    // Shift-click: add/remove the hit item from the merge set instead of selecting. Not on
    // a handle, where Shift modifies the drag (angle snapping) rather than the selection.
    const onHandle = target !== undefined && (target.kind === 'element'
      ? target.corner !== undefined
      : target.vi !== undefined || target.ei !== undefined || target.rotate === true)
    if (e.shiftKey && !onHandle) {
      beginDrag(e, { mode: 'lasso', from: pt, to: pt })
      return
    }
    // The pen draws wherever it is put down, a click as much as a drag: a column inside
    // its table, a line inside the descender of the one above, the box just drawn and
    // still selected included. Only a handle is grabbed while it is loaded; picking
    // things is the select tool's.
    const drawing = tool === 'draw' && !onHandle
    if (target && !drawing) {
      if (target.kind === 'element') {
        if (target.corner) beginDrag(e, { mode: 'resize', id: target.id, corner: target.corner, bbox: target.bbox })
        else beginDrag(e, { mode: 'move', id: target.id, from: pt, origin: target.bbox, bbox: target.bbox })
      } else {
        const of = target.of ?? 'line'
        if (target.rotate) {
          const center = polyCenter(target.poly)
          beginDrag(e, { mode: 'lrotate', of, id: target.id, origin: target.poly, center,
                         from: angleAround(center, pt, aspect), poly: target.poly })
        } else if (target.vi !== undefined)
          beginDrag(e, { mode: 'lvertex', of, id: target.id, vi: target.vi, origin: target.poly, poly: target.poly })
        else if (target.ei !== undefined)
          beginDrag(e, { mode: 'ledge', of, id: target.id, ei: target.ei, from: pt, origin: target.poly, poly: target.poly })
        else beginDrag(e, { mode: 'lmove', of, id: target.id, from: pt, origin: target.poly, poly: target.poly })
      }
      return
    }
    if (mergeSet.size) setMergeSet(new Set())
    if (tool !== 'draw') {
      if (!selectAt(pt)) beginDrag(e, { mode: 'lasso', from: pt, to: pt })
      return
    }
    if ((drawingLines && linePenShape === 'polygon') || drawingOutlines) beginPolyStroke(e, pt)
    else if (drawingLines) beginDrag(e, { mode: 'lside', from: pt, to: pt })
    else beginDrag(e, { mode: 'new', from: pt, bbox: orderBbox(pt[0], pt[1], pt[0], pt[1]) })
  }

  // The keydown listener is bound once, so it must not close over these: reading
  // them through a ref keeps one subscription and removes the stale-closure risk.
  const editActionValues = {
    undo, redo, pickClass, setTool, finishPolyDraft, toggleLayoutChecked, toggleLinesChecked, commitDelete, commitBbox, stepStack,
    commitLineDelete, commitSetDelete, commitMerge, turnSelectedLine, selKind, selectedId, activeLine,
    curId: curSelId(),
    selected, selectedLine, mergeSet,
  }
  const editActions = useRef(editActionValues)
  editActions.current = editActionValues
  const loupeRotate = useRef<(dir?: 1 | -1) => void>(() => {})
  loupeRotate.current = (dir = 1) => rotateLine(loupeLine, dir)
  const hkRef = useRef(hk) // resolved hotkeys, read at keypress so remaps take effect live
  hkRef.current = hk
  const loupeReocr = useRef<() => void>(() => {})
  loupeReocr.current = () => {
    const l = loupeLine
    if (l) reocrOneLine(l)
  }

  // A palette that fills itself: what the dataset has been read as, gathered once, plus
  // what the page in front of you holds - so a character typed into a correction is a key
  // at once rather than after the next fetch. Your own picks stand in until there is text.
  const [datasetChars, setDatasetChars] = useState<string[]>([])
  useEffect(() => {
    if (keyboardSource !== 'dataset') return
    getJobCharacters(jobId).then((r) => setDatasetChars(r.characters)).catch(() => undefined)
  }, [jobId, keyboardSource])
  const filled = useMemo(() => {
    if (keyboardSource !== 'dataset') return []
    const here = page
      ? page.elements.flatMap((e) => e.lines.flatMap((l) => [l.text, l.corrected_text]))
      : []
    return orderByGroups([...datasetChars, ...beyondPlain([...here, draft])])
  }, [keyboardSource, datasetChars, page, draft])
  const palette = keyboardSource === 'dataset' && filled.length > 0 ? filled : vkbd
  const hasKeys = palette.length > 0

  // In its place above the footer the keyboard reserves vertical space through --vkbd-h,
  // so it never covers the OCR list or the scan: the panels' max-height calc subtracts it.
  // Dragged elsewhere it floats where it was put and reserves nothing.
  const kbRef = useRef<HTMLDivElement | null>(null)
  const [kbBox, setKbBox] = useState({ width: 0, height: 0, areaWidth: 0, areaHeight: 0 })
  const kbVisible =
    canEdit && hasKeys &&
    (keyboardMode === 'show' || (keyboardMode === 'auto' && editingId !== null))
  useLayoutEffect(() => {
    const el = kbRef.current
    const area = el?.parentElement
    if (!el || !area) {
      setKbBox({ width: 0, height: 0, areaWidth: 0, areaHeight: 0 })
      return
    }
    const measure = () => setKbBox({
      width: el.offsetWidth, height: el.offsetHeight,
      areaWidth: area.clientWidth, areaHeight: area.clientHeight,
    })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(area)
    return () => ro.disconnect()
  }, [kbVisible])
  const kbHeight = kbBox.height && !kbPlace ? kbBox.height + 12 : 0
  const within = (at: number, size: number, of: number) => Math.max(0, Math.min(of - size, at - size / 2))
  const kbFloat = kbPlace && {
    left: within(kbPlace.x * kbBox.areaWidth, kbBox.width, kbBox.areaWidth),
    top: within(kbPlace.y * kbBox.areaHeight, kbBox.height, kbBox.areaHeight),
  }

  const cycleKeyboardMode = () => {
    const next = keyboardMode === 'auto' ? 'show' : keyboardMode === 'show' ? 'hide' : 'auto'
    saveSettings({ keyboard_mode: next })
  }
  useCommand('keyboardMode', cycleKeyboardMode, canEdit && hasKeys)

  const editInputRef = useRef<HTMLTextAreaElement | null>(null)
  // The draft is held composed, like everything on screen, so a mark typed or inserted
  // after its letter folds into it - and the caret has to be put back where that leaves it.
  // Put back as the new draft is committed, not a frame later, or a key pressed in between
  // lands wherever the browser left the caret on rewriting the value: at the end.
  const pendingCaret = useRef<{ caret: number; refocus: boolean } | null>(null)
  const editDraft = (text: string, caret: number, refocus = false) => {
    const edit = composedEdit(text, caret)
    if (refocus || edit.text !== text) pendingCaret.current = { caret: edit.caret, refocus }
    setDraft(edit.text)
  }
  useLayoutEffect(() => {
    const el = editInputRef.current
    const pending = pendingCaret.current
    if (!el || !pending) return
    pendingCaret.current = null
    if (pending.refocus) el.focus()
    el.setSelectionRange(pending.caret, pending.caret)
  })

  const insertChar = (ch: string) => {
    const el = editInputRef.current
    if (!el) return
    const start = el.selectionStart ?? draft.length
    const end = el.selectionEnd ?? draft.length
    editDraft(draft.slice(0, start) + ch + draft.slice(end), start + ch.length, true)
  }

  useLayoutEffect(() => {
    const el = editInputRef.current
    if (!el) return
    el.style.height = 'auto'
    // scrollHeight is the content alone, while the height set here is border-box, so the
    // borders have to be added back or the last row is clipped by them.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [draft, editingId])

  const startEdit = (line: Line) => {
    setActiveLine(line.id)
    setEditingId(line.id)
    setEditBase(line.revision)
    setDraft(displayed(line.corrected_text ?? line.text ?? ''))
  }

  // Every reading on offer for the page, read again after the server moved one.
  const reloadCandidates = async () =>
    setCandidates((await getPageCandidates(Number(pageId))).candidates)

  // A refused save is not an error to show and forget: the other person's reading is
  // in the response, so offer the choice instead of silently overwriting either. What was
  // stored comes back, so whatever follows the save works on the line as it now is.
  const saveText = async (
    line: Line, text: string | null, revision: number, fromReading = false,
  ): Promise<Line | null> => {
    try {
      const saved = await patchLine(line.id, text, revision, fromReading)
      applyLine(saved)
      setConflict(null)
      return saved
    } catch (e) {
      const clash = conflictOf<Line>(e)
      if (clash) setConflict({ lineId: line.id, author: clash.author, theirs: clash.current, mine: text ?? '' })
      else setError((e as Error).message)
      return null
    }
  }

  const saveEdit = async (line: Line): Promise<Line | null> => {
    setEditingId(null)
    if (sameText(draft, line.corrected_text ?? line.text ?? '')) return line
    return saveText(line, draft, editBase)
  }

  // A typed correction the revert displaces comes back on offer under its author's name.
  const revert = async (line: Line) => {
    if (await saveText(line, null, line.revision)) await reloadCandidates()
  }

  const keepTheirs = () => {
    if (!conflict) return
    applyLine(conflict.theirs)
    setConflict(null)
  }

  const overwriteWithMine = async () => {
    if (!conflict) return
    setResolving(true)
    try {
      await saveText(conflict.theirs, conflict.mine, conflict.theirs.revision)
    } finally {
      setResolving(false)
    }
  }

  // Last interaction wins: keyboard navigation drops the hover so the loupe follows
  // the active line even while the cursor rests on a row. Scrolling can make the
  // browser re-dispatch hover events without the mouse moving, so hover only
  // reasserts itself once the pointer has actually changed position.
  const lastPointer = useRef<[number, number] | null>(null)
  const hoverLine = (e: React.MouseEvent, id: number) => {
    const p = lastPointer.current
    if (p && p[0] === e.clientX && p[1] === e.clientY) return
    lastPointer.current = [e.clientX, e.clientY]
    setHoveredLine(id)
  }

  const activateLine = (lineId: number, smooth = false) => {
    setActiveLine(lineId)
    setReadingCursor(null)
    setHoveredLine(null)
    rowRefs.current.get(lineId)?.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }

  /** Step down or up the readings held for the active line, and say whether the step
   *  stayed among them. Out of the last one is out of the line: the arrows walk what is on
   *  screen, and a line's readings are on screen exactly while it is the active one. */
  // The reading a line is wearing: taken, so no longer offered, and only undone from here.
  const takenReading = (line: Line): LineCandidate | undefined =>
    (candidatesByLine.get(line.id) ?? [])
      .find((c) => sameText(c.text, line.corrected_text ?? line.text ?? ''))

  // The arrow keys and Enter walk what is drawn, not the pool behind it.
  const offeredLineReadings = (lineId: number): LineCandidate[] => {
    const line = pageLines.find((l) => l.id === lineId)
    if (!line) return []
    return offeredReadings(candidatesByLine.get(lineId) ?? [], line.corrected_text ?? line.text ?? '',
                           line.text ? { text: line.text, author: line.text_author } : null)
  }

  const stepReading = (move: 1 | -1): boolean => {
    if (activeLine === null) return false
    const held = offeredLineReadings(activeLine)
    if (held.length === 0) return false
    const at = held.findIndex((c) => c.id === readingCursor)
    if (at === -1) {
      if (move === -1) return false          // upwards out of a line is the line above it
      setReadingCursor(held[0].id)
      return true
    }
    const next = at + move
    if (next < 0 || next >= held.length) {
      setReadingCursor(null)
      return move === -1                     // back onto the line itself, not past it
    }
    setReadingCursor(held[next].id)
    return true
  }

  // Landing on a page in review mode jumps straight to the line that brought us
  // here; keyed on page id so re-renders from an edit do not re-arm.
  // keyed on threshold too: tightening it can drop the active line out of the queue
  useEffect(() => {
    if (!reviewMode || !page || !queue) return
    const key = `${page.id}:${queue.max_conf}`
    if (armedFor.current === key) return
    armedFor.current = key
    setStage((s) => (s === 'element' ? 'page' : s))
    const want = pendingLine.current ?? queue.lines.find((l) => l.page_id === page.id)?.id ?? null
    pendingLine.current = null
    if (want !== null) activateLine(want)
  }, [reviewMode, page, queue])

  // Checking off the last line carries on to the next page, so a finished page is left
  // in the same motion that finished it.
  useEffect(() => {
    if (pendingFirstLine.current === null || !page || page.id !== pendingFirstLine.current) return
    const first = sortedPageLines[0]
    if (!first) return
    pendingFirstLine.current = null
    setStage((st) => (st === 'element' ? 'page' : st))
    activateLine(first.id)
  }, [page, sortedPageLines])

  // A link from an evaluation names the line it is about. It is selected once, when the
  // page's lines arrive, and then the person is free to move on.
  const lineParam = Number(searchParams.get('line')) || null
  const openedLine = useRef<number | null>(null)
  useEffect(() => {
    if (lineParam === null || openedLine.current === lineParam) return
    if (!pageLines.some((l) => l.id === lineParam)) return
    openedLine.current = lineParam
    setStage((st) => (st === 'element' ? 'page' : st))
    activateLine(lineParam)
  }, [lineParam, pageLines])

  // Walks the job-wide queue, crossing page boundaries on its own.
  const gotoQueued = useCallback(
    (delta: 1 | -1) => {
      if (!queue) return
      const lines = queue.lines
      const cur = lines.findIndex((l) => l.id === activeLine)
      const here = page?.idx ?? -1
      const target = cur !== -1 ? lines[cur + delta]
        : delta === 1 ? lines.find((l) => l.page_idx >= here)
        : lines.findLast((l) => l.page_idx < here)
      if (!target) return
      if (String(target.page_id) === pageId) {
        setActiveLine(target.id)
        setReadingCursor(null)
        rowRefs.current.get(target.id)?.scrollIntoView({ block: 'nearest' })
        return
      }
      pendingLine.current = target.id
      navigate(`/jobs/${jobId}/pages/${target.page_id}?review=${maxConf}`)
    },
    [queue, activeLine, page, pageId, jobId, maxConf, navigate],
  )

  /** The whole of what Shift+Enter means: this line is done with, so it is checked off and
   *  the keyboard moves to the next one - over the page break where that was the last. */
  const checkAndAdvance = (line: Line) => {
    const list = reviewMode ? reviewLines : stage === 'element' ? listLines : sortedPageLines
    const at = list.findIndex((l) => l.id === line.id)
    void toggleLineChecked(line, true)
    if (reviewMode) return gotoQueued(1)
    if (at !== -1 && at + 1 < list.length) return activateLine(list[at + 1].id)
    // Last line of the page: on to the next one, first line focused. Within an element the
    // rest of the page is still ahead, so that stays put.
    if (stage === 'element') return
    const here = orderedPages.findIndex((p) => String(p.id) === pageId)
    const next = here === -1 ? undefined : orderedPages[here + 1]
    if (next) {
      pendingFirstLine.current = next.id
      navigate(`/jobs/${jobId}/pages/${next.id}`)
    }
  }

  useEffect(() => {
    const gotoPage = (delta: number) => {
      const cur = orderedPages.findIndex((p) => String(p.id) === pageId)
      const next = cur + delta
      if (cur !== -1 && next >= 0 && next < orderedPages.length) {
        navigate(`/jobs/${jobId}/pages/${orderedPages[next].id}`)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === '?' && editingId === null) {
        e.preventDefault()
        setSheetOpen((v) => !v)
        return
      }
      if (e.key === ' ' && editing && editingId === null) {
        e.preventDefault() // the page must not scroll under the hand
        if (!e.repeat) setSpaceHeld(true)
        return
      }
      if (e.key === 'Alt' && editing && editingId === null) {
        if (!e.repeat) setAltHeld(true)
        return
      }
      if (e.key === 'Escape') {
        if (armed) arm(null)
        else if (editingId !== null) setEditingId(null)
        else if (drag.isDragging()) drag.cancel()
        else if (tool === 'hand') setTool('select')
        else if (lineDraft || boxDraft || polyDraft) {
          setLineDraft(null)
          setBoxDraft(null)
          setPolyDraft(null)
          setDrawCursor(null)
        } else if (cutArmed) {
          setCutArmed(false)
          setCutPos(null)
        } else if (mergeSet.size) setMergeSet(new Set())
        // Letting go of what is selected comes before leaving: Escape steps back one
        // thing at a time, and the selection is the innermost thing there is. An element
        // nobody has selected has nothing to list, so letting go of it is the way out.
        else if (curSelId() !== null) {
          setSelectedId(null)
          setActiveLine(null)
          setStage((s) => (s === 'element' ? 'page' : s))
        } else if (editing) setEditing(false)
        else if (stage === 'element') backToPage()
        else navigate(`/jobs/${jobId}`)
        return
      }
      // A corner put in the wrong place is taken back rather than starting over.
      if (polyDraft && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault()
        setPolyDraft((prev) => (prev && prev.length > 1 ? prev.slice(0, -1) : null))
        return
      }
      if (editingId !== null) return
      const combo = eventCombo(e)
      // '' is a bare modifier press, and also what an unbound command holds.
      if (!combo) return
      if (combo === hkRef.current.edit && canEdit) {
        e.preventDefault()
        setEditing((v) => !v)
        return
      }
      if (combo === hkRef.current.rotateCw && canEdit) {
        e.preventDefault()
        loupeRotate.current(1)
        return
      }
      if (combo === hkRef.current.rotateCcw && canEdit) {
        e.preventDefault()
        loupeRotate.current(-1)
        return
      }
      if (combo === hkRef.current.reocr && canReread) {
        e.preventDefault()
        loupeReocr.current()
        return
      }
      // Edits recorded outside edit mode (a line thrown out of the reading list) are
      // taken back the same way, so undo does not wait for edit mode.
      if (combo === 'ctrl+shift+z' || combo === 'meta+shift+z' || combo === 'ctrl+y') {
        e.preventDefault()
        void editActions.current.redo()
        return
      }
      if (combo === 'ctrl+z' || combo === 'meta+z') {
        e.preventDefault()
        void editActions.current.undo()
        return
      }
      if (editing) {
        const a = editActions.current
        if (combo === hkRef.current.toolSelect) { e.preventDefault(); a.pickClass(null); return }
        if (combo === hkRef.current.toolHand) { e.preventDefault(); a.setTool('hand'); return }
        if (combo === hkRef.current.toolDraw) { e.preventDefault(); a.setTool('draw'); return }
        if (combo === hkRef.current.toolErase) { e.preventDefault(); a.setTool('erase'); return }
        if (e.key === 'Enter' && polyDraft) {
          e.preventDefault()
          a.finishPolyDraft()
          return
        }
        if (combo === hkRef.current.verify) { e.preventDefault(); a.toggleLayoutChecked(); return }
        // + / - step the containment stack (QWERTZ-friendly; [ ] need AltGr).
        if (e.key === '+' || e.key === '=' || e.key === '-') {
          e.preventDefault()
          a.stepStack(e.key === '-' ? -1 : 1)
          return
        }
        // s arms the scissors on the selection; pressing it again puts them away.
        if (combo === hkRef.current.split && a.curId !== null) {
          e.preventDefault()
          setCutArmed((v) => !v)
          return
        }
        if (combo === hkRef.current.lineTurnCw || combo === hkRef.current.lineTurnCcw) {
          if (a.selKind !== 'line') return
          e.preventDefault()
          a.turnSelectedLine(combo === hkRef.current.lineTurnCw ? TURN_STEP_DEG : -TURN_STEP_DEG)
          return
        }
        // m merges the shift-selected set (falls back to the single selection).
        if (combo === hkRef.current.merge) {
          e.preventDefault()
          const ids = a.mergeSet.size >= 2 ? [...a.mergeSet] : []
          if (ids.length >= 2) a.commitMerge(mergeKind.current, ids)
          return
        }
        if (/^[0-9]$/.test(e.key)) {
          const cls = layoutClasses[e.key === '0' ? 9 : Number(e.key) - 1]
          if (cls && cls !== LINE_CLASS) {
            e.preventDefault()
            a.pickClass(cls)
          }
          return
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          // A gathered set goes together; otherwise it is the single selection.
          if (a.mergeSet.size) a.commitSetDelete(mergeKind.current, [...a.mergeSet])
          else if (a.selKind === 'line' && a.activeLine !== null) a.commitLineDelete(a.activeLine)
          else if (a.selKind === 'element' && a.selectedId !== null) a.commitDelete(a.selectedId)
          return
        }
        // Nudge (elements only) must come before page nav, which preventDefaults arrows.
        if (e.shiftKey && e.key.startsWith('Arrow') && a.selKind === 'element' && a.selected) {
          e.preventDefault()
          const step = 0.002
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          a.commitBbox(a.selected.id, moveBbox(a.selected.bbox, dx, dy))
          return
        }
      }
      if (e.key === 'ArrowRight' || combo === hkRef.current.nextPage) {
        e.preventDefault()
        gotoPage(1)
        return
      }
      if (e.key === 'ArrowLeft' || combo === hkRef.current.prevPage) {
        e.preventDefault()
        gotoPage(-1)
        return
      }
      if (!canLineNav) return
      // The readings' own key: in review mode the arrows keep to the flagged lines, so this
      // is the way into the readings under one, and on through them back to the line.
      if (combo === hkRef.current.readings && activeLine !== null) {
        e.preventDefault()
        stepReading(1)
        return
      }
      const list = reviewMode ? reviewLines : stage === 'element' ? listLines : sortedPageLines
      const move =
        e.key === 'ArrowDown' || combo === hkRef.current.lineDown
          ? 1
          : e.key === 'ArrowUp' || combo === hkRef.current.lineUp
            ? -1
            : 0
      // Walking the lines hands the keyboard to the list, so whatever button was clicked
      // last lets go of it: Enter otherwise presses that button again and never reaches the
      // line - or the reading - the cursor has arrived on.
      const held = move !== 0 && e.target instanceof HTMLElement ? e.target.closest('button, a') : null
      if (held instanceof HTMLElement) held.blur()
      if (move !== 0 && reviewMode) {
        e.preventDefault()
        gotoQueued(move)
        return
      }
      if (move !== 0 && list.length > 0) {
        e.preventDefault()
        // Down walks into the active line's readings before leaving it, and up walks back
        // out through them, so the arrows follow the list as it is drawn.
        if (stepReading(move as 1 | -1)) return
        const cur = list.findIndex((l) => l.id === activeLine)
        const next =
          cur === -1
            ? move === 1
              ? 0
              : list.length - 1
            : Math.min(list.length - 1, Math.max(0, cur + move))
        activateLine(list[next].id)
        return
      }
      if (e.key === 'Enter' && activeLine !== null) {
        if (e.target instanceof HTMLElement && e.target.closest('button, a')) return
        const cur = list.findIndex((l) => l.id === activeLine)
        const line = list[cur]
        if (!line) return
        e.preventDefault()
        // On a reading, Enter takes it: the same as clicking the row it is sitting on.
        if (readingCursor !== null && !e.shiftKey) {
          const held = offeredLineReadings(activeLine).find((c) => c.id === readingCursor)
          if (held && canEdit) acceptCandidate(line, held)
          return
        }
        if (e.shiftKey) checkAndAdvance(line)
        else startEdit(line)
      }
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
  }, [jobId, pageId, orderedPages, stage, navigate, editingId, activeLine, listLines, sortedPageLines, showLines,
      canLineNav, reviewMode, reviewLines, gotoQueued, editing, selectedId, layoutClasses, cutArmed, mergeSet,
      canEdit, canReread, drag, lineDraft, boxDraft, polyDraft, tool, armed, readingCursor, candidatesByLine])

  const elementById = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements])
  // What the overlays draw: the region list can mute individual boxes.
  const shownElements = useMemo(
    () => (hiddenEls.size ? elements.filter((e) => !hiddenEls.has(e.id)) : elements),
    [elements, hiddenEls])
  const shownContainers = useMemo(
    () => (hiddenEls.size ? containers.filter((e) => !hiddenEls.has(e.id)) : containers),
    [containers, hiddenEls])

  const overlayClick = useCallback(
    (e: React.MouseEvent) => {
      const el = elementById.get(Number((e.target as Element).getAttribute?.('data-id')))
      if (el) selectElement(el)
    },
    [elementById],
  )
  const overlayOver = useCallback((e: React.MouseEvent) => {
    const id = Number((e.target as Element).getAttribute?.('data-id'))
    setHoveredEl(id || null)
  }, [])

  // A fifth, deliberately unmemoized layer: it changes on every mousemove, so its
  // state must never reach contextRects/contextLabels or their raster cache is lost.
  // One layer for boxes and lines. It renders both, and the selected item's handles
  // (8-corner box handles for an element, vertex plus edge handles for a line).
  const editLayer = () => {
    const liveBox = dragView && (dragView.mode === 'move' || dragView.mode === 'resize') ? dragView : null
    // An element with an outline is reshaped like a line, by corners and sides; one
    // without is a box with its eight handles.
    const box = curEl && !curOutlined ? (liveBox && liveBox.id === curEl.id ? liveBox.bbox : curEl.bbox) : null
    const livePoly =
      dragView && (dragView.mode === 'lvertex' || dragView.mode === 'ledge' || dragView.mode === 'lmove'
                   || dragView.mode === 'lrotate')
        ? dragView
        : null
    const edited: { of: Outlined; id: number; ring: Ring } | null = curLine
      ? { of: 'line', id: curLine.id, ring: curLine.polygon }
      : curOutlined ? { of: 'element', id: curOutlined.id, ring: curOutlined.polygon! } : null
    const poly = edited
      ? (livePoly && livePoly.id === edited.id && livePoly.of === edited.of ? livePoly.poly : edited.ring)
      : null
    const outlineTarget = (extra: { vi?: number; ei?: number; rotate?: boolean } = {}) =>
      ({ kind: 'line' as const, of: edited!.of, id: edited!.id, poly: poly!, ...extra })
    const drawBox = dragView?.mode === 'new' ? dragView.bbox
      : boxDraft && drawCursor ? orderBbox(boxDraft[0], boxDraft[1], drawCursor[0], drawCursor[1])
      : null
    const lassoBox = dragView?.mode === 'lasso'
      ? orderBbox(dragView.from[0], dragView.from[1], dragView.to[0], dragView.to[1])
      : null
    // The Line pen's preview: the side while it is laid down, then the whole rectangle
    // following the pointer until the height is clicked.
    const draftSide: [Pt, Pt] | null =
      dragView?.mode === 'lside' ? [dragView.from, dragView.to]
      : lineDraft ? [lineDraft.a, lineDraft.b ?? drawCursor ?? lineDraft.a]
      : null
    const draftQuad = lineDraft?.b && drawCursor ? angledQuad(lineDraft.a, lineDraft.b, drawCursor, aspect) : null
    // The polygon pen: what has been clicked, the band to the cursor, and whether that
    // cursor is near enough to the first corner to close on it.
    const draftPoly = polyDraft && drawCursor ? [...polyDraft, drawCursor] : polyDraft
    const closing = !!polyDraft && polyDraft.length >= 3 && !!drawCursor
      && screenDistance(polyDraft[0], drawCursor) <= CLOSE_SLOP_PX
    const rotateHandle = poly ? rotateHandleAnchor(poly, aspect) : null
    const turning = dragView?.mode === 'lrotate' ? dragView : null
    // The scissors' preview: the stroke being drawn, and the cut it will make - across
    // the line where the stroke crosses it, or along one axis of a box.
    const cutting = dragView?.mode === 'cut' ? dragView : null
    const cutStroke: [Pt, Pt] | null = cutting ? [cutting.from, cutting.to] : cutPos ? cutAcross(cutPos) : null
    const cutLine: [Pt, Pt] | null = (() => {
      if (!cutArmed || !cutStroke) return null
      if (poly && edited?.of === 'line') return (poly.length === 4 ? quadCrossing : polygonCrossing)(poly, cutStroke[0], cutStroke[1])
      const bounds = box ?? curOutlined?.bbox
      if (!bounds) return null
      const [from, to] = cutStroke
      const upright = Math.abs(to[1] - from[1]) >= Math.abs((to[0] - from[0]) * aspect)
      const mid: Pt = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
      if (upright) return mid[0] > bounds[0] && mid[0] < bounds[2] ? [[mid[0], bounds[1]], [mid[0], bounds[3]]] : null
      return mid[1] > bounds[1] && mid[1] < bounds[3] ? [[bounds[0], mid[1]], [bounds[2], mid[1]]] : null
    })()
    const inMerge = (kind: 'element' | 'line', id: number) => mergeKind.current === kind && mergeSet.has(id)
    return (
      <div
        className="absolute inset-0"
        style={{
          cursor: handTool ? 'grab'
            // The brush circle is the cursor while erasing; a second one beside it only
            // makes the aim harder to read.
            : tool === 'erase' ? 'none'
            : cutArmed || dragView?.mode === 'new' || dragView?.mode === 'lside'
              || lineDraft || boxDraft || polyDraft
            ? 'crosshair' : 'default',
          touchAction: 'none',
        }}
        onPointerDown={(e) => onEditPointerDown(e)}
        onPointerMove={(e) => {
          if (tool !== 'erase' && !cutArmed && !lineDraft && !boxDraft && !polyDraft) return
          const pt = toNorm(e)
          if (!pt) return
          if (tool === 'erase') setBrushAt(pt)
          if (cutArmed) setCutPos(pt)
          if (lineDraft || boxDraft || polyDraft) setDrawCursor(pt)
        }}
        onPointerLeave={() => setBrushAt(null)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (polyDraft) finishPolyDraft(true)
        }}
        onContextMenu={(e) => {
          if (!polyDraft) return
          e.preventDefault()
          finishPolyDraft()
        }}
      >
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {selectable.map((el) => {
            const ghost = (!!liveBox || (!!livePoly && livePoly.of === 'element')) && curEl?.id === el.id
            const sel = selKind === 'element' && el.id === selectedId
            const lit = el.id === hoveredEl
            const Shape = outlines && el.polygon ? 'polygon' : 'rect'
            return (
              <Shape
                key={`e${el.id}`}
                data-testid="region-box"
                data-id={el.id}
                data-shape={Shape === 'polygon' ? 'outline' : 'box'}
                data-merged={inMerge('element', el.id) || undefined}
                data-hovered={lit || undefined}
                {...(Shape === 'polygon'
                  ? { points: el.polygon!.map(([x, y]) => `${x},${y}`).join(' ') }
                  : { x: el.bbox[0], y: el.bbox[1], width: el.bbox[2] - el.bbox[0], height: el.bbox[3] - el.bbox[1] })}
                fill={inMerge('element', el.id)
                  ? 'color-mix(in srgb, var(--ui-warn) 20%, transparent)'
                  : lit ? classColor(el.class_name, 0.15) : 'transparent'}
                stroke={classColor(el.class_name)}
                strokeWidth={sel || lit ? 2.5 : 1.25}
                strokeOpacity={ghost ? 0.4 : 1}
                strokeDasharray={ghost || el.kind === 'container' ? '4 3' : undefined}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )
          })}
          {visibleLines.map((l) => {
            if (selKind === 'line' && l.id === activeLine && !livePoly) return null
            const ghost = selKind === 'line' && l.id === activeLine
            const erasable = tool === 'erase' && !readByAPerson(l)
            return (
              <polygon
                key={`l${l.id}`}
                data-testid="line-poly"
                data-id={l.id}
                data-merged={inMerge('line', l.id) || undefined}
                points={pagePoints(l)}
                fill={inMerge('line', l.id) ? 'color-mix(in srgb, var(--ui-warn) 20%, transparent)' : 'transparent'}
                stroke={ghost || erasable ? 'var(--ui-accent)' : 'color-mix(in srgb, var(--ui-accent) 55%, transparent)'}
                strokeWidth={ghost ? 2.5 : erasable ? 1.5 : 1}
                strokeOpacity={ghost ? 0.4 : 1}
                strokeDasharray={ghost ? '4 3' : undefined}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )
          })}
          {/* With the eraser in hand, every corner a plain sweep can take: one zero-length
              stroke per corner, whose round cap is a dot that keeps its size under zoom. */}
          {tool === 'erase' && visibleLines.filter((l) => !readByAPerson(l)).map((l) => (
            <path
              key={`c${l.id}`}
              data-testid="line-erase-corners"
              data-id={l.id}
              data-corners={l.polygon.length}
              d={l.polygon.map(([x, y]) => `M${x} ${y}h0`).join('')}
              stroke="var(--ui-accent)"
              strokeWidth={6}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
          {cutting && (
            <line x1={cutting.from[0]} y1={cutting.from[1]} x2={cutting.to[0]} y2={cutting.to[1]}
                  stroke="var(--ui-danger)" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
                  pointerEvents="none" />
          )}
          {cutLine && (
            <line data-testid="cut-preview" x1={cutLine[0][0]} y1={cutLine[0][1]} x2={cutLine[1][0]} y2={cutLine[1][1]}
                  stroke="var(--ui-danger)" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}
          {drawBox && penClass && (
            <rect data-testid="box-draft"
                  x={drawBox[0]} y={drawBox[1]} width={drawBox[2] - drawBox[0]} height={drawBox[3] - drawBox[1]}
                  fill={classColor(penClass, 0.15)} stroke={classColor(penClass)} strokeWidth={2}
                  strokeDasharray={boxDraft ? '4 3' : undefined}
                  vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}
          {lassoBox && (
            <rect data-testid="lasso-box"
                  x={lassoBox[0]} y={lassoBox[1]}
                  width={lassoBox[2] - lassoBox[0]} height={lassoBox[3] - lassoBox[1]}
                  fill="color-mix(in srgb, var(--ui-warn) 12%, transparent)" stroke="var(--ui-warn)" strokeWidth={1.5} strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}
          {draftQuad && (
            <polygon data-testid="line-draft" points={draftQuad.map(([x, y]) => `${x},${y}`).join(' ')}
                     fill={classColor(LINE_CLASS, 0.15)} stroke={classColor(LINE_CLASS)} strokeWidth={1.5}
                     vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}
          {draftSide && (
            <line x1={draftSide[0][0]} y1={draftSide[0][1]} x2={draftSide[1][0]} y2={draftSide[1][1]}
                  stroke={classColor(LINE_CLASS)} strokeWidth={2.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}
          {draftPoly && draftPoly.length > 1 && (
            <polyline data-testid="line-poly-draft"
                      points={draftPoly.map(([x, y]) => `${x},${y}`).join(' ')}
                      fill={closing ? classColor(penColour, 0.15) : 'none'} stroke={classColor(penColour)} strokeWidth={2}
                      strokeDasharray={closing ? undefined : '5 3'}
                      vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}
          {box && (
            /* While lines are being drawn the selected box's body lets the click through:
               a line is drawn inside a box by nature, and the box would otherwise catch
               every stroke aimed at it. Its handles stay live, so it can still be resized. */
            <rect x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]}
                  fill="transparent" stroke={classColor(curEl!.class_name)} strokeWidth={2.5}
                  vectorEffect="non-scaling-stroke" className={tool === 'draw' ? undefined : 'cursor-move'}
                  pointerEvents={drawingLines ? 'none' : undefined}
                  onPointerDown={(e) => onEditPointerDown(e, { kind: 'element', id: curEl!.id, bbox: box })} />
          )}
          {poly && (
            <polygon data-testid={edited!.of === 'element' ? 'element-outline' : undefined}
                     points={poly.map(([x, y]) => `${x},${y}`).join(' ')} fill="transparent"
                     stroke={edited!.of === 'element' ? classColor(curOutlined!.class_name) : 'var(--ui-accent)'}
                     strokeWidth={2.5} vectorEffect="non-scaling-stroke"
                     className={tool === 'draw' ? undefined : 'cursor-move'}
                     pointerEvents={edited!.of === 'element' && drawingLines ? 'none' : undefined}
                     onPointerDown={(e) => onEditPointerDown(e, outlineTarget())} />
          )}
        </svg>
        {/* Handles are DOM, not SVG: nothing keeps an SVG shape's size fixed under zoom. */}
        {polyDraft && (
          <span
            data-testid="line-poly-close"
            data-armed={closing || undefined}
            title="Click here to close the line"
            style={{
              left: `${polyDraft[0][0] * 100}%`, top: `${polyDraft[0][1] * 100}%`,
              borderColor: classColor(penColour),
              backgroundColor: closing ? classColor(penColour) : 'white',
            }}
            className={`pointer-events-none absolute rounded-full border-2 ${
              closing ? '-ml-[7px] -mt-[7px] h-[14px] w-[14px]' : '-ml-[5px] -mt-[5px] h-[10px] w-[10px]'
            }`}
          />
        )}
        {tool === 'erase' && !handTool && brushAt && (
          <span
            data-testid="erase-brush"
            style={{
              left: `${brushAt[0] * 100}%`,
              top: `${brushAt[1] * 100}%`,
              width: brushPx * 2,
              height: brushPx * 2,
              marginLeft: -brushPx,
              marginTop: -brushPx,
            }}
            className="pointer-events-none absolute rounded-full border-2 border-dashed border-danger/80 bg-danger/10"
          />
        )}
        {polyDraft && (strokeFrom === null ? polyDraft : polyDraft.slice(0, strokeFrom)).map(([x, y], i) => (
          <span
            key={i}
            data-testid="line-poly-corner"
            style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
            className="pointer-events-none absolute -ml-[4px] -mt-[4px] h-[8px] w-[8px] rounded-full bg-accent"
          />
        ))}
        {boxDraft && penClass && (
          <span
            data-testid="box-draft-corner"
            title="Click again to finish the box - Escape drops it"
            style={{ left: `${boxDraft[0] * 100}%`, top: `${boxDraft[1] * 100}%`,
                     borderColor: classColor(penClass) }}
            className="pointer-events-none absolute -ml-[5px] -mt-[5px] h-[10px] w-[10px] rounded-sm border-2 bg-white/70"
          />
        )}
        {box &&
          HANDLES.map(([corner, fx, fy]) => (
            <span
              key={corner}
              data-testid="element-handle"
              onPointerDown={(e) => onEditPointerDown(e, { kind: 'element', id: curEl!.id, corner, bbox: box })}
              style={{ left: `${(box[0] + (box[2] - box[0]) * fx) * 100}%`,
                       top: `${(box[1] + (box[3] - box[1]) * fy) * 100}%`, cursor: `${corner}-resize` }}
              className="absolute -ml-[5px] -mt-[5px] h-[10px] w-[10px] rounded-sm border border-white bg-accent shadow"
            />
          ))}
        {poly &&
          poly.map(([x, y], i) => {
            const [bx, by] = poly[(i + 1) % poly.length]
            const alongX = Math.abs(bx - x) >= Math.abs(by - y)
            return (
              <span
                key={`s${i}`}
                data-testid="line-edge-handle"
                title={poly.length > 4 || edited!.of === 'element'
                  ? 'Drag: grow or shrink - hold Ctrl to move it freely - click to add a corner here'
                  : 'Drag: grow or shrink - hold Ctrl to move the edge freely'}
                onContextMenu={(e) => e.preventDefault()}
                onPointerDown={(e) => onEditPointerDown(e, outlineTarget({ ei: i }))}
                style={{ left: `${((x + bx) / 2) * 100}%`, top: `${((y + by) / 2) * 100}%`,
                         cursor: alongX ? 'ns-resize' : 'ew-resize' }}
                className="absolute -ml-[5px] -mt-[5px] h-[10px] w-[10px] rounded-sm border border-white bg-accent shadow"
              />
            )
          })}
        {poly &&
          poly.map(([x, y], i) => (
            <span
              key={`v${i}`}
              data-testid="line-vertex-handle"
              title={poly.length === 4
                ? 'Drag: resize, keeping the angle - hold Ctrl to move this corner alone'
                  + (edited!.of === 'element' ? ' - right-click to remove it' : '')
                : 'Drag to move this corner - right-click to remove it'}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (poly.length > 3) reshapeLine(dropVertex(poly, i))
              }}
              onPointerDown={(e) => onEditPointerDown(e, outlineTarget({ vi: i }))}
              style={{ left: `${x * 100}%`, top: `${y * 100}%`, cursor: 'grab', touchAction: 'none' }}
              className="absolute -ml-[5px] -mt-[5px] h-[10px] w-[10px] rounded-full border border-white bg-accent shadow"
            />
          ))}
        {poly && rotateHandle && (
          <>
            <span
              className="pointer-events-none absolute h-px origin-left bg-accent"
              style={{ left: `${rotateHandle.at[0] * 100}%`, top: `${rotateHandle.at[1] * 100}%`,
                       width: ROTATE_HANDLE_PX, transform: `rotate(${Math.atan2(rotateHandle.dir[1], rotateHandle.dir[0])}rad)` }}
            />
            <span
              data-testid="line-rotate-handle"
              title={`Drag to turn the ${edited!.of === 'element' ? 'element' : 'line'} - Shift snaps to ${TURN_SNAP_DEG}°`}
              onPointerDown={(e) => onEditPointerDown(e, outlineTarget({ rotate: true }))}
              style={{ left: `${rotateHandle.at[0] * 100}%`, top: `${rotateHandle.at[1] * 100}%`, cursor: 'grab',
                       touchAction: 'none',
                       transform: `translate(${rotateHandle.dir[0] * ROTATE_HANDLE_PX}px, ${rotateHandle.dir[1] * ROTATE_HANDLE_PX}px)` }}
              className="absolute -ml-[6px] -mt-[6px] h-[12px] w-[12px] rounded-full border-2 border-accent bg-white shadow"
            />
          </>
        )}
        {turning && (
          <span
            data-testid="line-angle"
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded bg-accent px-1 text-[10px] font-medium text-on-accent tabular-nums"
            style={{ left: `${turning.center[0] * 100}%`, top: `${turning.center[1] * 100}%` }}
          >
            {quadAngle(turning.poly, aspect).toFixed(1)}°
          </span>
        )}
      </div>
    )
  }

  // Split in two so selecting an element does not invalidate the whole overlay:
  // this layer holds every rect and never changes while an element is selected,
  // so its raster stays cached. Hover and selection are drawn separately.
  const contextRects = useMemo(
    () => (
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        onClick={overlayClick}
        onMouseOver={overlayOver}
        onMouseLeave={() => setHoveredEl(null)}
      >
        {shownContainers.map((el) => {
          const Shape = outlines && el.polygon ? 'polygon' : 'rect'
          return (
          <Shape
            key={el.id}
            {...(Shape === 'polygon'
              ? { points: el.polygon!.map(([x, y]) => `${x},${y}`).join(' ') }
              : { x: el.bbox[0], y: el.bbox[1], width: el.bbox[2] - el.bbox[0], height: el.bbox[3] - el.bbox[1] })}
            fill="transparent"
            stroke={classColor(el.class_name)}
            strokeWidth={1}
            strokeDasharray="4 3"
            strokeOpacity={0.5}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          )
        })}
        {shownElements.map((el) => {
          const Shape = outlines && el.polygon ? 'polygon' : 'rect'
          return (
          <Shape
            key={el.id}
            data-id={el.id}
            {...(Shape === 'polygon'
              ? { points: el.polygon!.map(([x, y]) => `${x},${y}`).join(' ') }
              : { x: el.bbox[0], y: el.bbox[1], width: el.bbox[2] - el.bbox[0], height: el.bbox[3] - el.bbox[1] })}
            fill={showConfidence ? confStroke(elMinConf(el)) : 'transparent'}
            fillOpacity={showConfidence ? 0.12 : undefined}
            stroke={showConfidence ? confStroke(elMinConf(el)) : classColor(el.class_name)}
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
            className="cursor-pointer"
          />
          )
        })}
      </svg>
    ),
    [shownContainers, shownElements, showConfidence, overlayClick, overlayOver, outlines],
  )

  const contextLabels = useMemo(
    () => (
      <div className="pointer-events-none absolute inset-0">
        {shownContainers.map((el) => (
          <span
            key={`c${el.id}`}
            className="absolute rounded-t-sm px-1 text-[9px] font-medium italic leading-3 text-white opacity-70"
            style={{
              left: `${el.bbox[0] * 100}%`,
              top: `${el.bbox[1] * 100}%`,
              transform: 'translateY(-100%)',
              backgroundColor: classColor(el.class_name),
            }}
          >
            {el.class_name}
          </span>
        ))}
        {shownElements.map((el) => (
          <span
            key={el.id}
            className="absolute rounded-t-sm px-1 text-[9px] font-medium leading-3 text-white"
            style={{
              left: `${el.bbox[0] * 100}%`,
              top: `${el.bbox[1] * 100}%`,
              transform: 'translateY(-100%)',
              backgroundColor: classColor(el.class_name),
            }}
          >
            {el.class_name}
          </span>
        ))}
      </div>
    ),
    [shownContainers, shownElements],
  )

  const highlightRects = () => {
    const ids = [...new Set([selected?.id, hoveredEl].filter((v): v is number => !!v))]
    const hot = ids.map((id) => elementById.get(id)).filter((e): e is PageElement => !!e)
    if (!hot.length) return null
    return (
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        {hot.map((el) => (
          <rect
            key={el.id}
            x={el.bbox[0]}
            y={el.bbox[1]}
            width={el.bbox[2] - el.bbox[0]}
            height={el.bbox[3] - el.bbox[1]}
            fill={showConfidence ? confStroke(elMinConf(el)) : classColor(el.class_name, 0.15)}
            fillOpacity={showConfidence ? 0.3 : undefined}
            stroke={showConfidence ? confStroke(elMinConf(el)) : classColor(el.class_name)}
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    )
  }

  const highlightLabel = () =>
    showLabels && selected && elementById.has(selected.id) ? (
      <span
        className="pointer-events-none absolute rounded-t-sm px-1 text-[9px] font-medium leading-3 text-white"
        style={{
          left: `${selected.bbox[0] * 100}%`,
          top: `${selected.bbox[1] * 100}%`,
          transform: 'translateY(-100%)',
          backgroundColor: classColor(selected.class_name),
        }}
      >
        {selected.class_name}
      </span>
    ) : null

  const panelBox = `h-full overflow-auto ${boxChrome}`
  // The viewer draws into the pane and clips to it; the overlay is placed over the scan
  // by the surface, in pixels, so it is out of the flow and starts hidden.
  const scanPane = `relative h-full overflow-hidden ${boxChrome}`
  const overlayBoxClass = 'absolute left-0 top-0 z-10 origin-top-left invisible'

  /** The region the selected line is actually cut from - the padded rectangle the crop is
   *  warped out of, which is not the polygon. On a line the backend will not deskew it is an
   *  upright box swallowing the neighbours, and that is worth being able to see. */
  const cropRegion = () => {
    if (!selectedLine || !page) return null
    const plan = cropPlan(selectedLine.polygon, aspect, selectedLine.orientation)
    return (
      <svg viewBox="0 0 1 1" preserveAspectRatio="none"
           data-testid="crop-region"
           data-deskewed={plan.deskewed}
           className="pointer-events-none absolute inset-0 h-full w-full">
        <polygon
          points={plan.quad.map(([x, y]) => `${x},${y}`).join(' ')}
          fill="none"
          stroke={plan.deskewed ? 'var(--ui-warn)' : 'var(--ui-danger)'}
          strokeWidth="1.5"
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  const overlayPolys = (lines: Line[], pointsFn: (l: Line) => string, prefix: string) => (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <defs>
        {showConfidence &&
          lines.map((line) => {
            if (!line.conf_profile) return null
            // Along the line the crop laid flat, not along the page. The profile places each
            // character as a fraction of that crop's width, so a gradient left to right across
            // the bounding box - which is what objectBoundingBox units give - slides the
            // colours off the characters on anything tilted.
            const axis = cropAxis(line.polygon, aspect, line.orientation)
            const along = axis
              ? { gradientUnits: 'userSpaceOnUse' as const,
                  x1: axis[0][0], y1: axis[0][1], x2: axis[1][0], y2: axis[1][1] }
              : { x1: 0, y1: 0, x2: 1, y2: 0 }
            return (
              <linearGradient key={line.id} id={`${prefix}-${line.id}`} {...along}>
                {profileStops(line.conf_profile).map((s, i) => (
                  <stop key={i} offset={s.offset} stopColor={s.color} />
                ))}
              </linearGradient>
            )
          })}
      </defs>
      {lines.map((line) => {
        const hot = hoveredLine === line.id || activeLine === line.id
        const heat = showConfidence && line.conf_profile
        return (
          <polygon
            key={line.id}
            points={pointsFn(line)}
            fill={heat ? `url(#${prefix}-${line.id})` : hot ? 'color-mix(in srgb, var(--ui-accent) 25%, transparent)' : 'color-mix(in srgb, var(--ui-accent) 6%, transparent)'}
            fillOpacity={heat ? (hot ? 0.7 : 0.45) : undefined}
            stroke={showConfidence ? confStroke(line.confidence) : hot ? 'var(--ui-accent)' : 'color-mix(in srgb, var(--ui-accent) 90%, transparent)'}
            strokeWidth={hot ? 2.5 : 1.5}
            vectorEffect="non-scaling-stroke"
            className="pointer-events-auto cursor-pointer"
            onMouseEnter={(e) => hoverLine(e, line.id)}
            onMouseMove={(e) => hoverLine(e, line.id)}
            onMouseLeave={() => setHoveredLine(null)}
            onClick={() => activateLine(line.id)}
          />
        )
      })}
    </svg>
  )

  /** Every reader of one line, models first and the local OCR last - the order they are
   *  weighed in. A reading the line has since been read past is not offered at all, so
   *  the OCR row here is the current one. */
  const showReadings = (line: Line, badge: HTMLElement, pinned = false) => {
    const held = (candidatesByLine.get(line.id) ?? [])
      .map((candidate) => ({
        key: String(candidate.id),
        reader: readerName(candidate.source, candidate.author),
        text: candidate.text,
        source: candidate.source,
        candidateId: candidate.id,
      }))
    const rows: Reading[] = line.text
      ? [...held, { key: 'line', reader: 'OCR', text: line.text, source: 'ocr' as const }]
      : held
    if (rows.length === 0) return
    const box = badge.getBoundingClientRect()
    // A checked line keeps the readings it was checked on, so they are not offered for deleting.
    setReadings({ rows, top: box.bottom + 4, right: window.innerWidth - box.right, pinned,
                  removable: canEdit && !line.checked })
  }

  // The rail after a line's text: one slot per thing a row can carry, kept at its width
  // whether or not this row carries it. A line gaining an edit then moves nothing beside
  // it, and the readings down the panel line up as columns instead of landing wherever
  // each row's text happened to end.
  const SLOT = 'flex shrink-0 items-center justify-end'
  // Narrow, nothing gives way: the row stacks instead, the reading on a line of its own and
  // the rail right-aligned under it, so the columns still line up down the panel.
  const ACTION_SLOT = `${SLOT} w-5`

  // Settled by the models agreeing, checked by nobody: review work, and badged as such.
  // Once a person checks it, it is theirs and reads as any other correction.
  const isSettled = (line: Line) =>
    line.corrected_by?.startsWith('llm:consensus') === true && !line.checked

  const lineContent = (line: Line, hot: boolean) => (
    <>
      <input
        type="checkbox"
        checked={line.checked}
        onChange={(e) => toggleLineChecked(line, e.target.checked)}
        onClick={(e) => e.stopPropagation()}
        title="Checked"
        className="shrink-0 cursor-pointer accent-accent"
      />
      {editingId === line.id ? (
        // A textarea, not an input: a long line is shown wrapped over as many rows as it
        // takes, and clicking into it must not collapse that into one scrolling row. It is
        // still one line of transcription - Enter saves it, and a pasted break is folded
        // into a space rather than splitting it in two.
        <textarea
          ref={editInputRef}
          data-testid="line-editor"
          autoFocus
          rows={1}
          value={draft}
          onChange={(e) => {
            const typed = e.target.value.replace(/\s*\n\s*/g, ' ')
            editDraft(typed, typed === e.target.value ? e.target.selectionStart : typed.length)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              // Shift+Enter means the same here as on the row behind it: saved, checked
              // off, on to the next line. It took two presses while the editor only ever
              // closed itself, because the key never reached the handler on the window.
              const saved = saveEdit(line)
              if (e.shiftKey) void saved.then((done) => done && checkAndAdvance(done))
            } else if (e.key === 'Escape') {
              // Escape leaves the editor, not the work: what was typed is kept, the same
              // as clicking away keeps it. Undoing a correction is the revert beside it.
              void saveEdit(line)
            }
          }}
          onBlur={() => saveEdit(line)}
          // Exactly the box the text it replaces occupied: an outline rather than a border
          // and no padding of its own, because either would make the row taller on the way
          // in and shorter on the way out, and everything below it jump by that much.
          className="w-full min-w-0 flex-1 resize-none overflow-hidden rounded bg-surface font-ocr text-sm leading-6 outline outline-1 outline-accent"
        />
      ) : (
        <span
          data-testid="line-text"
          onClick={() => startEdit(line)}
          className={`min-h-5 min-w-0 flex-1 cursor-text font-ocr text-sm leading-6 ${
            hot ? 'text-accent-ink' : 'text-ink'
          }`}
        >
          {displayed(line.corrected_text ?? line.text ?? '')}
        </span>
      )}
      {/* Narrow, the row stacks: this ends the reading's line, and the rail wraps under it. */}
      <span aria-hidden="true" className="hidden h-0 basis-full @max-md:block" />
      <span data-testid="edited-slot" className={`${SLOT} w-11 @max-md:ml-auto`}>
        {isSettled(line) ? (
          // Agreement without a check is not a review: the line is flagged like any other
          // unchecked one, and says why it is there.
          <>
            <span data-testid="settled-badge"
                  title="Settled by the models agreeing - not checked by anyone yet"
                  className="rounded bg-series-7/15 px-1 text-[10px] font-medium text-series-7">
              settled
            </span>
          </>
        ) : line.corrected_text !== null && editingId !== line.id && (
          <>
            <span className="rounded bg-accent-wash px-1 text-[10px] font-medium text-accent-ink">
              edited
            </span>
          </>
        )}
      </span>
      <span className={ACTION_SLOT}>
        {line.corrected_text !== null && editingId !== line.id && (
          <button
            onClick={() => revert(line)}
            title="Revert to OCR text"
            className="rounded px-0.5 text-sm leading-none text-ink-muted hover:text-danger"
          >
            ↺
          </button>
        )}
      </span>
      <span className={ACTION_SLOT}>
      {canReread && !line.needs_ocr && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            reocrOneLine(line)
          }}
          title="Re-run OCR on this line"
          className="rounded px-0.5 text-ink-subtle hover:text-accent-ink"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 4v6h6M20 20v-6h-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M5 13a7 7 0 0 0 12 4M19 11a7 7 0 0 0-12-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {line.needs_ocr && (
        <span title="Re-reading…" className="text-accent">
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
      )}
      </span>
      <span className={`${SLOT} w-7`}>
      {line.llm_agree_count >= 2 && (
        // Where the models agree and the local model reads something else is exactly the
        // line worth a person's eyes - and the most useful line to train on.
        <span
          data-testid="agree-badge"
          data-disputed={line.corrected_text !== null && !sameText(line.text ?? '', line.corrected_text) || undefined}
          aria-label={line.corrected_text !== null && line.text !== line.corrected_text
            ? `${line.llm_agree_count} models agree, and read it differently from the OCR model`
            : `${line.llm_agree_count} models agree`}
          onMouseEnter={(e) => { if (!readings?.pinned) showReadings(line, e.currentTarget) }}
          onMouseLeave={() => { if (!readings?.pinned) setReadings(null) }}
          onClick={(e) => { e.stopPropagation(); showReadings(line, e.currentTarget, true) }}
          title="Click to keep the readings open"
          className={`cursor-pointer rounded px-1 text-[10px] font-medium ${
            line.corrected_text !== null && line.text !== line.corrected_text
              ? 'bg-warn/15 text-warn'
              : 'bg-series-7/15 text-series-7'
          }`}
        >
          {line.llm_agree_count}×
        </span>
      )}
      </span>
      <span
        data-testid="line-confidence"
        className={`w-10 shrink-0 rounded px-1 py-0.5 text-right text-[10px] font-medium tabular-nums ${confBadgeClass(line.confidence)}`}
      >
        {line.confidence !== null ? `${Math.round(line.confidence * 100)}%` : '–'}
      </span>
    </>
  )

  // Readings that matched no line at all: usually a line the segmentation missed.
  const unmatchedReadings = useMemo(
    () => candidates.filter((c) => c.line_id === null && !c.dismissed),
    [candidates],
  )

  // Choosing a reading is the same as typing it - the correction becomes yours, checked,
  // and a clash with someone else's edit is offered rather than overwritten. A reading from
  // the pool displacing typed text has that text offered back; the model's own read is the
  // line's and not a reading taken, so putting it back offers nothing.
  const acceptCandidate = async (line: Line, candidate: LineCandidate) => {
    const fromPool = candidate.id !== MACHINE_ID
    const saved = await saveText(line, candidate.text, line.revision, fromPool)
    if (saved && fromPool) await reloadCandidates()
  }

  const lineRow = (line: Line) => {
    const hot = hoveredLine === line.id || activeLine === line.id
    const over = dropLine === line.id
    const taken = takenReading(line)
    return (
      <div
        key={line.id}
        ref={(n) => {
          if (n) rowRefs.current.set(line.id, n)
          else rowRefs.current.delete(line.id)
        }}
        data-testid="line-row"
        data-line-id={line.id}
        data-hot={hot || undefined}
        data-drop-target={armed !== null || undefined}
        onMouseEnter={(e) => hoverLine(e, line.id)}
        onMouseMove={(e) => hoverLine(e, line.id)}
        onMouseLeave={() => setHoveredLine(null)}
        // A reading being dragged, or armed by a click, lands on the row it is let go over.
        // The drag handlers are always attached and read the ref: gating them on the state
        // loses a drop that arrives before the re-render that would add them.
        onDragOver={(e) => {
          if (!armedRef.current) return
          e.preventDefault()
          setDropLine(line.id)
        }}
        onDragLeave={() => setDropLine((held) => (held === line.id ? null : held))}
        onDrop={(e) => {
          const held = armedRef.current
          if (!held) return
          e.preventDefault()
          void attachReading(held, line.id)
        }}
        // Capture, so arming turns the whole row into one target: without it the click
        // would also reach the line's own text and open the editor behind the drop.
        onClickCapture={armed ? (e) => {
          e.stopPropagation()
          void attachReading(armed, line.id)
        } : undefined}
        className={`group flex items-center gap-1.5 rounded px-1 @max-md:flex-wrap @max-md:gap-y-0 ${
          over
            ? 'outline outline-2 outline-accent'
            : armed
              ? 'cursor-copy outline-dashed outline-1 outline-accent/60'
              : ''
        } ${hot && !over
          // Once the cursor is down among the readings, the line is only context: it keeps
          // a tint to say where we are, and the reading takes the colour that means focus.
          ? readingCursor !== null
            ? 'bg-accent-wash/70'
            : 'bg-accent-wash'
          : ''}`}
      >
        {lineContent(line, hot)}
        <span className={ACTION_SLOT}>
        {canEdit && taken && (
          <button
            type="button"
            data-testid="release-line-reading"
            onClick={(e) => { e.stopPropagation(); void attachReading(taken, null) }}
            title="Take this reading off the line and put it back in the list"
            aria-label="Release this reading"
            className="rounded px-0.5 text-ink-subtle hover:text-danger"
          >
            {/* A chain broken across the middle: the reading is let go of, not thrown
                away. The cross beside it is what throws the line away. */}
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M9.5 12h5"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              />
              <path d="M4 20 20 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        </span>
        <span className={ACTION_SLOT}>
        {canEdit && (
          <button
            data-testid="delete-line"
            onClick={(e) => {
              e.stopPropagation()
              // A stray detection is deleted on the spot; a line somebody has corrected or
              // checked is work, so it asks first even though Ctrl+Z would bring it back.
              const own = line.checked || line.corrected_text !== null
              if (own && !window.confirm('Delete this line? It carries a correction or a check.')) return
              commitLineDelete(line.id)
            }}
            title="Delete this line and its box"
            aria-label="Delete line"
            className="rounded px-0.5 text-sm leading-none text-ink-subtle hover:text-danger"
          >
            ×
          </button>
        )}
        </span>
        <PresenceAvatars entries={onTarget('line', line.id)} />
      </div>
    )
  }

  const lineBlock = (line: Line) => (
    <div key={`block-${line.id}`}>
      {lineRow(line)}
      {activeLine === line.id && (
        <LineCandidates
          candidates={candidatesByLine.get(line.id) ?? []}
          current={line.corrected_text ?? line.text ?? ''}
          canEdit={canEdit}
          activeId={readingCursor}
          machine={line.text ? { text: line.text, author: line.text_author } : null}
          onAccept={(candidate) => acceptCandidate(line, candidate)}
          onRelease={(candidate) => void attachReading(candidate, null)}
          onRemove={(candidate) => void deleteReading(candidate.id)}
        />
      )}
    </div>
  )

  const runPhase = async (phase: PagePhase) => {
    if (!page || runningJob) return
    try {
      await runPagePhase(page.id, phase)
      waitForJobThenReload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // A reading runs on the worker's own cadence, so nothing here waits on it: the pill
  // below polls while anything is in flight and reloads the page once the queue drains -
  // agreement may have filled a line in the meantime.
  const reloadReadings = useCallback(async () => {
    if (!page) return
    await reloadPage()
    await reloadCandidates()
  }, [page, reloadPage])

  // The pill speaks for the page on screen, so every ask is for that page alone - a run
  // working through the rest of the dataset is not this page being read, which is what it
  // used to go on claiming after an arrow key.
  const readsWithModels = (job?.llm_model_ids ?? []).length > 0
  const shownPage = page?.id ?? null
  useEffect(() => {
    if (shownPage === null || !readsWithModels) return
    getLlmReadStatus(jobId, [shownPage]).then(setReading).catch(() => undefined)
  }, [jobId, shownPage, readsWithModels])

  // Poll only while something is in flight, and reload once it stops - the same shape the
  // dataset page uses for the same worker.
  useEffect(() => {
    if (!reading?.active || shownPage === null) return
    const timer = window.setInterval(() => {
      getLlmReadStatus(jobId, [shownPage])
        .then((status) => {
          setReading(status)
          if (!status.active) void reloadReadings()
        })
        .catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [reading?.active, jobId, shownPage, reloadReadings])

  // While the page is being read, the chip's x stops that reading - the call in flight
  // included - rather than only hiding the chip and leaving the answer to land anyway.
  const stopReading = () => {
    const active = reading?.active
    setReading(null)
    if (active && shownPage !== null) {
      cancelLlmRead(jobId, [shownPage]).then(() => reloadReadings()).catch((e: Error) => setError(e.message))
    }
  }

  const arm = (candidate: LineCandidate | null) => {
    armedRef.current = candidate
    setArmed(candidate)
  }

  // Gone for good, and the agreement it was part of is worked out again without it.
  const deleteReading = async (candidateId: number) => {
    try {
      setCandidates((await removeCandidate(candidateId)).candidates)
      await reloadPage()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const attachReading = async (candidate: LineCandidate, lineId: number | null) => {
    arm(null)
    setDropLine(null)
    try {
      setCandidates((await attachCandidate(candidate.id, lineId)).candidates)
      // Putting a reading on a line says it belongs there, so the line takes it - unless
      // somebody has already reviewed that line, which is not this gesture's to undo.
      const onto = lineId === null ? undefined : pageLines.find((l) => l.id === lineId)
      if (onto && !onto.checked) await saveText(onto, candidate.text, onto.revision, true)
      await Promise.all([reloadPage(), reloadCandidates()])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const deleteCurrent = () => {
    if (selKind === 'line' && activeLine !== null) commitLineDelete(activeLine)
    else if (selKind === 'element' && selectedId !== null) commitDelete(selectedId)
  }

  const classRail = () => {
    // One pen class: its colour, its digit hint, and an eye to hide the class on the page.
    const shapeToggle = (shape: LinePenShape, label: string, hint: string, icon: ReactNode) => (
      <Toggle
        on={tool === 'draw' && penClass === LINE_CLASS && linePenShape === shape}
        data-testid={`line-pen-${shape}`}
        aria-label={label}
        title={hint}
        onClick={() => pickLinePen(shape)}
        className="flex shrink-0 justify-center px-1"
      >
        {icon}
      </Toggle>
    )

    const elementShapeToggle = (shape: LinePenShape, label: string, hint: string, icon: ReactNode) => (
      <Toggle
        on={elementPenShape === shape}
        data-testid={`element-pen-${shape}`}
        aria-label={label}
        title={hint}
        onClick={() => setElementPenShape(shape)}
        className="flex shrink-0 justify-center px-1"
      >
        {icon}
      </Toggle>
    )

    const penGroup = (label: string, items: readonly (readonly [string, number | null])[]) => (
      <PenPanel
        heading={label}
        pens={items.map(([name, digit]) => ({
          key: name, label: name, color: classColor(name), digit, hidden: hidden.has(name),
        }))}
        active={tool === 'draw' ? penClass : null}
        selected={curLine ? LINE_CLASS : curEl?.class_name ?? null}
        onPick={(key) => pickClass(String(key))}
        onToggleHidden={(key) => toggleHidden(String(key))}
        extra={(pen) => pen.key === LINE_CLASS ? (
          <>
            {shapeToggle('box', 'Draw lines as a box', 'Box: three clicks - the start of the line, its end, then its height', <TurnedBoxIcon />)}
            {shapeToggle('polygon', 'Draw lines as a polygon', 'Polygon: a corner per click - click the first corner again to close it', <PolygonIcon />)}
          </>
        ) : outlines && tool === 'draw' && penClass === pen.key ? (
          <>
            {elementShapeToggle('box', 'Draw as a box', 'Box: drag, or click two corners', <TurnedBoxIcon />)}
            {elementShapeToggle('polygon', 'Draw as an outline', 'Outline: a corner per click - click the first corner again to close it', <PolygonIcon />)}
          </>
        ) : null}
      />
    )
    const content = layoutClasses.map((c, i) => [c, i < 10 ? (i + 1) % 10 : null] as const)
      .filter(([c]) => !containerClasses.has(c))
    const containerItems = layoutClasses.map((c, i) => [c, i < 10 ? (i + 1) % 10 : null] as const)
      .filter(([c]) => containerClasses.has(c))
    // What the selection is, and how to change it - the pills above say what the next
    // stroke will be, which is a different question and used to be answered in the same
    // place. A line's class is fixed; what it has instead is its shape.
    const selectionPanel = () => {
      if (curLine) {
        const quad = curLine.polygon.length === 4
        return (
          <div className="space-y-1">
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
              Line shape
            </div>
            <div className="flex gap-1">
              <Toggle
                on={quad}
                data-testid="line-shape-box"
                aria-label="Make this line a box"
                title="Box: four corners kept square to each other - dragging one keeps the angle"
                onClick={() => !quad && reshapeLine(minAreaQuad(curLine.polygon, aspect))}
                className="flex flex-1 justify-center"
              >
                <TurnedBoxIcon />
              </Toggle>
              <Toggle
                on={!quad}
                data-testid="line-shape-polygon"
                aria-label="Make this line a polygon"
                title="Polygon: corners that move on their own - click a side to add one, right-click a corner to remove it"
                onClick={() => quad && reshapeLine(splitLongSides(curLine.polygon, aspect))}
                className="flex flex-1 justify-center"
              >
                <PolygonIcon />
              </Toggle>
            </div>
          </div>
        )
      }
      if (!curEl) return null
      return (
        <div className="space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
            Selected
          </div>
          <Select
            size="xs"
            data-testid="selected-class"
            aria-label="Class of the selected box"
            value={curEl.raw_class_name ?? curEl.class_name}
            onChange={(e) => commitClass(curEl, e.target.value)}
            className="w-full"
          >
            {layoutClasses.filter((c) => c !== LINE_CLASS).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </div>
      )
    }

    return (
      <>
        <div className="space-y-1">
          <Toggle on={!!page?.layout_checked} onClick={toggleLayoutChecked} className="w-full">
            Layout complete <span className="opacity-60">{comboLabel(hk.verify)}</span>
          </Toggle>
          <Toggle on={!!page?.lines_checked} onClick={toggleLinesChecked} className="w-full">
            Lines complete
          </Toggle>
          <div className="flex gap-1">
            <Button size="xs" onClick={deleteCurrent} disabled={curSelId() === null} className="flex-1">
              Delete
            </Button>
            <Button size="xs" onClick={undo} disabled={!canUndo} className="flex-1">
              Undo
            </Button>
            <Button size="xs" onClick={redo} disabled={!canRedo} className="flex-1">
              Redo
            </Button>
          </div>
        </div>
        <ToolPalette
          tool={handTool ? 'hand' : tool}
          onTool={(t) => (t === 'select' ? pickClass(null) : setTool(t))}
          capabilities={{ erase: true, detect: false }}
          bindings={{ select: hk.toolSelect, hand: hk.toolHand, draw: hk.toolDraw, erase: hk.toolErase }}
        />
        {tool === 'erase' && <BrushPanel radius={brushRadius} onRadius={setBrushRadius} />}
        {penGroup('Lines', [[LINE_CLASS, null]])}
        {penGroup('Content', content)}
        {penGroup('Containers', containerItems)}
        {selectionPanel()}
        {/* Only worth showing where it does something: the lines of a page with no
            layout boxes. Inside a box the boxes carry the reading order. */}
        {unassignedLines > 0 && page && (
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
              Reading order
            </p>
            <Select
              size="xs"
              data-testid="page-reading-order"
              title={page.reading_order_template
                ? `Set by the ${page.reading_order_template} template of this dataset's layout model`
                : 'How the lines of this page are ordered where no layout box orders them'}
              disabled={!!page.reading_order_template}
              className="w-full min-w-0 truncate"
              value={page.reading_order ?? ''}
              onChange={(e) => {
                const structure = e.target.value
                setPageReadingOrder(page.id, structure)
                  .then((saved) => {
                    recordEdit(saved.span)
                    return reloadPage()
                  })
                  .catch((err: Error) => fail(err))
              }}
            >
              <option value="">
                {`Dataset: ${READING_ORDER_LABEL[page.job_reading_order] ?? page.job_reading_order}`}
              </option>
              {READING_ORDERS.map((value) => (
                <option key={value} value={value}>{READING_ORDER_LABEL[value]}</option>
              ))}
            </Select>
          </div>
        )}
        <ObjectList
          heading="Regions"
          count={`${regionElements.length} · ${regionElements.reduce((n, el) => n + el.lines.length, 0) + unassignedLines} lines`}
          items={regionElements.map((el) => ({
            id: el.id,
            label: el.class_name,
            color: classColor(el.class_name),
            index: boxNumber.get(el.id) ?? el.order_idx + 1,
            group: el.class_name,
            meta: el.kind === 'container'
              ? <span className="shrink-0 text-ink-subtle" title="Holds other regions, no text">⊞</span>
              : <span className="shrink-0 tabular-nums text-ink-subtle">{el.lines.length}</span>,
            hidden: hiddenEls.has(el.id) || hidden.has(el.class_name),
            lines: el.lines.map((line) => ({
              id: line.id,
              label: LINE_CLASS,
              color: classColor(LINE_CLASS),
              index: line.order_idx + 1,
              meta: <span className="truncate text-ink-subtle">{line.corrected_text ?? line.text}</span>,
              hidden: hiddenEls.has(el.id) || hidden.has(el.class_name) || hidden.has(LINE_CLASS),
            })),
          }))}
          selectedId={selKind === 'element' ? selectedId : null}
          selectedLineId={selKind === 'line' ? activeLine : null}
          hoveredId={hoveredEl}
          grouping={{ value: grouping, onChange: setGrouping }}
          onSelect={selectRegion}
          onSelectLine={selectLine}
          onHover={setHoveredEl}
          onToggleHidden={toggleHiddenElement}
          unassigned={{ count: unassignedLines, label: 'Unassigned' }}
          empty={unassignedLines > 0 ? 'No layout regions on this page.' : 'No regions on this page.'}
        />
      </>
    )
  }

  const shortcutGroups = [
    { title: 'Tools', rows: [
      [comboLabel(hk.toolSelect), 'Select'], [hk.toolHand ? comboLabel(hk.toolHand) : 'Space (hold)', 'Hand'],
      [comboLabel(hk.toolDraw), 'Draw with the pen'],
      [comboLabel(hk.toolErase), 'Erase'],
    ] as [string, string][] },
    { title: 'Selecting', rows: [
      ['click', 'select · again steps out'], ['+ / −', 'step out / in'],
      ['Shift+click', 'add to the set'], ['Shift+drag', 'sweep the visible ones into it'],
      [comboLabel(hk.split), 'cut: drag across, or click'], [comboLabel(hk.merge), 'merge the set'],
      ['Delete', 'delete'], ['1-9', 'pick a pen'],
    ] as [string, string][] },
    { title: 'Drawing', rows: [
      ['drag', 'draw a box with the pen class'], ['click · click', 'the same box in two clicks'],
      ['Ctrl+press', 'draw through what is already there'],
      ['Line pen', 'click start · end · height'], ['Line polygon', 'a corner per click · first again closes'],
      ['Enter · right-click · double-click', 'finish the polygon'],
      ['Backspace', 'take the last corner back'], ['Esc', 'cancel'],
    ] as [string, string][] },
    { title: 'Reshaping', rows: [
      ['click a side', 'add a corner to a polygon'], ['right-click a corner', 'remove it'],
      ['Erase: drag', 'sweep corners away · under three the line goes'],
      ['Erase: Shift+drag', 'take checked and corrected lines too'],
      ['corner', 'resize · Ctrl skews'], ['edge', 'grow · Ctrl moves'],
      ['ring', `turn · Shift snaps ${TURN_SNAP_DEG}°`],
      [`${comboLabel(hk.lineTurnCcw)} ${comboLabel(hk.lineTurnCw)}`, `turn ${TURN_STEP_DEG}°`],
      [`${comboLabel(hk.rotateCw)} ${comboLabel(hk.rotateCcw)}`, 'turn the loupe crop a quarter'],
    ] as [string, string][] },
    { title: 'View', rows: [
      ['hand', 'drag to move the page · Alt-drag anywhere'], ['Ctrl+wheel', 'zoom'],
      ['Shift+wheel', 'size the eraser\'s brush'],
      ['Ctrl+Z · Ctrl+Shift+Z', 'undo · redo'], [comboLabel(hk.edit), 'edit mode'],
      [`${comboLabel(hk.prevPage)} · ${comboLabel(hk.nextPage)}`, 'previous · next page'],
      [`${comboLabel(hk.lineUp)} · ${comboLabel(hk.lineDown)}`, 'previous · next line'],
      [comboLabel(hk.readings), 'into the line\'s readings, and on through them'],
      [comboLabel(hk.verify), 'layout complete'], [comboLabel(hk.reocr), 're-read the focused line'], ['?', 'this sheet'],
    ] as [string, string][] },
  ]
  const sentence = editing
              ? tool === 'hand'
                ? 'Hand - drag to move the page; holding Space does the same in any tool'
                : tool === 'erase'
                ? 'sweep over a line\'s corners to rub them out · a line left under three goes · ⇧ takes checked lines too'
                : polyDraft
                ? polyDraft.length >= 3
                  ? 'click the first corner to close · ⌫ takes one back · Esc cancel'
                  : 'click each corner of the line · ⌫ takes one back · Esc cancel'
                : lineDraft
                ? lineDraft.b
                  ? 'click to set the line height · Esc cancel'
                  : 'click the other end of the side · Esc cancel'
                : cutArmed
                ? 'drag a cut across the selection, or click to cut straight across there · Esc cancel'
                : mergeSet.size
                  ? `${mergeSet.size} selected · m merges · Entf deletes · Esc clears`
                  : 'click to select · drag to edit · ⇧click/⇧drag multi · s split · m merge · Entf delete · ⌘Z undo · Esc exit'
              : reviewMode
                ? `↑/↓ flagged lines · ${comboLabel(hk.readings)} readings · Enter edit · ⇧Enter check + next · Esc back · e edit`
                : canLineNav
                  ? '←/→ pages · ↑/↓ lines · Enter edit · ⇧Enter check + next · Esc back · e edit'
                  : '←/→ pages · Esc back · e edit'
  return (
    <>
    <EditorShell
      headerTestId="viewer-header"
      style={{ ['--vkbd-h' as string]: `${kbVisible ? kbHeight : 0}px` }}
      header={{
        left: (<>
          {page && <span className="min-w-0 truncate text-xs text-ink-subtle">{page.filename}</span>}
          {page && (
            <NoteTag note={page.note} title={page.filename} canEdit={canEdit} addable onSave={async (text) => {
              const note = await setPageNote(page.id, text)
              setPage((p) => (p ? { ...p, note } : p))
              return note
            }} />
          )}
          {page && job && (isAdmin || job.owner === user)
            ? <TestPageSwitch on={page.is_test} onClick={toggleTestPage} data-testid="page-test-toggle" />
            : page?.is_test && <TestDataChip data-testid="page-test-chip">Test page</TestDataChip>}
          {page && <PresenceBanner entries={onPage(page.id)} />}
          {accuracy && (
            <span data-testid="page-error-rate"
                  data-cer={accuracy.cer.toFixed(4)}
                  data-wer={accuracy.wer.toFixed(4)}
                  data-lines={accuracy.lines}
                  title={`What the OCR got wrong on the ${accuracy.lines} line${
                    accuracy.lines === 1 ? '' : 's'} checked off here, against what was settled on. `
                    + 'Lines language models checked among themselves do not count.'}
                  className="flex shrink-0 items-center gap-1.5 rounded bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-muted">
              CER {percent(accuracy.cer)} <span className="opacity-40">·</span> WER {percent(accuracy.wer)}
              <span className="opacity-60">{accuracy.lines} checked</span>
            </span>
          )}
          {reading && (reading.active || reading.error > 0) && (
            <span data-testid="llm-run-pill"
                  className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium ${
                    reading.active
                      ? 'bg-accent-wash text-accent-ink'
                      : 'bg-danger/15 text-danger'
                  }`}>
              {reading.active
                ? `Reading with ${reading.models.filter((m) => m.pending + m.running > 0)
                    .map((m) => m.label).join(', ') || 'the models'}…`
                : `${reading.error} reading${reading.error === 1 ? '' : 's'} failed`}
              <button onClick={stopReading} aria-label={reading.active ? 'Stop reading this page' : 'Dismiss'}
                      title={reading.active ? 'Stop reading this page' : undefined}
                      data-testid="llm-run-pill-dismiss"
                      className="opacity-60 hover:opacity-100">×</button>
            </span>
          )}
          {reviewMode && queue && (
            <span className="flex shrink-0 items-center gap-2 rounded bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">
              {queuePosition === -1
                ? `${queue.total} to review`
                : `Review ${queuePosition + 1} / ${queue.total}`}
              <select
                value={maxConf}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setReviewConf(next)
                  navigate(`/jobs/${jobId}/pages/${pageId}?review=${next}`, { replace: true })
                }}
                title="Confidence threshold"
                className="cursor-pointer bg-transparent text-[11px] text-warn"
              >
                {REVIEW_THRESHOLDS.map((t) => (
                  <option key={t} value={t}>
                    under {Math.round(t * 100)}%
                  </option>
                ))}
              </select>
              <Link to={`/jobs/${jobId}/pages/${pageId}`} className="underline underline-offset-2">
                exit
              </Link>
            </span>
          )}
        </>),
        actions: (<>
            <ButtonGroup aria-label="Show on the scan">
              <GroupButton on={showLayout} onClick={() => setShowLayout((v) => !v)}>Layout</GroupButton>
              <GroupButton on={showLinePolys} onClick={toggleLinePolys}>Lines</GroupButton>
              <GroupButton on={showLabels} onClick={() => setShowLabels((v) => !v)}>Labels</GroupButton>
              <GroupButton on={showConfidence} onClick={() => setShowConfidence((v) => !v)}>Confidence</GroupButton>
              <GroupButton on={showOrder} onClick={() => setShowOrder((v) => !v)}>Order</GroupButton>
            </ButtonGroup>
            {canEdit && page && (
              <>
                <BarDivider />
                <RunMenu
                  pageId={page.id}
                  jobId={jobId}
                  llmModelIds={job?.llm_model_ids ?? []}
                  busy={runningJob}
                  onRun={runPhase}
                  onReadPage={() => setReadOpen(true)}
                  onError={setError}
                />
                <ButtonGroup aria-label="Turn the scan">
                  {([[-90, 'anticlockwise'], [90, 'clockwise']] as const).map(([degrees, way]) => (
                    <GroupButton
                      key={degrees}
                      data-testid="turn-page"
                      data-degrees={degrees}
                      disabled={runningJob}
                      aria-label={`Turn the scan ${way}`}
                      title={`Turn the scan ${way} - it and everything drawn on it, for good`}
                      onClick={() => turnScan(degrees)}
                    >
                      <RotateIcon way={way} />
                    </GroupButton>
                  ))}
                </ButtonGroup>
              </>
            )}
            <BarDivider />
            {canEdit && (
              // With no keys there is nothing to show - but taking the control away with
              // them leaves the keyboard with no way back from the page that wants it,
              // so it stays and points at the one place that can fill it.
              <Button
                variant="ghost"
                size="xs"
                aria-pressed={hasKeys && keyboardMode !== 'hide'}
                aria-label={`Keys ${hasKeys ? keyboardMode : 'none'}`}
                onClick={hasKeys ? cycleKeyboardMode : () => navigate('/settings?section=characters')}
                title={hasKeys
                  ? 'Virtual keyboard: auto shows it while editing a line'
                  : 'The character keyboard has no keys yet - pick them in Settings'}
                className={hasKeys && keyboardMode !== 'hide' ? 'text-accent-ink' : ''}
              >
                <KeyboardIcon /> <span className="opacity-70">{hasKeys ? keyboardMode : 'none'}</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-pressed={ocrFrac <= 0.03}
              onClick={toggleEnlarge}
              title={ocrFrac <= 0.03 ? 'Show the OCR panel' : 'Enlarge - collapse the OCR panel'}
            >
              <PanelIcon collapsed={ocrFrac <= 0.03} />
            </Button>
            {canEdit && (
              <ButtonGroup aria-label="Mode">
                <GroupButton on={!editing} onClick={() => setEditing(false)} title="Look and read - Esc">
                  View
                </GroupButton>
                <GroupButton on={editing} onClick={() => setEditing((v) => !v)} title="Edit boxes and lines - e" strong>
                  Edit <span className="[&_svg]:size-3"><PenIcon /></span> <span className="opacity-60">e</span>
                </GroupButton>
              </ButtonGroup>
            )}
        </>),
      }}
      rail={editing ? classRail() : null}
      canvas={<>
      {error && <p className="mx-3 mt-3 shrink-0 text-sm text-danger">{error}</p>}
      {conflict && (
        <div className="mx-3 mt-3 shrink-0">
          <LineConflict conflict={conflict} busy={resolving} onKeepTheirs={keepTheirs} onUseMine={overwriteWithMine} />
        </div>
      )}
      {readOpen && page && job && (
        /* The dataset's own dialog, scoped to this page: it already does model choice, the
           prompt, the agreement settings and a per-page price, so the viewer needs no
           second version of any of it. */
        <LlmReadDialog
          jobId={jobId}
          pageIds={[page.id]}
          pageCount={job.pages_live}
          selected={job.llm_model_ids ?? []}
          consensusMin={job.llm_consensus_min ?? 2}
          autocheck={job.llm_autocheck ?? false}
          consensusWithOcr={job.llm_consensus_with_ocr ?? false}
          prompt={job.llm_prompt ?? ''}
          canOwn={isAdmin || job.owner === user}
          onClose={() => setReadOpen(false)}
          onStarted={() => {
            getJob(jobId).then(setJob).catch(() => undefined)
            getLlmReadStatus(jobId, [page.id]).then(setReading).catch(() => undefined)
          }}
          onError={setError}
        />
      )}
      {(canLineNav || editing) && (
        <LineLoupe
          line={loupeLine}
          plan={loupeLine && page?.height ? cropPlan(loupeLine.polygon, aspect, loupeLine.orientation, page.height) : null}
          targetHeight={ocrModel?.target_height ?? null}
          maxWidth={ocrModel?.max_width ?? null}
          editing={editing}
          showConfidence={showConfidence}
          orientation={loupeLine ? lineOrient(loupeLine) : 0}
          onRotate={(dir) => rotateLine(loupeLine, dir)}
          height={loupeH}
          onResize={beginLoupeResize}
          onHeight={setLoupeH}
        />
      )}
      {kbVisible && kbSnap && (
        <div data-testid="keyboard-dock-target" style={{ width: kbBox.width, height: kbBox.height }}
             className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center justify-center rounded border-2 border-dashed border-accent bg-accent-wash/60 text-xs font-medium text-accent-ink">
          Dock here
        </div>
      )}
      {kbVisible && (
        <div
          ref={kbRef}
          data-testid="virtual-keyboard"
          // Anywhere on the board, not only on a key: a press that misses one must not take
          // the focus, or the edit closes and saves.
          onMouseDown={(e) => e.preventDefault()}
          // A width, not a ceiling: the keys are fewer than the canvas is wide, so a cap
          // they never reach would leave the board the same size whatever it was set to.
          style={{ width: `${kbSize.span * 100}%`, maxWidth: '98%', ...kbFloat }}
          className={`absolute z-30 flex flex-wrap justify-center gap-1 p-1.5 shadow-lg transition-opacity ${
            kbFloat ? '' : 'bottom-3 left-1/2 -translate-x-1/2'
          } ${
            editingId === null ? 'opacity-50' : ''
          } ${boxChrome}`}
        >
          {canEdit && (
            <span
              ref={kbGrip}
              onPointerDown={beginKeyboardResize}
              onDoubleClick={() => setKbSize({ span: 0.92, key: 28 })}
              data-testid="keyboard-grip"
              role="separator"
              aria-label="Resize the keyboard"
              title="Drag: sideways for width, up and down for key size · double-click to reset"
              className="absolute -left-1 -top-1 h-3 w-3 cursor-nwse-resize rounded-sm border border-line-strong bg-white"
            />
          )}
          {canEdit && (
            <span
              ref={kbHandle}
              onPointerDown={beginKeyboardMove}
              onDoubleClick={() => setKbPlace(null)}
              data-testid="keyboard-move"
              role="button"
              aria-label="Move the keyboard"
              title="Drag to move · double-click to put it back above the footer"
              className="absolute -top-1.5 left-1/2 h-3 w-12 -translate-x-1/2 cursor-move rounded-full border border-line-strong bg-white"
            />
          )}
          {canEdit && kbPlace && (
            <button type="button" data-testid="keyboard-dock" onClick={() => setKbPlace(null)}
                    title="Put the keyboard back above the footer"
                    className="absolute -top-2.5 left-[calc(50%+2.25rem)] rounded-full border border-line-strong bg-surface px-1.5 text-[10px] font-medium leading-4 text-ink-muted hover:border-accent hover:text-accent-ink">
              Dock
            </button>
          )}
          {palette.map((c, i) => (
            <button
              key={i}
              type="button"
              onMouseDown={() => insertChar(c)}
              title={`Insert ${c}`}
              style={{ height: kbSize.key, minWidth: kbSize.key,
                       fontSize: Math.max(10, Math.round(kbSize.key * 0.5)) }}
              className="flex items-center justify-center rounded border border-line px-1 font-ocr leading-none hover:border-accent hover:bg-accent-wash"
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-2 p-3" style={{ paddingBottom: 'calc(var(--vkbd-h) + 0.75rem)' }}>
      <div ref={contentRef} className="relative min-w-0 flex-1 overflow-hidden">
        {page && stage !== 'enter' && (
          <Splitter
            ref={divider}
            orientation="vertical"
            onPointerDown={beginDivider}
            onDoubleClick={() => setOcrFracState(0.5)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              e.stopPropagation() // the arrows turn the page everywhere else
              setOcrFracState((f) => clampOcrFrac(f + (e.key === 'ArrowLeft' ? 0.02 : -0.02)))
            }}
            title="Drag to resize · double-click to reset"
            data-testid="pane-divider"
            aria-label="Width of the OCR panel"
            aria-valuemin={Math.round(OCR_FRAC.least * 100)}
            aria-valuemax={Math.round(OCR_FRAC.most * 100)}
            aria-valuenow={Math.round(ocrFrac * 100)}
            aria-controls="ocr-panel"
            className="absolute top-0 z-20 h-full -translate-x-1/2"
            style={{ left: `${(1 - ocrFrac) * 100}%` }}
          />
        )}
        <div
          className="flex h-full w-[150%] transition-transform duration-300 ease-out"
          style={{ transform: stripTransform, willChange: 'transform' }}
        >
          <section className="h-full w-1/3 shrink-0 pr-1.5">
            <div
              ref={plainPane}
              data-testid="scan-pane"
              onPointerDown={onPanStart}
              onPointerMove={onPanMove}
              onPointerUp={onPanEnd}
              onPointerCancel={onPanEnd}
              onDoubleClick={resetOnDoubleClick}
              className={scanPane}
            >
              <div ref={plainRefs.host} className="absolute inset-0" />
              <div ref={plainRefs.box} className={overlayBoxClass} />
            </div>
          </section>
          <section
            style={{ width: `${(1 - ocrFrac) * (200 / 3)}%` }}
            className={`h-full shrink-0 px-1.5 transition-opacity duration-300 ease-out ${
              stage === 'enter' ? 'opacity-0' : 'opacity-100'
            }`}
          >
            <div
              ref={overlayPane}
              data-testid="overlay-pane"
              onPointerDown={onOverlayPanePointerDown}
              onPointerMove={onPanMove}
              onPointerUp={onPanEnd}
              onPointerCancel={onPanEnd}
              onDoubleClick={resetOnDoubleClick}
              className={scanPane}
            >
              <div ref={overlayRefs.host} className="absolute inset-0" />
              {/* Pinned to the pane rather than to the scan: the scan is drawn on a canvas
                  now, and a button riding it would be off-screen at any real zoom. */}
              {page && (
                <CopyImageButton
                  url={renditionUrl(page.id, 'screen', page.rotation)}
                  onError={setError}
                  className="absolute right-1.5 top-1.5 z-20"
                />
              )}
              <div ref={overlayBoxRef} data-testid="overlay-box" className={overlayBoxClass}>
                {page && (
                  <>
                  {editing ? (
                    editLayer()
                  ) : (
                    <>
                      {showLayout && (
                        <>
                          <div className="absolute inset-0" style={{ opacity: inElement ? 0.15 : 1 }}>
                            {contextRects}
                            {showLabels && contextLabels}
                          </div>
                          {highlightRects()}
                          {highlightLabel()}
                        </>
                      )}
                      {showLines && overlayPolys(pageLines, pagePoints, 'lp')}
                      {inElement && overlayPolys(selectedLines, pagePoints, 'el')}
                      {cropRegion()}
                    </>
                  )}
                  {showOrder && (
                    <OrderOverlay width={page.width} height={page.height} centers={orderCenters} />
                  )}
                  </>
                )}
              </div>
            </div>
          </section>
          <section id="ocr-panel" style={{ width: `${ocrFrac * (200 / 3)}%` }} className="h-full shrink-0 pl-1.5">
            {!inElement ? (
              <div className={`flex h-full flex-col overflow-hidden p-3 ${boxChrome}`}>
                <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-ink-muted">
                    {reviewMode ? `Flagged here (${reviewLines.length})` : `All lines (${pageLines.length})`}
                  </span>
                  {!reviewMode && (
                    <Select
                      size="xs"
                      value={lineSort}
                      onChange={(e) => setLineSort(e.target.value as typeof lineSort)}
                      title="Sort the lines"
                      className="cursor-pointer text-ink-muted"
                    >
                      <option value="reading">Reading order</option>
                      <option value="line">Lowest line conf.</option>
                      <option value="min">Entry min conf.</option>
                      <option value="avg">Entry avg conf.</option>
                    </Select>
                  )}
                </div>
                {reviewMode && reviewLines.length === 0 && (
                  <p className="text-sm text-ink-muted">Nothing flagged on this page.</p>
                )}
                {!reviewMode && pageLines.length === 0 && (
                  <p className="shrink-0 text-sm text-ink-muted">No lines yet.</p>
                )}

                {/* Readings that matched no line get a scroller of their own, so one of them
                    and the line it belongs to can be on screen together however long the
                    page is - dragging across two hundred rows meant scrolling to the top to
                    pick one up and to the bottom to put it down. */}
                {/* The row answers to this panel's width, not the window's: the splitter
                    moves one without the other, and a rail of badges as wide as the
                    reading is what a narrow panel gets otherwise. Written out rather than
                    Tailwind's `@container`, whose class is `.\@container` and comes out of
                    the CSS minifier as a bare `@container` at-rule that matches nothing -
                    it works in dev and silently does not in a build. */}
                <div className="[container-type:inline-size] min-h-0 flex-1">
                {unmatchedReadings.length > 0 ? (
                  <div ref={listRef} className="flex h-full flex-col">
                    {/* As much room as they need, up to the share the divider gives them:
                        two readings should not hold a third of the panel open. */}
                    <div data-testid="unmatched-pane"
                         style={{ maxHeight: `${readingsFrac * 100}%` }}
                         className="min-h-0 shrink-0 overflow-y-auto pr-1">
                      <UnmatchedReadings
                        readings={unmatchedReadings}
                        armed={armed}
                        canEdit={canEdit}
                        onArm={arm}
                      />
                    </div>
                    <Splitter
                      orientation="horizontal"
                      onPointerDown={beginReadingsDivider}
                      onDoubleClick={() => setReadingsFracState(0.35)}
                      onKeyDown={(e) => {
                        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                        e.preventDefault()
                        e.stopPropagation() // the arrows turn the page everywhere else
                        setReadingsFracState((f) => clampReadingsFrac(f + (e.key === 'ArrowUp' ? -0.02 : 0.02)))
                      }}
                      data-testid="readings-divider"
                      aria-label="Height of the unmatched readings"
                      aria-valuemin={Math.round(READINGS_FRAC.least * 100)}
                      aria-valuemax={Math.round(READINGS_FRAC.most * 100)}
                      aria-valuenow={Math.round(readingsFrac * 100)}
                      aria-controls="lines-pane"
                      title="Drag to give the readings more or less room · double-click to reset"
                    />
                    <div id="lines-pane" data-testid="lines-pane" className="min-h-0 flex-1 overflow-y-auto pr-1">
                      {(reviewMode ? reviewLines : sortedPageLines).map(lineBlock)}
                    </div>
                  </div>
                ) : (
                  <div className="h-full overflow-y-auto pr-1">
                    {(reviewMode ? reviewLines : sortedPageLines).map(lineBlock)}
                  </div>
                )}
                </div>
              </div>
            ) : (
              selected && (
                <div className={`${panelBox} p-3`}>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={selected.checked}
                        onChange={(e) => toggleElementChecked(selected, e.target.checked)}
                        title="Mark entry and all its lines checked"
                        className="cursor-pointer accent-accent"
                      />
                      <span
                        className="block w-fit rounded border px-1.5 py-0.5 text-[11px] font-medium"
                        style={{ color: classColor(selected.class_name), borderColor: classColor(selected.class_name) }}
                      >
                        {selected.class_name}
                      </span>
                    </label>
                    <Segmented
                      value={sortMode}
                      onChange={setSortMode}
                      options={[
                        { value: 'reading', label: 'Reading order' },
                        { value: 'confidence', label: 'Lowest conf.' },
                      ]}
                    />
                  </div>
                  {listLines.length === 0 && (
                    <p className="text-sm text-ink-muted">No lines yet.</p>
                  )}
                  {/* The same container as the page's list, so its rows shed the same. */}
                  <div className="[container-type:inline-size]">{listLines.map(lineBlock)}</div>
                </div>
              )
            )}
          </section>
        </div>
      </div>
      {readings?.pinned && (
        <div data-testid="line-readings-backdrop" className="fixed inset-0 z-30" onClick={() => setReadings(null)} />
      )}
      {readings && (
        <div className={`${readings.pinned ? '' : 'pointer-events-none'} fixed z-40`}
             style={{ top: readings.top, right: readings.right }}>
          <LineReadings readings={readings.rows} withOcr={job?.llm_consensus_with_ocr ?? false}
                        onRemove={readings.pinned && readings.removable ? (reading) => {
                          setReadings(null)
                          if (reading.candidateId !== undefined) void deleteReading(reading.candidateId)
                        } : undefined} />
        </div>
      )}
      </div>
      {!page && !error && <p className="p-3 text-sm text-ink-muted">Loading…</p>}
      </>}
      status={
        <StatusBar
          zoom={{
            out: () => setScale(scaleRef.current / 1.25),
            in: () => setScale(scaleRef.current * 1.25),
            reset: () => setScale(1),
            readoutRef,
          }}
          sentence={sentence}
          notice={erasedNotice}
          keys="Ctrl+Z undo · Ctrl+Shift+Z redo · Alt-drag pans · Ctrl+wheel zooms · Shift+wheel sizes the eraser"
          onShortcuts={() => setSheetOpen(true)}
          provenance={page?.provenance && <ModelProvenance provenance={page.provenance} />}
        />
      }
    />
    {sheetOpen && <ShortcutSheet groups={shortcutGroups} onClose={() => setSheetOpen(false)} />}
    </>
  )
}
