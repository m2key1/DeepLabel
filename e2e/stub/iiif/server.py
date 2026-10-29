"""A small IIIF archive for the e2e stack: manifests in both Presentation versions, a
collection of them, and an image service that draws each page on request.

A manifest's address may carry ?run=<token>; the token is threaded into its image URLs,
so each scenario's pages are its own. The last canvas of the v3 manifest fails its first
full-size request and succeeds after, which is how a scenario sees a failed download and
its retry. Thumbnails (THUMB px wide) never fail.
"""
import hashlib
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw

BASE = os.environ.get('IIIF_BASE', 'http://iiif:8000')
THUMB = 240
WIDTH, HEIGHT = 1200, 1600
LABELS = ['fol. 1r', 'fol. 1v', 'fol. 2r', 'fol. 2v']
ATTRIBUTION = 'Example town archive, Council minutes, Nr. 17'
RIGHTS = 'http://creativecommons.org/licenses/by/4.0/'

failed_once: set[str] = set()
lock = threading.Lock()


def v3_manifest(run: str) -> dict:
    def canvas(n: int, label: str) -> dict:
        flaky = 'flaky-' if n == len(LABELS) else ''
        service = f'{BASE}/img/{flaky}{run}-{n}'
        return {'id': f'{BASE}/canvas/{run}/{n}', 'type': 'Canvas', 'label': {'none': [label]},
                'width': WIDTH, 'height': HEIGHT,
                'items': [{'id': f'{BASE}/page/{run}/{n}', 'type': 'AnnotationPage', 'items': [{
                    'id': f'{BASE}/anno/{run}/{n}', 'type': 'Annotation', 'motivation': 'painting',
                    'target': f'{BASE}/canvas/{run}/{n}',
                    'body': {'id': f'{service}/full/max/0/default.jpg', 'type': 'Image', 'format': 'image/jpeg',
                             'width': WIDTH, 'height': HEIGHT,
                             'service': [{'id': service, 'type': 'ImageService3', 'profile': 'level1'}]}}]}]}
    return {'@context': 'http://iiif.io/api/presentation/3/context.json', 'id': f'{BASE}/v3/manifest.json?run={run}',
            'type': 'Manifest', 'label': {'en': ['Council minutes 1781']},
            'requiredStatement': {'label': {'en': ['Attribution']}, 'value': {'en': [ATTRIBUTION]}},
            'rights': RIGHTS, 'items': [canvas(n, label) for n, label in enumerate(LABELS, 1)]}


def v2_manifest(run: str) -> dict:
    canvases = [{'@id': f'{BASE}/v2canvas/{run}/{n}', '@type': 'sc:Canvas', 'label': label,
                 'width': WIDTH, 'height': HEIGHT,
                 'images': [{'@type': 'oa:Annotation', 'motivation': 'sc:painting', 'resource': {
                     '@id': f'{BASE}/img/v2-{run}-{n}/full/full/0/default.jpg', 'width': WIDTH, 'height': HEIGHT,
                     'service': {'@context': 'http://iiif.io/api/image/2/context.json',
                                 '@id': f'{BASE}/img/v2-{run}-{n}', 'profile': 'http://iiif.io/api/image/2/level1.json'}}}]}
                for n, label in enumerate(LABELS[:2], 1)]
    return {'@context': 'http://iiif.io/api/presentation/2/context.json', '@id': f'{BASE}/v2/manifest.json?run={run}',
            '@type': 'sc:Manifest', 'label': 'Council minutes 1782', 'attribution': ATTRIBUTION,
            'sequences': [{'canvases': canvases}]}


def collection(run: str) -> dict:
    return {'@context': 'http://iiif.io/api/presentation/3/context.json', 'id': f'{BASE}/collection.json?run={run}',
            'type': 'Collection', 'label': {'en': ['Council minutes']},
            'items': [{'id': f'{BASE}/v3/manifest.json?run={run}', 'type': 'Manifest', 'label': {'en': ['1781']}},
                      {'id': f'{BASE}/v2/manifest.json?run={run}', 'type': 'Manifest', 'label': {'en': ['1782']}}]}


def page_image(key: str, width: int) -> bytes:
    """A pale page with a few dark strokes whose lengths come from a hash of the key, so no
    two pages are the same scan - DeepLabel would rightly keep a second one as a duplicate."""
    height = round(width * HEIGHT / WIDTH)
    img = Image.new('RGB', (width, height), (236, 228, 206))
    draw = ImageDraw.Draw(img)
    digest = hashlib.sha256(key.encode()).digest()
    for row, byte in enumerate(digest[:8]):
        y = round(height * (0.12 + row * 0.09))
        draw.rectangle([round(width * 0.1), y, round(width * (0.3 + byte / 400)), y + max(2, height // 160)],
                       fill=(70, 60, 45))
    out = io.BytesIO()
    img.save(out, 'JPEG', quality=85)
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parts = urlsplit(self.path)
        run = (parse_qs(parts.query).get('run') or ['default'])[0]
        documents = {'/v3/manifest.json': v3_manifest, '/v2/manifest.json': v2_manifest,
                     '/collection.json': collection}
        if parts.path in documents:
            return self._send(200, json.dumps(documents[parts.path](run)).encode(), 'application/ld+json')
        segments = parts.path.strip('/').split('/')
        if len(segments) == 6 and segments[0] == 'img' and segments[2] == 'full':
            key, size = segments[1], segments[3]
            width = WIDTH if size in ('max', 'full') else int(size.rstrip(','))
            if key.startswith('flaky-') and width != THUMB:
                with lock:
                    first = key not in failed_once
                    failed_once.add(key)
                if first:
                    return self._send(404, b'not found', 'text/plain')
            return self._send(200, page_image(key, min(width, WIDTH)), 'image/jpeg')
        self._send(404, b'not found', 'text/plain')

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
