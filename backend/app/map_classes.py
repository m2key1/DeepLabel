"""Map-segmentation class vocabulary, ported from the cadastre trainer.

Mirrors cadastre/annotation_tool/utilities/classes.py: MASK_ORDER is the single
source of truth for foreground ordering — a pixel's class id is its index in
CLASS_NAMES (background is 0). Colours and the overlap tie-break priority are the
trainer's, and must stay in sync with it (rasterization paints lowest priority
first so the highest-priority class wins an overlapping pixel).

This is the map analogue of layout_classes.py. It is now the **legacy default seed**
only: each map job owns an editable copy in the `job_classes` table (seeded here or
from the model registry). Runtime readers resolve per-job classes; nothing but job
seeding and the backfill migration reads these tables anymore.
"""

BACKGROUND_NAME = 'background'
MASK_ORDER = ['buildings', 'forests', 'rivers', 'roads', 'urban']

# Class id == index here; background is 0 and is never drawn (uncovered = background).
CLASS_NAMES = [BACKGROUND_NAME, *MASK_ORDER]

CLASS_TO_ID = {name: idx for idx, name in enumerate(CLASS_NAMES)}
ID_TO_CLASS = {idx: name for idx, name in enumerate(CLASS_NAMES)}

# RGB per class id (trainer's overlay colours).
CLASS_COLORS = {
    CLASS_TO_ID['background']: [0, 0, 0],
    CLASS_TO_ID['buildings']: [255, 0, 195],   # pink
    CLASS_TO_ID['forests']: [137, 243, 54],    # lime green
    CLASS_TO_ID['rivers']: [255, 0, 0],        # red
    CLASS_TO_ID['roads']: [0, 255, 255],       # cyan
    CLASS_TO_ID['urban']: [128, 0, 128],       # deep purple
}

# Highest priority first: when classes claim the same pixel, the earliest here wins.
OVERLAP_PRIORITY = ['buildings', 'urban', 'roads', 'rivers', 'forests', 'background']
OVERLAP_PRIORITY_IDS = [CLASS_TO_ID[name] for name in OVERLAP_PRIORITY]
# rank[class_id] — smaller is higher priority. Used to sort polygons for painting.
PRIORITY_RANK = {cid: rank for rank, cid in enumerate(OVERLAP_PRIORITY_IDS)}

# Drawable ids: everything except background.
DRAWABLE_IDS = [CLASS_TO_ID[name] for name in MASK_ORDER]


def is_drawable(class_id: int) -> bool:
    return class_id in DRAWABLE_IDS


def classes_payload() -> list[dict]:
    """Vocabulary for the frontend palette. priority is the rank (0 = highest)."""
    return [{'id': cid, 'name': ID_TO_CLASS[cid], 'color': CLASS_COLORS[cid],
             'priority': PRIORITY_RANK[cid]} for cid in range(len(CLASS_NAMES))]


# --- line tracing ------------------------------------------------------------

# A traced boundary is a boundary: which surface it happened to bound (a forest vs. a
# field) does not survive reduction to an outline, so line jobs seed one drawable class
# instead of the segmentation vocabulary, and prediction merges every detected surface's
# outline into it. Still an ordinary editable job_classes copy — a job that genuinely
# needs several line types can add them in the palette.
LINE_CLASS_NAME = 'edge lines'
LINE_CLASS_ID = 1
LINE_CLASS_COLOR = [255, 214, 0]  # amber: reads against both map paper and dark UI


def line_classes_payload() -> list[dict]:
    return [
        {'id': 0, 'name': BACKGROUND_NAME, 'color': CLASS_COLORS[0], 'priority': 1},
        {'id': LINE_CLASS_ID, 'name': LINE_CLASS_NAME, 'color': LINE_CLASS_COLOR, 'priority': 0},
    ]
