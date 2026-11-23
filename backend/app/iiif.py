import io
import ipaddress
import json
import re
import socket
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from PIL import Image

from app import config

TIMEOUT = 30
# The whole of one fetch: TIMEOUT is per read, so a server sending a byte at a time would
# otherwise hold it for as long as it liked.
FETCH_SECONDS = 120
MAX_REDIRECTS = 5
MAX_MANIFEST_BYTES = 20 << 20
MAX_THUMBNAIL_BYTES = 2 << 20
THUMBNAIL_WIDTH = 240
LABEL_LANGUAGES = ('none', 'en', 'de')


class IiifError(Exception):
    """Something about a manifest or an image that the person importing it can act on."""


def _client() -> httpx.Client:
    return httpx.Client(timeout=TIMEOUT, follow_redirects=False,
                        headers={'Accept': 'application/ld+json, application/json, image/*;q=0.9, */*;q=0.5'})


def _require_public(host: str) -> None:
    """Refuses a host that resolves to a private, loopback, link-local or otherwise
    internal address, unless the deployment allows it by name."""
    if host.lower() in config.IIIF_ALLOWED_HOSTS:
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise IiifError(f'{host} could not be found')
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split('%')[0])
        address = getattr(address, 'ipv4_mapped', None) or address
        if not address.is_global or address.is_multicast:
            raise IiifError(f'{host} is a private or internal address, which DeepLabel does not fetch from')


def fetch(url: str, max_bytes: int, what: str) -> tuple[bytes, str]:
    """The body and content type at `url`, following redirects by hand so every hop is
    checked for an internal address, and stopping once the body passes `max_bytes`."""
    started = time.monotonic()
    with _client() as client:
        for _ in range(MAX_REDIRECTS + 1):
            parts = urlsplit(url)
            if parts.scheme not in ('http', 'https') or not parts.hostname:
                raise IiifError(f'{url} is not an http or https address')
            _require_public(parts.hostname)
            try:
                with client.stream('GET', url) as response:
                    if response.is_redirect and 'location' in response.headers:
                        url = urljoin(url, response.headers['location'])
                        continue
                    if response.status_code != 200:
                        raise IiifError(f'the server answered {response.status_code} for {what}')
                    if int(response.headers.get('content-length') or 0) > max_bytes:
                        raise IiifError(f'{what} is larger than {_size(max_bytes)}')
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body += chunk
                        if len(body) > max_bytes:
                            raise IiifError(f'{what} is larger than {_size(max_bytes)}')
                        if time.monotonic() - started > FETCH_SECONDS:
                            raise IiifError(f'{what} took longer than {FETCH_SECONDS} s to arrive')
                    return bytes(body), response.headers.get('content-type', '')
            except httpx.HTTPError as error:
                raise IiifError(f'{what} could not be fetched: {error}')
    raise IiifError(f'{what} redirects more than {MAX_REDIRECTS} times')


def _size(n: int) -> str:
    return f'{n / (1 << 20):g} MB'


def _id(node) -> str | None:
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        return node.get('id') or node.get('@id')
    return None


def _type(node) -> str:
    return (node.get('type') or node.get('@type') or '') if isinstance(node, dict) else ''


def _first(node):
    return node[0] if isinstance(node, list) and node else node if not isinstance(node, list) else None


def text(value) -> str:
    """A label or statement in any shape the two versions use - a string, a list, a
    {'@value'} or a language map - as plain text, one language, markup removed."""
    if value is None:
        return ''
    if isinstance(value, str):
        return re.sub(r'<[^>]+>', '', value).strip()
    if isinstance(value, list):
        tagged = {item.get('@language'): item for item in value if isinstance(item, dict) and '@language' in item}
        for language in LABEL_LANGUAGES:
            if language in tagged:
                return text(tagged[language])
        return '; '.join(part for part in (text(item) for item in value) if part)
    if isinstance(value, dict):
        if '@value' in value:
            return text(value['@value'])
        for language in LABEL_LANGUAGES:
            if language in value:
                return text(value[language])
        return text(next(iter(value.values()), ''))
    return str(value)


def _is_v3(document: dict) -> bool:
    context = document.get('@context')
    contexts = context if isinstance(context, list) else [context]
    return any(isinstance(c, str) and 'presentation/3' in c for c in contexts)


def _image_service(resource: dict) -> str | None:
    services = resource.get('service') or []
    for service in services if isinstance(services, list) else [services]:
        if not isinstance(service, dict):
            continue
        declared = f"{service.get('profile', '')} {service.get('@context', '')}"
        if 'ImageService' in _type(service) or 'iiif.io/api/image' in declared:
            return (_id(service) or '').rstrip('/') or None
    return None


def _image_resource(canvas: dict, v3: bool) -> dict:
    if v3:
        page = _first(canvas.get('items')) or {}
        annotation = _first(page.get('items')) or {}
        body = annotation.get('body') or {}
    else:
        body = (_first(canvas.get('images')) or {}).get('resource') or {}
    if _type(body) in ('Choice', 'oa:Choice'):
        body = _first(body.get('items')) or body.get('default') or {}
    return body if isinstance(body, dict) else {}


# The seeAlso files read as a canvas's transcription, by a mark their profile, format or
# address carries, and the order one kind is preferred to another.
TRANSCRIPT_FILES = (('alto', 'alto'), ('page', 'primaresearch'), ('page', 'pagecontent'), ('hocr', 'hocr'))
FILE_PREFERENCE = ('alto', 'page', 'hocr')
# The v3 motivations of an annotation that transcribes; a v2 transcription is a text resource
# under any motivation but commenting.
TRANSCRIBING = {'supplementing', 'transcribing'}
XYWH = re.compile(r'xywh=(?:(pixel|percent):)?([\d.]+),([\d.]+),([\d.]+),([\d.]+)')
SVG_POINTS = re.compile(r'points\s*=\s*["\']([^"\']+)["\']')


def _listed(node) -> list:
    return node if isinstance(node, list) else [node] if node else []


def annotation_text(annotation) -> str | None:
    """What a transcription annotation reads, or None for any other annotation."""
    if not isinstance(annotation, dict):
        return None
    motivations = {m.split(':')[-1] for m in _listed(annotation.get('motivation')) if isinstance(m, str)}
    if 'commenting' in motivations:
        return None
    for body in _listed(annotation.get('body') or annotation.get('resource')):
        if not isinstance(body, dict):
            continue
        if 'TextualBody' in _type(body) and motivations & TRANSCRIBING:
            value = text(body.get('value'))
        elif 'ContentAsText' in _type(body) or 'chars' in body:
            value = text(body.get('chars'))
        else:
            continue
        if value:
            return value
    return None


def annotation_outline(annotation: dict, width: float, height: float) -> list[list[float]] | None:
    """Where on the canvas an annotation sits, as a polygon over the page from 0 to 1: an SVG
    polygon where it gives one, else its xywh region, in pixels or percent. None for an
    outline that does not read, which leaves the one annotation out rather than the page."""
    try:
        return _outline(annotation, width, height)
    except (ValueError, TypeError, ZeroDivisionError):
        return None


def _outline(annotation: dict, width: float, height: float) -> list[list[float]] | None:
    marks = []
    for target in _listed(annotation.get('target') or annotation.get('on')):
        marks.append(_id(target) or '')
        if isinstance(target, dict):
            marks += [str(s.get('value', '')) for s in _listed(target.get('selector')) if isinstance(s, dict)]
    clamp = lambda v: max(0.0, min(v, 1.0))
    for mark in marks:
        if points := SVG_POINTS.search(mark):
            numbers = [float(n) for n in re.split(r'[\s,]+', points.group(1).strip())]
            corners = [[clamp(x / width), clamp(y / height)] for x, y in zip(numbers[0::2], numbers[1::2])]
            if len(corners) >= 3:
                return corners
    for mark in marks:
        if region := XYWH.search(mark):
            x, y, w, h = (float(n) for n in region.groups()[1:])
            if region.group(1) == 'percent':
                x, y, w, h = x * width / 100, y * height / 100, w * width / 100, h * height / 100
            x0, y0, x1, y1 = clamp(x / width), clamp(y / height), clamp((x + w) / width), clamp((y + h) / height)
            return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return None


def _transcript(canvas: dict, v3: bool) -> dict | None:
    """Where the archive's own transcription of a canvas is: a seeAlso file, ALTO before
    PAGE before hOCR, or else its text annotations - those it carries, and pages of them to
    fetch."""
    files = []
    for link in _listed(canvas.get('seeAlso')):
        url = _id(link)
        if not url:
            continue
        declared = ' '.join(str(link.get(key, '')) for key in ('profile', 'format', 'label')).lower() \
            if isinstance(link, dict) else ''
        # What the link says it is, before what its address happens to contain.
        kind = next((kind for kind, mark in TRANSCRIPT_FILES if mark in declared), None) \
            or next((kind for kind, mark in TRANSCRIPT_FILES if mark in url.lower()), None)
        if kind:
            files.append((FILE_PREFERENCE.index(kind), kind, url))
    if files:
        _, kind, url = min(files)
        return {'kind': kind, 'url': url}
    pages = []
    for page in _listed(canvas.get('annotations') if v3 else canvas.get('otherContent')):
        if not isinstance(page, (dict, str)):
            continue
        carried = page.get('items') if isinstance(page, dict) and v3 else \
            page.get('resources') if isinstance(page, dict) else None
        if carried:
            transcribed = [a for a in carried if annotation_text(a)]
            if transcribed:
                pages.append({'annotations': transcribed})
        elif _id(page):
            pages.append({'url': _id(page)})
    return {'kind': 'annotations', 'pages': pages} if pages else None


def _dimension(value) -> int | None:
    try:
        return int(float(value)) if value not in (None, '') else None
    except (TypeError, ValueError):
        return None


def _canvas(canvas: dict, v3: bool) -> dict:
    resource = _image_resource(canvas, v3)
    service = _image_service(resource)
    width = resource.get('width') or canvas.get('width')
    image = (f'{service}/full/{min(width, config.IIIF_MAX_WIDTH)},/0/default.jpg' if service and width
             else _id(resource))
    thumbnail = (f'{service}/full/{THUMBNAIL_WIDTH},/0/default.jpg' if service
                 else _id(_first(canvas.get('thumbnail'))) or _id(resource))
    transcript = _transcript(canvas, v3)
    # A canvas that gives no size of its own takes its image's, which places its annotations.
    return {'canvas': _id(canvas), 'label': text(canvas.get('label')),
            'width': _dimension(canvas.get('width')) or _dimension(resource.get('width')),
            'height': _dimension(canvas.get('height')) or _dimension(resource.get('height')),
            'image': image, 'thumbnail': thumbnail, **({'transcript': transcript} if transcript else {})}


def parse(document: dict, url: str) -> dict:
    """A manifest's canvases with what they are called and where their image is, or a
    collection's members, read from Presentation API 2 or 3."""
    kind = _type(document)
    v3 = _is_v3(document)
    if kind in ('Collection', 'sc:Collection'):
        members = document.get('items') if v3 else (
            document.get('members') or (document.get('manifests') or []) + (document.get('collections') or []))
        return {'kind': 'collection', 'url': url, 'label': text(document.get('label')),
                'members': [{'url': _id(m), 'label': text(m.get('label')),
                             'kind': 'collection' if 'Collection' in _type(m) else 'manifest'}
                            for m in members or [] if _id(m)]}
    if kind not in ('Manifest', 'sc:Manifest'):
        raise IiifError('this is neither a IIIF manifest nor a collection')
    canvases = document.get('items') if v3 else (_first(document.get('sequences')) or {}).get('canvases')
    pages = [_canvas(c, v3) for c in canvases or [] if _type(c) in ('Canvas', 'sc:Canvas')]
    pages = [p for p in pages if p['canvas'] and p['image']]
    if not pages:
        raise IiifError('this manifest has no canvas with an image')
    if v3:
        statement = document.get('requiredStatement') or {}
        attribution = text(statement.get('value'))
        rights = document.get('rights') or ''
    else:
        attribution = text(document.get('attribution'))
        rights = text(document.get('license'))
    return {'kind': 'manifest', 'url': url, 'label': text(document.get('label')), 'version': 3 if v3 else 2,
            'attribution': attribution, 'rights': rights, 'canvases': pages}


def read(url: str) -> dict:
    body, _ = fetch(url.strip(), MAX_MANIFEST_BYTES, 'the manifest')
    try:
        document = json.loads(body)
    except (ValueError, RecursionError):
        raise IiifError('the address did not return JSON - is it the manifest itself?')
    if not isinstance(document, dict):
        raise IiifError('this is neither a IIIF manifest nor a collection')
    return parse(document, url.strip())


def thumbnail(url: str) -> tuple[bytes, str]:
    body, content_type = fetch(url, MAX_THUMBNAIL_BYTES, 'the thumbnail')
    if not content_type.startswith('image/'):
        raise IiifError('the thumbnail is not an image')
    return body, content_type


def download(image_url: str, target: Path) -> Path:
    """The page's image, written to `target` as JPEG no wider than IIIF_MAX_WIDTH: an image
    server is asked for that size, a plain image is shrunk here."""
    body, _ = fetch(image_url, int(config.IIIF_MAX_MB * (1 << 20)), 'the image')
    try:
        img = Image.open(io.BytesIO(body))
        img.load()
    except Exception:
        raise IiifError('the image server did not send a readable image')
    if img.width > config.IIIF_MAX_WIDTH:
        img = img.resize((config.IIIF_MAX_WIDTH, round(img.height * config.IIIF_MAX_WIDTH / img.width)))
    target.parent.mkdir(parents=True, exist_ok=True)
    img.convert('RGB').save(target, 'JPEG', quality=92)
    return target


def _canvas_points(polygon: list, canvas: dict) -> list[tuple[int, int]]:
    return [(round(x * canvas['width']), round(y * canvas['height'])) for x, y in polygon]


def annotation_page(page: dict, job_id: str) -> dict:
    """A page's lines as W3C Web Annotations on its canvas, the IIIF Presentation 3 way:
    one supplementing annotation per line, placed by its box and its outline."""
    canvas = page['iiif']
    items = []
    for element in page['elements']:
        for line in element['lines']:
            content = line['corrected_text'] if line['corrected_text'] is not None else (line['text'] or '')
            points = _canvas_points(line['polygon'], canvas)
            xs, ys = [x for x, _ in points], [y for _, y in points]
            svg = ('<svg xmlns="http://www.w3.org/2000/svg"><polygon points="'
                   + ' '.join(f'{x},{y}' for x, y in points) + '"/></svg>')
            items.append({
                'id': f'urn:deeplabel:{job_id}:line:{line["id"]}', 'type': 'Annotation', 'motivation': 'supplementing',
                'body': {'type': 'TextualBody', 'value': content, 'format': 'text/plain'},
                'target': {'type': 'SpecificResource', 'source': canvas['canvas'], 'selector': [
                    {'type': 'FragmentSelector', 'conformsTo': 'http://www.w3.org/TR/media-frags/',
                     'value': f'xywh={min(xs)},{min(ys)},{max(xs) - min(xs)},{max(ys) - min(ys)}'},
                    {'type': 'SvgSelector', 'value': svg}]},
            })
    return {'@context': 'http://iiif.io/api/presentation/3/context.json',
            'id': f'urn:deeplabel:{job_id}:page:{page["id"]}', 'type': 'AnnotationPage', 'items': items}
