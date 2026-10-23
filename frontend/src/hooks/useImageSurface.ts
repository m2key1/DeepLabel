import { useCallback, useEffect, useMemo, useRef } from 'react'
import OpenSeadragon from 'openseadragon'

// Wheel deltas as d3-zoom normalizes them, so a notch means the same on every engine and
// on a trackpad: pixels, lines and pages each scaled to an exponent of two, and the zoom
// multiplied by 2 ** delta.
const WHEEL_SCALE: Record<number, number> = { 0: 0.002, 1: 0.05, 2: 1 }

// A line of wheel-scroll in pixels, for the panning half of the same event. A wheel that
// reports whole pages instead is given the pane's height.
const LINE_PX = 16

// WebKit's own pinch, which is not in any specification and which no other engine has.
// It matters because Safari is also the only engine that does *not* report a trackpad
// pinch as a wheel with ctrl held - so left unhandled, a pinch there zooms the whole page
// instead of the scan. It carries the turn of the fingers too, which is the one place a
// trackpad can rotate at all.
interface WebKitGestureEvent extends UIEvent {
  readonly scale: number
  readonly rotation: number
  readonly clientX: number
  readonly clientY: number
}

// Below this a turn is the hand not being quite straight, not an attempt to tilt the page.
const TURN_DEADBAND_DEG = 4

// How long one scan takes to give way to the next. Short enough not to be waited on, long
// enough that paging through a volume reads as one scan replacing another rather than the
// pane blinking. Matches the fade the transcript's plates used to do in CSS.
const FADE_MS = 200

// The most one wheel event may zoom, as an exponent of two. An accelerated wheel reports
// thousands of delta in a single event - enough to cross the whole range at once - and
// what is over this is dropped rather than owed, so a hard flick cannot keep zooming
// after the hand has stopped. A notch of a mouse is 0.24, well under it.
const MAX_STEP = 0.5

// Re-rendering the page on every frame of a zoom buys nothing now that the overlay is
// placed imperatively, so the published zoom only moves when it has moved enough to
// matter - or when the gesture settles.
const ZOOM_REPORT_STEP = 0.005

// What the backend cut the tiles with - see renditions.py, which is where these live.
const TILE_SIZE = 254
const TILE_OVERLAP = 1

/** A page's deep-zoom pyramid: where its tiles live, and the size they lay out to. */
export interface ScanSource {
  tiles: string
  width: number
  height: number
}

export interface SurfaceOptions {
  /** Zoom bounds, as a multiple of the scan drawn at the pane's width. */
  min?: number
  max?: number
  /** Whether a plain left drag pans, rather than only middle-drag and Alt-drag. */
  grab?: boolean
  /** What zoom 1 means: the scan at the pane's width, which is how an editor reads a tall
   *  page, or the whole of it in view, which is how a gallery shows one. */
  frame?: 'width' | 'whole'
  /** Whether a two-finger turn turns the view. Off by default: a map tile is already
   *  square to its frame, and a stray degree of tilt there is a nuisance. */
  rotate?: boolean
  /** Called as the scan's drawn size changes, in CSS pixels. For a caller that draws its
   *  own geometry at the scan's size and measures its hit radii in pixels of screen. */
  /** The drawn size of the scan, and how far from the fitted view it is: 1 with the scan
   *  fitted to the pane, 2 at twice that, whatever the scan's own resolution. */
  onSize?: (width: number, height: number, zoom: number) => void
  /** Called as the zoom changes, for a caller with a readout to keep. Left out, nothing
   *  is published and nothing re-renders: the page viewer draws its overlay through the
   *  box rather than off a number, and re-rendering it sixty times a second to tell it a
   *  number it never reads cost 250ms frames on a page with a hundred boxes on it. */
  onZoom?: (zoom: number) => void
  /** Called for a wheel turned with Shift held: +1 for a notch up (away from the hand),
   *  -1 for one down. Returning true keeps the turn, and the view does not move. Every
   *  event is one notch whatever its delta - a line-mode wheel reports small numbers,
   *  an accelerated one thousands - and an engine that answers Shift with a sideways
   *  delta is read on that axis instead. For a caller with a tool to size under the
   *  hand that is already on the scan. */
  onShiftWheel?: (notch: 1 | -1) => boolean
}

export interface ImageSurface {
  /** Draw the scan at this multiple of the pane's width: 1 fills it, 4 is four times in. */
  setZoom: (zoom: number) => void
  /** Draw the scan at this multiple of its own pixels: 1 is one image pixel per pixel of
   *  screen. For a caller whose readout counts the scan's pixels rather than the pane's. */
  setScale: (scale: number) => void
  /** Turn the view, in degrees clockwise. The scan and everything drawn on it turn
   *  together; the page's own coordinates are untouched, so nothing is edited by it. */
  setRotation: (degrees: number) => void
  /** Bring a point of the page - in the same [0, 1] coordinates as everything drawn on
   *  it - to the middle of every pane. */
  centerOn: (x: number, y: number) => void
  /** Where a point of the window falls on the page, in [0, 1]. Asked of the viewer rather
   *  than measured off the overlay's box, because a turned box's bounding rectangle is not
   *  the box - so this is the only conversion that survives rotation. */
  toPage: (clientX: number, clientY: number) => [number, number] | null
  /** How far apart two points of the page are on the screen, in pixels. */
  screenDistance: (a: [number, number], b: [number, number]) => number
  /** The two refs a pane needs: `host` is the div OpenSeadragon draws in, `box` the
   *  overlay held over the scan. Stable per id, so wiring them re-renders nothing. */
  register: (id: string) => PaneRefs
  onPanStart: (e: React.PointerEvent<HTMLElement>) => void
  onPanMove: (e: React.PointerEvent<HTMLElement>) => void
  onPanEnd: (e: React.PointerEvent<HTMLElement>) => void
}

export interface PaneRefs {
  host: (el: HTMLElement | null) => void
  box: (el: HTMLElement | null) => void
}

interface Placed {
  x: number
  y: number
  w: number
  h: number
  /** How far the view is turned, in radians. */
  turn: number
}

interface Pane {
  id: string
  /** The element the two refs share a parent in: what the wheel and a pan are read on. */
  pane: HTMLElement
  host: HTMLElement
  box: HTMLElement
  viewer: OpenSeadragon.Viewer
  /** The scan currently open in it, so a re-render does not reopen the same one. */
  source: string
  /** The scan being shown. Not simply the world's first item: while one page gives way to
   *  the next they are both in the world, and everything measured against the scan - the
   *  overlay's place, where a click lands - belongs to the one coming in. */
  showing: OpenSeadragon.TiledImage | null
  /** Cancels a fade still running, so a reader paging quickly is never left holding two
   *  half-faded scans. */
  stopFade: (() => void) | null
  /** Counts the scans asked for, so one that arrives after a newer one was asked for is
   *  dropped instead of staying in the world under it. */
  ticket: number
  /** Whether anyone has moved this view yet. Until they have, the pane is free to frame
   *  the scan again - it opens while the surrounding panels are still laying out, and
   *  the size it first saw is not the size it ends up. */
  touched: boolean
  /** Set when the pane has been resized under an untouched view, and cleared by the next
   *  frame, which re-frames the scan. A flag rather than framing on the spot: the resize
   *  applies its own constraints after telling us about it, and would undo the answer. */
  reframe: boolean
  /** Where the box was last put, so an idle frame writes no styles at all. */
  placed: Placed | null
  detach: () => void
}

const deepZoom = (scan: ScanSource) => ({
  Image: {
    xmlns: 'http://schemas.microsoft.com/deepzoom/2008',
    Url: scan.tiles,
    Format: 'jpg',
    TileSize: String(TILE_SIZE),
    Overlap: String(TILE_OVERLAP),
    Size: { Width: String(scan.width), Height: String(scan.height) },
  },
})

/** One scan shown in one or more panes that zoom and pan as one, drawn by OpenSeadragon so
 *  that tiling, cursor anchoring and the gesture handling are its problem rather than ours.
 *  Each pane carries an overlay box - an absolutely positioned div held exactly over the
 *  drawn image - so everything on top keeps addressing the page in [0, 1] coordinates and
 *  knows nothing about the viewer underneath.
 *
 *  Pointer input stays with the overlay rather than the viewer: the editor has to see a
 *  press before anyone decides it was a pan, and the overlay is what it sits on. The panes
 *  wire onPanStart/Move/End exactly as they did before, so only the surface changed.
 *
 *  Several panes because the page viewer mirrors a clean scan and an annotated one side by
 *  side. Whichever pane the hand is in drives; the others follow in the same frame. */
export function useImageSurface(
  scan: ScanSource | null,
  {
    min = 0.25, max = 8, grab = false, rotate = false, frame = 'width', onSize, onZoom, onShiftWheel,
  }: SurfaceOptions = {},
): ImageSurface {
  const panes = useRef(new Map<string, Pane>())
  const mounted = useRef(new Map<string, { host?: HTMLElement; box?: HTMLElement }>())
  // Which pane the hand is in. Only it hands its viewport to the others, and it keeps
  // doing so until it settles - a gesture is not finished when its event returns, and a
  // follower that mirrored back would push the pair apart a little on every frame.
  const driving = useRef<string | null>(null)
  // Every pointer currently down on a pane, so a second finger can be noticed arriving.
  const down = useRef(new Map<number, { id: string; x: number; y: number }>())
  const pinch = useRef<
    { cx: number; cy: number; span: number; angle: number; from: number; turning: boolean } | null
  >(null)
  const reported = useRef(1)
  // Read during a gesture, which asks several times before React commits an answer.
  const opts = useRef({ min, max, grab, rotate, frame, onSize, onZoom, onShiftWheel })
  opts.current = { min, max, grab, rotate, frame, onSize, onZoom, onShiftWheel }

  const each = (fn: (p: Pane) => void) => panes.current.forEach(fn)

  // The angle between two fingers wraps at half a turn, and a level hand sits on the wrap:
  // taken plainly, one step across it reads as a full circle and clears the deadband.
  const turnFrom = (from: number, to: number) => ((to - from + 540) % 360) - 180

  // Where two fingers are, how far apart, and how far round - carrying forward the angle
  // the gesture began at, so a turn can be ignored until it is clearly meant. Two fingers
  // are never quite level; past the threshold the turn follows freely, because one that
  // kept being re-applied would make the page feel like it was sticking.
  const spanOf = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    was?: { from: number; turning: boolean } | null,
  ) => {
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
    const from = was ? was.from : angle
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      span: Math.hypot(b.x - a.x, b.y - a.y),
      angle,
      from,
      turning: (was?.turning ?? false) || Math.abs(turnFrom(from, angle)) >= TURN_DEADBAND_DEG,
    }
  }

  const paneOf = (el: HTMLElement | null): Pane | null => {
    for (const p of panes.current.values()) if (p.pane === el || p.pane.contains(el)) return p
    return null
  }

  // Zoom 1 is the scan at the pane's width, however tall that leaves it - which is what
  // a percentage width always meant here, and what the zoom readouts elsewhere are
  // counting. OpenSeadragon measures zoom the same way once defaultZoomLevel says so, so
  // this is 1 and the bounds below are absolute.
  const fitZoom = (v: OpenSeadragon.Viewer) => v.viewport.getHomeZoom() || 1

  const clampZoom = (v: OpenSeadragon.Viewer, absolute: number) => {
    const fit = fitZoom(v)
    return Math.min(opts.current.max * fit, Math.max(opts.current.min * fit, absolute))
  }

  const publishZoom = (p: Pane, force = false) => {
    const tell = opts.current.onZoom
    if (!tell) return
    if (driving.current && driving.current !== p.id) return
    const v = p.viewer
    const next = v.viewport.getZoom(true) / fitZoom(v)
    // Never round across 1, which is the number a reader is most likely to be watching for.
    const crossed = next > 1 !== reported.current > 1
    if (!force && !crossed && Math.abs(next - reported.current) < ZOOM_REPORT_STEP) return
    reported.current = next
    tell(next)
  }

  // Hold the overlay box exactly over the drawn image. Width and height are real CSS
  // pixels rather than a transform scale, because what sits in the box - stroke widths,
  // drag handles, labels - has to keep its own size while the scan grows under it.
  const imageOf = (p: Pane) =>
    p.showing ?? (p.viewer.world.getItemCount() ? p.viewer.world.getItemAt(0) : null)

  const placeBox = (p: Pane) => {
    const image = imageOf(p)
    if (!image) {
      p.box.style.visibility = 'hidden'
      delete p.box.dataset.scan
      delete p.box.dataset.scanSrc
      delete p.box.dataset.scanLoaded
      p.placed = null
      return
    }
    const { viewport } = p.viewer
    const rect = image.getBounds(true)
    // Three corners, not two: once the view is turned the scan's box is no longer square
    // to the window, and the distance between opposite corners stops being its size. The
    // top edge gives the width and the angle, the left edge the height.
    const topLeft = viewport.viewportToViewerElementCoordinates(rect.getTopLeft())
    const topRight = viewport.viewportToViewerElementCoordinates(rect.getTopRight())
    const bottomLeft = viewport.viewportToViewerElementCoordinates(rect.getBottomLeft())
    const next: Placed = {
      x: topLeft.x, y: topLeft.y,
      w: Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
      h: Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y),
      turn: Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x),
    }
    // Which scan is on the wall. Written before the guard below, not after it: two pages
    // of the same size put the overlay in exactly the same place, so turning between them
    // moves nothing - and a marker only written when something moves would go on naming
    // the page before it.
    p.box.style.visibility = 'visible'
    if (p.box.dataset.scanSrc !== p.source) {
      p.box.dataset.scanSrc = p.source
      delete p.box.dataset.scanLoaded
    }

    // The viewer offers a frame whether or not anything moved, and writing the size back
    // every time would lay the overlay out again - hundreds of shapes - for nothing.
    const was = p.placed
    if (was && was.x === next.x && was.y === next.y && was.w === next.w && was.h === next.h
        && was.turn === next.turn) return
    p.placed = next
    // Moved on every frame of a pan. Said plainly, the browser gives the overlay a layer
    // of its own and slides it; left unsaid, it repaints every shape and label on it.
    p.box.style.willChange = 'transform'
    // Says the scan is drawn and the overlay is over it - what anything measuring against
    // page coordinates has to wait for, and the only outward sign now that the scan is
    // painted to a canvas rather than being an <img> inside the box. The source names
    // which scan it is: with no <img> left, this is what it asked the server for.
    p.box.dataset.scan = 'ready'
    // Turned about its own top-left, which is the corner the translate puts in place.
    p.box.style.transformOrigin = '0 0'
    p.box.style.transform = `translate(${next.x}px, ${next.y}px) rotate(${next.turn}rad)`
    p.box.style.width = `${next.w}px`
    p.box.style.height = `${next.h}px`
    if (!was || was.w !== next.w || was.h !== next.h) {
      opts.current.onSize?.(next.w, next.h, p.viewer.viewport.getZoom(true) / fitZoom(p.viewer))
    }
  }

  // Hand the driving pane's viewport to the others, immediately rather than animated: a
  // follower catching up on its own spring lags a frame behind, which reads as the two
  // scans sliding against each other.
  //
  // Only when the driver has moved since it last handed over. This is called from the
  // frame loop, and handing the same viewport over again would write the followers'
  // springs on every frame - which keeps them drawing forever, and them redrawing keeps
  // this being called.
  const handed = useRef<{ cx: number; cy: number; z: number; r: number } | null>(null)
  const mirror = (from: Pane) => {
    if (panes.current.size < 2) return
    const center = from.viewer.viewport.getCenter(true)
    const z = from.viewer.viewport.getZoom(true)
    const r = from.viewer.viewport.getRotation(true)
    const last = handed.current
    if (last && last.cx === center.x && last.cy === center.y && last.z === z && last.r === r) return
    handed.current = { cx: center.x, cy: center.y, z, r }
    each((p) => {
      if (p === from) return
      p.touched = from.touched
      p.viewer.viewport.setRotation(r, true)
      p.viewer.viewport.zoomTo(z, undefined, true)
      p.viewer.viewport.panTo(center, true)
      placeBox(p)
    })
  }


  // The top of the scan at the pane's width, which is where a pane that scrolled started.
  // A scan shorter than the pane has nothing to scroll and is centred instead.
  //
  // Asserted on every frame until someone moves the view, rather than set once: a pane
  // opens while the panels around it are still laying out, and the resize that follows
  // re-fits the scan to whatever was framed before it. Setting the same values again
  // costs nothing once they are already the values.
  const frameTop = (p: Pane) => {
    const image = imageOf(p)
    if (!image) return
    const { viewport } = p.viewer
    const bounds = image.getBounds()
    const container = viewport.getContainerSize()
    const visibleHeight = container.y / container.x / fitZoom(p.viewer)
    viewport.zoomTo(fitZoom(p.viewer), undefined, true)
    // A page read at the pane's width starts at its top, which is where a pane that
    // scrolled started; one framed whole has no top to start at and is simply centred.
    const middle = opts.current.frame === 'whole'
      ? bounds.height / 2
      : Math.min(bounds.height, visibleHeight) / 2
    viewport.panTo(
      new OpenSeadragon.Point(bounds.x + bounds.width / 2, bounds.y + middle),
      true,
    )
    viewport.applyConstraints(true)
  }

  // Where a point of the window sits in the viewer's own pixels. The viewer holds its
  // container's size as a whole number of pixels, while a pane laid out by flexbox is
  // very often a fraction of one wider - so a cursor near the right of the scan converts
  // a little short, and eight notches of zoom each converting a little short walk the
  // point out from under the hand. Scaling into the size the viewer believes in costs
  // one division and makes it exact.
  const viewerPixel = (p: Pane, clientX: number, clientY: number) => {
    const rect = p.host.getBoundingClientRect()
    const size = p.viewer.viewport.getContainerSize()
    return new OpenSeadragon.Point(
      ((clientX - rect.left) * size.x) / (rect.width || size.x),
      ((clientY - rect.top) * size.y) / (rect.height || size.y),
    )
  }

  // Where a point of the window falls on the page, and back. Both go through the viewer,
  // which knows how the view is turned; measuring the overlay's box instead would give the
  // rectangle around a turned box rather than the box.
  const pageAt = (p: Pane, clientX: number, clientY: number): [number, number] | null => {
    const image = imageOf(p)
    if (!image) return null
    const bounds = image.getBounds(true)
    const at = p.viewer.viewport.pointFromPixel(viewerPixel(p, clientX, clientY), true)
    return [(at.x - bounds.x) / bounds.width, (at.y - bounds.y) / bounds.height]
  }

  const screenAt = (p: Pane, x: number, y: number): OpenSeadragon.Point | null => {
    const image = imageOf(p)
    if (!image) return null
    const bounds = image.getBounds(true)
    return p.viewer.viewport.viewportToViewerElementCoordinates(
      new OpenSeadragon.Point(bounds.x + x * bounds.width, bounds.y + y * bounds.height),
    )
  }

  const rotateBy = (p: Pane, degrees: number, clientX: number, clientY: number) => {
    const { viewport } = p.viewer
    viewport.setRotationWithPivot(
      viewport.getRotation(true) + degrees,
      viewport.pointFromPixel(viewerPixel(p, clientX, clientY), true),
      true,
    )
    viewport.applyConstraints(true)
  }

  const zoomAt = (p: Pane, factor: number, clientX: number, clientY: number) => {
    const { viewport } = p.viewer
    const now = viewport.getZoom(true)
    const next = clampZoom(p.viewer, now * factor)
    if (next === now) return
    viewport.zoomTo(next, viewport.pointFromPixel(viewerPixel(p, clientX, clientY), true), true)
    viewport.applyConstraints(true)
  }

  // Immediately, as the second argument says: left to the spring, the scan eases towards
  // where the hand already is over the best part of a second, which on a trackpad - where
  // the fingers are sending a new position every few milliseconds - reads as the page
  // lagging behind them. A pan is direct manipulation and has nothing to animate to.
  const panBy = (p: Pane, dxPx: number, dyPx: number) => {
    const { viewport } = p.viewer
    viewport.panBy(viewport.deltaPointsFromPixels(new OpenSeadragon.Point(dxPx, dyPx), true), true)
    viewport.applyConstraints(true)
  }

  const attach = useCallback((id: string, host: HTMLElement, box: HTMLElement, source: ScanSource) => {
    const pane = host.parentElement ?? host
    const viewer = OpenSeadragon({
      element: host as HTMLDivElement,
      tileSources: deepZoom(source),
      // Draw with the 2d canvas, not WebGL. OpenSeadragon prefers WebGL everywhere but
      // iOS, where it already knows better - and an M1 Pro driving 120Hz is the same
      // story: the WebGL drawer pinned its GPU at 98% while panning, and the canvas one
      // is smooth. On a Linux box with Chrome the two measured identically at every zoom,
      // so this gives up nothing to buy that back (measured 2026-09-20).
      drawer: 'canvas',
      // Every control is ours: the scan sits in an editor that already has a toolbar.
      showNavigationControl: false,
      showNavigator: false,
      // Input is the overlay's, handled through onPanStart and the wheel listener below.
      mouseNavEnabled: false,
      gestureSettingsMouse: { scrollToZoom: false, clickToZoom: false, dblClickToZoom: false },
      // Leave the scan where it is put rather than easing on after every gesture: an edit
      // aimed at a line that is still drifting lands somewhere else.
      animationTime: 0.3,
      springStiffness: 14,
      // Zoom 1 fills the pane's width, so a tall page opens readable and runs off the
      // bottom - unless the caller wants the whole page in view, which is what a gallery
      // means by fitted, and which is the zoom OpenSeadragon works out for itself.
      defaultZoomLevel: frame === 'width' ? 1 : 0,
      // Let the scan shrink past its pane, and let zooming go well past 1:1 for fine work;
      // the exact bounds are applied in clampZoom, these only stop OSD pulling back first.
      minZoomImageRatio: min,
      maxZoomPixelRatio: 100,
      // How much of the pane may fall outside the scan. Not 1: with no overhang allowed
      // the scan's edge cannot come inside the pane, so zooming into a line near the
      // margin stops holding the point under the cursor and the page slides instead.
      // Half a pane of room is enough that ordinary work never reaches the limit, and
      // the scan can still never be pushed out of sight.
      visibilityRatio: 0.5,
      constrainDuringPan: true,
      homeFillsViewer: false,
      // A pane that changes size keeps framing what it was framing, rather than holding
      // the scan at its pixel size and showing more or less of it. This is what replaced
      // remembering the centre by hand across the edit-mode rail and the splitter.
      preserveImageSizeOnResize: false,
    })

    const p: Pane = {
      id, pane, host, box, viewer, source: source.tiles, showing: null, stopFade: null, ticket: 0,
      touched: false, reframe: false, placed: null, detach: () => {},
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // The caller is offered a turn with Shift held first; what it takes moves nothing.
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && opts.current.onShiftWheel) {
        const delta = e.deltaY || e.deltaX
        if (delta && opts.current.onShiftWheel(delta < 0 ? 1 : -1)) return
      }
      driving.current = id
      p.touched = true
      // A pinch on a trackpad arrives as a wheel with ctrl held, which is also how the
      // page has always been zoomed with a mouse. Everything else scrolls the scan,
      // including the sideways axis a trackpad sends and a wheel does not.
      if (e.ctrlKey || e.metaKey) {
        const scale = WHEEL_SCALE[e.deltaMode] ?? WHEEL_SCALE[0]
        const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, -e.deltaY * scale))
        zoomAt(p, 2 ** step, e.clientX, e.clientY)
      } else {
        const page = pane.getBoundingClientRect().height
        const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? page : 1
        panBy(p, e.deltaX * unit, e.deltaY * unit)
      }
      mirror(p)
      publishZoom(p)
    }

    // Every frame the viewer draws, whether or not anything changed. Nothing in here may
    // touch the viewport unless it has to: writing a spring marks the viewport dirty, the
    // viewer draws again to catch up, and the pair of them never go idle - which is a
    // canvas being repainted sixty times a second for as long as the page is open.
    viewer.addHandler('update-viewport', () => {
      if (p.reframe && !p.touched) {
        p.reframe = false
        frameTop(p)
      }
      placeBox(p)
      if (driving.current === id) mirror(p)
    })
    viewer.addHandler('open', () => {
      p.showing = viewer.world.getItemCount() ? viewer.world.getItemAt(0) : null
      // A pane that arrives beside one already being read takes that one's view rather
      // than framing its own - the annotated pane slides in behind a transition, and
      // landing somewhere else than the scan beside it would be the wrong answer. When
      // nobody has moved either of them there is nothing to take, and both frame the same
      // scan the same way anyway.
      const settled = [...panes.current.values()].find((q) => q !== p && q.viewer.isOpen() && q.touched)
      if (settled) mirror(settled)
      else frameTop(p)
      placeBox(p)
      publishZoom(p, true)
    })
    // Drawn is not the same as finished: the scan arrives tile by tile, and anything
    // measuring what the page looks like - rather than where it is - has to wait for the
    // last of them.
    viewer.addHandler('fully-loaded-change', () => {
      const done = viewer.world.getItemCount() > 0
        && [...Array(viewer.world.getItemCount())].every((_, i) => viewer.world.getItemAt(i).getFullyLoaded())
      if (done) p.box.dataset.scanLoaded = '1'
      else delete p.box.dataset.scanLoaded
    })
    viewer.addHandler('after-resize', () => {
      p.reframe = true
      placeBox(p)
    })
    viewer.addHandler('animation-finish', () => publishZoom(p, true))
    // Where the gesture stood when it began, so each change is applied as a delta.
    let gesture: { scale: number; rotation: number; turning: boolean } | null = null
    const onGestureStart = (e: Event) => {
      const g = e as WebKitGestureEvent
      e.preventDefault()
      driving.current = id
      p.touched = true
      gesture = { scale: g.scale || 1, rotation: g.rotation || 0, turning: false }
    }
    const onGestureChange = (e: Event) => {
      const g = e as WebKitGestureEvent
      e.preventDefault()
      if (!gesture) return
      const scale = g.scale || 1
      if (scale > 0 && gesture.scale > 0) zoomAt(p, scale / gesture.scale, g.clientX, g.clientY)
      if (opts.current.rotate) {
        const turn = g.rotation || 0
        gesture.turning ||= Math.abs(turn) >= TURN_DEADBAND_DEG
        if (gesture.turning) rotateBy(p, turn - gesture.rotation, g.clientX, g.clientY)
        gesture.rotation = turn
      }
      gesture.scale = scale
      mirror(p)
      publishZoom(p)
    }
    const onGestureEnd = (e: Event) => {
      e.preventDefault()
      gesture = null
    }

    pane.addEventListener('wheel', onWheel, { passive: false })
    pane.addEventListener('gesturestart', onGestureStart)
    pane.addEventListener('gesturechange', onGestureChange)
    pane.addEventListener('gestureend', onGestureEnd)
    // The fingers are ours to read: left to the browser, a pinch scales the whole page and
    // a drag scrolls whatever is behind the pane.
    pane.style.touchAction = 'none'

    p.detach = () => {
      p.stopFade?.()
      pane.removeEventListener('wheel', onWheel)
      pane.removeEventListener('gesturestart', onGestureStart)
      pane.removeEventListener('gesturechange', onGestureChange)
      pane.removeEventListener('gestureend', onGestureEnd)
      viewer.destroy()
    }
    return p
    // min is read once, at construction; the live bound is opts.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Panes register through callback refs rather than ref objects, so a pane that appears
  // later - the annotated one slides in behind a transition - is picked up as it mounts
  // instead of on whatever render happens to follow. Both refs have landed by the time
  // the effect below runs, so neither has to arrive before the other.
  const registrars = useRef(new Map<string, PaneRefs>())
  const register = useCallback((id: string): PaneRefs => {
    const existing = registrars.current.get(id)
    if (existing) return existing
    const slot = () => mounted.current.get(id) ?? {}
    const refs: PaneRefs = {
      host: (el) => mounted.current.set(id, { ...slot(), host: el ?? undefined }),
      box: (el) => mounted.current.set(id, { ...slot(), box: el ?? undefined }),
    }
    registrars.current.set(id, refs)
    return refs
  }, [])

  // Opening, reopening and closing in one place: a pane that registered before the scan
  // was known and a scan that changed under a mounted pane are the same job.
  useEffect(() => {
    // Only a pane going away closes its viewer. The scan going away does not: turning to
    // the next page clears it for as long as the new one takes to arrive, and tearing the
    // viewer down over that would throw away its tiles and blink the pane white.
    panes.current.forEach((p, id) => {
      const live = mounted.current.get(id)
      if (live?.host !== p.host || live?.box !== p.box) {
        p.detach()
        panes.current.delete(id)
      }
    })
    if (!scan) return
    mounted.current.forEach(({ host, box }, id) => {
      if (host && box && !panes.current.has(id)) panes.current.set(id, attach(id, host, box, scan))
    })
  })

  // One scan gives way to the next rather than the pane blinking between them: the new
  // page is added beside the old, faded up as the old fades down, and the old dropped once
  // it is invisible. Paging through a volume is the whole point of a gallery, and a blink
  // on every step is what it would otherwise be.
  const fadeTo = (p: Pane, next: ScanSource) => {
    p.stopFade?.()
    const ticket = ++p.ticket
    if (p.showing) p.box.dataset.fading = '1'
    p.viewer.addTiledImage({
      tileSource: deepZoom(next),
      opacity: p.showing ? 0 : 1,
      success: (e: unknown) => {
        const arriving = (e as { item: OpenSeadragon.TiledImage }).item
        if (ticket !== p.ticket) {
          p.viewer.world.removeItem(arriving)
          return
        }
        const leaving = p.showing
        p.showing = arriving
        if (!leaving) delete p.box.dataset.fading
        // A new page is read from the top, whatever was being looked at on the last one.
        p.touched = false
        p.reframe = true
        placeBox(p)
        if (!leaving) return

        const began = performance.now()
        let frame = 0
        const done = (settled: boolean) => {
          cancelAnimationFrame(frame)
          p.stopFade = null
          if (!settled) arriving.setOpacity(1)
          if (p.viewer.world.getIndexOfItem(leaving) !== -1) p.viewer.world.removeItem(leaving)
          delete p.box.dataset.fading
        }
        const step = () => {
          const t = Math.min(1, (performance.now() - began) / FADE_MS)
          arriving.setOpacity(t)
          leaving.setOpacity(1 - t)
          if (t < 1) {
            frame = requestAnimationFrame(step)
            return
          }
          done(true)
        }
        frame = requestAnimationFrame(step)
        // A reader paging quickly must never be left holding two half-faded scans.
        p.stopFade = () => done(false)
      },
    })
  }

  // Keyed off the fields rather than the object, which a caller rebuilds on every render.
  const { tiles, width, height } = scan ?? { tiles: '', width: 0, height: 0 }
  useEffect(() => {
    if (!tiles) return
    each((p) => {
      if (p.source === tiles) return
      p.source = tiles
      fadeTo(p, { tiles, width, height })
    })
  }, [tiles, width, height])

  useEffect(() => {
    const open = panes.current
    return () => {
      open.forEach((p) => p.detach())
      open.clear()
    }
  }, [])

  // Middle-drag and Alt-drag always pan; a plain drag does too while the hand is picked
  // up. So does a finger or a pen, which have no second button to reach for - the editor
  // stops a press it means to draw with before it gets here, so this only ever sees the
  // ones nobody wanted. The pane captures the pointer, so leaving it mid-drag does not
  // end the pan.
  //
  // A second finger turns the pan into a pinch: two fingers spread and turn and travel at
  // once, and the scan follows all three. Every touch device reaches this - the viewer's
  // own gesture handling is off, because the overlay is what the fingers land on and the
  // viewer never sees them.
  const onPanStart = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const handed = e.pointerType !== 'mouse'
    if (!handed && e.button !== 1 && !e.altKey && !(opts.current.grab && e.button === 0)) return
    const p = paneOf(e.currentTarget)
    if (!p) return
    e.preventDefault()
    driving.current = p.id
    p.touched = true
    // Capture is an optimisation, not a requirement: a pointer that is no longer active
    // cannot be captured, and the pan still ends cleanly on its up.
    try {
      p.pane.setPointerCapture(e.pointerId)
    } catch {
      /* not capturable */
    }
    down.current.set(e.pointerId, { id: p.id, x: e.clientX, y: e.clientY })
    // A pinch starts from where the two fingers already are, not from where they have
    // got to by the time the first move arrives - otherwise the first step of every
    // gesture is spent working out where it began.
    const two = [...down.current.values()].filter((d) => d.id === p.id).slice(0, 2)
    pinch.current = two.length === 2 ? spanOf(two[0], two[1]) : null
  }, [])

  const onPanMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const held = down.current.get(e.pointerId)
    if (!held) return
    const fromX = held.x
    const fromY = held.y
    held.x = e.clientX
    held.y = e.clientY
    const p = panes.current.get(held.id)
    if (!p) return

    const two = [...down.current.values()].filter((d) => d.id === held.id).slice(0, 2)
    if (two.length === 2) {
      const was = pinch.current
      const now = spanOf(two[0], two[1], was)
      pinch.current = now
      if (was && was.span > 0) {
        panBy(p, was.cx - now.cx, was.cy - now.cy)
        zoomAt(p, now.span / was.span, now.cx, now.cy)
        if (opts.current.rotate && now.turning) {
          rotateBy(p, turnFrom(was.angle, now.angle), now.cx, now.cy)
        }
      }
      mirror(p)
      publishZoom(p)
      return
    }

    // One finger, or a mouse: the scan follows it exactly, from where it was pressed.
    pinch.current = null
    panBy(p, fromX - e.clientX, fromY - e.clientY)
    mirror(p)
  }, [])

  const onPanEnd = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const held = down.current.get(e.pointerId)
    if (!held) return
    down.current.delete(e.pointerId)
    // The finger that is left carries on panning from wherever it is now, rather than
    // from where it was when the pinch began.
    pinch.current = null
    const p = panes.current.get(held.id)
    if (p?.pane.hasPointerCapture?.(e.pointerId)) p.pane.releasePointerCapture(e.pointerId)
  }, [])

  const centerOn = useCallback((x: number, y: number) => {
    driving.current = null
    each((p) => {
      p.touched = true
      const image = imageOf(p)
      if (!image) return
      const bounds = image.getBounds()
      p.viewer.viewport.panTo(
        new OpenSeadragon.Point(bounds.x + x * bounds.width, bounds.y + y * bounds.height),
      )
      p.viewer.viewport.applyConstraints()
    })
  }, [])

  // Which pane a point of the window belongs to, by where the panes actually are.
  //
  // Not by asking what is under the point: a press captured by the overlay goes on being
  // followed after the hand has left the pane, and hit-testing then answers with a handle,
  // the bar above, or nothing at all. Falling back to "any pane" for those is what makes
  // it dangerous - the panes show the same scan but sit in different places, and the page
  // viewer's clean one is parked a thousand pixels off the left of the window. Converting
  // an on-screen point against that pane does not fail, it quietly returns a point from
  // somewhere else on the page.
  const paneOver = (clientX: number, clientY: number): Pane | undefined => {
    for (const p of panes.current.values()) {
      const r = p.host.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return p
    }
    // Off the pane entirely. That is ordinary here, not a mistake: a drag goes on being
    // followed after the cursor has left, and a vertex may be placed by clicking past the
    // edge of the scan, from over the toolbar or the rail. So it still converts - against
    // the pane the gesture started in, or failing that the one being looked at. What it
    // must never do is pick an arbitrary pane: the page viewer parks its clean scan a
    // thousand pixels off the window, and converting against that returns a point from
    // somewhere else on the page rather than failing.
    const driver = driving.current ? panes.current.get(driving.current) : undefined
    return driver ?? shownPane()
  }

  // The pane a reader is looking at: whichever shows the most of itself.
  //
  // By area, not by "any of it on screen". The page viewer slides its clean scan out to
  // the left but leaves a sliver of it against the divider, so any test looser than this
  // picks the pane that is ten pixels wide over the one filling the window.
  const shownPane = (): Pane | undefined => {
    if (driving.current) {
      const p = panes.current.get(driving.current)
      if (p) return p
    }
    let best: Pane | undefined
    let most = -1
    for (const p of panes.current.values()) {
      const r = p.host.getBoundingClientRect()
      const wide = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0)
      const tall = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)
      const seen = Math.max(0, wide) * Math.max(0, tall)
      if (seen > most) {
        most = seen
        best = p
      }
    }
    return best
  }

  const toPage = useCallback((clientX: number, clientY: number) => {
    const p = paneOver(clientX, clientY)
    return p ? pageAt(p, clientX, clientY) : null
  }, [])

  const screenDistance = useCallback((a: [number, number], b: [number, number]) => {
    const p = shownPane()
    if (!p) return 0
    const from = screenAt(p, a[0], a[1])
    const to = screenAt(p, b[0], b[1])
    return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0
  }, [])

  const setRotation = useCallback((degrees: number) => {
    driving.current = null
    each((p) => {
      p.touched = true
      p.viewer.viewport.setRotation(degrees)
      p.viewer.viewport.applyConstraints()
    })
  }, [])

  const setScale = useCallback((scale: number) => {
    driving.current = null
    each((p) => {
      p.touched = true
      const image = imageOf(p)
      if (!image) return
      const { viewport } = p.viewer
      // Viewport zoom is how many pane-widths the scan spans, so a scan drawn at a
      // multiple of its own pixels is that multiple of its pixels over the pane's.
      const across = image.getContentSize().x / viewport.getContainerSize().x
      viewport.zoomTo(clampZoom(p.viewer, scale * across))
      viewport.applyConstraints()
    })
  }, [])

  const setZoom = useCallback((next: number) => {
    driving.current = null
    each((p) => {
      p.touched = true
      p.viewer.viewport.zoomTo(clampZoom(p.viewer, next * fitZoom(p.viewer)))
      p.viewer.viewport.applyConstraints()
    })
  }, [])

  return useMemo(
    () => ({ setZoom, setScale, setRotation, centerOn, toPage, screenDistance, register,
             onPanStart, onPanMove, onPanEnd }),
    [setZoom, setScale, setRotation, centerOn, toPage, screenDistance, register,
     onPanStart, onPanMove, onPanEnd],
  )
}
