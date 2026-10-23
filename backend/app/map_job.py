import argparse
import json
from pathlib import Path

from PIL import Image

from app import backend_client, store
from app.backend_client import Item
from app.line_geometry import as_regions
from app.map_ingest import ingest_map_job
from app.ocr_phase import is_cancelled
from app.remote_models import scan_image

Image.MAX_IMAGE_PIXELS = None


def served_model(conn, job: dict) -> tuple[backend_client.BackendClient, int] | None:
    """The job's map model on its model backend, as (client, models row id), or None while
    it is read in-process. Map models are picked by their registry id, which the models row
    keeps as `ref`."""
    if not job.get('model_id'):
        return None
    row = conn.execute("SELECT id FROM models WHERE task = 'map_segmentation' AND ref = ?",
                       (job['model_id'],)).fetchone()
    client = backend_client.client_for(conn, row['id']) if row else None
    return (client, row['id']) if client else None


def phase_predict(conn, job_id: str, client, model_id: int, class_ids: list[int], epsilon: float, min_area: int,
                  region_kind: str = 'polygon', merge_class_id: int | None = None):
    """Pre-annotate every ingested tile on the model backend (4.6): the backend slides its
    own window over a whole tile and polygonises the mask; DeepLabel stores the regions -
    a line job's as the surfaces' outlines, merged onto its one class - as the in-process
    runner does."""
    weights, _facts = client.load(conn, model_id)
    name = conn.execute('SELECT name FROM models WHERE id = ?', (model_id,)).fetchone()['name']
    author = f'model:mapseg@{name}'
    params = {'class_ids': class_ids, 'epsilon': epsilon, 'min_area': min_area}
    pages = conn.execute(
        "SELECT id, source_file FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'ingested' ORDER BY idx",
        (job_id,)).fetchall()
    done = conn.execute(
        "SELECT COUNT(*) c FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'done'", (job_id,)).fetchone()['c']
    store.update_counters(conn, job_id, pages_predicted=done)

    step = client.max_items('map_segmentation')
    for start in range(0, len(pages), step):
        if is_cancelled(conn, job_id):
            return
        chunk = pages[start:start + step]
        tiles = [Image.open(page['source_file']).convert('RGB') for page in chunk]
        response = client.predict_all('map_segmentation', weights, params, [
            Item(str(page['id']), scan_image(page['source_file'], tile)) for page, tile in zip(chunk, tiles)])
        for page, tile, result in zip(chunk, tiles, response['results']):
            if 'error' in result:
                raise RuntimeError(f"map backend refused tile {page['id']}: {result['error'].get('message')}")
            base = conn.execute('SELECT COALESCE(MAX(order_idx), -1) + 1 n FROM regions WHERE page_id = ?',
                                (page['id'],)).fetchone()['n']
            k = 0
            for region in result.get('regions', []):
                class_id = region['class_id'] if merge_class_id is None else merge_class_id
                surface = {'points': region['points'], 'holes': region.get('holes') or []}
                for points, holes in as_regions(surface, region_kind, *tile.size):
                    cur = conn.execute(
                        'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind, checked) '
                        'VALUES (?,?,?,?,?,?,0)',
                        (page['id'], base + k, class_id, json.dumps(points), json.dumps(holes), region_kind))
                    store.log_region(conn, cur.lastrowid, author, 'create')
                    k += 1
            conn.execute("UPDATE pages SET status = 'done' WHERE id = ?", (page['id'],))
            conn.commit()
            done += 1
            store.update_counters(conn, job_id, pages_predicted=done)


def main():
    """A map job whose tiles are already cut and whose model is on a model backend: the
    tiles ingested and pre-annotated with no model code in this process."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--db-path', required=True)
    parser.add_argument('--job-path', required=True)
    parser.add_argument('--blobs-dir', default='')
    parser.add_argument('--class-ids', default='')
    parser.add_argument('--epsilon', type=float, default=2.0)
    parser.add_argument('--min-area', type=int, default=12)
    parser.add_argument('--region-kind', default='polygon', choices=('polygon', 'polyline'))
    parser.add_argument('--merge-class-id', type=int, default=None)
    args = parser.parse_args()

    conn = store.connect(Path(args.db_path))
    job_id = args.job_id
    served = served_model(conn, store.get_job(conn, job_id))
    try:
        if served is None:
            raise RuntimeError("the job's map model is not on a model backend")
        store.set_job_state(conn, job_id, phase='ingest')
        ingest_map_job(conn, job_id, Path(args.job_path), final_status='ingested',
                       blobs_dir=Path(args.blobs_dir) if args.blobs_dir else None)
        if is_cancelled(conn, job_id):
            return
        store.set_job_state(conn, job_id, phase='predict')
        phase_predict(conn, job_id, *served, [int(c) for c in args.class_ids.split(',') if c], args.epsilon,
                      args.min_area, args.region_kind, args.merge_class_id)
        if not is_cancelled(conn, job_id):
            store.set_job_state(conn, job_id, status='done')
        conn.execute('UPDATE jobs SET phase = NULL WHERE id = ?', (job_id,))
        conn.commit()
    except Exception as exc:
        store.set_job_state(conn, job_id, status='error', error=f'{type(exc).__name__}: {exc}')
        raise


if __name__ == '__main__':
    main()
