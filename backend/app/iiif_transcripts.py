import json
from xml.etree.ElementTree import ParseError

from app import geometry, iiif, imports, store

MAX_TRANSCRIPT_BYTES = 20 << 20
PARSERS = {'alto': imports.parse_alto, 'page': imports.parse_page_xml, 'hocr': imports.parse_hocr}
AUTHOR = 'import:iiif'
# How many pages offering a transcription the wizard fetches to see what they hold.
SAMPLE = 3


# What reading an archive's file can raise besides a fetch failing: it is anybody's file.
UNREADABLE = (ParseError, ValueError, TypeError, KeyError, AttributeError, RecursionError)


def lines(transcript: dict, width: float | None, height: float | None, most_pages: int | None = None) -> list[dict]:
    """The lines of a canvas's transcription, in reading order, each with its text and its
    outline over the page from 0 to 1. A file's own page size places its lines; annotations
    are placed against the canvas, and need its size. IiifError where it cannot be had or
    read; `most_pages` stops after that many pages of annotations."""
    try:
        return _lines(transcript, width, height, most_pages)
    except UNREADABLE as error:
        raise iiif.IiifError(f'the transcription could not be read: {type(error).__name__}') from None


def _lines(transcript: dict, width: float | None, height: float | None, most_pages: int | None) -> list[dict]:
    if transcript['kind'] in PARSERS:
        body, _ = iiif.fetch(transcript['url'], MAX_TRANSCRIPT_BYTES, 'the transcription')
        parsed = PARSERS[transcript['kind']](body)
        return [{'polygon': line['polygon'], 'text': line['text']}
                for region in parsed['regions'] for line in region['lines'] if line['text']]
    if not width or not height:
        raise iiif.IiifError('the canvas gives no size to place its annotations on')
    found = []
    canvas_id = transcript.get('canvas')
    for page in transcript['pages'][:most_pages]:
        annotations = page.get('annotations')
        if annotations is None:
            body, _ = iiif.fetch(page['url'], MAX_TRANSCRIPT_BYTES, 'the transcription')
            fetched = json.loads(body)
            annotations = (fetched.get('items') or fetched.get('resources')) if isinstance(fetched, dict) else None
        for annotation in annotations if isinstance(annotations, list) else []:
            named = iiif.annotation_targets(annotation)
            if canvas_id and named and canvas_id not in named:
                continue
            said = iiif.annotation_text(annotation)
            outline = iiif.annotation_outline(annotation, width, height) if said else None
            if outline:
                found.append({'polygon': outline, 'text': said})
    return found


def sample(canvases: list[dict]) -> dict:
    """What the manifest offers, counted from its canvases, and what a few of those pages held
    when fetched - the full fetch waits for the import."""
    offering = [c for c in canvases if c.get('transcript')]
    held = []
    for canvas in offering[:SAMPLE]:
        try:
            held.append(len(lines(canvas['transcript'], canvas['width'], canvas['height'], most_pages=1)))
        except iiif.IiifError:
            held.append(0)
    return {'pages': len(offering), 'kinds': sorted({c['transcript']['kind'] for c in offering}),
            'sampled': len(held), 'sampled_with_text': sum(1 for n in held if n), 'sampled_lines': sum(held)}


def apply(conn, page) -> bool:
    """Put the archive's transcription on a freshly ingested page, if it chose one: its lines
    in the page's Unassigned bucket, and the page through every step, layout included: it
    is finished as the archive left it. False, leaving the page to the pipeline, where
    there is none or it cannot be had."""
    source = json.loads(page['iiif'] or '{}')
    if 'transcript' not in source:
        return False
    try:
        found = lines(source['transcript'], source.get('width'), source.get('height'))
    except iiif.IiifError as error:
        print(f"{page['filename']}: the transcription was left out - {error}", flush=True)
        return False
    if not found:
        return False
    xs = [x for line in found for x, _ in line['polygon']]
    ys = [y for line in found for _, y in line['polygon']]
    bbox = [min(xs), min(ys), max(xs), max(ys)]
    bucket = conn.execute(
        'INSERT INTO elements (page_id, order_idx, class_name, bbox, conf, kind) VALUES (?, 0, ?, ?, NULL, ?)',
        (page['id'], 'Unassigned', json.dumps(bbox), 'orphan')).lastrowid
    store.log_element(conn, bucket, AUTHOR, 'create')
    for order_idx, line in enumerate(found):
        line_id = conn.execute(
            'INSERT INTO lines (element_id, order_idx, polygon, text, checked) VALUES (?, ?, ?, ?, ?)',
            (bucket, order_idx, json.dumps(line['polygon']), line['text'], int(bool(source.get('reviewed'))))).lastrowid
        store.log_line(conn, line_id, AUTHOR, 'create')
    geometry.resequence_page(conn, page['id'])
    conn.execute("UPDATE pages SET status = 'done' WHERE id = ?", (page['id'],))
    conn.commit()
    return True
