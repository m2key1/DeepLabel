import unicodedata
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from app import conventions, layout_templates, registry
from app.backend_client import BackendClient, Encoded, Item

PASS_THROUGH = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png'}


def scan_image(path: str, image: Image.Image) -> Image.Image | Encoded:
    """What to send for a whole page: the file's own bytes when the contract takes its
    format and nothing was done to it, else the decoded image."""
    mime = PASS_THROUGH.get(Path(path).suffix.lower())
    with Image.open(path) as original:
        untouched = original.size == image.size and original.mode == 'RGB'
    return Encoded(Path(path).read_bytes(), mime) if mime and untouched else image


def _model_name(conn, model_id: int) -> str:
    row = conn.execute('SELECT name FROM models WHERE id = ?', (model_id,)).fetchone()
    return row['name'] if row else f'model {model_id}'


@dataclass
class Detection:
    """One layout box: the class DeepLabel calls it, the checkpoint's own label, a
    normalised [x0, y0, x1, y1] and the detector's confidence."""
    class_name: str
    raw_class_name: str
    bbox: list[float]
    confidence: float | None


@dataclass
class PageLayout:
    """A page's boxes. `ordered` says the content boxes are already in reading order;
    otherwise DeepLabel orders the page itself once they are stored."""
    content: list[Detection]
    containers: list[Detection]
    ordered: bool


class RemoteLayout:
    """A layout model on its model backend (4.3). The backend only detects; which boxes are
    containers and the order they are read in are DeepLabel's."""

    def __init__(self, conn, client: BackendClient, model_id: int, vocabulary: layout_templates.Vocabulary):
        self.client = client
        self.model_id = model_id
        self.vocabulary = vocabulary
        self.weights, self.facts = client.load(conn, model_id)
        self.author = f'model:layout@{_model_name(conn, model_id)}'

    def detect(self, images: list[Image.Image], sources: list[str]) -> list[PageLayout]:
        sent = [scan_image(source, image) for image, source in zip(images, sources)]
        response = self.client.predict_all('layout', self.weights, {},
                                           [Item(str(i), image) for i, image in enumerate(sent)])
        pages = []
        for result in response['results']:
            if 'error' in result:
                raise RuntimeError(f"layout backend refused a page: {result['error'].get('message')}")
            content, containers = [], []
            for found in result.get('detections', []):
                class_name, raw, kind = self.vocabulary.resolve(found['label'])
                detection = Detection(class_name, raw, [float(v) for v in found['bbox']], found.get('confidence'))
                (containers if kind == 'container' else content).append(detection)
            pages.append(PageLayout(content, containers, ordered=False))
        return pages

    def close(self):
        pass


class RemoteLines:
    """A line detector on its model backend (4.4): polygons normalised to each image sent,
    whether that is a page or one element's crop."""

    def __init__(self, conn, client: BackendClient, model_id: int):
        self.client = client
        self.model_id = model_id
        self.weights, self.facts = client.load(conn, model_id)
        self.author = f'model:lines@{_model_name(conn, model_id)}'

    def detect(self, images: list[Image.Image], scope: str) -> list[list[list[list[float]]]]:
        response = self.client.predict_all('lines', self.weights, {'scope': scope},
                                           [Item(str(i), image) for i, image in enumerate(images)])
        found = []
        for result in response['results']:
            if 'error' in result:
                found.append([])
                continue
            found.append([[[float(x), float(y)] for x, y in line['polygon']] for line in result.get('lines', [])])
        return found

    def close(self):
        pass


class RemoteOcrEngine:
    """An OCR model read on its model backend, with the interface the in-process engine
    has: predict_batch, the decode that ran, and the convention flags honoured."""

    def __init__(self, conn, client: BackendClient, model_id: int, decode: str,
                 convention: dict[str, bool] | None = None):
        self.client = client
        self.weights, self.facts = client.load(conn, model_id)
        self.convention_names = list(self.facts.get('conventions')
                                     or client.info().get('tasks_detail', {}).get('ocr', {}).get('conventions') or [])
        asked = convention or {}
        self.honoured = conventions.honoured(asked, self.convention_names)
        self.decode = decode
        self.params = {'decode': decode, 'convention': {name: True for name, on in asked.items() if on}}
        registry.note_model_facts(conn, model_id, self.facts, self.convention_names)

    def predict_batch(self, images: list[Image.Image], contexts: list[dict] | None = None):
        contexts = contexts or [{}] * len(images)
        response = self.client.predict_all('ocr', self.weights, self.params,
                                           [Item(str(i), image, context)
                                            for i, (image, context) in enumerate(zip(images, contexts))])
        self.decode = response.get('decode', self.decode)
        if 'conventions' in response:
            self.honoured = list(response['conventions'])
        texts, confs, profiles = [], [], []
        for result in response['results']:
            if 'error' in result:
                # One unreadable crop fails alone (3.7): it reads as nothing, like a crop
                # too small to cut.
                texts.append('')
                confs.append(0.0)
                profiles.append(None)
                continue
            # Stored text is composed (NFC), as a person's corrections are; a model may read decomposed.
            texts.append(unicodedata.normalize('NFC', result.get('text') or ''))
            confs.append(float(result.get('confidence') or 0.0))
            profiles.append(result.get('conf_profile'))
        return texts, confs, profiles
