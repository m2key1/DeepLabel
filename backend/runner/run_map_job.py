"""Map-segmentation GPU runner: ingest tiles, then run the pre-trained segmentation
model over each and write editable pre-annotations — filled polygons, or (--region-kind
polyline, for line-tracing jobs) the same detected surfaces reduced to their outlines.

Spawned as a subprocess by app/jobs.py `_spawn_map_runner` under MAPSEG_PYTHON (a
torch-capable venv): a phase list driven off page
status, per-item commits, cancellation checks between items, and status='error' on any
exception (the traceback lands in the job's runner.log).

The model and map-IO code is NOT in this repo: it lives in the sibling
cadastre_segmentation repo's `inference` package (engine / tiling / polygonize), which
_spawn_map_runner puts on PYTHONPATH via MAPSEG_ROOT — the same external-model-repo
pattern the text pipeline uses for Schematismus / DeepOCR / DeepSegment.

Deliberately imports NO Schematismus code and NOT app.config — every tunable arrives via
argv (like run_job's batch-size args), so this module loads in a minimal torch venv that
only needs the torch stack + PIL + numpy + cv2 + inference.* + the torch-free
app.store/map_ingest.
"""

import argparse
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

from app import blobs, map_job, store
from app import renditions, scans
from app.map_ingest import ingest_map_job
from inference import tiling
from runner import map_windows
from app.line_geometry import as_regions

Image.MAX_IMAGE_PIXELS = None

PAPER = 255


def is_cancelled(conn, job_id: str) -> bool:
    row = conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return row is None or row['status'] == 'cancelled'


def _load_tile(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.uint8)


def _predict_tile(engine, model, activation, tile: np.ndarray, device, batch_size: int,
                  window: int) -> np.ndarray:
    """The tile's class-index mask at its own resolution: the model's window slides over
    it (padded with paper where the tile is smaller), never a resized copy of the tile."""
    height, width = tile.shape[:2]
    padded = np.full((max(height, window), max(width, window), 3), PAPER, dtype=np.uint8)
    padded[:height, :width] = tile
    wins = map_windows.windows(width, height, window)
    patches = [padded[w.y:w.y + window, w.x:w.x + window] for w in wins]
    mask = np.zeros((height, width), dtype=np.uint8)
    for w, piece in zip(wins, engine.infer_batch(model, activation, patches, device, batch_size)):
        mask[w.keep_top:w.keep_bottom, w.keep_left:w.keep_right] = \
            piece[w.keep_top - w.y:w.keep_bottom - w.y, w.keep_left - w.x:w.keep_right - w.x]
    return mask


def phase_predict(conn, job_id, checkpoint, num_classes, class_ids, batch_size, epsilon, min_area,
                  region_kind='polygon', merge_class_id=None, window=512):
    import torch  # local: keeps the module importable for --help / tiling-only without a GPU stack
    from inference import engine, polygonize

    ckpt_path = Path(checkpoint)
    if not ckpt_path.exists():
        raise FileNotFoundError(f'map-segmentation checkpoint not found: {ckpt_path}')

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model, ckpt = engine.load(str(ckpt_path), device, num_classes=num_classes)
    activation = ckpt['Activation']
    # The sigmoid fusion path hardcodes a 6-class priority order; a different class count
    # would mis-assign channels. softmax2d (the shipped checkpoint) is unaffected.
    if activation == 'sigmoid' and num_classes != 6:
        raise ValueError('sigmoid checkpoints with a non-default class count need a priority order')
    author = f'model:mapseg@{ckpt_path.name}'
    try:
        pages = conn.execute(
            "SELECT id FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'ingested' ORDER BY idx",
            (job_id,)).fetchall()
        # Pre-seed with already-predicted tiles so the UI bar resumes on a re-queue.
        done = conn.execute(
            "SELECT COUNT(*) c FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'done'",
            (job_id,)).fetchone()['c']
        store.update_counters(conn, job_id, pages_predicted=done)

        for page in pages:
            if is_cancelled(conn, job_id):
                return
            pid = page['id']
            tile = _load_tile(conn.execute(
                'SELECT source_file FROM pages WHERE id = ?', (pid,)).fetchone()['source_file'])
            height, width = tile.shape[:2]
            mask = _predict_tile(engine, model, activation, tile, device, batch_size, window)
            polys = polygonize.to_normalized(
                polygonize.polygonize(mask, epsilon, min_area, class_ids), width, height)
            base = conn.execute(
                'SELECT COALESCE(MAX(order_idx), -1) + 1 n FROM regions WHERE page_id = ?',
                (pid,)).fetchone()['n']
            k = 0
            for poly in polys:
                # Line jobs: the surface's outlines, minus any stretch along the tile cut,
                # all merged onto one class (an outline does not inherit the class of the
                # surface it bounded).
                class_id = poly['class_id'] if merge_class_id is None else merge_class_id
                for points, holes in as_regions(poly, region_kind, width, height):
                    # checked=0: a prediction is unreviewed (unlike a hand-drawn region,
                    # which routes/maps.py inserts checked=1).
                    cur = conn.execute(
                        'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind, checked) '
                        'VALUES (?,?,?,?,?,?,0)',
                        (pid, base + k, class_id, json.dumps(points),
                         json.dumps(holes), region_kind))
                    store.log_region(conn, cur.lastrowid, author, 'create')
                    k += 1
            # Regions + status commit together, so a crash/requeue is idempotent: a
            # tile is either fully predicted+done or still 'ingested' with no rows.
            conn.execute("UPDATE pages SET status = 'done' WHERE id = ?", (pid,))
            conn.commit()
            done += 1
            store.update_counters(conn, job_id, pages_predicted=done)
    finally:
        del model
        engine.free_gpu()


def phase_tile(conn, job_id, job_path, tile_size, skip_blank, blobs_dir=None):
    """Cut each pending full map (job_maps) into square tiles, writing PNGs to
    job_dir/tiles/ and one pages row per kept tile. Per-map atomicity: the tile PNGs are
    written first, then all page rows + the map's status flip commit together — so a crash
    or cancel mid-map leaves the map 'pending' with no page rows, and a requeue redoes it
    (PNGs are deterministically overwritten)."""
    tiles_dir = job_path / 'tiles'
    tiles_dir.mkdir(parents=True, exist_ok=True)
    maps = conn.execute(
        "SELECT * FROM job_maps WHERE job_id = ? AND deleted = 0 AND status = 'pending' ORDER BY idx",
        (job_id,)).fetchall()
    seen = store.taken_hashes(conn, 'job_maps', job_id)
    done = conn.execute(
        "SELECT COUNT(*) c FROM job_maps WHERE job_id = ? AND deleted = 0 AND status != 'pending'",
        (job_id,)).fetchone()['c']
    store.update_counters(conn, job_id, maps_tiled=done)

    for m in maps:
        source = m['source_file']
        digest = renditions.file_hash(source)
        if digest not in seen:
            # Normalised like a page scan, so a turned photo uploaded twice is one map too.
            source = scans.normalised_map(source, m['filename'], job_path, m['id'])
            if source != m['source_file']:
                digest = renditions.file_hash(source)
                if digest in seen:
                    Path(source).unlink(missing_ok=True)
        if digest in seen:
            conn.execute("UPDATE job_maps SET status = 'duplicate', content_hash = ?, n_tiles = 0 WHERE id = ?",
                         (digest, m['id']))
            conn.commit()
            done += 1
            store.update_counters(conn, job_id, maps_tiled=done)
            continue
        seen.add(digest)
        blobs.share(source, digest, job_path, blobs_dir)

        reader = tiling.open_map_reader(source, tile_size, stream=True)
        try:
            h, w = reader.height, reader.width
            positions = list(tiling.tile_positions(h, w, tile_size))
            stem = Path(m['filename']).stem
            kept = []  # (display_name, disk_path, x0, y0)
            for i, (x0, y0) in enumerate(positions):
                if i % 50 == 0:
                    if is_cancelled(conn, job_id):
                        return  # map stays 'pending'; nothing committed for it yet
                    # Safe to publish progress here — no page rows inserted until the map is done.
                    store.update_counters(conn, job_id, tile_positions_total=len(positions),
                                          tile_positions_done=i)
                arr = reader.read_tile(x0, y0)
                if skip_blank and tiling.is_near_blank(arr):
                    continue
                arr = tiling.pad_tile(arr, tile_size)
                disk = tiles_dir / f'{m["id"]:05d}_{stem}__x{x0}_y{y0}.png'
                Image.fromarray(arr, 'RGB').save(disk)
                # Display name == disk name, map id included: two source maps in one job may
                # share a filename, and without the id their tiles are indistinguishable in
                # the tile list and collide on export.
                kept.append((disk.name, str(disk), x0, y0))
        finally:
            reader.close()

        # Single atomic commit for this map: its tile page rows + the status flip together.
        base = conn.execute(
            'SELECT COALESCE(MAX(idx), -1) + 1 n FROM pages WHERE job_id = ?', (job_id,)).fetchone()['n']
        for off, (fn, src, x0, y0) in enumerate(kept):
            conn.execute(
                'INSERT INTO pages (job_id, idx, filename, source_file, source_map, tile_x, tile_y) '
                'VALUES (?,?,?,?,?,?,?)', (job_id, base + off, fn, src, m['id'], x0, y0))
        conn.execute("UPDATE job_maps SET status = 'done', source_file = ?, content_hash = ?, width = ?, height = ?, "
                     "n_tiles = ? WHERE id = ?", (source, digest, w, h, len(kept), m['id']))
        conn.commit()
        done += 1
        store.recount_pages(conn, job_id)  # pages_total grows live; maps_tiled recomputed
    store.recount_pages(conn, job_id)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--db-path', required=True)
    parser.add_argument('--job-path', required=True)
    parser.add_argument('--run-tile', type=int, default=0)
    parser.add_argument('--run-predict', type=int, default=1)  # default 1 = back-compatible
    parser.add_argument('--tile-size', type=int, default=512)
    parser.add_argument('--skip-blank', type=int, default=1)
    parser.add_argument('--checkpoint', default='')
    parser.add_argument('--num-classes', type=int, default=6)
    parser.add_argument('--class-ids', default='')  # comma-separated drawable class ids
    parser.add_argument('--batch-size', type=int, default=4)
    parser.add_argument('--epsilon', type=float, default=2.0)
    parser.add_argument('--min-area', type=int, default=12)
    parser.add_argument('--window', type=int, default=512)  # the model's square input, px
    # 'polygon' (default, back-compatible) or 'polyline' for line-tracing jobs.
    parser.add_argument('--region-kind', default='polygon', choices=('polygon', 'polyline'))
    # Line jobs: tag every detected surface's outline with this one class id. Unset keeps
    # the model's own class per surface, which is what polygon jobs want.
    parser.add_argument('--merge-class-id', type=int, default=None)
    # Set when the model is on a model backend: the tiles are cut here, then read there.
    parser.add_argument('--served', type=int, default=0)
    args = parser.parse_args()

    conn = store.connect(Path(args.db_path))
    job_id = args.job_id
    job_path = Path(args.job_path)
    class_ids = [int(c) for c in args.class_ids.split(',') if c]
    # Via env rather than argv/app.config: the spawner sets it, and this module stays
    # loadable in the minimal mapseg venv.
    blobs_dir = Path(os.environ['BLOBS_DIR']) if os.environ.get('BLOBS_DIR') else None

    # Tiling → ingest → predict. Ingest parks tiles at 'ingested' only when predict follows;
    # otherwise they are 'done' (no later phase to advance them).
    final = 'ingested' if args.run_predict else 'done'
    phases = []
    if args.run_tile:
        phases.append(('tile', lambda: phase_tile(conn, job_id, job_path, args.tile_size,
                                                  bool(args.skip_blank), blobs_dir)))
    phases.append(('ingest', lambda: ingest_map_job(conn, job_id, job_path, final_status=final,
                                                    blobs_dir=blobs_dir)))
    if args.run_predict and args.served:
        def predict_served():
            served = map_job.served_model(conn, store.get_job(conn, job_id))
            if served is None:
                raise RuntimeError("the job's map model is no longer on a model backend")
            map_job.phase_predict(conn, job_id, *served, class_ids, args.epsilon, args.min_area,
                                  args.region_kind, args.merge_class_id)
        phases.append(('predict', predict_served))
    elif args.run_predict:
        phases.append(('predict', lambda: phase_predict(conn, job_id, args.checkpoint, args.num_classes,
                                                        class_ids, args.batch_size, args.epsilon, args.min_area,
                                                        args.region_kind, args.merge_class_id,
                                                        args.window)))

    try:
        for phase, fn in phases:
            if is_cancelled(conn, job_id):
                return
            store.set_job_state(conn, job_id, phase=phase)
            fn()
        if not is_cancelled(conn, job_id):
            store.set_job_state(conn, job_id, status='done')
        conn.execute('UPDATE jobs SET phase = NULL WHERE id = ?', (job_id,))
        conn.commit()
    except Exception as exc:
        store.set_job_state(conn, job_id, status='error', error=f'{type(exc).__name__}: {exc}')
        raise


if __name__ == '__main__':
    main()
