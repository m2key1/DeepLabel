import io
import json
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app import auto_decode, backend_client, config, conventions, decode, evaluator, formats, ingest, \
    layout_templates, linecrop, ocr_phase, reading_order, registry, scans, store, text_job
from app.backend_client import Encoded
from app.remote_models import RemoteLines, RemoteOcrEngine

FORMATS = ('json', 'page', 'alto', 'hocr', 'txt')
SENT_AS_IS = {'JPEG': 'image/jpeg', 'PNG': 'image/png'}


class Refused(Exception):
    """A request the recognition API will not run, with its status, the reason, and for a
    429 how many seconds until it is worth asking again."""

    def __init__(self, status: int, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


BUSY_RETRY_SECONDS = 5


@dataclass
class Upload:
    name: str
    data: bytes


@dataclass
class InFlight:
    """A request while it runs, as the queue shows it."""
    id: str
    account: str
    pages: int
    lines_total: int = 0
    lines_read: int = 0
    stage: str = 'finding lines'
    waiting: bool = False
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S'))
    started: float = field(default_factory=time.monotonic)
    waited: float = 0.0
    wait_began: float = 0.0

    def wait(self, waiting: bool) -> None:
        self.waiting = waiting
        if waiting:
            self.wait_began = time.monotonic()
        else:
            self.waited += time.monotonic() - self.wait_began

    def held(self) -> float:
        """How long it had the card: its time so far, less what it spent waiting for a turn."""
        return time.monotonic() - self.started - self.waited

    def public(self) -> dict:
        """Never whose it is, nor what its images are called."""
        return {'id': self.id, 'pages': self.pages, 'lines_total': self.lines_total, 'lines_read': self.lines_read,
                'state': 'waiting for the GPU' if self.waiting else self.stage, 'started_at': self.started_at}


_running: dict[str, InFlight] = {}
_running_lock = threading.Lock()


@contextmanager
def admitted(account: str, pages: int = 0, lines: int = 0) -> Iterator[InFlight]:
    """One request at a time per account, listed on the queue while it runs. Nothing of it
    outlives the request."""
    with _running_lock:
        if any(r.account == account for r in _running.values()):
            raise Refused(429, 'this account has a recognition request running already', BUSY_RETRY_SECONDS)
        request = InFlight(uuid.uuid4().hex[:12], account, pages, lines_total=lines)
        _running[request.id] = request
    try:
        yield request
    finally:
        with _running_lock:
            _running.pop(request.id, None)


def in_flight() -> list[dict]:
    with _running_lock:
        return [r.public() for r in sorted(_running.values(), key=lambda r: r.started_at)]


def _month(moment: datetime) -> str:
    return moment.strftime('%Y-%m')


def _next_month(moment: datetime) -> datetime:
    year, month = divmod(moment.year * 12 + moment.month, 12)
    return datetime(year, month + 1, 1, tzinfo=timezone.utc)


def record_usage(conn, account: str, pages: int, lines: int, seconds: float, day: str | None = None) -> None:
    """One answered request, added to its account's row for the day."""
    day = day or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    conn.execute('INSERT INTO recognition_usage (account, day, requests, pages, lines, seconds) VALUES (?,?,1,?,?,?) '
                 'ON CONFLICT (account, day) DO UPDATE SET requests = requests + 1, pages = pages + excluded.pages, '
                 'lines = lines + excluded.lines, seconds = seconds + excluded.seconds',
                 (account, day, pages, lines, seconds))
    conn.commit()


def month_usage(conn, account: str, month: str) -> dict:
    row = conn.execute('SELECT COALESCE(SUM(requests), 0) requests, COALESCE(SUM(pages), 0) pages, '
                       'COALESCE(SUM(lines), 0) lines, COALESCE(SUM(seconds), 0) seconds '
                       "FROM recognition_usage WHERE account = ? AND day LIKE ? || '-%'", (account, month)).fetchone()
    return {'requests': row['requests'], 'pages': row['pages'], 'lines': row['lines'],
            'seconds': round(float(row['seconds']), 3)}


def cap_of(conn, account: str) -> int | None:
    row = conn.execute('SELECT monthly_lines FROM recognition_caps WHERE account = ?', (account,)).fetchone()
    return row['monthly_lines'] if row else None


def set_cap(conn, account: str, monthly_lines: int | None) -> None:
    if monthly_lines is None:
        conn.execute('DELETE FROM recognition_caps WHERE account = ?', (account,))
    else:
        conn.execute('INSERT INTO recognition_caps (account, monthly_lines) VALUES (?, ?) '
                     'ON CONFLICT (account) DO UPDATE SET monthly_lines = excluded.monthly_lines',
                     (account, monthly_lines))
    conn.commit()


def check_cap(conn, account: str, now: datetime | None = None) -> None:
    """Refuses an account whose lines read this month have reached its cap, until the 1st of
    next month. A request that starts below the cap is let finish."""
    now = now or datetime.now(timezone.utc)
    cap = cap_of(conn, account)
    if cap is None or month_usage(conn, account, _month(now))['lines'] < cap:
        return
    resets = _next_month(now)
    raise Refused(429, f'this account has read its {cap:,} lines for this month; it can read again from '
                       f'{resets:%Y-%m-%d}', int((resets - now).total_seconds()))


def usage_report(conn) -> dict:
    """Every account that read this month or last, or has a cap, with both months and its cap."""
    now = datetime.now(timezone.utc)
    this, last = _month(now), _month(now.replace(day=1) - timedelta(days=1))
    accounts = sorted({row['account'] for row in conn.execute(
        "SELECT DISTINCT account FROM recognition_usage WHERE day LIKE ? || '-%' OR day LIKE ? || '-%' "
        'UNION SELECT account FROM recognition_caps', (this, last))})
    return {'month': this, 'last_month': last,
            'accounts': [{'account': account, 'cap': cap_of(conn, account),
                          'this_month': month_usage(conn, account, this),
                          'last_month': month_usage(conn, account, last)} for account in accounts]}


def default_decode(conn, model_id: int) -> str:
    """What a dataset on 'auto' reads this model with."""
    return auto_decode.resolve(conn, model_id, 'auto')


def _served(conn, task: str) -> list:
    rows = conn.execute('SELECT * FROM models WHERE task = ? AND archived = 0 ORDER BY created_at', (task,)).fetchall()
    return [row for row in rows if backend_client.client_for(conn, row['id']) is not None]


def offered(conn, account: str) -> dict:
    def entry(row) -> dict:
        model = {'id': row['id'], 'name': row['name'], 'default': bool(row['is_default'])}
        if row['task'] != 'ocr':
            return model
        return {**model, 'decodes': evaluator.decodes_for(conn, row['id']),
                'default_decode': default_decode(conn, row['id']),
                'conventions': json.loads(row['conventions']) if row['conventions'] else []}
    this_month = _month(datetime.now(timezone.utc))
    return {'models': {task: [entry(row) for row in _served(conn, task)] for task in ('lines', 'ocr')},
            'limits': {'pages': config.RECOGNIZE_MAX_PAGES, 'lines': config.RECOGNIZE_MAX_LINES,
                       'megabytes': config.RECOGNIZE_MAX_MB},
            'formats': list(FORMATS),
            'usage': {'month': this_month, 'lines': month_usage(conn, account, this_month)['lines'],
                      'cap': cap_of(conn, account)}}


def _model(conn, task: str, raw_id: str | None):
    """The model a request named, or the task's default, and the backend it runs on."""
    if raw_id:
        try:
            row = registry.get_model(conn, int(raw_id))
        except ValueError:
            raise Refused(400, f'{task}_model must be a model id') from None
        if row is None or row['task'] != task or row['archived']:
            raise Refused(400, f'not an available {task} model')
    else:
        row = registry.default_model(conn, task)
        if row is None:
            raise Refused(503, f'this deployment has no default {task} model')
    client = backend_client.client_for(conn, row['id'])
    if client is None:
        raise Refused(503, f'the {task} model "{row["name"]}" is not on a configured model backend')
    return row, client


@dataclass
class Reading:
    """How the lines of a request are to be read."""
    model: object
    client: backend_client.BackendClient
    decode: str
    convention: dict[str, bool]


def _reading(conn, fields: dict) -> Reading:
    row, client = _model(conn, 'ocr', fields.get('ocr_model'))
    mode = fields.get('decode') or default_decode(conn, row['id'])
    if mode not in decode.OCR_DECODES:
        raise Refused(400, f'decode must be one of {", ".join(decode.OCR_DECODES)}')
    names = [name.strip() for name in (fields.get('convention') or '').split(',') if name.strip()]
    try:
        convention = conventions.validate({name: True for name in names})
    except ValueError as error:
        raise Refused(400, str(error)) from None
    return Reading(row, client, mode, convention)


def _decoded(upload: Upload) -> tuple[Image.Image, Image.Image | Encoded] | str:
    """The image upright in RGB, and what to send a model of it: the file itself when it
    already is that, else the upright image. A string says why it could not be read."""
    try:
        with Image.open(io.BytesIO(upload.data)) as img:
            if config.MAX_IMAGE_PIXELS and img.width * img.height > config.MAX_IMAGE_PIXELS:
                return f'the image is over {config.MAX_IMAGE_PIXELS:,} pixels'
            img.load()
            mime = SENT_AS_IS.get(img.format) if img.mode == 'RGB' and not scans.needs_normalising(img) else None
            upright = scans.normalised(img)
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return 'the image could not be read'
    return upright, Encoded(upload.data, mime) if mime else upright


def _outline(value) -> bool:
    return isinstance(value, list) and len(value) >= 3 and all(
        isinstance(point, list) and len(point) == 2
        and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point) for point in value)


def _own_lines(raw: str | None, names: list[str]) -> dict[str, list]:
    if not raw:
        return {}
    try:
        given = json.loads(raw)
    except ValueError:
        given = None
    if not isinstance(given, dict):
        raise Refused(400, 'lines must be a JSON object: {"<file name>": [<outline>, ...]}')
    for name, outlines in given.items():
        if name not in names:
            raise Refused(400, f'lines names {name}, which is not a file of this request')
        if not isinstance(outlines, list) or not all(_outline(o) for o in outlines):
            raise Refused(400, f'the lines of {name} must be outlines of at least three [x, y] points')
    _within_line_limit(sum(len(outlines) for outlines in given.values()))
    return given


def _within_line_limit(count: int) -> None:
    if config.RECOGNIZE_MAX_LINES and count > config.RECOGNIZE_MAX_LINES:
        raise Refused(413, f'at most {config.RECOGNIZE_MAX_LINES} lines per request, this one has {count}')


Crops = list[tuple[int, Image.Image]]


@dataclass
class LineRead:
    text: str
    confidence: float | None
    profile: list | None = None
    orientation: int = 0


def _read(conn, reading: Reading, request: InFlight, lines: list[tuple[object, Crops, dict]]) -> tuple[dict, dict]:
    """Read every line, each at the orientations it was cut at, keeping the more confident
    reading. Sorted by width, as a dataset's lines are, since a batch of like widths reads
    better. Returns the readings by key, and the model block of the answer."""
    reading.client.on_wait = request.wait
    engine = RemoteOcrEngine(conn, reading.client, reading.model['id'], reading.decode, reading.convention)
    request.stage = 'reading'
    items = sorted(((key, orientation, crop, context) for key, crops, context in lines for orientation, crop in crops),
                   key=lambda item: item[2].width)
    best: dict[object, LineRead] = {key: LineRead('', None) for key, crops, _ in lines if not crops}
    chunk = reading.client.max_items('ocr')
    for start in range(0, len(items), chunk):
        part = items[start:start + chunk]
        texts, confidences, profiles = engine.predict_batch([crop for _, _, crop, _ in part],
                                                            [context for *_, context in part])
        for (key, orientation, _, _), text, confidence, profile in zip(part, texts, confidences, profiles):
            if key not in best or confidence > (best[key].confidence or 0):
                best[key] = LineRead(text.strip(), confidence, profile, orientation)
        request.lines_read = len(best)
    model = {'id': reading.model['id'], 'name': reading.model['name'], 'decode': engine.decode}
    if reading.convention:
        model['conventions'] = engine.honoured
    return best, model


def _export_page(idx: int, name: str, width: int, height: int, lines: list[dict]) -> dict:
    """A page as the exporters take it: its lines in one region, in the order read."""
    page = {'idx': idx, 'filename': name, 'width': width, 'height': height, 'elements': []}
    if not lines:
        return page
    norm = [[[x / width, y / height] for x, y in line['polygon']] for line in lines]
    xs = [x for poly in norm for x, _ in poly]
    ys = [y for poly in norm for _, y in poly]
    page['elements'] = [{
        'order_idx': 0, 'class_name': 'Text', 'bbox': [min(xs), min(ys), max(xs), max(ys)], 'conf': None,
        'kind': 'content',
        'lines': [{'polygon': poly, 'text': line['text'], 'corrected_text': None,
                   'confidence': line['confidence'], 'checked': False} for poly, line in zip(norm, lines)]}]
    return page


def _document(fmt: str, idx: int, name: str, width: int, height: int, lines: list[dict]) -> str:
    if fmt == 'txt':
        return '\n'.join(line['text'] for line in lines)
    page = _export_page(idx, name, width, height, lines)
    return {'page': formats.page_xml, 'alto': formats.alto, 'hocr': lambda p: formats.hocr(p, name)}[fmt](page)


@dataclass
class Keeping:
    """Where a request's pages are kept: the caller's dataset of that name, or the name a
    new one will take."""
    name: str
    job_id: str | None


def keeping(conn, account: str, name: str, uploads: list[Upload]) -> Keeping:
    """The dataset `keep` names, settled before anything is read, as is every file name the
    pages will be kept under."""
    for upload in uploads:
        try:
            ingest.require_short_name(_kept_name(upload.name))
        except ingest.IngestError as error:
            raise Refused(error.status_code, error.detail) from None
    holder = ingest.name_holder(conn, name)
    if holder is None:
        return Keeping(name, None)
    job = store.get_job(conn, holder)
    if job['owner'] != account:
        raise Refused(409, f'a dataset named "{name}" belongs to another account; keep needs a name of your own')
    if ingest.is_tile_task(job['task']):
        raise Refused(400, f'"{job["name"]}" is a map dataset; pages are kept in a text dataset')
    if job['status'] in ('queued', 'running'):
        raise Refused(409, f'"{job["name"]}" is queued or running; keep into it once it has finished')
    return Keeping(job['name'], holder)


def _kept_name(sent: str) -> str:
    """A page is kept under the file's own name, without any folders the request gave it."""
    return Path(sent).name or 'page'


def _new_dataset(conn, account: str, name: str, fields: dict, finder, reading: Reading) -> str:
    """A text dataset that reads pages added to it later as this request read its own: lines
    found on the whole page, then read, with the models, decode and convention it named."""
    job_id = uuid.uuid4().hex[:12]
    conn.execute('INSERT INTO jobs (id, name, owner, task, line_mode, run_layout, run_lines, run_ocr, '
                 "model_lines_id, model_ocr_id, ocr_decode, status) VALUES (?,?,?,'text','per_page',0,1,1,?,?,?,'done')",
                 (job_id, name, account, finder[0]['id'] if finder and fields.get('lines_model') else None,
                  reading.model['id'] if fields.get('ocr_model') else None,
                  fields.get('decode') or decode.DATASET_DEFAULT))
    if reading.convention:
        conn.execute('UPDATE jobs SET ocr_convention = ? WHERE id = ?', (json.dumps(reading.convention), job_id))
        conventions.note(conn, list(reading.convention))
    layout_templates.copy_into(conn, job_id)
    return job_id


def _keep_lines(conn, page_id: int, page: dict, reads: list[LineRead], lines_by: str, read_by: str,
                ocr_model_id: int) -> None:
    """A page's lines as a dataset that skips layout holds them: in the page's Unassigned
    bucket, in reading order, read and unchecked."""
    outlines = [[[x / page['width'], y / page['height']] for x, y in line['polygon']] for line in page['lines']]
    if not outlines:
        return
    xs = [x for outline in outlines for x, _ in outline]
    ys = [y for outline in outlines for _, y in outline]
    bucket = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox, conf, kind) "
                          "VALUES (?, 0, 'Unassigned', ?, NULL, 'orphan')",
                          (page_id, json.dumps([min(xs), min(ys), max(xs), max(ys)]))).lastrowid
    store.log_element(conn, bucket, lines_by, 'create')
    for order_idx, (outline, read) in enumerate(zip(outlines, reads)):
        line_id = conn.execute(
            'INSERT INTO lines (element_id, order_idx, polygon, text, confidence, conf_profile, orientation, '
            "ocr_model_id, ocr_run_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))",
            (bucket, order_idx, json.dumps(outline), read.text, read.confidence,
             json.dumps(read.profile) if read.profile else None, read.orientation, ocr_model_id)).lastrowid
        store.log_line(conn, line_id, read_by, 'create')


def _keep(conn, account: str, target: Keeping, uploads: list[Upload], answered: list[dict], read: dict,
          fields: dict, own: dict, finder, reading: Reading) -> dict:
    """File every page that was read into the dataset, as done: nothing of the pipeline
    runs on it. A scan the dataset holds already lands as a duplicate, as an upload of it
    would, without its lines."""
    kept = {'dataset': target.job_id, 'name': target.name, 'created': False, 'pages': 0, 'duplicates': []}
    readable = [i for i, page in enumerate(answered) if 'error' not in page]
    if not readable:
        return kept
    job_id = target.job_id or _new_dataset(conn, account, target.name, fields, finder, reading)
    kept.update(dataset=job_id, created=target.job_id is None)
    job_path = config.job_dir(job_id)
    (job_path / 'uploads').mkdir(parents=True, exist_ok=True)
    seen = store.taken_hashes(conn, 'pages', job_id)
    lines_by = f'model:lines@{finder[0]["name"]}' if finder else f'import:{account}'
    read_by = text_job.ocr_author(conn, reading.model['id'], reading.decode)
    for i in readable:
        page = answered[i]
        name = _kept_name(page['id'])
        source = job_path / 'uploads' / f'{ingest.page_count(conn, job_id):05d}_{name}'
        source.write_bytes(uploads[i].data)
        page_id = ingest.insert_pages(conn, job_id, [(name, str(source))])[str(source)]
        row = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
        outcome = scans.ingest_page(conn, row, job_path, seen, config.BLOBS_DIR, 'done')
        if outcome == 'duplicate':
            kept['duplicates'].append(page['id'])
        if outcome != 'done':
            continue
        _keep_lines(conn, page_id, page, [read[(i, n)] for n in range(len(page['lines']))], lines_by, read_by,
                    reading.model['id'])
        if page['id'] not in own:
            store.note_page_model(conn, page_id, 'lines', finder[0]['id'])
        conn.commit()
        kept['pages'] += 1
    store.recount_pages(conn, job_id)
    return kept


def pages(conn, account: str, uploads: list[Upload], fields: dict) -> dict:
    """Find the lines of whole pages - or take the outlines the caller sent for a page -
    and read them. Pages are decoded one at a time and only their line crops are kept, so
    a request of large scans never holds them all at once. With `keep`, the pages and what
    was read on them are filed into a dataset of the caller's."""
    check_cap(conn, account)
    fmt = fields.get('format') or 'json'
    if fmt not in FORMATS:
        raise Refused(400, f'format must be one of {", ".join(FORMATS)}')
    keep_name = (fields.get('keep') or '').strip()
    target = keeping(conn, account, keep_name, uploads) if keep_name else None
    own = _own_lines(fields.get('lines'), [u.name for u in uploads])
    finder = _model(conn, 'lines', fields.get('lines_model')) if any(u.name not in own for u in uploads) else None
    reading = _reading(conn, fields)
    models: dict = {}
    with admitted(account, pages=len(uploads)) as request:
        detector = None
        answered: list[dict] = []
        lines: list[tuple[object, Crops, dict]] = []
        for i, upload in enumerate(uploads):
            decoded = _decoded(upload)
            if isinstance(decoded, str):
                answered.append({'id': upload.name, 'error': decoded})
                continue
            image, sent = decoded
            if upload.name in own:
                outlines = own[upload.name]
            else:
                if detector is None:
                    row, client = finder
                    client.on_wait = request.wait
                    detector = RemoteLines(conn, client, row['id'])
                    models['lines'] = {'id': row['id'], 'name': row['name']}
                found = detector.detect([sent], 'page')[0]
                outlines = [[[round(x * image.width), round(y * image.height)] for x, y in found[j]]
                            for j in reading_order.order(found, *reading_order.detect(found))]
            for n, outline in enumerate(outlines):
                crops = [(o, linecrop.crop_line(image, outline, o, mask=config.LINE_CROP_MASK))
                         for o in ocr_phase.orientations(outline)]
                lines.append(((i, n), [(o, crop) for o, crop in crops if crop is not None], {'line_index': n}))
            answered.append({'id': upload.name, 'width': image.width, 'height': image.height, 'lines': outlines})
            request.lines_total = len(lines)
        read, models['ocr'] = _read(conn, reading, request, lines) if lines else ({}, None)
    record_usage(conn, account, pages=sum('error' not in page for page in answered), lines=len(lines),
                 seconds=request.held())
    for i, page in enumerate(answered):
        if 'error' in page:
            continue
        page['lines'] = [{'polygon': outline, 'text': read[(i, n)].text, 'confidence': read[(i, n)].confidence}
                         for n, outline in enumerate(page['lines'])]
        if fmt != 'json':
            page['document'] = _document(fmt, i, page['id'], page['width'], page['height'], page['lines'])
    if models.get('ocr') is None:
        models.pop('ocr', None)
    answer = {'models': models, 'pages': answered}
    if target:
        answer['kept'] = _keep(conn, account, target, uploads, answered, read, fields, own, finder, reading)
    return answer


def lines(conn, account: str, uploads: list[Upload], fields: dict) -> dict:
    """Read line images as they were sent, in the order sent."""
    check_cap(conn, account)
    reading = _reading(conn, fields)
    with admitted(account, lines=len(uploads)) as request:
        errors, crops = {}, []
        for i, upload in enumerate(uploads):
            decoded = _decoded(upload)
            if isinstance(decoded, str):
                errors[i] = decoded
            else:
                crops.append((i, [(0, decoded[0])], {'line_index': i}))
        read, model = _read(conn, reading, request, crops) if crops else ({}, None)
    record_usage(conn, account, pages=0, lines=len(crops), seconds=request.held())
    answered = [{'id': upload.name, 'error': errors[i]} if i in errors
                else {'id': upload.name, 'text': read[i].text, 'confidence': read[i].confidence}
                for i, upload in enumerate(uploads)]
    return {'models': {'ocr': model} if model else {}, 'lines': answered}
