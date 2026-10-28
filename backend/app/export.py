import io
import json
import zipfile
from pathlib import Path

from app import formats
from app.caches import counted_page


def _line_text(line: dict) -> str:
    return line['corrected_text'] if line['corrected_text'] is not None else (line['text'] or '')


# Five places is a tenth of a pixel on a ten-thousand pixel scan, and the geometry arrives
# as doubles: one corner of one line spells 0.07833333333333334 where 0.07833 says the same
# thing. Over a volume that is most of the payload, to send and to parse alike.
PLACES = 5


def _rounded(polygon: list) -> list:
    return [[round(x, PLACES), round(y, PLACES)] for x, y in polygon]


def collect_job(conn, job_id: str, checked_only: bool = False) -> dict:
    job = conn.execute('SELECT id, name, owner, created_at, layout_shape FROM jobs WHERE id = ?', (job_id,)).fetchone()
    outlines = job is not None and job['layout_shape'] == 'polygon'
    pages = []
    for page in conn.execute(
            f'SELECT * FROM pages WHERE job_id = ? AND {counted_page()} '
            'ORDER BY idx', (job_id,)):
        elements = []
        for element in conn.execute(
                'SELECT * FROM elements WHERE page_id = ? AND deleted = 0 ORDER BY order_idx', (page['id'],)):
            lines = [
                {'id': l['id'], 'order_idx': l['order_idx'],
                 'polygon': _rounded(json.loads(l['polygon'])),
                 'text': l['text'], 'corrected_text': l['corrected_text'],
                 'confidence': l['confidence'], 'checked': bool(l['checked'])}
                for l in conn.execute(
                    'SELECT * FROM lines WHERE element_id = ? AND deleted = 0 ORDER BY order_idx', (element['id'],))
                if not checked_only or l['checked']
            ]
            elements.append({'order_idx': element['order_idx'], 'class_name': element['class_name'],
                             'bbox': [round(v, PLACES) for v in json.loads(element['bbox'])],
                             'conf': element['conf'],
                             'kind': element['kind'], 'lines': lines,
                             **({'polygon': _rounded(json.loads(element['polygon']))}
                                if outlines and element['polygon'] else {})})
        if checked_only and not any(element['lines'] for element in elements):
            continue
        pages.append({'id': page['id'], 'idx': page['idx'], 'filename': page['filename'],
                      'width': page['width'], 'height': page['height'],
                      # The way up, because the reader draws the scan from its tiles and
                      # those are rewritten when a page is turned - without it the browser
                      # would keep handing back the ones from before the turn.
                      'rotation': page['rotation'],
                      # Which pages were reviewed whole, so an import elsewhere keeps them ground truth.
                      'layout_checked': bool(page['layout_checked']), 'lines_checked': bool(page['lines_checked']),
                      'elements': elements})
    described = {k: job[k] for k in ('id', 'name', 'owner', 'created_at')} if job else {}
    return {'job': described, 'pages': pages}


def page_markdown(page: dict) -> str:
    parts = [f"## Page {page['idx'] + 1}: {page['filename']}\n"]
    for element in page['elements']:
        text = '\n'.join(_line_text(l) for l in element['lines']).strip()
        if not text:
            continue
        parts.append(f"**{element['class_name']}**\n\n{text}\n")
    return '\n'.join(parts)


def to_markdown(data: dict) -> str:
    parts = [f"# {data['job'].get('name', '')}\n"]
    parts += [page_markdown(page) for page in data['pages']]
    return '\n'.join(parts)


def to_text(data: dict) -> str:
    parts = []
    for page in data['pages']:
        lines = [_line_text(l) for e in page['elements'] for l in e['lines']]
        parts.append('\n'.join(l for l in lines if l))
    return '\n\n'.join(parts)


def write_archive(conn, data: dict, files: dict[str, str], out) -> None:
    """A zip of these text files and every page's scan under images/, written to `out` (a
    path or a file object) so a volume's worth of scans never has to fit in memory. The
    scans are stored as they are - they are compressed already."""
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, text in files.items():
            zf.writestr(name, text)
        written = set()
        for page in data['pages']:
            name = f"images/{page['filename']}"
            if name in written:
                continue
            row = conn.execute('SELECT source_file FROM pages WHERE id = ?', (page['id'],)).fetchone()
            if row and row['source_file'] and Path(row['source_file']).is_file():
                zf.write(row['source_file'], name, compress_type=zipfile.ZIP_STORED)
                written.add(name)


def page_stem(page: dict) -> str:
    return f"page_{page['idx'] + 1:04d}"


def deeplabel_files(data: dict) -> dict[str, str]:
    """DeepLabel's own archive: the whole dataset as job.json, which an import elsewhere
    reads back with every class, correction and check, and each page as JSON and Markdown."""
    files = {'job.json': json.dumps(data, ensure_ascii=False, indent=2)}
    for page in data['pages']:
        files[f'pages/{page_stem(page)}.json'] = json.dumps(page, ensure_ascii=False, indent=2)
        files[f'pages/{page_stem(page)}.md'] = page_markdown(page)
    return files


def _file_stems(data: dict) -> dict[int, str]:
    """Each page's file named after its scan, as Transkribus and eScriptorium name theirs;
    two scans of one name fall back to the page number."""
    stems = [Path(page['filename']).stem for page in data['pages']]
    return {page['id']: stem if stems.count(stem) == 1 else page_stem(page)
            for page, stem in zip(data['pages'], stems)}


def standard_files(data: dict, fmt: str) -> dict[str, str]:
    """The dataset in a standard format: PAGE XML, ALTO or hOCR as a file per page, TEI as
    one document. The scans go beside them in the archive."""
    if fmt == 'tei':
        return {'tei.xml': formats.tei(data)}
    stems = _file_stems(data)
    title = data['job'].get('name', '')
    render = {'page': (formats.page_xml, 'xml'), 'alto': (formats.alto, 'xml'),
              'hocr': (lambda page: formats.hocr(page, title), 'hocr')}[fmt]
    return {f'{fmt}/{stems[page["id"]]}.{render[1]}': render[0](page) for page in data['pages']}
