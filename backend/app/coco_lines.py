import json
import shutil
from pathlib import Path

from PIL import Image

from app.caches import counted_page
from app.coco import ANNOTATION_FILE

Image.MAX_IMAGE_PIXELS = None

CATEGORIES = [{'id': 1, 'name': 'Line', 'supercategory': 'text'}]
MIN_SIDE = 1.0


def _crop_local(polygon: list, ex0: int, ey0: int, w: int, h: int) -> list:
    # Page-normalized polygon -> element-crop-local pixels, the exact inverse of the
    # runner's per-crop line detection (round(bbox*dim) origin, matching the crop cache).
    return [[pt[0] * w - ex0, pt[1] * h - ey0] for pt in polygon]


def _shoelace(poly: list) -> float:
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def collect(conn, job_id: str) -> tuple[dict, dict]:
    """One COCO dataset of the sole 'Line' category: images are element crops of
    pages marked lines-complete, annotations are their line polygons in crop space."""
    pages = conn.execute(
        'SELECT id, content_hash, filename, source_file, width, height FROM pages '
        f"WHERE job_id = ? AND lines_checked = 1 AND {counted_page()} "
        'AND content_hash IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL '
        'ORDER BY idx', (job_id,)).fetchall()
    doc = {'images': [], 'annotations': [], 'categories': CATEGORIES}
    crops = {}      # file_name -> (source_file, crop_box_px)
    skipped = 0
    for page in pages:
        w, h = page['width'], page['height']
        for el in conn.execute(
                "SELECT id, bbox FROM elements WHERE page_id = ? AND deleted = 0 AND kind = 'content' "
                'ORDER BY order_idx', (page['id'],)):
            x0, y0, x1, y1 = json.loads(el['bbox'])
            ex0, ey0, ex1, ey1 = round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)
            cw, ch = ex1 - ex0, ey1 - ey0
            lines = conn.execute(
                'SELECT polygon FROM lines WHERE element_id = ? AND deleted = 0 ORDER BY order_idx',
                (el['id'],)).fetchall()
            if cw < MIN_SIDE or ch < MIN_SIDE or not lines:
                continue
            image_id = len(doc['images']) + 1
            name = f"{job_id}_{page['content_hash'][:8]}_el{el['id']}.jpg"
            doc['images'].append({'id': image_id, 'file_name': name, 'width': cw, 'height': ch})
            crops[name] = (page['source_file'], (ex0, ey0, ex1, ey1))
            for ln in lines:
                poly = _crop_local(json.loads(ln['polygon']), ex0, ey0, w, h)
                xs = [max(0.0, min(p[0], cw)) for p in poly]
                ys = [max(0.0, min(p[1], ch)) for p in poly]
                bw, bh = max(xs) - min(xs), max(ys) - min(ys)
                if bw < MIN_SIDE or bh < MIN_SIDE:
                    skipped += 1
                    continue
                seg = [round(v, 2) for xy in zip(xs, ys) for v in xy]
                doc['annotations'].append({
                    'id': len(doc['annotations']) + 1, 'image_id': image_id, 'category_id': 1,
                    'segmentation': [seg], 'bbox': [round(min(xs), 2), round(min(ys), 2),
                                                    round(bw, 2), round(bh, 2)],
                    'area': round(_shoelace(list(zip(xs, ys))), 2), 'iscrowd': 0})
    manifest = {'pages': len(pages), 'skipped_lines': skipped,
                'images': len(doc['images']), 'annotations': len(doc['annotations'])}
    return {'doc': doc, 'crops': crops}, manifest


def write(dataset: dict, dest: Path) -> None:
    """Crop each element out of its source page and write the line annotations into
    one flat dataset under dest (no train/valid split). Files no longer wanted are
    pruned, including the old train/ and valid/ split dirs; a source that has gone
    (a purged page) is skipped, never fatal."""
    dest.mkdir(parents=True, exist_ok=True)
    present = {}
    for name, (source, boxpx) in dataset['crops'].items():
        target = dest / name
        if target.exists():
            present[name] = source
        elif Path(source).exists():
            try:
                with Image.open(source) as img:
                    img.convert('RGB').crop(boxpx).save(target, quality=90)
                present[name] = source
            except Exception:
                pass
    for existing in dest.iterdir():
        if existing.name == ANNOTATION_FILE or existing.name in present:
            continue
        if existing.is_dir():
            shutil.rmtree(existing)
        else:
            existing.unlink()
    tmp = dest / (ANNOTATION_FILE + '.tmp')
    tmp.write_text(json.dumps(dataset['doc']), encoding='utf-8')
    tmp.replace(dest / ANNOTATION_FILE)
