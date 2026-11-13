import io
import json
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone

from PIL import Image, UnidentifiedImageError

from app import auto_decode, backend_client, config, conventions, decode, evaluator, formats, linecrop, ocr_phase, \
    reading_order, registry, scans
from app.backend_client import Encoded
from app.remote_models import RemoteLines, RemoteOcrEngine

FORMATS = ('json', 'page', 'alto', 'hocr', 'txt')
SENT_AS_IS = {'JPEG': 'image/jpeg', 'PNG': 'image/png'}


class Refused(Exception):
    """A request the recognition API will not run, with its status and the reason."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


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

    def wait(self, waiting: bool) -> None:
        self.waiting = waiting

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
            raise Refused(429, 'this account has a recognition request running already')
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


def default_decode(conn, model_id: int) -> str:
    """What a dataset on 'auto' reads this model with."""
    return auto_decode.resolve(conn, model_id, 'auto')


def _served(conn, task: str) -> list:
    rows = conn.execute('SELECT * FROM models WHERE task = ? AND archived = 0 ORDER BY created_at', (task,)).fetchall()
    return [row for row in rows if backend_client.client_for(conn, row['id']) is not None]


def offered(conn) -> dict:
    def entry(row) -> dict:
        model = {'id': row['id'], 'name': row['name'], 'default': bool(row['is_default'])}
        if row['task'] != 'ocr':
            return model
        return {**model, 'decodes': evaluator.decodes_for(conn, row['id']),
                'default_decode': default_decode(conn, row['id']),
                'conventions': json.loads(row['conventions']) if row['conventions'] else []}
    return {'models': {task: [entry(row) for row in _served(conn, task)] for task in ('lines', 'ocr')},
            'limits': {'pages': config.RECOGNIZE_MAX_PAGES, 'lines': config.RECOGNIZE_MAX_LINES,
                       'megabytes': config.RECOGNIZE_MAX_MB},
            'formats': list(FORMATS)}


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


def _read(conn, reading: Reading, request: InFlight, lines: list[tuple[object, Crops, dict]]) -> tuple[dict, dict]:
    """Read every line, each at the orientations it was cut at, keeping the more confident
    reading. Sorted by width, as a dataset's lines are, since a batch of like widths reads
    better. Returns the readings by key, and the model block of the answer."""
    reading.client.on_wait = request.wait
    engine = RemoteOcrEngine(conn, reading.client, reading.model['id'], reading.decode, reading.convention)
    request.stage = 'reading'
    items = sorted(((key, crop, context) for key, crops, context in lines for _, crop in crops),
                   key=lambda item: item[1].width)
    best: dict = {key: ('', None) for key, crops, _ in lines if not crops}
    chunk = reading.client.max_items('ocr')
    for start in range(0, len(items), chunk):
        part = items[start:start + chunk]
        texts, confidences, _ = engine.predict_batch([crop for _, crop, _ in part], [context for *_, context in part])
        for (key, _, _), text, confidence in zip(part, texts, confidences):
            if key not in best or confidence > (best[key][1] or 0):
                best[key] = (text.strip(), confidence)
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


def pages(conn, account: str, uploads: list[Upload], fields: dict) -> dict:
    """Find the lines of whole pages - or take the outlines the caller sent for a page -
    and read them. Pages are decoded one at a time and only their line crops are kept, so
    a request of large scans never holds them all at once."""
    fmt = fields.get('format') or 'json'
    if fmt not in FORMATS:
        raise Refused(400, f'format must be one of {", ".join(FORMATS)}')
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
    for i, page in enumerate(answered):
        if 'error' in page:
            continue
        page['lines'] = [{'polygon': outline, 'text': read[(i, n)][0], 'confidence': read[(i, n)][1]}
                         for n, outline in enumerate(page['lines'])]
        if fmt != 'json':
            page['document'] = _document(fmt, i, page['id'], page['width'], page['height'], page['lines'])
    if models.get('ocr') is None:
        models.pop('ocr', None)
    return {'models': models, 'pages': answered}


def lines(conn, account: str, uploads: list[Upload], fields: dict) -> dict:
    """Read line images as they were sent, in the order sent."""
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
    answered = [{'id': upload.name, 'error': errors[i]} if i in errors
                else {'id': upload.name, 'text': read[i][0], 'confidence': read[i][1]}
                for i, upload in enumerate(uploads)]
    return {'models': {'ocr': model} if model else {}, 'lines': answered}
