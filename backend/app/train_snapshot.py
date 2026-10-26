import hashlib
import json
import multiprocessing
import os
import shutil
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

from app import characters, coco, config, layout_templates, line_shapes, linecrop
from app.caches import counted_page


class SnapshotCancelled(Exception):
    """Raised when the training was cancelled while its snapshot was still being cut."""


# Level 6 spends 20 ms per crop on compression and 80% of a large snapshot's wall clock;
# level 1 costs 5 ms for files 5% larger. Still lossless, still PNG.
PNG_COMPRESS = 1

# One page is one independent unit of work - open, cut, write - so the cut fans out over
# the box. Two cores stay free for the API this runs inside.
WORKERS = max(1, (os.cpu_count() or 2) - 2)
# Forked from the threaded API, a worker can inherit a lock another thread holds and
# wait on it forever; a forkserver starts each one clean.
POOL_CONTEXT = multiprocessing.get_context('forkserver')


# A line that language models settled among themselves carries check_source 'llm'; every
# other check was made by a person, or by matching a transcription they supplied.
HUMAN_CHECK = "(l.check_source IS NULL OR l.check_source != 'llm')"
HUMAN_CHECKED = f'AND {HUMAN_CHECK}'


def checked_by(human_checked_only: bool) -> str:
    return HUMAN_CHECKED if human_checked_only else ''


def _hash(key: str) -> bytes:
    return hashlib.sha256(key.encode()).digest()


def _split_key(page) -> str:
    """One key per page, derived from the scanned image itself. Splitting whole pages
    keeps a page's lines from straddling the split, and keying on the content hash puts
    identical pages - the same scan ingested into several datasets - on the same side,
    so the model never validates on an image it trained on. A test page is its own key:
    it goes to a run's test set or nowhere."""
    if page['is_test']:
        return f"test:{page['id']}"
    return f"page:{page['content_hash'] or page['id']}"


# The part a page goes to when the run must not read it at all.
LEFT_OUT = 'left_out'


def test_scans(conn) -> set[str]:
    """The scans of every test page. A page of the same scan anywhere is never trained on."""
    return {row[0] for row in conn.execute(
        'SELECT DISTINCT content_hash FROM pages WHERE is_test = 1 AND deleted = 0 '
        'AND content_hash IS NOT NULL')}


def page_filter(alias: str = '', pages: str = 'train') -> str:
    """SQL for the pages a run trains on - not test data, nor a scan of it - or for the
    'test' pages, or for 'all' of them."""
    a = f'{alias}.' if alias else ''
    if pages == 'all':
        return '1 = 1'
    if pages == 'test':
        return f'{a}is_test = 1'
    return (f'{a}is_test = 0 AND ({a}content_hash IS NULL OR {a}content_hash NOT IN ('
            'SELECT content_hash FROM pages WHERE is_test = 1 AND deleted = 0 AND content_hash IS NOT NULL))')


def _kept_out(key: str, scans: set[str]) -> bool:
    return key.startswith('test:') or key.removeprefix('page:') in scans


def _keeping_tests_out(split, read: list[str], tests: list[str], scans: set[str]):
    """The split with test data kept out of training: a test page goes to the test set
    when its dataset is one of the run's test sets, and every other page that is test
    data, shares a scan with test data, or sits in a test set the run does not train on,
    is left out."""
    read, tests = set(read), set(tests)

    def guarded(job_id: str, key: str) -> str:
        if key.startswith('test:'):
            return 'test' if job_id in tests else LEFT_OUT
        if job_id not in read or _kept_out(key, scans):
            return LEFT_OUT
        return split(job_id, key)
    return guarded


def _holdout_splitter(valid_job_ids: list[str]):
    valid = set(valid_job_ids)

    def split(job_id: str, key: str) -> str:
        return 'val' if job_id in valid else 'train'
    return split


def _task_keys(conn, task: str, job_id: str, human_checked_only: bool = False) -> list[str]:
    """The split keys the task's builder will ask about, mirroring its selection."""
    if task == 'ocr':
        rows = conn.execute(
            'SELECT DISTINCT p.id, p.content_hash, p.is_test FROM pages p '
            'JOIN elements e ON e.page_id = p.id JOIN lines l ON l.element_id = e.id '
            f"WHERE p.job_id = ? AND {counted_page('p')} "
            f'AND l.checked = 1 AND l.deleted = 0 AND e.deleted = 0 {checked_by(human_checked_only)}',
            (job_id,)).fetchall()
    elif task == 'layout':
        rows = conn.execute(
            'SELECT id, content_hash, is_test FROM pages '
            f"WHERE job_id = ? AND layout_checked = 1 AND {counted_page()} "
            'AND content_hash IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL',
            (job_id,)).fetchall()
    else:
        rows = conn.execute(
            'SELECT id, content_hash, is_test FROM pages '
            f"WHERE job_id = ? AND lines_checked = 1 AND {counted_page()} "
            'AND width IS NOT NULL', (job_id,)).fetchall()
    return [_split_key(r) for r in rows]


def _rank_split(keys: set[str], val_fraction: float, at_least_one: bool = False) -> set[str]:
    """The lowest-hashing keys go to valid: deterministic, an exact fraction, and never
    all of them - at least one key always stays in train. With at_least_one, a fraction
    that rounds to nothing still takes one key, wherever two or more can be split."""
    ranked = sorted(keys, key=_hash)
    picked = round(len(ranked) * val_fraction)
    if at_least_one and val_fraction > 0:
        picked = max(picked, 1)
    return set(ranked[:min(picked, max(len(ranked) - 1, 0))])


def _trainable_keys(conn, task: str, job_id: str, human_checked_only: bool, scans: set[str]) -> set[str]:
    return {key for key in _task_keys(conn, task, job_id, human_checked_only) if not _kept_out(key, scans)}


def _uniform_splitter(conn, task: str, job_ids: list[str], val_fraction: float,
                      human_checked_only: bool = False, scans: frozenset = frozenset()):
    """val_fraction of all distinct trainable pages lands in valid, picked by hash rank."""
    keys = {key for job_id in job_ids
            for key in _trainable_keys(conn, task, job_id, human_checked_only, scans)}
    val_keys = _rank_split(keys, val_fraction)

    def split(job_id: str, key: str) -> str:
        return 'val' if key in val_keys else 'train'
    return split


def _stratified_splitter(conn, task: str, job_ids: list[str], val_fraction: float,
                         human_checked_only: bool = False, scans: frozenset = frozenset()):
    """Exactly val_fraction of every dataset's pages lands in valid, and at least one page
    of every dataset that has two. Keys are ranked by hash so the picks are deterministic
    yet uncorrelated with insertion order."""
    val_keys: set[str] = set()
    for job_id in job_ids:
        val_keys |= _rank_split(_trainable_keys(conn, task, job_id, human_checked_only, scans),
                                val_fraction, at_least_one=True)

    def split(job_id: str, key: str) -> str:
        return 'val' if key in val_keys else 'train'
    return split


def _page_image(page_row) -> Image.Image:
    return Image.open(page_row['source_file']).convert('RGB')


def ocr_pages(conn, job_ids: list[str], split, human_checked_only: bool = False):
    """Every page the OCR cut reads, as (job_id, page, part, lines): the checked lines on
    it, each with the target it would train on. A line whose target comes out empty, or
    only whitespace, is still listed - the cut leaves it out, and the pre-flight reports it."""
    for job_id in job_ids:
        pages = conn.execute(
            'SELECT id, source_file, content_hash, filename, width, height, is_test FROM pages '
            f"WHERE job_id = ? AND {counted_page()}", (job_id,)).fetchall()
        for page in pages:
            lines = []
            for row in conn.execute(
                    'SELECT l.id, l.polygon, l.orientation, l.text, l.corrected_text, '
                    'l.check_source FROM lines l JOIN elements e ON l.element_id = e.id '
                    f'WHERE e.page_id = ? AND l.checked = 1 AND l.deleted = 0 AND e.deleted = 0 '
                    f'{checked_by(human_checked_only)}',
                    (page['id'],)):
                stored = row['corrected_text'] if row['corrected_text'] is not None else row['text']
                target = characters.training_target(stored or '')
                lines.append({**dict(row), 'stored': stored or '',
                              'target': target if target.strip() else ''})
            part = split(job_id, _split_key(page))
            if part != LEFT_OUT:
                yield job_id, page, part, lines


def _ocr_work(conn, job_ids: list[str], dirs: dict, split,
              human_checked_only: bool = False) -> list[tuple]:
    """The whole cut, resolved to plain data: one entry per page, holding everything a
    worker needs. Every database read happens here, in this process."""
    work = []
    manifest = {}
    for job_id, page, part, lines in ocr_pages(conn, job_ids, split, human_checked_only):
        items = []
        for line in lines:
            if not line['target']:
                continue
            items.append((f'line_{line["id"]}', str(dirs[part]), json.loads(line['polygon']),
                          line['orientation'], line['target']))
            manifest[f'line_{line["id"]}'] = job_id
        if items:
            work.append((page['source_file'], items))
    return work, manifest


def _cut_page(entry: tuple) -> list[str]:
    """Cut one page's checked lines into crop/text pairs. Runs in a worker process, so it
    touches nothing but the image and the filesystem."""
    source_file, items = entry
    img = Image.open(source_file).convert('RGB')
    written = []
    for stem, out_dir, polygon, orientation, text in items:
        poly = [[x * img.width, y * img.height] for x, y in polygon]
        crop = linecrop.crop_line(img, poly, orientation, mask=config.LINE_CROP_MASK)
        if crop is None:
            continue
        crop.save(Path(out_dir) / f'{stem}.png', compress_level=PNG_COMPRESS)
        (Path(out_dir) / f'{stem}.txt').write_text(text, encoding='utf-8')
        written.append(out_dir)
    return written


def _build_ocr(conn, job_ids: list[str], dest: Path, split, on_progress=None,
               should_stop=None, human_checked_only: bool = False) -> dict:
    """Checked lines only, in DeepOCR's native layout: train/ and valid/ dirs of
    crop images with sibling .txt ground-truth files.

    A page is cut per worker process: the work is embarrassingly parallel and a large
    dataset is tens of thousands of crops, which one core turns into an hour of silence."""
    dirs = {'train': dest / 'train', 'val': dest / 'valid'}
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    work, manifest = _ocr_work(conn, job_ids, dirs, split, human_checked_only)
    # Which dataset each crop came from, so an evaluation over the frozen split can
    # report per-dataset scores.
    (dest / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    total = sum(len(items) for _source, items in work)
    counts = {'train': 0, 'val': 0}
    by_dir = {str(path): part for part, path in dirs.items()}
    done = 0
    if on_progress:
        on_progress(done, total)

    with ProcessPoolExecutor(max_workers=WORKERS, mp_context=POOL_CONTEXT) as pool:
        futures = {pool.submit(_cut_page, entry): len(entry[1]) for entry in work}
        for future in as_completed(futures):
            for out_dir in future.result():
                counts[by_dir[out_dir]] += 1
            done += futures[future]
            if on_progress:
                on_progress(done, total)
            if should_stop and should_stop():
                pool.shutdown(wait=False, cancel_futures=True)
                raise SnapshotCancelled()
    return counts


def layout_images(conn, job_ids: list[str], split, remap: dict | None = None):
    """Every layout-complete page the layout cut copies, as (job_id, part, image, its
    annotations, source file, page row) in COCO form - its category ids the training's
    (layout_templates.training_classes) when a `remap` is given."""
    for job_id in job_ids:
        dataset, _ = coco.collect(conn, job_id)
        page_by_name = {
            coco.image_name(job_id, p['content_hash'], p['filename']): p
            for p in conn.execute(
                'SELECT id, content_hash, filename, is_test FROM pages '
                f"WHERE job_id = ? AND {counted_page()} "
                'AND content_hash IS NOT NULL', (job_id,))}
        annos_by_image: dict[int, list] = {}
        renumber = (remap or {}).get(job_id, {})
        for anno in dataset['doc']['annotations']:
            annos_by_image.setdefault(anno['image_id'], []).append(
                {**anno, 'category_id': renumber.get(anno['category_id'], anno['category_id'])})
        for img in dataset['doc']['images']:
            page = page_by_name.get(img['file_name'])
            key = _split_key(page) if page else f'page:{img["file_name"]}'
            part = split(job_id, key)
            if part != LEFT_OUT:
                yield (job_id, part, img, annos_by_image.get(img['id'], []),
                       dataset['files'][img['file_name']], page)


def segmentation_lines(conn, job_ids: list[str], split, line_shape: str = 'polygon'):
    """Every line-verified page the line-detection cut draws, as (job_id, page, part, its
    lines as (id, polygon in page pixels in the run's line shape, the class of the element
    it sits in)). A page without a line is skipped, as the cut skips it."""
    for job_id in job_ids:
        pages = conn.execute(
            'SELECT id, source_file, content_hash, filename, width, height, is_test FROM pages '
            f"WHERE job_id = ? AND lines_checked = 1 AND {counted_page()} "
            'AND width IS NOT NULL', (job_id,)).fetchall()
        for page in pages:
            lines = [
                (line['id'], line_shapes.shaped([(x * page['width'], y * page['height'])
                                                 for x, y in json.loads(line['polygon'])], line_shape),
                 line['class_name'])
                for line in conn.execute(
                    'SELECT l.id, l.polygon, e.class_name FROM lines l JOIN elements e ON l.element_id = e.id '
                    'WHERE e.page_id = ? AND l.deleted = 0 AND e.deleted = 0 ORDER BY e.order_idx, l.order_idx',
                    (page['id'],))
            ]
            part = split(job_id, _split_key(page))
            if lines and part != LEFT_OUT:
                yield job_id, page, part, lines


def segmentation_pages(conn, job_ids: list[str], split, line_shape: str = 'polygon'):
    """As segmentation_lines, with only each line's polygon."""
    for job_id, page, part, lines in segmentation_lines(conn, job_ids, split, line_shape):
        yield job_id, page, part, [polygon for _id, polygon, _class in lines]


# The contract kinds' split directories; test/ only when the run has test datasets.
CONTRACT_SPLITS = {'train': 'train', 'val': 'valid', 'test': 'test'}


def _build_page_boxes(conn, job_ids: list[str], dest: Path, split) -> dict:
    """The contract's `page-boxes/1` (6.3): <split>/images/<file> and one COCO file per
    split, boxes in page pixels under DeepLabel's own layout vocabulary - without the
    roboflow test/ mirror, which an RF-DETR entrypoint adds for itself. A run's test datasets
    are its test/ split, scored once the run is trained."""
    dirnames = CONTRACT_SPLITS
    categories, remap = layout_templates.training_classes(conn, job_ids)
    docs = {name: {'images': [], 'annotations': [], 'categories': categories} for name in dirnames}
    counts = {'train': 0, 'val': 0, 'test': 0}
    groups = {}
    for job_id, part, img, annos, source, _page in layout_images(conn, job_ids, split, remap):
        groups[Path(img['file_name']).stem] = job_id
        doc = docs[part]
        new_id = len(doc['images']) + 1
        out = dest / dirnames[part] / 'images' / img['file_name']
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, out)
        doc['images'].append({**img, 'id': new_id})
        for anno in annos:
            doc['annotations'].append({**anno, 'id': len(doc['annotations']) + 1, 'image_id': new_id})
        counts[part] += 1
    for part, name in dirnames.items():
        if part == 'test' and not counts['test']:
            continue
        (dest / name).mkdir(parents=True, exist_ok=True)
        (dest / name / '_annotations.coco.json').write_text(json.dumps(docs[part]), encoding='utf-8')
    _write_groups(dest, groups)
    return _without_empty_test(counts)


def _write_groups(dest: Path, groups: dict[str, str]) -> None:
    """Which dataset each page came from, by its file's stem: the contract manifest's
    `groups`, so a backend can score its run per dataset."""
    (dest / 'manifest.json').write_text(json.dumps(groups), encoding='utf-8')


def _build_page_lines(conn, job_ids: list[str], dest: Path, split, line_shape: str = 'polygon') -> dict:
    """The contract's `page-lines/1` (6.3): <split>/images/<stem>.png and
    <split>/lines/<stem>.json with every line's polygon in page pixels and the class of
    the element it sits in. Any trainer's own layout - DeepSegment's instance maps - is its
    entrypoint's to draw. A run's test datasets are its test/ split."""
    for part, name in CONTRACT_SPLITS.items():
        if part != 'test':
            (dest / name / 'images').mkdir(parents=True, exist_ok=True)
            (dest / name / 'lines').mkdir(parents=True, exist_ok=True)
    counts = {'train': 0, 'val': 0, 'test': 0}
    groups = {}
    for job_id, page, part, lines in segmentation_lines(conn, job_ids, split, line_shape):
        stem = Path(coco.image_name(job_id, page['content_hash'], page['filename'])).stem
        groups[stem] = job_id
        root = dest / CONTRACT_SPLITS[part]
        (root / 'images').mkdir(parents=True, exist_ok=True)
        (root / 'lines').mkdir(parents=True, exist_ok=True)
        img = _page_image(page)
        img.save(root / 'images' / f'{stem}.png', compress_level=PNG_COMPRESS)
        (root / 'lines' / f'{stem}.json').write_text(json.dumps({
            'width': img.width, 'height': img.height,
            'lines': [{'id': line_id, 'polygon': [[round(x, 2), round(y, 2)] for x, y in polygon],
                       'element_class': element_class} for line_id, polygon, element_class in lines]}),
            encoding='utf-8')
        counts[part] += 1
    _write_groups(dest, groups)
    return _without_empty_test(counts)


def _without_empty_test(counts: dict) -> dict:
    return counts if counts['test'] else {key: n for key, n in counts.items() if key != 'test'}


def splitter(conn, task: str, job_ids: list[str], val_fraction: float = 0.1,
             split_strategy: str = 'uniform', valid_job_ids: list[str] | None = None,
             human_checked_only: bool = False, test_job_ids: list[str] | None = None):
    """The split a run cuts with, as (split, every dataset it reads): a holdout run reads
    its validation datasets beside the training ones, and a run with a test set the
    test pages of its test datasets. Test data never trains or validates."""
    scans = frozenset(test_scans(conn))
    if split_strategy == 'holdout':
        split = _holdout_splitter(valid_job_ids or [])
        read = job_ids + [j for j in valid_job_ids or [] if j not in job_ids]
    elif split_strategy == 'stratified':
        split, read = _stratified_splitter(conn, task, job_ids, val_fraction, human_checked_only, scans), job_ids
    else:
        split, read = _uniform_splitter(conn, task, job_ids, val_fraction, human_checked_only, scans), job_ids
    tests = test_job_ids or []
    return (_keeping_tests_out(split, read, tests, scans),
            read + [j for j in tests if j not in read])


def left_out(conn, job_ids: list[str]) -> list[dict]:
    """Pages of these datasets left out of training for sharing a scan with test pages,
    counted per dataset that holds those test pages."""
    if not job_ids:
        return []
    marks = ', '.join('?' * len(job_ids))
    return [dict(row) for row in conn.execute(
        'SELECT t.job_id, j.name, COUNT(DISTINCT p.id) pages FROM pages p '
        'JOIN pages t ON t.content_hash = p.content_hash AND t.is_test = 1 AND t.deleted = 0 '
        'JOIN jobs j ON j.id = t.job_id '
        f"WHERE p.job_id IN ({marks}) AND p.is_test = 0 AND {counted_page('p')} "
        'GROUP BY t.job_id ORDER BY j.name', job_ids)]


# Each task's cut, in the contract's kind (6.3).
BUILDERS = {'ocr': _build_ocr, 'layout': _build_page_boxes, 'lines': _build_page_lines}


def build(conn, training_id: int, task: str, job_ids: list[str], val_fraction: float = 0.1,
          split_strategy: str = 'uniform', valid_job_ids: list[str] | None = None,
          on_progress=None, should_stop=None, human_checked_only: bool = False,
          test_job_ids: list[str] | None = None, line_shape: str = 'polygon') -> dict:
    """Freeze the checked material of the given datasets under the training's dir.
    The snapshot is what the model sees; later edits to the datasets do not touch it. A
    layout or lines run carries its test datasets as a test split, which its backend
    scores once the run is trained; OCR scores its test sets itself."""
    dest = config.training_dir(training_id) / 'snapshot'
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    # An OCR run scores its test set itself, from the datasets, once it is trained.
    split, job_ids = splitter(conn, task, job_ids, val_fraction, split_strategy, valid_job_ids,
                              human_checked_only, test_job_ids if task != 'ocr' else [])
    builder = BUILDERS[task]
    # Only the OCR cut is long enough to need reporting or interrupting.
    extra = ({'on_progress': on_progress, 'should_stop': should_stop,
              'human_checked_only': human_checked_only} if task == 'ocr'
             else {'line_shape': line_shape} if task == 'lines' else {})
    counts = builder(conn, job_ids, dest, split, **extra)
    (dest / 'counts.json').write_text(json.dumps(counts), encoding='utf-8')
    return counts
