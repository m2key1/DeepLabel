import json

from app import caches, registry, store


# Every editable row carries `revision`, the newest revision id logged for it (0 when
# none): the client hands it back with an edit so a concurrent save can be refused.


def line_dict(row, revision: int, text_author: str = '') -> dict:
    return {'id': row['id'], 'order_idx': row['order_idx'], 'polygon': json.loads(row['polygon']),
            'text': row['text'], 'corrected_text': row['corrected_text'],
            # Who wrote the correction, so the client can tell a person's typing from a
            # machine's fill-in (store.MACHINE_AUTHORS) - the eraser spares only the former.
            'corrected_by': row['corrected_by'], 'confidence': row['confidence'],
            'conf_profile': json.loads(row['conf_profile']) if row['conf_profile'] else None,
            'orientation': row['orientation'], 'needs_ocr': bool(row['needs_ocr']),
            'checked': bool(row['checked']),
            # Who settled it, and how many language models agreed on the text - what the
            # viewer sorts and filters by, and what keeps a machine check distinguishable.
            'check_source': row['check_source'], 'llm_agree_count': row['llm_agree_count'],
            # How the crop is cut. The browser keeps a crop for a year, so its URL has to
            # carry this: a client cannot know when the server starts cutting them another way.
            'crop_recipe': caches.line_crop_recipe(),
            'text_author': text_author,
            'revision': revision}


def get_line(conn, line_id: int) -> dict:
    row = conn.execute('SELECT * FROM lines WHERE id = ?', (line_id,)).fetchone()
    return line_dict(row, store.latest_revision(conn, 'line', line_id),
                     registry.line_readers(conn, [line_id])[line_id])


def region_dict(row, names: dict, revision: int) -> dict:
    """`names` maps the job's class ids to names (store.job_class_names). A class removed
    from the job (soft-deleted regions still carry its id) falls back to the numeric id."""
    return {'id': row['id'], 'order_idx': row['order_idx'], 'class_id': row['class_id'],
            'class_name': names.get(row['class_id'], str(row['class_id'])),
            'points': json.loads(row['points']), 'holes': json.loads(row['holes']),
            'kind': row['kind'], 'checked': bool(row['checked']), 'revision': revision}


def get_region(conn, region_id: int) -> dict:
    row = conn.execute(
        'SELECT r.*, p.job_id FROM regions r JOIN pages p ON r.page_id = p.id WHERE r.id = ?',
        (region_id,)).fetchone()
    return region_dict(row, store.job_class_names(conn, row['job_id']),
                       store.latest_revision(conn, 'region', region_id))


def element_payload(row, lines: list, revision: int) -> dict:
    return {'id': row['id'], 'order_idx': row['order_idx'], 'class_name': row['class_name'],
            'raw_class_name': row['raw_class_name'], 'bbox': json.loads(row['bbox']),
            'conf': row['conf'], 'kind': row['kind'], 'checked': bool(row['checked']),
            'polygon': json.loads(row['polygon']) if row['polygon'] else None,
            'lines': lines, 'revision': revision}


def lines_of_element(conn, element_id: int) -> list[dict]:
    rows = conn.execute('SELECT * FROM lines WHERE element_id = ? AND deleted = 0 ORDER BY order_idx',
                        (element_id,)).fetchall()
    ids = [r['id'] for r in rows]
    revisions = store.latest_revisions(conn, 'line', ids)
    authors = registry.line_readers(conn, ids)
    return [line_dict(r, revisions[r['id']], authors[r['id']]) for r in rows]


def element_with_lines(conn, element_id: int) -> dict:
    row = conn.execute('SELECT * FROM elements WHERE id = ?', (element_id,)).fetchone()
    return element_payload(row, lines_of_element(conn, element_id),
                           store.latest_revision(conn, 'element', element_id))
