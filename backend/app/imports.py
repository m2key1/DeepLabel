"""Parsers for preexisting dataset exports: PAGE XML (Transkribus, eScriptorium,
OCR-D) and ALTO XML (library world, eScriptorium's second format). Both arrive
as a zip of one XML per page plus the page images; regions, line geometry and
transcriptions are ingested directly - nothing needs to be recognized."""

import json
import posixpath
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

from app import ingest, store


class ImportError_(Exception):
    def __init__(self, detail: str):
        self.detail = detail


# PAGE region @type -> our layout vocabulary. Unknown types stay text-bearing
# paragraphs rather than failing an import over taxonomy differences.
REGION_CLASSES = {
    'paragraph': 'Paragraph',
    'heading': 'Header',
    'header': 'PageHeader',
    'page-number': 'Pagenumber',
    'footnote': 'Footnote',
    'caption': 'Paragraph',
    'marginalia': 'Paragraph',
}


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


class UnreadableXml(ValueError):
    pass


def _number(value, what: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise UnreadableXml(f'{what} "{value}" is not a number')


def _page_size(page, width_attr: str, height_attr: str) -> tuple[int, int]:
    size = []
    for attr in (width_attr, height_attr):
        if not page.get(attr):
            raise UnreadableXml(f'the Page element has no {attr}')
        value = int(_number(page.get(attr), attr))
        if value <= 0:
            raise UnreadableXml(f'the Page element\'s {attr} is {value}')
        size.append(value)
    return size[0], size[1]


def _page_element(root):
    page = next((el for el in root.iter() if _local(el.tag) == 'Page'), None)
    if page is None:
        raise UnreadableXml('it has no Page element')
    return page


def _points(value: str) -> list[tuple[float, float]]:
    pairs = [_number(token, 'coordinate') for token in value.replace(',', ' ').split()]
    return list(zip(pairs[0::2], pairs[1::2]))


def _bbox(points: list[tuple[float, float]], width: int, height: int) -> list[float]:
    xs = [max(0.0, min(x / width, 1.0)) for x, _ in points]
    ys = [max(0.0, min(y / height, 1.0)) for _, y in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def _quad(bbox: list[float]) -> list[list[float]]:
    x0, y0, x1, y1 = bbox
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _polygon(points: list[tuple[float, float]], width: int, height: int) -> list[list[float]]:
    return [[max(0.0, min(x / width, 1.0)), max(0.0, min(y / height, 1.0))] for x, y in points]


# Elements whose own TextLines make one region of ours. Transkribus and eScriptorium put
# lines in table cells and in regions nested inside regions as well as directly under
# the Page, so every one of them is read wherever it sits, in document order.
LINE_CONTAINERS = {'TextRegion', 'TableCell'}


def _region_type(region) -> str:
    if _local(region.tag) == 'TableCell':
        return 'table-cell'
    rtype = region.get('type') or ''
    if not rtype:
        match = re.search(r'type\s*:\s*([\w-]+)', region.get('custom') or '')
        rtype = match.group(1) if match else ''
    return rtype


def _custom(el, tag: str, key: str) -> str | None:
    """One value of PAGE's @custom, which reads `tag {key:value; ...}`."""
    match = re.search(rf'{tag}\s*{{[^}}]*\b{key}\s*:\s*([^;}}]+)', el.get('custom') or '')
    return match.group(1).strip() if match else None


def _page_line(line, width: int, height: int) -> dict | None:
    line_points, text = None, ''
    for part in line:
        if _local(part.tag) == 'Coords':
            line_points = _points(part.get('points') or '')
        if _local(part.tag) == 'TextEquiv':
            unicode_el = next((u for u in part if _local(u.tag) == 'Unicode'), None)
            if unicode_el is not None and unicode_el.text:
                text = unicode_el.text
    if not line_points:
        return None
    # A slanted line's bounding box reaches into the lines above and below, and the
    # crop is deskewed from the polygon - so keep the polygon. Fewer than three points
    # cannot enclose anything, and fall back to the box.
    polygon = (_polygon(line_points, width, height) if len(line_points) >= 3
               else _quad(_bbox(line_points, width, height)))
    return {'polygon': polygon, 'text': text.strip()}


def _written_by_deeplabel(root) -> bool:
    return any(_local(el.tag) in ('Creator', 'softwareName') and (el.text or '').strip() == 'DeepLabel'
               for el in root.iter())


def parse_page_xml(data: bytes) -> dict:
    root = ElementTree.fromstring(data)
    page = _page_element(root)
    width, height = _page_size(page, 'imageWidth', 'imageHeight')
    # Our own export says the dataset's class and which lines were checked; anyone else's is
    # read by PAGE's types alone, and its lines take the import's review setting.
    ours = _written_by_deeplabel(root)
    regions = []
    for region in page.iter():
        if _local(region.tag) not in LINE_CONTAINERS:
            continue
        lines, region_points = [], None
        for child in region:
            if _local(child.tag) == 'Coords':
                region_points = _points(child.get('points') or '')
            if _local(child.tag) == 'TextLine':
                line = _page_line(child, width, height)
                if line and ours:
                    line['checked'] = _custom(child, 'deeplabel', 'checked') == 'true'
                if line:
                    lines.append(line)
        if not lines:
            continue
        rtype = _region_type(region)
        bbox = (_bbox(region_points, width, height) if region_points
                else _region_bbox_from_lines(lines))
        own_class = _custom(region, 'structure', 'type') if ours else None
        regions.append({'class_name': own_class or REGION_CLASSES.get(rtype.lower(), 'Paragraph'),
                        'raw_type': own_class or rtype or 'paragraph', 'bbox': bbox, 'lines': lines})
    return {'image': page.get('imageFilename') or '', 'width': width, 'height': height,
            'regions': regions}


def parse_alto(data: bytes) -> dict:
    root = ElementTree.fromstring(data)
    page = _page_element(root)
    width, height = _page_size(page, 'WIDTH', 'HEIGHT')
    image = ''
    for el in root.iter():
        if _local(el.tag) == 'fileName' and el.text:
            image = el.text.strip()
    # A block's class, where our own export named it in a layout tag.
    labels = ({el.get('ID'): el.get('LABEL') for el in root.iter() if _local(el.tag) == 'LayoutTag'}
              if _written_by_deeplabel(root) else {})
    regions = []
    for block in (el for el in page.iter() if _local(el.tag) == 'TextBlock'):
        lines = []
        for line in (el for el in block if _local(el.tag) == 'TextLine'):
            words = _alto_words(line)
            x, y, w, h = _alto_box(line)
            outline = next((el.get('POINTS') for el in line.iter() if _local(el.tag) == 'Polygon'), None)
            points = _points(outline) if outline else []
            polygon = (_polygon(points, width, height) if len(points) >= 3
                       else _quad(_bbox([(x, y), (x + w, y + h)], width, height)))
            lines.append({'polygon': polygon, 'text': ' '.join(w for w in words if w).strip()})
        if not lines:
            continue
        x, y, w, h = _alto_box(block)
        bbox = (_bbox([(x, y), (x + w, y + h)], width, height) if w and h
                else _region_bbox_from_lines(lines))
        label = next((labels[ref] for ref in (block.get('TAGREFS') or '').split() if ref in labels), None)
        regions.append({'class_name': label or 'Paragraph', 'raw_type': label or 'TextBlock',
                        'bbox': bbox, 'lines': lines})
    return {'image': image, 'width': width, 'height': height, 'regions': regions}


def _hocr_props(el) -> dict[str, str]:
    """hOCR's title, `bbox 0 0 10 10; image a.png; x_class Header`, as a dict."""
    props = {}
    for part in (el.get('title') or '').split(';'):
        key, _, value = part.strip().partition(' ')
        if key:
            props[key] = value.strip().strip('"')
    return props


def _hocr_classes(el) -> set[str]:
    return set((el.get('class') or '').split())


def _hocr_bbox(props: dict, what: str) -> tuple[float, float, float, float]:
    values = (props.get('bbox') or '').split()
    if len(values) != 4:
        raise UnreadableXml(f'{what} has no bbox')
    x0, y0, x1, y1 = (_number(v, 'bbox') for v in values)
    return x0, y0, x1, y1


def parse_hocr(data: bytes) -> dict:
    """An hOCR page (Tesseract, OCRopus, Kraken and our own export): its areas as regions and
    their lines with the text of their words. hOCR keeps boxes, so lines arrive upright."""
    root = ElementTree.fromstring(data)
    page = next((el for el in root.iter() if 'ocr_page' in _hocr_classes(el)), None)
    if page is None:
        raise UnreadableXml('it has no ocr_page')
    props = _hocr_props(page)
    _, _, width, height = _hocr_bbox(props, 'the ocr_page')
    width, height = int(width), int(height)
    if width <= 0 or height <= 0:
        raise UnreadableXml('the ocr_page has no size')
    ours = any(el.get('content') == 'DeepLabel' for el in root.iter() if _local(el.tag) == 'meta')
    # Areas hold paragraphs; a page written without areas has only paragraphs. Each line is
    # taken once, by the first area that holds it.
    areas = [el for el in page.iter() if 'ocr_carea' in _hocr_classes(el)] \
        or [el for el in page.iter() if 'ocr_par' in _hocr_classes(el)]
    seen, regions = set(), []
    for area in areas:
        lines = []
        for line in (el for el in area.iter() if _hocr_classes(el) & {'ocr_line', 'ocr_textfloat', 'ocr_header', 'ocr_caption'}):
            if id(line) in seen:
                continue
            seen.add(id(line))
            line_props = _hocr_props(line)
            x0, y0, x1, y1 = _hocr_bbox(line_props, 'an ocr_line')
            words = [''.join(w.itertext()).strip() for w in line.iter() if 'ocrx_word' in _hocr_classes(w)]
            text = ' '.join(w for w in words if w) or ' '.join(''.join(line.itertext()).split())
            entry = {'polygon': _quad(_bbox([(x0, y0), (x1, y1)], width, height)), 'text': text}
            if ours:
                entry['checked'] = line_props.get('x_checked') == '1'
            lines.append(entry)
        if not lines:
            continue
        area_props = _hocr_props(area)
        x0, y0, x1, y1 = _hocr_bbox(area_props, 'an ocr_carea')
        label = area_props.get('x_class') if ours else None
        regions.append({'class_name': label or 'Paragraph', 'raw_type': label or 'ocr_carea',
                        'bbox': _bbox([(x0, y0), (x1, y1)], width, height), 'lines': lines})
    return {'image': props.get('image') or '', 'width': width, 'height': height, 'regions': regions}


XML_ID = '{http://www.w3.org/XML/1998/namespace}id'


def _px_size(value: str | None, what: str) -> int:
    return int(_number((value or '').removesuffix('px'), what))


def parse_tei(data: bytes) -> list[dict]:
    """A TEI document with a facsimile (Transkribus, eScriptorium and our own export): a page
    per surface, a region per zone with lines inside, and each line's text from the <lb>
    that points at its zone. Lines no <lb> points at are kept, with no text."""
    root = ElementTree.fromstring(data)
    texts: dict[str, str] = {}
    for body in (el for el in root.iter() if _local(el.tag) == 'body'):
        current, buffer = None, []

        def close():
            if current is not None:
                texts[current] = ''.join(buffer).strip()

        for el in body.iter():
            if _local(el.tag) == 'lb':
                close()
                current, buffer = (el.get('facs') or '').lstrip('#') or None, []
                if el.tail:
                    buffer.append(el.tail)
            elif current is not None and _local(el.tag) in ('pb', 'ab', 'p'):
                # A page or region boundary ends the line before it.
                close()
                current, buffer = None, []
            elif current is not None:
                buffer.append((el.text or '') + (el.tail or ''))
        close()
    ours = 'Exported from DeepLabel' in ''.join(t for el in root.iter() if _local(el.tag) == 'publicationStmt'
                                               for t in el.itertext())
    pages = []
    for surface in (el for el in root.iter() if _local(el.tag) == 'surface'):
        graphic = next((el for el in surface if _local(el.tag) == 'graphic'), None)
        width = _px_size(surface.get('lrx') or (graphic.get('width') if graphic is not None else None), 'lrx')
        height = _px_size(surface.get('lry') or (graphic.get('height') if graphic is not None else None), 'lry')
        if width <= 0 or height <= 0:
            raise UnreadableXml('a surface has no size')
        regions = []
        for zone in (el for el in surface if _local(el.tag) == 'zone'):
            lines = []
            for line_zone in (el for el in zone if _local(el.tag) == 'zone'):
                points = _points(line_zone.get('points') or '')
                if not points:
                    continue
                polygon = (_polygon(points, width, height) if len(points) >= 3
                           else _quad(_bbox(points, width, height)))
                entry = {'polygon': polygon, 'text': texts.get(line_zone.get(XML_ID), '')}
                if ours:
                    entry['checked'] = line_zone.get('subtype') == 'checked'
                lines.append(entry)
            if not lines:
                continue
            points = _points(zone.get('points') or '')
            label = zone.get('type') if ours else None
            regions.append({'class_name': label or 'Paragraph', 'raw_type': zone.get('type') or 'zone',
                            'bbox': _bbox(points, width, height) if points else _region_bbox_from_lines(lines),
                            'lines': lines})
        url = graphic.get('url') if graphic is not None else ''
        pages.append({'image': PurePosixPath(url or '').name, 'width': width, 'height': height, 'regions': regions})
    if not pages:
        raise UnreadableXml('it has no facsimile surface')
    return pages


def _alto_box(el) -> tuple[float, float, float, float]:
    return tuple(_number(el.get(attr, 0), attr) for attr in ('HPOS', 'VPOS', 'WIDTH', 'HEIGHT'))


def _alto_words(line) -> list[str]:
    """A line's words as printed. A HYP is the hyphen drawn at the line end; it belongs to
    the word it breaks, since a diplomatic transcription keeps the hyphen as written."""
    words = []
    for part in line:
        kind, content = _local(part.tag), part.get('CONTENT') or ''
        if kind == 'HYP' and words:
            words[-1] += content
        elif kind in ('String', 'HYP'):
            words.append(content)
    return words


def _region_bbox_from_lines(lines: list[dict]) -> list[float]:
    xs = [x for line in lines for x, _ in line['polygon']]
    ys = [y for line in lines for _, y in line['polygon']]
    return [min(xs), min(ys), max(xs), max(ys)]


def ingest_pages(conn, job_id: str, pages: list[dict], author: str, reviewed: bool) -> dict:
    """Writes the parsed geometry and transcriptions straight into the job.
    Coordinates are normalized against each XML's own page size, so nothing
    here needs the image itself - the runner's ingest phase only has to build
    renditions afterwards."""
    counts = {'pages': 0, 'lines': 0}
    page_rows = conn.execute(
        'SELECT id, filename FROM pages WHERE job_id = ? ORDER BY idx', (job_id,)).fetchall()
    by_name = {row['filename']: row['id'] for row in page_rows}
    for parsed in pages:
        page_id = by_name.get(parsed['image_name'])
        if page_id is None:
            continue
        counts['pages'] += 1
        conn.execute('UPDATE pages SET width = ?, height = ?, layout_checked = ?, lines_checked = ? WHERE id = ?',
                     (parsed['width'], parsed['height'], int(parsed.get('layout_checked', False)),
                      int(parsed.get('lines_checked', False)), page_id))
        for order_idx, region in enumerate(parsed['regions']):
            cur = conn.execute(
                'INSERT INTO elements (page_id, order_idx, class_name, raw_class_name, bbox, conf, kind, polygon) '
                'VALUES (?,?,?,?,?,?,?,?)',
                (page_id, order_idx, region['class_name'], region['raw_type'],
                 json.dumps(region['bbox']), region.get('conf') or 1.0, region.get('kind') or 'content',
                 json.dumps(region['polygon']) if region.get('polygon') else None))
            element_id = cur.lastrowid
            store.log_element(conn, element_id, author, 'create')
            for line_idx, line in enumerate(region['lines']):
                # An export says which lines were checked; XML only implies it by their text.
                checked = line['checked'] if 'checked' in line else reviewed and bool(line['text'])
                cur = conn.execute(
                    'INSERT INTO lines (element_id, order_idx, polygon, text, corrected_text, checked) '
                    'VALUES (?,?,?,?,?,?)',
                    (element_id, line_idx, json.dumps(line['polygon']), line['text'], line.get('corrected_text'),
                     int(checked)))
                store.log_line(conn, cur.lastrowid, author, 'create')
                counts['lines'] += 1
    conn.commit()
    return counts


IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp'}


def _nearest(candidates: list[str], xml_name: str) -> str | None:
    """Of the images an XML could mean, the one sharing the most folders with it: volumes
    exported side by side each hold their own 0001.png."""
    xml_dir = PurePosixPath(xml_name).parent.parts

    def shared_folders(member: str) -> int:
        count = 0
        for ours, theirs in zip(PurePosixPath(member).parent.parts, xml_dir):
            if ours != theirs:
                break
            count += 1
        return count
    return max(sorted(candidates), key=shared_folders, default=None)


ANNOTATION_SUFFIXES = {'.xml', '.hocr', '.html', '.xhtml'}


class ScansOnly(ImportError_):
    """A zip with scans and nothing that describes them: a set of pages to upload, not an
    export to import."""


def _parse_export_xml(xml_name: str, content: bytes) -> list[dict]:
    """The pages one file describes: one for PAGE, ALTO and hOCR, as many as it has
    surfaces for TEI, none for a file in none of these formats."""
    head = content[:4000].decode('utf-8', errors='replace')
    try:
        if 'PcGts' in head:
            return [{**parse_page_xml(content), 'format': 'page-xml'}]
        if '<alto' in head or 'alto' in head[:200].lower():
            return [{**parse_alto(content), 'format': 'alto'}]
        if 'ocr_page' in content.decode('utf-8', errors='replace'):
            return [{**parse_hocr(content), 'format': 'hocr'}]
        if '<TEI' in head:
            return [{**page, 'format': 'tei'} for page in parse_tei(content)]
    except ElementTree.ParseError as e:
        raise ImportError_(f'{xml_name}: not well-formed XML ({e})')
    except UnreadableXml as e:
        raise ImportError_(f'{xml_name}: {e}')
    return []


def _page_names(members: list[str]) -> list[str]:
    """Each image named by its path below the folder all of them share, so a flat export
    keeps its file names and folders that repeat a name keep their pages apart."""
    common = posixpath.commonpath([posixpath.dirname(m) for m in members])
    return [(m[len(common) + 1:] if common else m).replace('/', '_') for m in members]


def _deeplabel_pages(archive: zipfile.ZipFile, members: list[str], manifest: str) -> list[dict]:
    """A DeepLabel export (job.json, as /api/jobs/{id}/export writes it, with each page's
    image under images/): every class, container and checked flag as it was, coordinates
    already the page fractions DeepLabel stores."""
    try:
        exported = json.loads(archive.read(manifest))
    except ValueError:
        raise ImportError_(f'{manifest} is not readable JSON')
    root = PurePosixPath(manifest).parent
    images = {PurePosixPath(m).name: m for m in members if PurePosixPath(m).parent == root / 'images'}
    pages = []
    for page in sorted(exported.get('pages') or [], key=lambda p: p.get('idx', 0)):
        member = images.get(page['filename'])
        if member is None:
            raise ImportError_(f"job.json names {page['filename']}, which is not under images/ in the archive")
        pages.append({
            'format': 'deeplabel', 'image': page['filename'], 'image_member': member, 'image_name': page['filename'],
            'width': page['width'], 'height': page['height'],
            'layout_checked': bool(page.get('layout_checked')), 'lines_checked': bool(page.get('lines_checked')),
            'regions': [{'class_name': element['class_name'], 'raw_type': element['class_name'],
                         'kind': element.get('kind') or 'content', 'bbox': element['bbox'],
                         'polygon': element.get('polygon'), 'conf': element.get('conf'),
                         'lines': [{'polygon': line['polygon'], 'text': line.get('text') or '',
                                    'corrected_text': line.get('corrected_text'),
                                    'checked': bool(line.get('checked'))}
                                   for line in sorted(element.get('lines') or [], key=lambda l: l.get('order_idx', 0))]}
                        for element in sorted(page.get('elements') or [], key=lambda e: e.get('order_idx', 0))]})
    if not pages:
        raise ImportError_(f'{manifest} lists no pages')
    return pages


def read_export_zip(fileobj) -> list[dict]:
    """Parsed XML pages from a Transkribus/eScriptorium-style export, each naming
    the zip member holding its image. Images are matched by the filename the XML
    references, falling back to an identical stem, and among several of that name
    the one nearest the XML wins. Their bytes stay in the zip until extract_images
    streams them out, so an export of any size never has to fit in memory. One XML
    that cannot be read refuses the whole import, naming the file."""
    try:
        archive = zipfile.ZipFile(fileobj)
    except zipfile.BadZipFile:
        raise ImportError_('this is not a readable zip archive')
    ingest.require_zip_within_limit(archive)
    members = [n for n in archive.namelist() if not n.endswith('/') and not ingest.is_system_entry(n)]
    manifests = sorted((n for n in members if PurePosixPath(n).name == 'job.json'), key=lambda n: n.count('/'))
    if manifests:
        return _deeplabel_pages(archive, members, manifests[0])
    xml_names = [n for n in members
                 if PurePosixPath(n).suffix.lower() in ANNOTATION_SUFFIXES and not n.endswith('mets.xml')
                 and not Path(n).name.startswith(('metadata', 'METS'))]
    by_name, by_stem = {}, {}
    for member in members:
        path = PurePosixPath(member)
        if path.suffix.lower() in IMAGE_SUFFIXES:
            by_name.setdefault(path.name, []).append(member)
            by_stem.setdefault(path.stem, []).append(member)
    pages = []
    for xml_name in sorted(xml_names):
        for parsed in _parse_export_xml(xml_name, archive.read(xml_name)):
            image_member = _nearest(by_name.get(PurePosixPath(parsed['image']).name)
                                    or by_stem.get(PurePosixPath(xml_name).stem, []), xml_name)
            # A blank leaf has an image and no regions; it is still a page of the export.
            if image_member is None:
                continue
            parsed['image_member'] = image_member
            pages.append(parsed)
    if not pages and by_name and not xml_names:
        raise ScansOnly('this zip holds scans and nothing describing them - upload it as pages instead')
    if not pages:
        raise ImportError_('no PAGE XML, ALTO, hOCR or TEI with matching images found in the zip - '
                           'export with images included (Transkribus and eScriptorium offer this)')
    for parsed, name in zip(pages, _page_names([p['image_member'] for p in pages])):
        parsed['image_name'] = name
    return pages


def extract_images(fileobj, pages: list[dict], uploads_dir: Path) -> list[tuple[str, str]]:
    """Stream each page's image out of the export zip into the job's uploads dir;
    returns (image_name, saved path) pairs in page order."""
    entries = []
    with zipfile.ZipFile(fileobj) as archive:
        for idx, parsed in enumerate(pages):
            dest = uploads_dir / f'{idx:05d}_{parsed["image_name"]}'
            with archive.open(parsed['image_member']) as src, open(dest, 'wb') as out:
                shutil.copyfileobj(src, out, length=1 << 20)
            ingest.require_pixels_within_limit(dest, parsed['image_name'])
            entries.append((parsed['image_name'], str(dest)))
    return entries
