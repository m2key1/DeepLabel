import json
import re
import shutil
from pathlib import Path

from app import layout_classes, layout_templates
from app.caches import counted_page

ANNOTATION_FILE = '_annotations.coco.json'
MIN_SIDE = 1.0


def category_for(class_name: str, raw_class_name: str | None, ids: dict) -> int | None:
    """The category id an element exports under: its dataset class's id, by raw label."""
    return ids.get(raw_class_name or layout_classes.LEGACY_RAW.get(class_name, class_name))


def to_abs_bbox(bbox: list[float], width: int, height: int) -> list[float] | None:
    x0 = max(0.0, min(bbox[0], 1.0)) * width
    y0 = max(0.0, min(bbox[1], 1.0)) * height
    x1 = max(0.0, min(bbox[2], 1.0)) * width
    y1 = max(0.0, min(bbox[3], 1.0)) * height
    w, h = x1 - x0, y1 - y0
    if w < MIN_SIDE or h < MIN_SIDE:
        return None
    return [round(x0, 2), round(y0, 2), round(w, 2), round(h, 2)]


def categories(classes: list[dict] | None = None) -> list[dict]:
    """COCO categories of a dataset's classes, by class id - Schematismus' by default."""
    return [{'id': c['id'], 'name': c['name']}
            for c in sorted(classes or layout_templates.schematismus_classes(), key=lambda c: c['id'])]


def image_name(job_id: str, content_hash: str, filename: str) -> str:
    return f'{job_id}_{content_hash[:8]}_{filename}'


def collect(conn, job_id: str, outlines: bool = False) -> tuple[dict, dict]:
    """Returns ({'doc': coco_dict, 'files': {name: source}}, manifest). Only
    layout-complete pages qualify: a partially annotated page would teach the
    detector that unmarked regions are background. With `outlines`, a polygon dataset's
    elements carry their outline as the segmentation; training leaves it out, since the
    layout model detects boxes."""
    polygons = outlines and conn.execute(
        'SELECT layout_shape FROM jobs WHERE id = ?', (job_id,)).fetchone()['layout_shape'] == 'polygon'
    pages = conn.execute(
        'SELECT id, content_hash, filename, source_file, width, height FROM pages '
        f"WHERE job_id = ? AND layout_checked = 1 AND {counted_page()} "
        'AND content_hash IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL '
        'ORDER BY idx', (job_id,)).fetchall()

    classes = layout_templates.job_classes(conn, job_id)
    ids = {c['name']: c['id'] for c in classes}
    doc = {'images': [], 'annotations': [], 'categories': categories(classes)}
    files = {}
    skipped = 0
    for page in pages:
        image_id = len(doc['images']) + 1
        name = image_name(job_id, page['content_hash'], page['filename'])
        doc['images'].append({'id': image_id, 'file_name': name,
                              'width': page['width'], 'height': page['height']})
        files[name] = page['source_file']
        # Containers are real checkpoint categories and belong in ground truth;
        # orphans are the synthetic 'Unassigned' line bucket and are not regions.
        for el in conn.execute(
                'SELECT class_name, raw_class_name, bbox, polygon FROM elements '
                "WHERE page_id = ? AND deleted = 0 AND kind != 'orphan' ORDER BY order_idx",
                (page['id'],)):
            category = category_for(el['class_name'], el['raw_class_name'], ids)
            bbox = to_abs_bbox(json.loads(el['bbox']), page['width'], page['height'])
            if category is None or bbox is None:
                skipped += 1
                continue
            doc['annotations'].append({
                'id': len(doc['annotations']) + 1, 'image_id': image_id,
                'category_id': category,
                'bbox': bbox, 'area': round(bbox[2] * bbox[3], 2),
                'segmentation': [[round(v, 2) for x, y in json.loads(el['polygon'])
                                  for v in (x * page['width'], y * page['height'])]]
                if polygons and el['polygon'] else [],
                'iscrowd': 0})

    manifest = {'pages': len(pages), 'skipped_elements': skipped,
                'images': len(doc['images']), 'annotations': len(doc['annotations'])}
    return {'doc': doc, 'files': files}, manifest


def slug(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'job'


def write(dataset: dict, dest: Path) -> None:
    """Write one flat COCO dataset under dest (no train/valid split): the images
    plus _annotations.coco.json. Files no longer in the manifest are pruned so a
    page that loses layout_checked leaves nothing stale behind - including the old
    train/ and valid/ split dirs. A source image that has gone (a purged page) is
    skipped rather than raising, so one missing scan cannot freeze the sync."""
    dest.mkdir(parents=True, exist_ok=True)
    present = {}
    for name, source in dataset['files'].items():
        target = dest / name
        if target.exists():
            present[name] = source
        elif Path(source).exists():
            shutil.copyfile(source, target)
            present[name] = source
    for existing in dest.iterdir():
        if existing.name == ANNOTATION_FILE or existing.name in present:
            continue
        if existing.is_dir():
            shutil.rmtree(existing)
        else:
            existing.unlink()
    # Written atomically and last, so a reader never sees a truncated file or an
    # annotation referencing an image not yet in place.
    tmp = dest / (ANNOTATION_FILE + '.tmp')
    tmp.write_text(json.dumps(dataset['doc']), encoding='utf-8')
    tmp.replace(dest / ANNOTATION_FILE)
