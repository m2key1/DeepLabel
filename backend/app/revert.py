import json

from app import caches, candidates, dataset_sync, geometry, layout_templates, serializers, store, training
from app.deps import conflict_detail


class Conflict(Exception):
    """A span that cannot be taken back as it stands. Carries the 409 body."""

    def __init__(self, detail: dict):
        super().__init__(detail['message'])
        self.detail = detail


class Empty(Exception):
    """Nothing in the span touched this page."""


TABLES = {'line': 'lines', 'element': 'elements', 'region': 'regions', 'page': 'pages'}
SNAPSHOTS = {'line': store.snapshot_line, 'element': store.snapshot_element, 'region': store.snapshot_region}
# A line's place in its element follows from the geometry of its neighbours, and is
# never restored: a sibling's edit moving it is no edit of this line.
DERIVED_FIELDS = {'line': {'id', 'order_idx'}, 'element': {'id'}, 'region': {'id'}}
# A check approves the text the line held when it was given, and is never carried onto other text.
REVIEWED_FIELDS = {'line': ('text', 'corrected_text'), 'element': (), 'region': ()}
# The page's own reading order is the one thing about the page row a span takes back.
# Its review flags, a turn or its deletion are acts of their own and refuse the span.
REVERTIBLE_PAGE_FIELDS = {'id', 'reading_order'}


def revert_span(conn, page_id: int, job_id: str, from_rev: int, to_rev: int,
                direction: str, user: str) -> dict:
    """Put every object a run of this page's edits touched back the way it stood before
    the run (undo) or after it (redo). The log records how each row stood after every
    write, so the target state is simply the newest snapshot at the cut; a row with no
    snapshot before the run was created in it and is taken off the page again.

    What you changed after the span is a separate edit and stays: those fields keep
    their current value. Where such a later edit changed what the span itself changed,
    the two cannot be pulled apart and the revert is refused.

    Refused, and nothing written, when another person has a hand in it: an edit of
    theirs inside the span, or a later one on anything the span touched. Machines write
    after a person's commit (re-matching, consensus) and never stand in the way.
    Every revert is logged as a revision of its own, so other tabs hear of it and the
    log keeps both the edit and its undoing. The write lock is taken before the checks,
    so nobody's edit can land between them and the writes."""
    mark = store.begin_span(conn)
    rows = store.page_revisions(conn, page_id, job_id, after=from_rev, upto=to_rev)
    if not rows:
        raise Empty()
    targets = list(dict.fromkeys((r['kind'], r['id']) for r in rows))
    _refuse_foreign(conn, page_id, rows, targets, from_rev, to_rev, user)
    goals = [(kind, target_id, _page_goal(conn, target_id, from_rev, to_rev, direction) if kind == 'page'
              else _goal(conn, kind, target_id, from_rev, to_rev, direction))
             for kind, target_id in targets]
    _refuse_missing_classes(conn, job_id, goals)

    touched = _apply(conn, goals, user)
    for element_id in touched['elements']:
        geometry.resequence_lines(conn, element_id)
    touched['elements'] |= geometry.resequence_page(conn, page_id)
    # Readings the span set aside go with it: nobody builds on a reading that is not on
    # offer, and only machines move the ones that are, so none of this is refused for.
    readings = candidates.revert_set_aside(conn, page_id, from_rev, to_rev, direction)
    span = store.end_span(conn, mark)
    conn.commit()

    # What the routes do once an edit has landed.
    if touched['lines'] or readings:
        candidates.rematch_page(conn, page_id)
        for line_id in touched['lines']:
            training.enqueue(line_id)
    if touched['reverted_elements'] or touched['pages']:
        dataset_sync.enqueue(job_id)
    return _payload(conn, page_id, touched, span)


def _refuse_foreign(conn, page_id, rows, targets, from_rev, to_rev, user) -> None:
    for r in rows:
        if r['kind'] == 'page' and not set(_snapshot_of(conn, r['revision'])) <= REVERTIBLE_PAGE_FIELDS:
            raise Conflict(conflict_detail(conn, r['revision'], 'the page itself changed in this span'))
    for r in rows:
        if store.is_person(r['author']) and r['author'] != user:
            raise Conflict(conflict_detail(conn, r['revision']))
    for kind, target_id in targets:
        for later in conn.execute(
                'SELECT id, author FROM revisions WHERE target_type = ? AND target_id = ? AND id > ? '
                'ORDER BY id', (kind, target_id, to_rev)):
            if store.is_person(later['author']) and later['author'] != user:
                raise Conflict(conflict_detail(conn, later['id']))
    # A turn rewrites every shape on the page without a revision per row, so a snapshot
    # from before it describes the scan the wrong way up.
    turned = conn.execute(
        "SELECT id FROM revisions WHERE target_type = 'page' AND target_id = ? AND id > ? "
        "AND json_extract(snapshot, '$.rotation') IS NOT NULL ORDER BY id LIMIT 1",
        (page_id, from_rev)).fetchone()
    if turned is not None:
        raise Conflict(conflict_detail(conn, turned['id'], 'the scan was turned since'))


def _snapshot_of(conn, revision: int) -> dict:
    return json.loads(conn.execute('SELECT snapshot FROM revisions WHERE id = ?', (revision,)).fetchone()['snapshot'])


def _snapshot_at(conn, kind: str, target_id: int, cut: int) -> dict | None:
    """How the row stood at the cut, or None where it did not exist yet. An origin is
    how the row stood before its first logged write, so it answers for any cut before
    it - a system write inside an edit takes its origin there and no earlier."""
    row = conn.execute(
        'SELECT snapshot FROM revisions WHERE target_type = ? AND target_id = ? AND id <= ? '
        'ORDER BY id DESC LIMIT 1', (kind, target_id, cut)).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT snapshot, action FROM revisions WHERE target_type = ? AND target_id = ? "
            'ORDER BY id LIMIT 1', (kind, target_id)).fetchone()
        if row is None or row['action'] != 'origin':
            return None
    return json.loads(row['snapshot'])


def _goal(conn, kind: str, target_id: int, from_rev: int, to_rev: int, direction: str) -> dict | None:
    """How the row should stand once the span is reverted: as it stood at the cut, except
    for fields a person has changed since. Each such field keeps its current value when
    the span left it alone, and refuses the revert when the span changed it too. A check
    given since refuses it as well when the span changed the line's text. A field only
    machines rewrote since (a re-read after a reshape) followed this edit and goes back
    with it."""
    before, after = _snapshot_at(conn, kind, target_id, from_rev), _snapshot_at(conn, kind, target_id, to_rev)
    expected, goal = (after, before) if direction == 'undo' else (before, after)
    current = conn.execute(f'SELECT * FROM {TABLES[kind]} WHERE id = ?', (target_id,)).fetchone()
    if current is None or expected is None:
        return goal
    now = SNAPSHOTS[kind](current)
    edited = _edited_by_people_since(conn, kind, target_id, to_rev, after)
    rewrites_reviewed_text = any((goal or {}).get(f) != expected.get(f) for f in REVIEWED_FIELDS[kind])
    goal = dict(goal) if goal is not None else None
    for field in now:
        if field in DERIVED_FIELDS[kind] or now[field] == expected.get(field) or field not in edited:
            continue
        if field == 'checked' and rewrites_reviewed_text:
            raise Conflict(conflict_detail(conn, edited[field], 'it was checked since'))
        if goal is not None and goal.get(field) == expected.get(field):
            goal[field] = now[field]
        else:
            raise Conflict(conflict_detail(
                conn, edited[field], f"its {field.replace('_', ' ')} was changed since"))
    return goal


def _page_goal(conn, page_id: int, from_rev: int, to_rev: int, direction: str) -> dict:
    """The page's reading order as it stood at the far end of the span. It is one
    choice, not fields to merge, so a change to it since refuses the revert."""
    before, after = _reading_order_at(conn, page_id, from_rev), _reading_order_at(conn, page_id, to_rev)
    expected, goal = (after, before) if direction == 'undo' else (before, after)
    current = _reading_order_at(conn, page_id, store.revision_mark(conn))
    if current[1] != expected[1]:
        raise Conflict(conflict_detail(conn, current[0], 'its reading order was changed since'))
    return {'reading_order': goal[1]}


def _reading_order_at(conn, page_id: int, cut: int) -> tuple[int | None, str | None]:
    """The revision that last set the page's reading order by the cut, and what it set.
    Before the first, the page followed its dataset."""
    row = conn.execute(
        "SELECT id, json_extract(snapshot, '$.reading_order') AS setting FROM revisions "
        "WHERE target_type = 'page' AND target_id = ? AND id <= ? "
        "AND json_type(snapshot, '$.reading_order') IS NOT NULL ORDER BY id DESC LIMIT 1",
        (page_id, cut)).fetchone()
    return (row['id'], row['setting']) if row is not None else (None, None)


def _edited_by_people_since(conn, kind: str, target_id: int, since: int, at_since: dict | None) -> dict[str, int]:
    """Each field a person's write changed after `since`, with the newest revision that did."""
    edited, previous = {}, at_since or {}
    for r in conn.execute(
            'SELECT id, author, snapshot FROM revisions WHERE target_type = ? AND target_id = ? AND id > ? '
            'ORDER BY id', (kind, target_id, since)):
        snapshot = json.loads(r['snapshot'])
        if store.is_person(r['author']):
            edited.update({field: r['id'] for field, value in snapshot.items() if value != previous.get(field)})
        previous = snapshot
    return edited


def _refuse_missing_classes(conn, job_id, goals) -> None:
    layout = {c['name'].lower() for c in layout_templates.job_classes(conn, job_id)}
    for kind, _, snap in goals:
        if kind == 'region' and snap is not None:
            refuse_missing_class(conn, job_id, snap['class_id'])
        # A box goes back only under a class the dataset still has. One merged
        # away already holds the class it was merged into, a later edit the span keeps; one
        # whose class went with its boxes would come back under a name nothing lists.
        if kind == 'element' and snap is not None and layout and snap['kind'] != 'orphan' \
                and snap['class_name'].lower() not in layout:
            raise Conflict(conflict_detail(
                conn, None, f'the class {snap["class_name"]} was removed from this dataset with its boxes'))


def refuse_missing_class(conn, job_id: str, class_id: int) -> None:
    """A region comes back only into a class the palette still lists: its mask pixels
    would otherwise carry a value class_map.json does not name."""
    if class_id not in store.job_class_names(conn, job_id):
        raise Conflict(conflict_detail(conn, None, f'class {class_id} no longer exists in this dataset'))


def _apply(conn, goals, user) -> dict:
    touched = {'lines': set(), 'elements': set(), 'reverted_elements': set(), 'regions': set(), 'pages': set()}
    for kind, target_id, snap in goals:
        current = conn.execute(f'SELECT * FROM {TABLES[kind]} WHERE id = ?', (target_id,)).fetchone()
        if current is None:
            continue  # purged from the database since; nothing left to put back
        if kind == 'line':
            touched['lines'].add(target_id)
            touched['elements'].add(current['element_id'])
            if snap is None:
                conn.execute('UPDATE lines SET deleted = 1 WHERE id = ?', (target_id,))
            else:
                _restore_line(conn, target_id, snap, current)
                touched['elements'].add(snap['element_id'])
            store.log_line(conn, target_id, user, 'revert')
        elif kind == 'element':
            touched['elements'].add(target_id)
            touched['reverted_elements'].add(target_id)
            if snap is None:
                conn.execute('UPDATE elements SET deleted = 1 WHERE id = ?', (target_id,))
            else:
                _restore_element(conn, target_id, snap, current)
            store.log_element(conn, target_id, user, 'revert')
        elif kind == 'page':
            touched['pages'].add(target_id)
            conn.execute('UPDATE pages SET reading_order = ? WHERE id = ?', (snap['reading_order'], target_id))
            store.log_revision(conn, 'page', target_id, current['job_id'], user, 'revert', {'id': target_id, **snap})
            touched['elements'].update(geometry.orphan_buckets(conn, target_id))
        else:
            touched['regions'].add(target_id)
            if snap is None:
                conn.execute('UPDATE regions SET deleted = 1 WHERE id = ?', (target_id,))
            else:
                _restore_region(conn, target_id, snap)
            store.log_region(conn, target_id, user, 'revert')
    return touched


def _restore_line(conn, line_id: int, snap: dict, current) -> None:
    # order_idx is left to resequence_lines, as every line route leaves it.
    conn.execute(
        'UPDATE lines SET element_id = ?, polygon = ?, text = ?, corrected_text = ?, confidence = ?, '
        'checked = ?, deleted = ? WHERE id = ?',
        (snap['element_id'], json.dumps(snap['polygon']), snap['text'], snap['corrected_text'],
         snap['confidence'], int(snap['checked']), int(snap['deleted']), line_id))
    if 'orientation' in snap:
        conn.execute('UPDATE lines SET orientation = ? WHERE id = ?', (snap['orientation'], line_id))
    if 'check_source' in snap:
        conn.execute('UPDATE lines SET check_source = ? WHERE id = ?', (snap['check_source'], line_id))
    # A snapshot from before the author was kept names nobody, and nobody is read as a person.
    conn.execute('UPDATE lines SET corrected_by = ? WHERE id = ?', (snap.get('corrected_by'), line_id))
    if snap['text'] != current['text']:
        conn.execute('UPDATE lines SET conf_profile = NULL WHERE id = ?', (line_id,))
    if snap['checked'] or snap['corrected_text']:
        conn.execute('UPDATE lines SET needs_ocr = 0 WHERE id = ?', (line_id,))  # review cancels re-OCR
    if snap['polygon'] != json.loads(current['polygon']):
        caches.drop_line_crop(conn, line_id)


def _restore_element(conn, element_id: int, snap: dict, current) -> None:
    conn.execute(
        'UPDATE elements SET order_idx = ?, class_name = ?, raw_class_name = ?, bbox = ?, conf = ?, '
        'kind = ?, checked = ?, deleted = ? WHERE id = ?',
        (snap['order_idx'], snap['class_name'], snap['raw_class_name'], json.dumps(snap['bbox']),
         snap['conf'], snap['kind'], int(snap['checked']), int(snap['deleted']), element_id))
    if 'lines_bbox' in snap:
        conn.execute('UPDATE elements SET lines_bbox = ? WHERE id = ?',
                     (json.dumps(snap['lines_bbox']) if snap['lines_bbox'] is not None else None, element_id))
    if 'polygon' in snap:
        conn.execute('UPDATE elements SET polygon = ? WHERE id = ?',
                     (json.dumps(snap['polygon']) if snap['polygon'] else None, element_id))
    elif current['polygon']:
        # Recorded before elements had outlines: the one it has now follows the box back.
        conn.execute('UPDATE elements SET polygon = ? WHERE id = ?', (json.dumps(geometry.fit_ring(
            json.loads(current['polygon']), json.loads(current['bbox']), snap['bbox'])), element_id))
    if snap['bbox'] != json.loads(current['bbox']):
        caches.drop_element_crop(conn, element_id)


def _restore_region(conn, region_id: int, snap: dict) -> None:
    conn.execute(
        'UPDATE regions SET order_idx = ?, class_id = ?, points = ?, holes = ?, kind = ?, checked = ?, '
        'deleted = ? WHERE id = ?',
        (snap['order_idx'], snap['class_id'], json.dumps(snap['points']), json.dumps(snap['holes']),
         snap['kind'], int(snap['checked']), int(snap['deleted']), region_id))


def _payload(conn, page_id: int, touched, span) -> dict:
    """Every element and region the revert reached, as it now stands - so the client
    replaces what it holds without asking for the page again. A line that went comes
    back through its element's list, or drops out of it."""
    elements, removed_elements = [], []
    for element_id in sorted(touched['elements']):
        if conn.execute('SELECT deleted FROM elements WHERE id = ?', (element_id,)).fetchone()['deleted']:
            removed_elements.append(element_id)
        else:
            elements.append(serializers.element_with_lines(conn, element_id))
    regions, removed_regions = [], []
    for region_id in sorted(touched['regions']):
        if conn.execute('SELECT deleted FROM regions WHERE id = ?', (region_id,)).fetchone()['deleted']:
            removed_regions.append(region_id)
        else:
            regions.append(serializers.get_region(conn, region_id))
    return {'elements': elements, 'regions': regions, 'removed_elements': removed_elements,
            'removed_regions': removed_regions, 'span': span,
            'reading_order': conn.execute('SELECT reading_order FROM pages WHERE id = ?',
                                          (page_id,)).fetchone()['reading_order']}
