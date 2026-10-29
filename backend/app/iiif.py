import io
import ipaddress
import json
import re
import socket
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from PIL import Image

from app import config

TIMEOUT = 30
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


def _canvas(canvas: dict, v3: bool) -> dict:
    resource = _image_resource(canvas, v3)
    service = _image_service(resource)
    width = resource.get('width') or canvas.get('width')
    image = (f'{service}/full/{min(width, config.IIIF_MAX_WIDTH)},/0/default.jpg' if service and width
             else _id(resource))
    thumbnail = (f'{service}/full/{THUMBNAIL_WIDTH},/0/default.jpg' if service
                 else _id(_first(canvas.get('thumbnail'))) or _id(resource))
    return {'canvas': _id(canvas), 'label': text(canvas.get('label')),
            'width': canvas.get('width'), 'height': canvas.get('height'),
            'image': image, 'thumbnail': thumbnail}


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
    except ValueError:
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
