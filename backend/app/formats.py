from dataclasses import dataclass, field
from datetime import datetime, timezone
from xml.sax.saxutils import escape, quoteattr

PAGE_NS = 'http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15'
ALTO_NS = 'http://www.loc.gov/standards/alto/ns-v4#'
TEI_NS = 'http://www.tei-c.org/ns/1.0'

# Our classes as PAGE's region types, for tools that read only the standard attribute; the
# class itself travels in @custom, where Transkribus keeps its structure tags.
PAGE_TYPES = {'Paragraph': 'paragraph', 'Header': 'heading', 'PageHeader': 'header',
              'Pagenumber': 'page-number', 'Footnote': 'footnote'}
# The classes the standards have a structure of their own for.
TABLE_CLASSES = {'Table', 'Nested-Table', 'WeirdTable'}
SEPARATOR_CLASSES = {'Divider'}


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


@dataclass
class Box:
    """One element of a page in the layout tree every format writes: its place in the
    reading order, and the boxes a container holds."""
    r: int
    element: dict
    children: list['Box'] = field(default_factory=list)

    @property
    def is_container(self) -> bool:
        return self.element['kind'] == 'container'

    @property
    def is_separator(self) -> bool:
        return self.element['class_name'] in SEPARATOR_CLASSES and not self.element['lines']

    @property
    def is_table(self) -> bool:
        return self.element['class_name'] in TABLE_CLASSES and not self.element['lines']


def _area(bbox: list[float]) -> float:
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])


def _holds(outer: list[float], inner: list[float]) -> bool:
    cx, cy = (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3] and _area(outer) > _area(inner)


def layout_tree(page: dict) -> list[Box]:
    """The page's elements nested as the standards nest them. Nothing stores which box holds
    which, so a box goes into the smallest container that holds its centre; a divider is a
    container that holds nothing."""
    boxes = [Box(r, element) for r, element in enumerate(page['elements'])]
    holders = [b for b in boxes if b.is_container and b.element['class_name'] not in SEPARATOR_CLASSES]
    roots = []
    for b in boxes:
        around = [h for h in holders if h is not b and _holds(h.element['bbox'], b.element['bbox'])]
        parent = min(around, key=lambda h: _area(h.element['bbox']), default=None)
        (parent.children if parent else roots).append(b)
    return roots


def _page_region(page: dict, b: Box) -> str:
    """A region with the regions it holds; a table and a divider in PAGE's own types."""
    element, rid = b.element, f'r{b.r + 1}'
    lines = []
    for l, line in enumerate(element['lines']):
        custom = f'readingOrder {{index:{l};}}' + (' deeplabel {checked:true;}' if line['checked'] else '')
        conf = f' conf="{line["confidence"]:.4f}"' if line.get('confidence') is not None else ''
        lines.append(
            f'<TextLine id="{rid}l{l + 1}" custom="{custom}">'
            f'<Coords points="{_points_attr(_px(page, line["polygon"]))}"/>'
            f'<TextEquiv{conf}><Unicode>{escape(line_text(line))}</Unicode></TextEquiv></TextLine>')
    custom = (f'readingOrder {{index:{b.r};}} structure {{type:{element["class_name"]};}}'
              + (' deeplabel {kind:container;}' if b.is_container else ''))
    tag = 'SeparatorRegion' if b.is_separator else 'TableRegion' if b.is_table else 'TextRegion'
    rtype = f' type="{PAGE_TYPES.get(element["class_name"], "other")}"' if tag == 'TextRegion' else ''
    inner = ''.join(_page_region(page, child) for child in b.children)
    return (f'<{tag} id="{rid}"{rtype} custom={quoteattr(custom)}>'
            f'<Coords points="{_points_attr(_region_points(page, element))}"/>{inner}{"".join(lines)}</{tag}>')


def page_xml(page: dict, source: dict | None = None) -> str:
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    tree = layout_tree(page)
    order = [f'<RegionRefIndexed index="{r}" regionRef="r{r + 1}"/>' for r in range(len(page['elements']))]
    regions = [_page_region(page, b) for b in tree]
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n<PcGts xmlns="{PAGE_NS}">'
        f'<Metadata><Creator>DeepLabel</Creator><Created>{now}</Created><LastChange>{now}</LastChange>'
        f'{f"<Comments>{escape(_source_line(source))}</Comments>" if source else ""}</Metadata>'
        f'<Page imageFilename={quoteattr(page["filename"])} imageWidth="{page["width"]}" imageHeight="{page["height"]}">'
        f'<ReadingOrder><OrderedGroup id="ro">{"".join(order)}</OrderedGroup></ReadingOrder>'
        f'{"".join(regions)}</Page></PcGts>\n')


def _alto_block(page: dict, b: Box, tag_id: dict[str, str]) -> str:
    """A container as a ComposedBlock around what it holds, a divider as a GraphicalElement,
    anything else as a TextBlock. A TextBlock cannot hold blocks, so a box with lines of its
    own is followed by what it holds rather than wrapped around it."""
    element = b.element
    lines = []
    for l, line in enumerate(element['lines']):
        points = _px(page, line['polygon'])
        x0, y0, x1, y1 = _box(points)
        words = []
        for w, word in enumerate(line_text(line).split()):
            words.append(('<SP/>' if w else '') + f'<String CONTENT={quoteattr(word)}/>')
        # ALTO has no word for reviewed, so a checked line points at a tag that says it.
        checked = ' TAGREFS="checked"' if line['checked'] else ''
        lines.append(
            f'<TextLine ID="r{b.r + 1}l{l + 1}" HPOS="{x0}" VPOS="{y0}" WIDTH="{x1 - x0}" HEIGHT="{y1 - y0}"{checked}>'
            f'<Shape><Polygon POINTS="{_points_attr(points)}"/></Shape>{"".join(words)}</TextLine>')
    x0, y0, x1, y1 = _box(_region_points(page, element))
    tags = tag_id[element['class_name']] + (' container' if b.is_container else '')
    attrs = f'ID="r{b.r + 1}" HPOS="{x0}" VPOS="{y0}" WIDTH="{x1 - x0}" HEIGHT="{y1 - y0}" TAGREFS="{tags}"'
    inner = ''.join(_alto_block(page, child, tag_id) for child in b.children)
    if b.is_separator:
        return f'<GraphicalElement {attrs}/>'
    if b.is_container and not lines:
        return f'<ComposedBlock {attrs}>{inner}</ComposedBlock>'
    return f'<TextBlock {attrs}>{"".join(lines)}</TextBlock>{inner}'


def alto(page: dict) -> str:
    classes = sorted({element['class_name'] for element in page['elements']})
    tag_id = {name: f'tag{i + 1}' for i, name in enumerate(classes)}
    blocks = [_alto_block(page, b, tag_id) for b in layout_tree(page)]
    tags = ''.join(f'<LayoutTag ID="{tag_id[name]}" LABEL={quoteattr(name)}/>' for name in classes) \
        + '<OtherTag ID="checked" LABEL="checked" DESCRIPTION="The line was reviewed by a person"/>' \
        + '<OtherTag ID="container" LABEL="container" DESCRIPTION="A box that holds other boxes"/>'
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


def _hocr_area(page: dict, b: Box) -> str:
    """An area with the areas it holds; a table and a divider by hOCR's own names."""
    element, r = b.element, b.r
    lines = []
    for l, line in enumerate(element['lines']):
        points = _px(page, line['polygon'])
        words = ' '.join(f"<span class='ocrx_word'>{escape(word)}</span>" for word in line_text(line).split())
        checked = '; x_checked 1' if line['checked'] else ''
        lines.append(f"<span class='ocr_line' id='line_{r + 1}_{l + 1}' "
                     f"title='{_bbox_title(points)}{checked}'>{words}</span>")
    kind = 'ocr_separator' if b.is_separator else 'ocr_table' if b.is_table else 'ocr_carea'
    props = f"{_bbox_title(_region_points(page, element))}; x_class {element['class_name']}" \
        + ('; x_container 1' if b.is_container else '')
    par = f"<p class='ocr_par'>{''.join(lines)}</p>" if lines else ''
    inner = ''.join(_hocr_area(page, child) for child in b.children)
    return f"<div class='{kind}' id='block_{r + 1}' title={quoteattr(props)}>{par}{inner}</div>"


def hocr(page: dict, title: str) -> str:
    areas = [_hocr_area(page, b) for b in layout_tree(page)]
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


def _tei_zone(page: dict, f: str, b: Box) -> str:
    """A region's zone around the zones it holds and its lines' zones."""
    element, rz = b.element, f'{f}_r{b.r + 1}'
    line_zones = []
    for l, line in enumerate(element['lines']):
        checked = ' subtype="checked"' if line['checked'] else ''
        line_zones.append(f'<zone xml:id="{rz}_l{l + 1}" type="line"{checked} '
                          f'points="{_points_attr(_px(page, line["polygon"]))}"/>')
    container = ' subtype="container"' if b.is_container else ''
    inner = ''.join(_tei_zone(page, f, child) for child in b.children)
    return (f'<zone xml:id="{rz}" type={quoteattr(element["class_name"])}{container} '
            f'points="{_points_attr(_region_points(page, element))}">{inner}{"".join(line_zones)}</zone>')


def tei(data: dict) -> str:
    """The dataset as one TEI document, as Transkribus and eScriptorium write it: a surface
    per page with a zone per region and per line, and a body whose page and line breaks
    point at them - so the text keeps its place on the scan."""
    surfaces, body = [], []
    for page in data['pages']:
        f = f'f{page["idx"] + 1}'
        zones = []
        body.append(f'<pb n="{page["idx"] + 1}" facs="#{f}"/>')
        zones.extend(_tei_zone(page, f, b) for b in layout_tree(page))
        for r, element in enumerate(page['elements']):
            if element['lines']:
                rz = f'{f}_r{r + 1}'
                marks = ''.join(f'<lb facs="#{rz}_l{l + 1}" n="{l + 1}"/>{escape(line_text(line))}'
                                for l, line in enumerate(element['lines']))
                body.append(f'<ab facs="#{rz}" type={quoteattr(element["class_name"])}>{marks}</ab>')
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
