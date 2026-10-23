"""Map training export: one class-index PNG mask + geometry JSON sidecar per reviewed
tile, matching the cadastre trainer's on-disk format. Pure Pillow (the app venv has no
numpy/cv2/shapely). Rasterization paints geometry lowest-priority-first so a higher-priority
class wins overlapping pixels, and holes cut back to background (0); this makes an explicit
vector overlap-resolution pass unnecessary.

Polygons fill their interior; polylines (line-tracing jobs) are stroked at the job's
line_width, since a traced boundary has no area to fill. Both kinds share the one
priority-ordered pass, so a job holding both exports correctly.
"""

import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw

from app import coco
from app.caches import counted_page

Image.MAX_IMAGE_PIXELS = None

# Masks are 8-bit greyscale with the class id as the pixel value, so this is the largest
# id a class can have: a larger one would be written as 255 and read back as that class.
MAX_CLASS_ID = 255

# `classes` throughout is the job's vocabulary in classes_payload form
# ([{id, name, color, priority}]) from store.job_classes — no global map_classes.


def _rank(classes: list) -> dict:
    return {c['id']: c['priority'] for c in classes}


def _names(classes: list) -> dict:
    return {c['id']: c['name'] for c in classes}


def _stem(tile: dict) -> str:
    """Basename shared by a tile's mask, sidecar and the sidecar's `tile_name`. collect()
    assigns a deduplicated one; hand-built tiles fall back to the page filename."""
    return tile.get('export_stem') or Path(tile['page']['filename']).stem


def _stencil(poly: dict, width: int, height: int, stroke: int) -> Image.Image | None:
    """One region's coverage as a 1-bit stencil, or None for degenerate geometry. Sized to
    the tile the coordinates are in, never to the canvas being painted — the fused export
    paints tile-local stencils at a map-wide offset."""
    pts = [tuple(pt) for pt in poly['points']]
    line = poly.get('kind') == 'polyline'
    if len(pts) < (2 if line else 3):
        return None
    stencil = Image.new('1', (width, height), 0)
    draw = ImageDraw.Draw(stencil)
    if line:
        # joint='curve' rounds interior joints so corners of a traced boundary do not
        # develop notches at width > 4; endpoints stay square. A trace that comes back to
        # where it began has a corner there too, so it is drawn from the point before the
        # seam and on past it: that makes the seam an interior joint like every other
        # corner, and the repeated segments add no coverage.
        closed = len(pts) > 3 and pts[0] == pts[-1]
        run = [pts[-2], *pts, pts[1]] if closed else pts
        draw.line(run, fill=1, width=stroke, joint='curve')
    else:
        draw.polygon(pts, fill=1)
        for hole in poly.get('holes', []):
            if len(hole) >= 3:
                draw.polygon([tuple(pt) for pt in hole], fill=0)
    return stencil


def _priority_order(polygons: list, rank: dict) -> list:
    """Lowest priority first, so higher-priority classes paint over them. Unknown ids sort
    last here (painted first, so overwritten). `sorted` is stable, so equal priorities keep
    input order — for the fused export that is page idx, then region order_idx."""
    default = len(rank)
    return sorted(polygons, key=lambda p: rank.get(p['class_id'], default), reverse=True)


def rasterize(polygons: list, width: int, height: int, rank: dict, stroke: int = 3) -> Image.Image:
    """Class-index mask (mode 'L', pixel value = class id) from pixel-space geometry.
    Each item: {'class_id', 'points': [[x,y],...], 'holes': [[[x,y],...],...], 'kind'}.
    kind 'polygon' (default) fills its ring minus holes; kind 'polyline' strokes an open
    line `stroke` px wide. `rank` maps class id → priority (smaller wins); unknown ids
    sort last (painted first, so overwritten)."""
    mask = Image.new('L', (width, height), 0)
    for poly in _priority_order(polygons, rank):
        stencil = _stencil(poly, width, height, stroke)
        if stencil is not None:
            mask.paste(poly['class_id'], (0, 0), stencil)
    return mask


def _unique_stem(stem: str, row_id: int, taken: set) -> str:
    """`stem`, suffixed with the row's id while another file already holds the name. The
    id is stable, so re-exporting a job is reproducible; the suffix repeats because a
    suffixed name can be some other file's own (`a-12.png` beside two `a.png`)."""
    while stem in taken:
        stem = f'{stem}-{row_id}'
    taken.add(stem)
    return stem


def collect(conn, job_id: str, include_all: bool = False) -> tuple[list, dict]:
    """Eligible tiles and their live regions, coordinates scaled to pixels. Eligible =
    ingested (has dimensions), not deleted, not a duplicate, and — unless include_all —
    marked reviewed (layout_checked). A partly-annotated tile would teach the model
    background where the annotator simply hadn't drawn yet, hence the reviewed gate."""
    review = '' if include_all else 'AND layout_checked = 1 '
    pages = conn.execute(
        f"SELECT * FROM pages WHERE job_id = ? AND {counted_page()} "
        + review + 'ORDER BY idx', (job_id,)).fetchall()
    tiles = []
    taken = set()  # export stems used so far, so no two tiles write the same mask
    for page in pages:
        w, h = page['width'], page['height']
        if not w or not h:
            continue  # not yet ingested
        polygons = []
        for r in conn.execute(
                'SELECT * FROM regions WHERE page_id = ? AND deleted = 0 ORDER BY order_idx',
                (page['id'],)):
            pts = [[round(x * w, 2), round(y * h, 2)] for x, y in json.loads(r['points'])]
            holes = [[[round(x * w, 2), round(y * h, 2)] for x, y in hole]
                     for hole in json.loads(r['holes'])]
            polygons.append({'id': r['id'], 'class_id': r['class_id'], 'points': pts,
                             'holes': holes, 'kind': r['kind']})
        # Tiles cut from different source maps can share a filename, which would collide
        # in the zip (last entry wins) and silently drop a mask from the training set.
        tiles.append({'page': page, 'width': w, 'height': h, 'polygons': polygons,
                      'export_stem': _unique_stem(Path(page['filename']).stem, page['id'], taken)})
    manifest = {'tiles': len(tiles), 'regions': sum(len(t['polygons']) for t in tiles),
                'reviewed_only': not include_all}
    return tiles, manifest


def _class_map(names: dict) -> dict:
    return {str(cid): name for cid, name in names.items()}


def sidecar(tile: dict, names: dict, stroke: int = 3) -> dict:
    """Trainer-compatible geometry sidecar (pixel coordinates). A tile with no traced
    lines emits exactly the schema_version 2 document the cadastre trainer already reads;
    polylines add a `polylines` list + `line_width` and bump the version to 3, so existing
    polygon exports stay byte-identical."""
    now = datetime.now(timezone.utc).isoformat()
    named = lambda p: names.get(p['class_id'], str(p['class_id']))
    polygons = [p for p in tile['polygons'] if p.get('kind') != 'polyline']
    polylines = [p for p in tile['polygons'] if p.get('kind') == 'polyline']
    doc = {
        'tile_name': _stem(tile),
        'tile_size': tile['width'],
        'width': tile['width'], 'height': tile['height'],
        'schema_version': 3 if polylines else 2,
        'created_utc': now, 'modified_utc': now,
        'uncovered_policy': 'background',
        'class_map': _class_map(names),
        'polygons': [
            {'id': p['id'], 'class_id': p['class_id'], 'class_name': named(p),
             'points': p['points'], 'holes': p['holes']}
            for p in polygons],
    }
    if polylines:
        # Exact vector coordinates alongside the stroked raster, so a trainer can
        # re-rasterize at its own width instead of inheriting ours.
        doc['line_width'] = stroke
        doc['polylines'] = [
            {'id': p['id'], 'class_id': p['class_id'], 'class_name': named(p),
             'points': p['points']}
            for p in polylines]
    return doc


def _class_map_doc(classes: list) -> dict:
    return {'classes': classes, 'class_map': _class_map(_names(classes))}


def to_zip(tiles: list, classes: list, stroke: int = 3) -> bytes:
    rank, names = _rank(classes), _names(classes)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for tile in tiles:
            stem = _stem(tile)
            png = io.BytesIO()
            rasterize(tile['polygons'], tile['width'], tile['height'], rank, stroke).save(png, format='PNG')
            zf.writestr(f'annotations/{stem}.png', png.getvalue())
            zf.writestr(f'annotations/{stem}.json',
                        json.dumps(sidecar(tile, names, stroke), ensure_ascii=False, indent=2))
        zf.writestr('class_map.json', json.dumps(_class_map_doc(classes), ensure_ascii=False, indent=2))
    return buf.getvalue()


def write(tiles: list, dest: Path, classes: list, stroke: int = 3) -> Path:
    rank, names = _rank(classes), _names(classes)
    ann = dest / 'annotations'
    ann.mkdir(parents=True, exist_ok=True)
    for tile in tiles:
        stem = _stem(tile)
        rasterize(tile['polygons'], tile['width'], tile['height'], rank, stroke).save(ann / f'{stem}.png')
        (ann / f'{stem}.json').write_text(
            json.dumps(sidecar(tile, names, stroke), ensure_ascii=False, indent=2), encoding='utf-8')
    (dest / 'class_map.json').write_text(
        json.dumps(_class_map_doc(classes), ensure_ascii=False, indent=2), encoding='utf-8')
    return dest


# --- Fused full-map export ----------------------------------------------------
#
# The inverse of tiling: reviewed tiles painted back into one mask the size of the map
# they were cut from. Three things make this more than pasting tile masks side by side.
#
# `tile_positions` strides by tile_size but appends an edge-aligned final row/column at
# `size - tile` whenever the map is not an exact multiple, so **the last row and column
# overlap their neighbours**. Pasting finished tile masks would therefore be wrong twice
# over: the later tile's background would erase the earlier tile's classes in the overlap
# band, and a low-priority class from the later tile would overwrite a high-priority one
# from the earlier. So fusion happens at the geometry level — every region of every tile
# in one global priority pass, each stencil pasted at its tile's origin.
#
# Skipped-blank tiles leave real gaps in the grid, and unreviewed tiles are excluded, so
# an unpainted pixel means "not annotated here" as much as "background". The sidecar's
# `tiles` list names every contributing tile so a consumer can build a validity mask;
# `unreviewed_policy` says so explicitly.
#
# Stencils stay tile-sized, so a stroke is still clipped at the tile frame exactly as the
# per-tile export clips it — fusing changes nothing about what a single tile contributes.
# A feature traced in both halves of an overlap band therefore paints twice, which is
# harmless: both paints carry the same class.


def _origin(page) -> tuple[int, int]:
    """A tile's paste position in PIL (left, top) terms. Note the transposition: tile_x is
    the row offset (vertical) and tile_y the column offset, the old tool's convention."""
    return (page['tile_y'] or 0, page['tile_x'] or 0)


def collect_fused(conn, job_id: str) -> tuple[list, dict]:
    """Reviewed tiles regrouped under the source maps they were cut from. Always
    reviewed-only: a full-map mask assembled from unreviewed tiles would state background
    across everything nobody has looked at yet, which is worse per pixel than the per-tile
    export's version of the same mistake. Maps with no reviewed tile are skipped rather
    than emitted blank — a map-sized all-background mask is both large and wrong."""
    tiles, _ = collect(conn, job_id)
    maps = {m['id']: m for m in conn.execute(
        "SELECT * FROM job_maps WHERE job_id = ? AND deleted = 0 AND status = 'done' "
        'AND width IS NOT NULL AND height IS NOT NULL ORDER BY idx', (job_id,))}

    grouped: dict[int, list] = {}
    unattributed = 0
    for tile in tiles:
        map_id = tile['page']['source_map']
        if map_id is None or map_id not in maps:
            unattributed += 1  # an upload-a-tile job, or a map still being cut
            continue
        grouped.setdefault(map_id, []).append(tile)

    entries = []
    taken = set()  # export stems, deduplicated exactly as collect() does for tiles
    for map_id, row_map in maps.items():
        group = grouped.get(map_id)
        if not group:
            continue
        stem = _unique_stem(Path(row_map['filename']).stem, map_id, taken)
        polygons = []
        for tile in group:
            origin, w, h = _origin(tile['page']), tile['width'], tile['height']
            for poly in tile['polygons']:
                polygons.append({**poly, 'origin': origin, 'tile_w': w, 'tile_h': h})
        entries.append({
            'map': row_map, 'width': row_map['width'], 'height': row_map['height'],
            # The map's own tiles say what size it was cut at: the dataset's setting may
            # have changed since.
            'export_stem': stem, 'tile_size': group[0]['width'],
            # Every reviewed tile, including ones with no regions: "reviewed and empty" is
            # a real statement about the map, and the only way a consumer can tell that
            # area from one that was never annotated.
            'tiles': [{'x': t['page']['tile_x'], 'y': t['page']['tile_y'],
                       'page_id': t['page']['id']} for t in group],
            'polygons': polygons,
        })
    manifest = {'maps': len(entries), 'maps_skipped': len(maps) - len(entries),
                'tiles': sum(len(e['tiles']) for e in entries),
                'regions': sum(len(e['polygons']) for e in entries),
                'tiles_unattributed': unattributed, 'reviewed_only': True}
    return entries, manifest


def rasterize_fused(entry: dict, rank: dict, stroke: int = 3) -> Image.Image:
    """One map-sized class-index mask. Stencils stay tile-sized and are pasted at their
    tile's origin; PIL clips a paste that runs past the canvas, which is what keeps
    geometry drawn in a small map's white padding from raising."""
    mask = Image.new('L', (entry['width'], entry['height']), 0)
    for poly in _priority_order(entry['polygons'], rank):
        stencil = _stencil(poly, poly['tile_w'], poly['tile_h'], stroke)
        if stencil is not None:
            mask.paste(poly['class_id'], poly['origin'], stencil)
    return mask


def _translated(poly: dict) -> tuple[list, list]:
    """A region's points and holes in map pixels. The same origin the raster paste uses,
    so the two can never drift apart."""
    left, top = poly['origin']
    move = lambda ring: [[round(x + left, 2), round(y + top, 2)] for x, y in ring]
    return move(poly['points']), [move(hole) for hole in poly['holes']]


def fused_sidecar(entry: dict, names: dict, stroke: int = 3) -> dict:
    """Geometry for one fused map, in map pixels. Its own schema: this is a different
    artifact from the per-tile sidecar, not a newer version of it, so it carries its own
    version counter rather than continuing that document's 2/3."""
    now = datetime.now(timezone.utc).isoformat()
    named = lambda p: names.get(p['class_id'], str(p['class_id']))
    entries = [(p, *_translated(p)) for p in entry['polygons']]
    polygons = [(p, pts, holes) for p, pts, holes in entries if p.get('kind') != 'polyline']
    polylines = [(p, pts) for p, pts, _ in entries if p.get('kind') == 'polyline']
    doc = {
        'schema': 'fused-map', 'schema_version': 1,
        'map_name': entry['export_stem'],
        'source_filename': entry['map']['filename'],
        'width': entry['width'], 'height': entry['height'],
        'tile_size': entry['tile_size'],
        'created_utc': now, 'modified_utc': now,
        'uncovered_policy': 'background',
        # Areas of the map whose tiles were skipped as blank, or not marked reviewed, are
        # background in the mask. `tiles` is what tells them apart from a real background.
        'unreviewed_policy': 'background',
        'class_map': _class_map(names),
        'tiles': entry['tiles'],
        'polygons': [
            {'id': p['id'], 'class_id': p['class_id'], 'class_name': named(p),
             'points': pts, 'holes': holes, 'tile': [p['origin'][1], p['origin'][0]]}
            for p, pts, holes in polygons],
    }
    if polylines:
        doc['line_width'] = stroke
        doc['polylines'] = [
            {'id': p['id'], 'class_id': p['class_id'], 'class_name': named(p),
             'points': pts, 'tile': [p['origin'][1], p['origin'][0]]}
            for p, pts in polylines]
    return doc


def fused_to_zip(entries: list, classes: list, stroke: int = 3) -> bytes:
    rank, names = _rank(classes), _names(classes)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            stem = entry['export_stem']
            mask = rasterize_fused(entry, rank, stroke)
            # Streamed into the archive rather than through a BytesIO: a full map mask can
            # be a few hundred MB uncompressed, and one copy of that is enough.
            with zf.open(f'maps/{stem}.png', 'w') as fh:
                mask.save(fh, format='PNG')
            del mask
            zf.writestr(f'maps/{stem}.json',
                        json.dumps(fused_sidecar(entry, names, stroke), ensure_ascii=False, indent=2))
        zf.writestr('class_map.json', json.dumps(_class_map_doc(classes), ensure_ascii=False, indent=2))
    return buf.getvalue()


def fused_write(entries: list, dest: Path, classes: list, stroke: int = 3) -> Path:
    rank, names = _rank(classes), _names(classes)
    maps_dir = dest / 'maps'
    maps_dir.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        stem = entry['export_stem']
        rasterize_fused(entry, rank, stroke).save(maps_dir / f'{stem}.png')
        (maps_dir / f'{stem}.json').write_text(
            json.dumps(fused_sidecar(entry, names, stroke), ensure_ascii=False, indent=2), encoding='utf-8')
    (dest / 'class_map.json').write_text(
        json.dumps(_class_map_doc(classes), ensure_ascii=False, indent=2), encoding='utf-8')
    return dest


def slug(name: str) -> str:
    return coco.slug(name)
