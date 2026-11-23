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

from app import auto_decode, backend_client, config, conventions, decode, evaluator, formats, geometry, ingest, \
    layout_shapes, layout_templates, linecrop, ocr_phase, reading_order, registry, scans, store, text_job
from app.backend_client import Encoded
from app.remote_models import Detection, PageLayout, PageRefused, RemoteLayout, RemoteLines, RemoteOcrEngine

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


def flag(value: str | None) -> bool:
    """A yes/no form field: on when it says so."""
    return (value or '').strip().lower() in ('true', '1', 'yes')


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


def reading_of(account: str) -> dict | None:
    """The account's request answered at once while it runs, as the queue shows it - for the
    page that sent it, which has no id for it until it is answered."""
    with _running_lock:
        return next((r.public() for r in _running.values() if r.account == account), None)


def _month(moment: datetime) -> str:
    return moment.strftime('%Y-%m')


def _next_month(moment: datetime) -> datetime:
    year, month = divmod(moment.year * 12 + moment.month, 12)
    return datetime(year, month + 1, 1, tzinfo=timezone.utc)


def record_usage(conn, account: str, pages: int, lines: int, seconds: float, day: str | None = None,
                 requests: int = 1) -> None:
    """One answered request - or one batch of an async one, which counts as a request once -
    added to its account's row for the day."""
    day = day or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    conn.execute('INSERT INTO recognition_usage (account, day, requests, pages, lines, seconds) VALUES (?,?,?,?,?,?) '
                 'ON CONFLICT (account, day) DO UPDATE SET requests = requests + excluded.requests, '
                 'pages = pages + excluded.pages, lines = lines + excluded.lines, seconds = seconds + excluded.seconds',
                 (account, day, requests, pages, lines, seconds))
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


def _served(conn, task: str, allowed: list[int] | None = None) -> list:
    rows = conn.execute('SELECT * FROM models WHERE task = ? AND archived = 0 ORDER BY created_at', (task,)).fetchall()
    return [row for row in rows if backend_client.client_for(conn, row['id']) is not None
            and (allowed is None or row['id'] in allowed)]


# The models an API key is limited to, as the auth service sends them. The route puts them
# among the request's fields, so an async request is held to them when its turn comes.
ALLOWED = 'allowed_models'


def held_to(fields: dict, models: list[int] | None) -> dict:
    """The request's fields with its key's list of models - never one the request sent."""
    rest = {key: value for key, value in fields.items() if key != ALLOWED}
    return rest if models is None else {**rest, ALLOWED: models}


def _default(conn, task: str, allowed: list[int] | None):
    """What a request naming no model reads with: the deployment's default - for a key
    limited to some models, only if the list has it, else the task's first on the list."""
    row = registry.default_model(conn, task)
    if allowed is None or (row is not None and row['id'] in allowed):
        return row
    return next(iter(_served(conn, task, allowed)), None)


def offered(conn, account: str, allowed: list[int] | None = None) -> dict:
    def entry(row) -> dict:
        model = {'id': row['id'], 'name': row['name'], 'default': row['id'] == defaults[row['task']]}
        if row['task'] == 'layout':
            return {**model, 'template': _layout_template(conn, row['id'])[1]['name']}
        if row['task'] != 'ocr':
            return model
        return {**model, 'decodes': evaluator.decodes_for(conn, row['id']),
                'default_decode': default_decode(conn, row['id']),
                'conventions': json.loads(row['conventions']) if row['conventions'] else []}
    this_month = _month(datetime.now(timezone.utc))
    defaults = {task: (row['id'] if (row := _default(conn, task, allowed)) else None) for task in ('layout', 'lines', 'ocr')}
    return {'models': {task: [entry(row) for row in _served(conn, task, allowed)] for task in ('layout', 'lines', 'ocr')},
            'limits': {'pages': config.RECOGNIZE_MAX_PAGES, 'lines': config.RECOGNIZE_MAX_LINES,
                       'megabytes': config.RECOGNIZE_MAX_MB,
                       'async': {'pages': config.RECOGNIZE_ASYNC_MAX_PAGES, 'lines': config.RECOGNIZE_ASYNC_MAX_LINES,
                                 'megabytes': config.RECOGNIZE_ASYNC_MAX_MB,
                                 'unfinished': config.RECOGNIZE_ASYNC_PER_ACCOUNT,
                                 'kept_hours': config.RECOGNIZE_KEEP_HOURS}},
            'formats': list(FORMATS),
            'usage': {'month': this_month, 'lines': month_usage(conn, account, this_month)['lines'],
                      'cap': cap_of(conn, account)}}


def _model(conn, task: str, raw_id: str | None, allowed: list[int] | None = None):
    """The model a request named, or the task's default, and the backend it runs on. For
    a key limited to some models, one off its list is as unavailable as one that is not there."""
    if raw_id:
        try:
            row = registry.get_model(conn, int(raw_id))
        except ValueError:
            raise Refused(400, f'{task}_model must be a model id') from None
        if row is None or row['task'] != task or row['archived'] or (allowed is not None and row['id'] not in allowed):
            raise Refused(400, f'not an available {task} model')
    else:
        row = _default(conn, task, allowed)
        if row is None and allowed is not None:
            raise Refused(403, f'this API token may use no {task} model')
        if row is None:
            raise Refused(503, f'this deployment has no default {task} model')
    client = backend_client.client_for(conn, row['id'])
    if client is None:
        raise Refused(503, f'the {task} model "{row["name"]}" is not on a configured model backend')
    return row, client


@dataclass
class Reading:
    """How the lines of a request are to be read, and whether each is answered with the
    confidence bands it was read with."""
    model: object
    client: backend_client.BackendClient
    decode: str
    convention: dict[str, bool]
    characters: bool = False


def _reading(conn, fields: dict) -> Reading:
    row, client = _model(conn, 'ocr', fields.get('ocr_model'), fields.get(ALLOWED))
    mode = fields.get('decode') or default_decode(conn, row['id'])
    if mode not in decode.OCR_DECODES:
        raise Refused(400, f'decode must be one of {", ".join(decode.OCR_DECODES)}')
    names = [name.strip() for name in (fields.get('convention') or '').split(',') if name.strip()]
    try:
        convention = conventions.validate({name: True for name in names})
    except ValueError as error:
        raise Refused(400, str(error)) from None
    return Reading(row, client, mode, convention, flag(fields.get('characters')))


def _layout_template(conn, model_id: int):
    """A layout model's own template (None for a model without one), and the template whose
    classes its pages are read in: its own, else the default."""
    own = layout_templates.model_template(conn, model_id)
    return own, own or layout_templates.template_row(conn, layout_templates.default_template(conn))


@dataclass
class Layout:
    """The layout model a request runs before the lines, the template whose classes it
    reads in, and how a page it lays out reads - all as a dataset of that template
    running that model has them."""
    model: object
    client: backend_client.BackendClient
    template: object
    vocabulary: layout_templates.Vocabulary
    rules: reading_order.Rules


def _layout(conn, raw_id: str, allowed: list[int] | None = None) -> Layout:
    row, client = _model(conn, 'layout', raw_id, allowed)
    own, template = _layout_template(conn, row['id'])
    vocabulary = layout_templates.Vocabulary(layout_templates.template_classes(conn, template['id']), template['rules'])
    return Layout(row, client, template, vocabulary, vocabulary.reading_rules(own))


@dataclass
class LaidOut:
    """A page's regions in reading order - the content regions, then the containers - and
    the lines found inside each content region; `loose` are a page's own lines, in
    reading order, when it has no content region. Outlines normalised to the page."""
    regions: list[tuple[Detection, str]]
    lines: list[list]
    loose: list


def _page_order(found: PageLayout, rules: reading_order.Rules, loose: list, setting: str) -> reading_order.PageOrder:
    """How the page reads, as geometry.resequence_page orders a dataset's page."""
    boxes = found.content + found.containers
    structure = (1, 1) if rules.pipeline else reading_order.resolve(
        loose + [geometry.bbox_ring(d.bbox) for d in found.content], setting)
    return reading_order.page_order([d.bbox for d in boxes], [d.class_name for d in boxes], loose, *structure,
                                    rules=rules)


def _lay_out(found: PageLayout, found_lines: RemoteLines, rules: reading_order.Rules, setting: str,
             image: Image.Image, sent: Image.Image | Encoded) -> LaidOut:
    """Lines inside each content region of a page whose regions were found. A region's role
    is the template's: the reading order may read a container that holds nothing, like a
    divider, among the content, but no line is looked for in it."""
    boxes = found.content + found.containers
    order = _page_order(found, rules, [], setting)
    content = [boxes[i] for i in order.content + order.containers if i < len(found.content)]
    loose = []
    if content:
        lines, _ = text_job.lines_in_elements(found_lines, image, [{'class_name': d.class_name} for d in content],
                                              [d.bbox for d in content])
    else:
        lines, page_lines = [], found_lines.detect([sent], 'page')[0]
        order = _page_order(found, rules, page_lines, setting)
        loose = [page_lines[j] for run in order.runs for j in run]
    containers = [boxes[i] for i in order.containers + order.content if i >= len(found.content)]
    return LaidOut([(d, 'content') for d in content] + [(d, 'container') for d in containers], lines, loose)


def _in_pixels(outline: list, width: int, height: int) -> list:
    return [[round(x * width), round(y * height)] for x, y in outline]


def _swept(outlines: list, setting: str) -> list:
    """Lines in the order the column sweep reads them."""
    return [outlines[j] for j in reading_order.order(outlines, *reading_order.resolve(outlines, setting))]


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


def _own_lines(raw: str | None, names: list[str], queued: bool = False) -> dict[str, list]:
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
    within_limit(sum(len(outlines) for outlines in given.values()), 'lines', queued)
    return given


def limit_of(unit: str, queued: bool) -> int:
    """How many pages, lines or MB one request may carry - one answered at once, or one sent
    async; 0 is no limit."""
    return {('pages', False): config.RECOGNIZE_MAX_PAGES, ('lines', False): config.RECOGNIZE_MAX_LINES,
            ('MB', False): config.RECOGNIZE_MAX_MB, ('pages', True): config.RECOGNIZE_ASYNC_MAX_PAGES,
            ('lines', True): config.RECOGNIZE_ASYNC_MAX_LINES, ('MB', True): config.RECOGNIZE_ASYNC_MAX_MB}[unit, queued]


def within_limit(count: int, unit: str, queued: bool) -> None:
    limit = limit_of(unit, queued)
    if limit and count > limit:
        raise Refused(413, f'at most {limit} {unit} per {"async " if queued else ""}request, this one has {count}')


Crops = list[tuple[int, Image.Image]]


@dataclass
class LineRead:
    text: str
    confidence: float | None
    profile: list | None = None
    orientation: int = 0


def _bands(read: LineRead) -> list[dict] | None:
    """The model's confidence bands for a line, each a stretch of it from its start (0) to
    its end (1) in the direction it was read, scored 0-1 like the line."""
    if read.profile is None:
        return None
    return [{'x0': band['x0'], 'x1': band['x1'], 'confidence': band['c'] / 100} for band in read.profile]


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


def _export_page(idx: int, name: str, width: int, height: int, lines: list[dict], regions: list[dict]) -> dict:
    """A page as the exporters take it: each region with the lines read in it, and any line
    outside every region in one region of its own, in the order read."""
    def normalised(polygon):
        return [[x / width, y / height] for x, y in polygon]

    def element(order_idx: int, class_name: str, kind: str, bbox: list, conf, held: list[dict]) -> dict:
        return {'order_idx': order_idx, 'class_name': class_name, 'bbox': bbox, 'conf': conf, 'kind': kind,
                'lines': [{'polygon': normalised(line['polygon']), 'text': line['text'], 'corrected_text': None,
                           'confidence': line['confidence'], 'checked': False} for line in held]}

    elements = [element(r, region['class'], region['role'], geometry.ring_bounds(normalised(region['polygon'])),
                        region['confidence'], [line for line in lines if line.get('region') == r])
                for r, region in enumerate(regions)]
    loose = [line for line in lines if line.get('region') is None]
    if loose:
        elements.append(element(len(elements), 'Text', 'content',
                                geometry.ring_bounds([pt for line in loose for pt in normalised(line['polygon'])]),
                                None, loose))
    return {'idx': idx, 'filename': name, 'width': width, 'height': height, 'elements': elements}


def _document(fmt: str, idx: int, name: str, width: int, height: int, lines: list[dict],
              regions: list[dict] = ()) -> str:
    if fmt == 'txt':
        return '\n'.join(line['text'] for line in lines)
    page = _export_page(idx, name, width, height, lines, regions)
    return {'page': formats.page_xml, 'alto': formats.alto, 'hocr': lambda p: formats.hocr(p, name)}[fmt](page)


@dataclass
class Keeping:
    """Where a request's pages are kept: the caller's dataset of that name, or the name a
    new one will take."""
    name: str
    job_id: str | None


def keeping(conn, account: str, name: str, names: list[str]) -> Keeping:
    """The dataset `keep` names, settled before anything is read, as is every file name the
    pages will be kept under."""
    for sent in names:
        try:
            ingest.require_short_name(_kept_name(sent))
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
    if job['status'] in store.JOB_BUSY:
        raise Refused(409, f'"{job["name"]}" is queued or running; keep into it once it has finished')
    return Keeping(job['name'], holder)


def _kept_name(sent: str) -> str:
    """A page is kept under the file's own name, without any folders the request gave it."""
    return Path(sent).name or 'page'


def _new_dataset(conn, account: str, name: str, fields: dict, finder, reading: Reading, layout: Layout | None) -> str:
    """A text dataset that reads pages added to it later as this request read its own: lines
    found on the whole page - or with layout, inside each region of the layout model's
    template - then read, with the models, decode and convention it named."""
    job_id = uuid.uuid4().hex[:12]
    conn.execute('INSERT INTO jobs (id, name, owner, task, line_mode, run_layout, run_lines, run_ocr, model_layout_id, '
                 "model_lines_id, model_ocr_id, ocr_decode, reading_order, status) "
                 "VALUES (?,?,?,'text',?,?,1,1,?,?,?,?,?,'done')",
                 (job_id, name, account, 'per_crop' if layout else 'per_page', int(layout is not None),
                  layout.model['id'] if layout else None,
                  finder[0]['id'] if finder and (fields.get('lines_model') or ALLOWED in fields) else None,
                  reading.model['id'] if fields.get('ocr_model') or ALLOWED in fields else None,
                  fields.get('decode') or decode.DATASET_DEFAULT, fields.get('reading_order') or reading_order.AUTO))
    # Made where a new dataset of theirs is made by default: their Sandbox.
    conn.execute('UPDATE jobs SET group_id = ? WHERE id = ?', (store.sandbox_id(conn, account), job_id))
    if reading.convention:
        conn.execute('UPDATE jobs SET ocr_convention = ? WHERE id = ?', (json.dumps(reading.convention), job_id))
        conventions.note(conn, list(reading.convention))
    layout_templates.copy_into(conn, job_id, layout.template['id'] if layout else None)
    return job_id


@dataclass
class KeptBy:
    """Who a kept page's elements and lines are logged as."""
    lines: str
    read: str
    layout: str | None
    ocr_model_id: int


def _keep_line(conn, element_id: int, order_idx: int, outline: list, read: LineRead, by: KeptBy) -> None:
    line_id = conn.execute(
        'INSERT INTO lines (element_id, order_idx, polygon, text, confidence, conf_profile, orientation, '
        "ocr_model_id, ocr_run_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))",
        (element_id, order_idx, json.dumps(outline), read.text, read.confidence,
         json.dumps(read.profile) if read.profile else None, read.orientation, by.ocr_model_id)).lastrowid
    store.log_line(conn, line_id, by.read, 'create')


def _keep_unassigned(conn, page_id: int, order_idx: int, outlines: list, reads: list[LineRead], by: KeptBy) -> None:
    """Lines in a bucket of the page's Unassigned, read and unchecked."""
    if not outlines:
        return
    bucket = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox, conf, kind) "
                          "VALUES (?, ?, 'Unassigned', ?, NULL, 'orphan')",
                          (page_id, order_idx, json.dumps(geometry.ring_bounds([pt for o in outlines for pt in o])))
                          ).lastrowid
    store.log_element(conn, bucket, by.lines, 'create')
    for n, (outline, read) in enumerate(zip(outlines, reads)):
        _keep_line(conn, bucket, n, outline, read, by)


def _keep_regions(conn, job_id: str, page_id: int, outlines: list, reads: list[LineRead], held_in: list,
                  regions: list[tuple[Detection, str]], layout: Layout, by: KeptBy) -> None:
    """Each region as a layout element of the dataset's class for its label, as a run of the
    layout model files it, with the lines read in it. A region whose label the dataset has
    no class for is left out, and its lines - like those of any region that holds none
    there - go to Unassigned. The page is then ordered by the dataset's own rules."""
    vocabulary = layout_templates.vocabulary(conn, job_id, layout.model['id'])
    drawn = layout_shapes.outlines(store.get_job(conn, job_id)['layout_shape'])
    numbered = {'content': 0, 'container': 0}
    unassigned = [n for n, r in enumerate(held_in) if r is None]
    for r, (found, role) in enumerate(regions):
        held = [n for n, at in enumerate(held_in) if at == r]
        placed = vocabulary.place(found.raw_class_name)
        if placed is None:
            unassigned += held
            continue
        class_name, raw, kind = vocabulary.resolve(placed)
        side = 'content' if kind == 'content' else 'container'
        element_id = conn.execute(
            'INSERT INTO elements (page_id, order_idx, class_name, raw_class_name, bbox, conf, kind, polygon, lines_bbox) '
            'VALUES (?,?,?,?,?,?,?,?,?)',
            (page_id, numbered[side], class_name, raw, json.dumps(found.bbox), found.confidence, kind,
             json.dumps(geometry.bbox_ring(found.bbox)) if drawn else None,
             # A box the request looked for no lines in is left for a run to detect them.
             json.dumps(found.bbox) if side == 'content' and role == 'content' else None)).lastrowid
        numbered[side] += 1
        store.log_element(conn, element_id, by.layout, 'create')
        if side == 'content':
            for k, n in enumerate(held):
                _keep_line(conn, element_id, k, outlines[n], reads[n], by)
        else:
            unassigned += held
    _keep_unassigned(conn, page_id, numbered['content'], [outlines[n] for n in unassigned],
                     [reads[n] for n in unassigned], by)
    geometry.resequence_page(conn, page_id)


def _keep(conn, account: str, target: Keeping, uploads: list[Upload], answered: list[dict], read: dict,
          fields: dict, own: dict, finder, reading: Reading, layout: Layout | None, laid_out: dict) -> dict:
    """File every page that was read into the dataset, as done: nothing of the pipeline
    runs on it. A scan the dataset holds already lands as a duplicate, as an upload of it
    would, without its lines."""
    kept = {'dataset': target.job_id, 'name': target.name, 'created': False, 'pages': 0, 'duplicates': []}
    readable = [i for i, page in enumerate(answered) if 'error' not in page]
    if not readable:
        return kept
    job_id = target.job_id or _new_dataset(conn, account, target.name, fields, finder, reading, layout)
    kept.update(dataset=job_id, created=target.job_id is None)
    job_path = config.job_dir(job_id)
    (job_path / 'uploads').mkdir(parents=True, exist_ok=True)
    seen = store.taken_hashes(conn, 'pages', job_id)
    by = KeptBy(f'model:lines@{finder[0]["name"]}' if finder else f'import:{account}',
                text_job.ocr_author(conn, reading.model['id'], reading.decode),
                f'model:layout@{layout.model["name"]}' if layout else None, reading.model['id'])
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
        outlines = [[[x / page['width'], y / page['height']] for x, y in line['polygon']] for line in page['lines']]
        reads = [read[(i, n)] for n in range(len(page['lines']))]
        if i in laid_out:
            _keep_regions(conn, job_id, page_id, outlines, reads, [line['region'] for line in page['lines']],
                          laid_out[i].regions, layout, by)
            store.note_page_model(conn, page_id, 'layout', layout.model['id'])
        else:
            _keep_unassigned(conn, page_id, 0, outlines, reads, by)
        if page['id'] not in own:
            store.note_page_model(conn, page_id, 'lines', finder[0]['id'])
        conn.commit()
        kept['pages'] += 1
    store.recount_pages(conn, job_id)
    return kept


def _find_regions(conn, layout: Layout, uploads: list[Upload], request: InFlight,
                  models: dict) -> tuple[dict[int, PageLayout], dict[int, str]]:
    """Every page's regions before any line is looked for, so that the layout model and the
    line model - which may share a card, each unloading the other - load once a request,
    as each does once a phase of a dataset's run. Returns the regions by page, and why
    the layout model refused a page."""
    request.stage = 'finding regions'
    found: dict[int, PageLayout] = {}
    refused: dict[int, str] = {}
    detector = None
    for i, upload in enumerate(uploads):
        decoded = _decoded(upload)
        if isinstance(decoded, str):
            continue
        image, sent = decoded
        if detector is None:
            layout.client.on_wait = request.wait
            detector = RemoteLayout(conn, layout.client, layout.model['id'], layout.vocabulary)
            models['layout'] = {'id': layout.model['id'], 'name': layout.model['name']}
        fitted = text_job.fit_for_layout(image)
        try:
            found[i] = detector.detect_sent([sent if fitted is image else fitted])[0]
        except PageRefused as error:
            refused[i] = f'the layout model could not read it: {error.reason}'
    request.stage = 'finding lines'
    return found, refused


@dataclass
class PagesPlan:
    """What a request for pages asked for, checked before anything is read."""
    fields: dict
    fmt: str
    target: Keeping | None
    own: dict[str, list]
    layout: Layout | None
    finder: tuple | None
    reading: Reading
    # How the pages are laid out: reading_order.AUTO or '<leaves>x<columns>'.
    order: str


def plan_pages(conn, account: str, names: list[str], fields: dict, queued: bool = False) -> PagesPlan:
    fmt = fields.get('format') or 'json'
    if fmt not in FORMATS:
        raise Refused(400, f'format must be one of {", ".join(FORMATS)}')
    order = fields.get('reading_order') or reading_order.AUTO
    if order not in reading_order.CHOICES:
        raise Refused(400, f'reading_order must be one of {", ".join(reading_order.CHOICES)}')
    keep_name = (fields.get('keep') or '').strip()
    target = keeping(conn, account, keep_name, names) if keep_name else None
    own = _own_lines(fields.get('lines'), names, queued)
    if own and fields.get('layout_model'):
        raise Refused(400, 'send lines or layout_model, not both: with layout the lines are found inside its regions')
    layout = _layout(conn, fields['layout_model'], fields.get(ALLOWED)) if fields.get('layout_model') else None
    finder = (_model(conn, 'lines', fields.get('lines_model'), fields.get(ALLOWED))
              if any(name not in own for name in names) else None)
    return PagesPlan(fields, fmt, target, own, layout, finder, _reading(conn, fields), order)


def pages(conn, account: str, uploads: list[Upload], fields: dict) -> dict:
    """Find the lines of whole pages - or take the outlines the caller sent for a page -
    and read them, while the caller waits."""
    check_cap(conn, account)
    plan = plan_pages(conn, account, [u.name for u in uploads], fields)
    with admitted(account, pages=len(uploads)) as request:
        return read_pages(conn, account, plan, uploads, request)


def read_pages(conn, account: str, plan: PagesPlan, uploads: list[Upload], request: InFlight, first: int = 0,
               requests: int = 1) -> dict:
    """The answer for these pages, the request's usage recorded. With `layout_model`, the
    pages' regions are found first and their lines inside each. Pages are decoded one at a
    time - again for their lines, after layout - and only their line crops are kept, so a
    request of large scans never holds them all at once. With `keep`, the pages and what
    was read on them are filed into a dataset of the caller's. `first` is the place of the
    first page in the whole request, for an async one read in batches."""
    layout, finder, own = plan.layout, plan.finder, plan.own
    models: dict = {}
    laid_out: dict[int, LaidOut] = {}
    regions_of, refused = _find_regions(conn, layout, uploads, request, models) if layout else ({}, {})
    found_lines = None
    answered: list[dict] = []
    lines: list[tuple[object, Crops, dict]] = []
    for i, upload in enumerate(uploads):
        if i in refused:
            answered.append({'id': upload.name, 'error': refused[i]})
            continue
        decoded = _decoded(upload)
        if isinstance(decoded, str):
            answered.append({'id': upload.name, 'error': decoded})
            continue
        image, sent = decoded
        page = {'id': upload.name, 'width': image.width, 'height': image.height}
        contexts = None
        if upload.name in own:
            outlines = own[upload.name]
        else:
            if found_lines is None:
                row, client = finder
                client.on_wait = request.wait
                found_lines = RemoteLines(conn, client, row['id'])
                models['lines'] = {'id': row['id'], 'name': row['name']}
            if layout is None:
                outlines = [_in_pixels(o, image.width, image.height)
                            for o in _swept(found_lines.detect([sent], 'page')[0], plan.order)]
            else:
                laid = laid_out[i] = _lay_out(regions_of[i], found_lines, layout.rules, plan.order, image, sent)
                page['regions'] = [{'class': found.class_name, 'role': role,
                                    'polygon': _in_pixels(geometry.bbox_ring(found.bbox), image.width, image.height),
                                    'confidence': found.confidence} for found, role in laid.regions]
                placed = [(r, k, o) for r, held in enumerate(laid.lines) for k, o in enumerate(held)] + \
                         [(None, k, o) for k, o in enumerate(laid.loose)]
                outlines = [_in_pixels(o, image.width, image.height) for *_, o in placed]
                page['held_in'] = [r for r, *_ in placed]
                contexts = [{'line_index': k} if r is None else
                            {'element_class': laid.regions[r][0].class_name, 'line_index': k}
                            for r, k, _ in placed]
        for n, outline in enumerate(outlines):
            crops = [(o, linecrop.crop_line(image, outline, o))
                     for o in ocr_phase.orientations(outline)]
            lines.append(((i, n), [(o, crop) for o, crop in crops if crop is not None],
                          contexts[n] if contexts else {'line_index': n}))
        answered.append({**page, 'lines': outlines})
        request.lines_total = len(lines)
    read, models['ocr'] = _read(conn, plan.reading, request, lines) if lines else ({}, None)
    record_usage(conn, account, pages=sum('error' not in page for page in answered), lines=len(lines),
                 seconds=request.held(), requests=requests)
    for i, page in enumerate(answered):
        if 'error' in page:
            continue
        held_in = page.pop('held_in', None)
        page['lines'] = [{'polygon': outline, 'text': read[(i, n)].text, 'confidence': read[(i, n)].confidence,
                          **({'region': held_in[n]} if held_in is not None else {}),
                          **({'characters': _bands(read[(i, n)])} if plan.reading.characters else {})}
                         for n, outline in enumerate(page['lines'])]
        if plan.fmt != 'json':
            page['document'] = _document(plan.fmt, first + i, page['id'], page['width'], page['height'],
                                         page['lines'], page.get('regions', []))
    if models.get('ocr') is None:
        models.pop('ocr', None)
    answer = {'models': models, 'pages': answered}
    if plan.target:
        answer['kept'] = _keep(conn, account, plan.target, uploads, answered, read, plan.fields, own, finder,
                               plan.reading, layout, laid_out)
    return answer


def lines(conn, account: str, uploads: list[Upload], fields: dict) -> dict:
    """Read line images as they were sent, in the order sent, while the caller waits."""
    check_cap(conn, account)
    reading = _reading(conn, fields)
    with admitted(account, lines=len(uploads)) as request:
        return read_lines(conn, account, reading, uploads, request)


def read_lines(conn, account: str, reading: Reading, uploads: list[Upload], request: InFlight, first: int = 0,
               requests: int = 1) -> dict:
    """The answer for these line images, the request's usage recorded. `first` is the place
    of the first image in the whole request, for an async one read in batches."""
    errors, crops = {}, []
    for i, upload in enumerate(uploads):
        decoded = _decoded(upload)
        if isinstance(decoded, str):
            errors[i] = decoded
        else:
            crops.append((i, [(0, decoded[0])], {'line_index': first + i}))
    read, model = _read(conn, reading, request, crops) if crops else ({}, None)
    record_usage(conn, account, pages=0, lines=len(crops), seconds=request.held(), requests=requests)
    answered = [{'id': upload.name, 'error': errors[i]} if i in errors
                else {'id': upload.name, 'text': read[i].text, 'confidence': read[i].confidence,
                      **({'characters': _bands(read[i])} if reading.characters else {})}
                for i, upload in enumerate(uploads)]
    return {'models': {'ocr': model} if model else {}, 'lines': answered}
