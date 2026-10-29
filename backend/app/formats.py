from datetime import datetime, timezone
from xml.sax.saxutils import escape, quoteattr

PAGE_NS = 'http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15'
ALTO_NS = 'http://www.loc.gov/standards/alto/ns-v4#'
TEI_NS = 'http://www.tei-c.org/ns/1.0'

# Our classes as PAGE's region types, for tools that read only the standard attribute; the
# class itself travels in @custom, where Transkribus keeps its structure tags.
PAGE_TYPES = {'Paragraph': 'paragraph', 'Header': 'heading', 'PageHeader': 'header',
              'Pagenumber': 'page-number', 'Footnote': 'footnote'}


def line_text(line: dict) -> str:
    return line['corrected_text'] if line['corrected_text'] is not None else (line['text'] or '')


def _px(page: dict, polygon: list) -> list[tuple[int, int]]:
    return [(round(x * page['width']), round(y * page['height'])) for x, y in polygon]


def _box(points: list[tuple[int, int]]) -> tuple[int, int, int, int]:
    xs, ys = [x for x, _ in points], [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def _region_points(page: dict, element: dict) -> list[tuple[int, int]]:
    if element.get('polygon'):
        return _px(page, element['polygon'])
    x0, y0, x1, y1 = element['bbox']
    return _px(page, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])


def _points_attr(points: list[tuple[int, int]], sep: str = ',') -> str:
    return ' '.join(f'{x}{sep}{y}' for x, y in points)


def _text_regions(page: dict):
    """Regions that hold lines, in reading order, with their lines - what every format
    writes. A container with no lines of its own carries nothing to transcribe."""
    for r, element in enumerate(page['elements']):
        if element['lines']:
            yield r, element


def page_xml(page: dict, source: dict | None = None) -> str:
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    regions, order = [], []
    for r, element in _text_regions(page):
        rid = f'r{r + 1}'
        order.append(f'<RegionRefIndexed index="{len(order)}" regionRef="{rid}"/>')
        lines = []
        for l, line in enumerate(element['lines']):
            custom = f'readingOrder {{index:{l};}}' + (' deeplabel {checked:true;}' if line['checked'] else '')
            conf = f' conf="{line["confidence"]:.4f}"' if line.get('confidence') is not None else ''
            lines.append(
                f'<TextLine id="{rid}l{l + 1}" custom="{custom}">'
                f'<Coords points="{_points_attr(_px(page, line["polygon"]))}"/>'
                f'<TextEquiv{conf}><Unicode>{escape(line_text(line))}</Unicode></TextEquiv></TextLine>')
        rtype = PAGE_TYPES.get(element['class_name'], 'other')
        custom = f'readingOrder {{index:{len(order) - 1};}} structure {{type:{element["class_name"]};}}'
        regions.append(
            f'<TextRegion id="{rid}" type="{rtype}" custom={quoteattr(custom)}>'
            f'<Coords points="{_points_attr(_region_points(page, element))}"/>{"".join(lines)}</TextRegion>')
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n<PcGts xmlns="{PAGE_NS}">'
        f'<Metadata><Creator>DeepLabel</Creator><Created>{now}</Created><LastChange>{now}</LastChange>'
        f'{f"<Comments>{escape(_source_line(source))}</Comments>" if source else ""}</Metadata>'
        f'<Page imageFilename={quoteattr(page["filename"])} imageWidth="{page["width"]}" imageHeight="{page["height"]}">'
        f'<ReadingOrder><OrderedGroup id="ro">{"".join(order)}</OrderedGroup></ReadingOrder>'
        f'{"".join(regions)}</Page></PcGts>\n')


def alto(page: dict) -> str:
    classes = sorted({element['class_name'] for _, element in _text_regions(page)})
    tag_id = {name: f'tag{i + 1}' for i, name in enumerate(classes)}
    blocks = []
    for r, element in _text_regions(page):
        lines = []
        for l, line in enumerate(element['lines']):
            points = _px(page, line['polygon'])
            x0, y0, x1, y1 = _box(points)
            words = []
            for w, word in enumerate(line_text(line).split()):
                words.append(('<SP/>' if w else '') + f'<String CONTENT={quoteattr(word)}/>')
            lines.append(
                f'<TextLine ID="r{r + 1}l{l + 1}" HPOS="{x0}" VPOS="{y0}" WIDTH="{x1 - x0}" HEIGHT="{y1 - y0}">'
                f'<Shape><Polygon POINTS="{_points_attr(points)}"/></Shape>{"".join(words)}</TextLine>')
        x0, y0, x1, y1 = _box(_region_points(page, element))
        blocks.append(
            f'<TextBlock ID="r{r + 1}" HPOS="{x0}" VPOS="{y0}" WIDTH="{x1 - x0}" HEIGHT="{y1 - y0}" '
            f'TAGREFS="{tag_id[element["class_name"]]}">{"".join(lines)}</TextBlock>')
    tags = ''.join(f'<LayoutTag ID="{tag_id[name]}" LABEL={quoteattr(name)}/>' for name in classes)
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n<alto xmlns="{ALTO_NS}">'
        f'<Description><MeasurementUnit>pixel</MeasurementUnit>'
        f'<sourceImageInformation><fileName>{escape(page["filename"])}</fileName></sourceImageInformation>'
        f'<OCRProcessing ID="ocr"><ocrProcessingStep><processingSoftware><softwareName>DeepLabel</softwareName>'
        f'</processingSoftware></ocrProcessingStep></OCRProcessing></Description>'
        f'<Tags>{tags}</Tags>'
        f'<Layout><Page ID="p{page["idx"] + 1}" PHYSICAL_IMG_NR="{page["idx"] + 1}" '
        f'WIDTH="{page["width"]}" HEIGHT="{page["height"]}">'
        f'<PrintSpace HPOS="0" VPOS="0" WIDTH="{page["width"]}" HEIGHT="{page["height"]}">{"".join(blocks)}</PrintSpace>'
        f'</Page></Layout></alto>\n')


def _bbox_title(points: list[tuple[int, int]]) -> str:
    return 'bbox {} {} {} {}'.format(*_box(points))


def hocr(page: dict, title: str) -> str:
    areas = []
    for r, element in _text_regions(page):
        lines = []
        for l, line in enumerate(element['lines']):
            points = _px(page, line['polygon'])
            words = ' '.join(f"<span class='ocrx_word'>{escape(word)}</span>" for word in line_text(line).split())
            checked = '; x_checked 1' if line['checked'] else ''
            lines.append(f"<span class='ocr_line' id='line_{r + 1}_{l + 1}' "
                         f"title='{_bbox_title(points)}{checked}'>{words}</span>")
        points = _region_points(page, element)
        areas.append(
            f"<div class='ocr_carea' id='block_{r + 1}' title='{_bbox_title(points)}; x_class {escape(element['class_name'])}'>"
            f"<p class='ocr_par'>{''.join(lines)}</p></div>")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head>'
        f'<title>{escape(title)}</title><meta charset="utf-8"/>'
        "<meta name='ocr-system' content='DeepLabel'/>"
        "<meta name='ocr-capabilities' content='ocr_page ocr_carea ocr_par ocr_line ocrx_word'/>"
        f"</head><body><div class='ocr_page' id='page_{page['idx'] + 1}' "
        f"title={quoteattr(f'image {page['filename']}; bbox 0 0 {page['width']} {page['height']}')}>"
        f"{''.join(areas)}</div></body></html>\n")


def _source_line(source: dict) -> str:
    parts = [f'IIIF manifest {source["manifest"]}', source.get('attribution'), source.get('rights')]
    return '; '.join(p for p in parts if p)


def _tei_source(source: dict) -> str:
    """The manifest a IIIF dataset came from, with its attribution and rights."""
    rights = source.get('rights')
    licence = (f'<licence{f" target={quoteattr(rights)}" if rights else ""}>'
               f'{escape(source.get("attribution") or rights or "")}</licence>')
    return (f'<bibl><title>{escape(source.get("label") or "")}</title>'
            f'<idno type="IIIF-manifest">{escape(source["manifest"])}</idno>'
            f'<availability>{licence}</availability></bibl>')


def tei(data: dict) -> str:
    """The dataset as one TEI document, as Transkribus and eScriptorium write it: a surface
    per page with a zone per region and per line, and a body whose page and line breaks
    point at them - so the text keeps its place on the scan."""
    surfaces, body = [], []
    for page in data['pages']:
        f = f'f{page["idx"] + 1}'
        zones = []
        body.append(f'<pb n="{page["idx"] + 1}" facs="#{f}"/>')
        for r, element in _text_regions(page):
            rz = f'{f}_r{r + 1}'
            line_zones, line_marks = [], []
            for l, line in enumerate(element['lines']):
                lz = f'{rz}_l{l + 1}'
                checked = ' subtype="checked"' if line['checked'] else ''
                line_zones.append(f'<zone xml:id="{lz}" type="line"{checked} '
                                  f'points="{_points_attr(_px(page, line["polygon"]))}"/>')
                line_marks.append(f'<lb facs="#{lz}" n="{l + 1}"/>{escape(line_text(line))}')
            zones.append(f'<zone xml:id="{rz}" type={quoteattr(element["class_name"])} '
                         f'points="{_points_attr(_region_points(page, element))}">{"".join(line_zones)}</zone>')
            body.append(f'<ab facs="#{rz}" type={quoteattr(element["class_name"])}>{"".join(line_marks)}</ab>')
        surfaces.append(
            f'<surface xml:id="{f}" ulx="0" uly="0" lrx="{page["width"]}" lry="{page["height"]}">'
            f'<graphic url={quoteattr("images/" + page["filename"])} width="{page["width"]}px" '
            f'height="{page["height"]}px"/>{"".join(zones)}</surface>')
    title = escape(data['job'].get('name', ''))
    source = data['job'].get('iiif_source')
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="{TEI_NS}"><teiHeader><fileDesc>'
        f'<titleStmt><title>{title}</title></titleStmt>'
        '<publicationStmt><p>Exported from DeepLabel</p></publicationStmt>'
        f'<sourceDesc>{_tei_source(source) if source else f"<p>{title}</p>"}</sourceDesc></fileDesc></teiHeader>'
        f'<facsimile>{"".join(surfaces)}</facsimile>'
        f'<text><body>{"".join(body)}</body></text></TEI>\n')
