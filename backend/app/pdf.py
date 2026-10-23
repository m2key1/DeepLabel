import math
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from app import config

# Placed images may overshoot the page slightly through rounding or bleed.
MAX_COVERAGE = 1.15

# /Rotate is clockwise, PIL transposes counter-clockwise.
ROTATE_TRANSPOSE = {90: Image.ROTATE_270, 180: Image.ROTATE_180, 270: Image.ROTATE_90}

_PAGE_SIZE = re.compile(r'^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts')
_PAGE_ROT = re.compile(r'^Page\s+(\d+) rot:\s+(-?\d+)')


class PdfError(ValueError):
    pass


@dataclass(frozen=True)
class PageSpec:
    page: int
    mode: str
    rotate: int
    ext: str
    # The page image materialize writes, upright, in pixels.
    width: int = 0
    height: int = 0


def _run(argv: list) -> str:
    try:
        proc = subprocess.run([str(a) for a in argv], capture_output=True, text=True, check=False)
    except FileNotFoundError:
        # Callers only catch PdfError; without this an image missing poppler-utils
        # answers PDF uploads with a 500 instead of a message naming the cause.
        raise PdfError(f'{argv[0]} is not installed - PDF support needs poppler-utils')
    if proc.returncode != 0:
        lines = [l.strip() for l in proc.stderr.splitlines() if l.strip()]
        # Warnings come first and say "continuing anyway", which reads absurdly on
        # a rejection; the real diagnostic is the Error line behind them.
        detail = next((l for l in lines if 'Warning' not in l), lines[0] if lines else 'poppler failed')
        raise PdfError(detail)
    return proc.stdout


def page_count(path: Path) -> int:
    for line in _run(['pdfinfo', path]).splitlines():
        if line.startswith('Pages:'):
            return int(line.split()[1])
    raise PdfError('no page count in pdfinfo output')


def _page_geometry(path: Path) -> dict:
    """{page: (width_pts, height_pts, rotate)} for every page, in one call."""
    sizes, rots = {}, {}
    for line in _run(['pdfinfo', '-f', 1, '-l', 99999, path]).splitlines():
        size = _PAGE_SIZE.match(line)
        if size:
            sizes[int(size[1])] = (float(size[2]), float(size[3]))
            continue
        rot = _PAGE_ROT.match(line)
        if rot:
            rots[int(rot[1])] = int(rot[2]) % 360
    if not sizes:
        raise PdfError('no page geometry in pdfinfo output')
    return {p: (*wh, rots.get(p, 0)) for p, wh in sizes.items()}


def _image_rows(path: Path) -> dict:
    """{page: [row, ...]} from pdfimages -list. Columns are
    page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio,
    where 'object ID' is two columns."""
    rows: dict = {}
    for line in _run(['pdfimages', '-list', path]).splitlines()[2:]:
        f = line.split()
        if len(f) < 15 or not f[0].isdigit():
            continue
        rows.setdefault(int(f[0]), []).append(
            {'type': f[2], 'width': int(f[3]), 'height': int(f[4]), 'enc': f[8],
             'x_ppi': float(f[12]), 'y_ppi': float(f[13])})
    return rows


def _upright(width: int, height: int, rotate: int) -> tuple[int, int]:
    return (height, width) if rotate in (90, 270) else (width, height)


def _rendered(page: int, page_w: float, page_h: float, rotate: int) -> PageSpec:
    """pdftoppm rounds each side of the page box up to a whole pixel."""
    size = (math.ceil(side / 72.0 * config.PDF_RENDER_DPI) for side in (page_w, page_h))
    return PageSpec(page, 'render', rotate, '.png', *_upright(*size, rotate))


def _classify(page: int, geom: tuple, rows: list) -> PageSpec:
    page_w, page_h, rotate = geom
    # Anything but a single plain image is composite, vector, strip-scanned or
    # soft-masked; rendering is the only faithful answer.
    if len(rows) != 1 or rows[0]['type'] != 'image':
        return _rendered(page, page_w, page_h, rotate)
    row = rows[0]
    if row['x_ppi'] <= 0 or row['y_ppi'] <= 0:
        return _rendered(page, page_w, page_h, rotate)
    # Placed size against the unrotated page box. Both sides independently, so a
    # wide-and-short image cannot pass on area alone.
    placed_w = row['width'] * 72.0 / row['x_ppi']
    placed_h = row['height'] * 72.0 / row['y_ppi']
    covers = (config.PDF_EXTRACT_COVERAGE <= placed_w / page_w <= MAX_COVERAGE
              and config.PDF_EXTRACT_COVERAGE <= placed_h / page_h <= MAX_COVERAGE)
    if not covers:
        return _rendered(page, page_w, page_h, rotate)
    return PageSpec(page, 'extract', rotate, '.jpg' if row['enc'] == 'jpeg' else '.png',
                    *_upright(row['width'], row['height'], rotate))


def probe(path: Path) -> list:
    """One PageSpec per page, from two whole-document poppler calls."""
    geometry = _page_geometry(path)
    rows = _image_rows(path)
    return [_classify(p, geometry[p], rows.get(p, [])) for p in sorted(geometry)]


def page_texts(path: Path) -> dict[int, str]:
    """{page: text} from the PDF's own text layer, in one call. Pages with no text
    layer come back empty. Deliberately not -layout: that mode preserves the visual
    arrangement and joins side-by-side columns into one line, and a line built from
    two columns matches neither of the segmented lines it came from."""
    pages = _run(['pdftotext', path, '-']).split('\f')
    if pages and not pages[-1].strip():
        pages.pop()  # pdftotext terminates the last page with a form feed too
    return dict(enumerate(pages, start=1))


def spec_for(path: Path, page: int) -> PageSpec:
    for spec in probe(path):
        if spec.page == page:
            return spec
    raise PdfError(f'page {page} not in document')


def materialize(path: Path, spec: PageSpec, dest_dir: Path, stem: str) -> Path:
    """Write one page as an image and return its path. Output naming is poppler's
    own (a global counter for pdfimages), so we collect from an empty temp dir
    rather than predicting it."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp = dest_dir / f'.{stem}.tmp'
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    try:
        if spec.mode == 'extract':
            _run(['pdfimages', '-j', '-png', '-f', spec.page, '-l', spec.page, path, tmp / 'i'])
        else:
            _run(['pdftoppm', '-r', config.PDF_RENDER_DPI, '-png',
                  '-f', spec.page, '-l', spec.page, path, tmp / 'i'])
        produced = sorted(p for p in tmp.iterdir() if p.is_file())
        if len(produced) != 1:
            raise PdfError(f'page {spec.page}: expected one image, got {len(produced)}')
        # pdftoppm applies /Rotate itself; an extracted stream is raw.
        if spec.mode == 'extract' and spec.rotate in ROTATE_TRANSPOSE:
            with Image.open(produced[0]) as im:
                im.transpose(ROTATE_TRANSPOSE[spec.rotate]).save(produced[0])
        target = dest_dir / f'{stem}{produced[0].suffix}'
        target.unlink(missing_ok=True)
        return produced[0].replace(target)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
