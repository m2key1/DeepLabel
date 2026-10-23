"""Layout vocabulary, duplicated from the detector because this venv is torch-free.

Mirrors RFDETRLayoutDetection in Schematismus/utils/layout_detection_utils.py:260
(CLASS_NAMES, in checkpoint order, which is also the COCO category order) and the
container set in Schematismus/utils/ordering_utils.py:78. The two must change together.
"""

CLASS_NAMES = ['BigParagraph', 'Column', 'Curly', 'Divider', 'Footnote', 'Header',
               'Nested-Column', 'Nested-Table', 'PageHeader', 'PageNumber',
               'Paragraph', 'SheetNumber', 'Table', 'WeirdTable']

DOWNSTREAM_LABEL_MAP = {'PageNumber': 'Pagenumber', 'WeirdTable': 'Table'}

# Raw labels that are not text-bearing leaves. kind='container' is what keeps an
# element out of line detection and OCR, so Divider belongs here even though it
# nests nothing: it is a rule, there is no text to read. WeirdTable belongs
# because it maps to Table.
CONTAINER_CLASSES = {'Curly', 'Nested-Column', 'Nested-Table', 'Column', 'Table', 'WeirdTable',
                     'Divider'}

# Recovers a raw label from a pre-raw_class_name element. Lossy for WeirdTable,
# which is indistinguishable from Table once mapped.
LEGACY_RAW = {'Pagenumber': 'PageNumber'}


def resolve(raw: str) -> tuple[str, str, str]:
    """Raw checkpoint label -> (class_name, raw_class_name, kind)."""
    return (DOWNSTREAM_LABEL_MAP.get(raw, raw), raw,
            'container' if raw in CONTAINER_CLASSES else 'content')


# A geometry change smaller than roughly half a line height cannot reveal or hide a
# line, so it is not worth re-detecting. On a 2500px page 0.005 is ~12px against a
# ~25px line; the shift+arrow nudge of 0.002 stays below it.
LINES_STALE_DELTA = 0.005

# Elements whose lines no longer match their geometry. Derived rather than flagged:
# a flag set per edit misses drift accumulated across several small nudges, and would
# have to be maintained on every create, edit and re-run path.
STALE_LINES_SQL = (
    "e.kind = 'content' AND e.deleted = 0 AND ("
    "e.lines_bbox IS NULL"
    " OR abs(json_extract(e.bbox,'$[0]') - json_extract(e.lines_bbox,'$[0]')) > ?"
    " OR abs(json_extract(e.bbox,'$[1]') - json_extract(e.lines_bbox,'$[1]')) > ?"
    " OR abs(json_extract(e.bbox,'$[2]') - json_extract(e.lines_bbox,'$[2]')) > ?"
    " OR abs(json_extract(e.bbox,'$[3]') - json_extract(e.lines_bbox,'$[3]')) > ?)"
)

STALE_LINES_ARGS = (LINES_STALE_DELTA,) * 4

# When a job has auto_redetect off, phase_relines re-detects only elements a human
# explicitly requested - signalled by clearing lines_bbox - so hand-edited lines and
# incidental bbox drift are left alone.
STALE_LINES_EXPLICIT_SQL = "e.kind = 'content' AND e.deleted = 0 AND e.lines_bbox IS NULL"
